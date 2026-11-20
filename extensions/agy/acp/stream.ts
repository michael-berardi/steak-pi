// Translate one ACP prompt turn into Pi stream events. A parked MCP call is emitted as a normal Pi toolCall block;
// Pi executes it through its own validation/hooks/approvals and the next provider step answers it with the toolResult,
// while agy's original session/prompt stays open. No ctx.executeTool() is involved.
import { createAssistantMessageEventStream, getCurrentTools, type AssistantMessage, type AssistantMessageEventStream, type Model, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { AgyError, cleanAgyText } from "../errors.ts";
import { agyBin } from "../process.ts";
import { ASSUMED_CONTEXT_WINDOW } from "../models.ts";
import { PROMPT_MAX_BYTES, tailBytes } from "../prompt.ts";
import { streamAgy } from "../stream.ts";
import { learnedContextWindows, learnedEfforts, thinkingLevelMapFromOptions } from "./options.ts";
import { getAcpSession, type TurnUpdate } from "./session.ts";
import { acpLog, probeAcpSupport, resolveTransport } from "./transport.ts";
import { AcpToolLoop, toolError, type AcpTurn, type ParkedCall } from "./tool-loop.ts";
import type { BridgeTool, BridgeToolResult } from "./mcp-bridge.ts";

/** Give agy a moment to issue every tool call of one parallel step before ending the Pi turn with toolUse. */
const PARALLEL_WINDOW_MS = 75;

const byteLength = (s: string) => Buffer.byteLength(s, "utf8");
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part: any) => part?.type === "text" ? part.text : part?.type === "thinking" ? part.thinking : "").filter(Boolean).join("\n");
  return "";
}

/** Pi 1.0.4 carries tool declarations in the normalized transcript's system messages, not in event contexts. */
export function toolsFromContext(context: TranscriptContext): BridgeTool[] {
  const declared = (context as any).tools;
  const tools = Array.isArray(declared) && declared.length ? declared : getCurrentTools(context.messages);
  return tools.map((tool: any) => ({
    name: String(tool.name),
    description: String(tool.description ?? ""),
    parameters: tool.parameters as Record<string, unknown>,
  }));
}

/** Pi's toolResult message is the answer to the parked MCP tools/call request. */
export function bridgeResultFrom(message: any): BridgeToolResult {
  const content = Array.isArray(message?.content) ? message.content : [{ type: "text", text: textOf(message?.content) }];
  return {
    content: content.flatMap((part: any) => part?.type === "image"
      ? [{ type: "image" as const, data: String(part.data ?? ""), mimeType: String(part.mimeType ?? "application/octet-stream") }]
      : part?.type === "text" ? [{ type: "text" as const, text: String(part.text ?? "") }] : []),
    isError: Boolean(message?.isError),
  };
}

/** ACP owns the live conversation: send system instructions plus the user's unfinished request, not a transcript replay. */
export function buildAcpPrompt(messages: readonly any[], fresh: boolean): string {
  const system = messages.filter((m) => m?.role === "system").map((m) => textOf(m.content)).filter(Boolean).join("\n\n");
  let last = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === "user") { last = i; break; }
  if (last < 0) throw new AgyError("failed", "ACP needs a user message to answer");
  const current = messages.slice(last).filter((m) => m?.role === "user").map((m) => textOf(m.content).trim()).filter(Boolean).join("\n\n");
  const parts: string[] = [];
  if (system) parts.push(`[Pi system instructions]\n${tailBytes(system, 60_000)}`);
  if (fresh) {
    const earlier = messages.slice(0, last).flatMap((m) => {
      if (m?.role === "user") return [`[user]\n${textOf(m.content).trim()}`];
      if (m?.role === "assistant") { const text = textOf(m.content).trim(); return text ? [`[assistant]\n${text}`] : []; }
      return [];
    }).join("\n\n");
    if (earlier) parts.push(`[Earlier Pi conversation, for context only]\n${tailBytes(earlier, 80_000)}`);
  }
  parts.push(`[Current request]\n${current}`);
  return tailBytes(parts.join("\n\n"), PROMPT_MAX_BYTES + 60_000);
}

const emptyUsage = (): AssistantMessage["usage"] => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

/** Hand a fallback turn to the existing headless stream, preserving its events verbatim. */
async function forwardHeadless(target: AssistantMessageEventStream, model: Model<any>, context: TranscriptContext, options?: SimpleStreamOptions): Promise<void> {
  for await (const event of streamAgy(model, context, options)) target.push(event as never);
  target.end();
}

export function streamAgyAcp(model: Model<any>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider || "agy", model: model.id, usage: emptyUsage(), stopReason: "pending", timestamp: Date.now() };
  let started = false, textIndex = -1, thinkingIndex = -1;
  const start = () => { if (!started) { started = true; stream.push({ type: "start", partial: output }); } };
  const delta = (kind: "text" | "thinking", value: string) => {
    if (!value) return;
    start();
    let index = kind === "text" ? textIndex : thinkingIndex;
    if (index < 0) {
      output.content.push(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
      index = output.content.length - 1;
      if (kind === "text") textIndex = index; else thinkingIndex = index;
      stream.push({ type: kind === "text" ? "text_start" : "thinking_start", contentIndex: index, partial: output } as never);
    }
    const part = output.content[index] as any;
    if (part?.type !== kind) return;
    if (kind === "text") part.text += value; else part.thinking += value;
    stream.push({ type: kind === "text" ? "text_delta" : "thinking_delta", contentIndex: index, delta: value, partial: output } as never);
  };
  const endBlocks = () => {
    if (thinkingIndex >= 0) stream.push({ type: "thinking_end", contentIndex: thinkingIndex, content: (output.content[thinkingIndex] as any)?.thinking ?? "", partial: output } as never);
    if (textIndex >= 0) stream.push({ type: "text_end", contentIndex: textIndex, content: (output.content[textIndex] as any)?.text ?? "", partial: output } as never);
    thinkingIndex = -1; textIndex = -1;
  };

  void (async () => {
    let turn: AcpTurn | undefined;
    let unsubscribe: (() => void) | undefined;
    let wakeCalls: (() => void) | undefined;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const env = process.env;
      const transport = resolveTransport(env);
      const cwd = process.cwd();
      if (transport === "headless") { await forwardHeadless(stream, model, context, options); return; }
      if (transport === "auto" && !(await probeAcpSupport({ bin: agyBin(env), env, cwd, signal: options?.signal }))) {
        acpLog("agy acp --help failed or reported no ACP support; falling back to headless agy");
        await forwardHeadless(stream, model, context, options);
        return;
      }
      const tools = toolsFromContext(context);
      let session;
      try {
        session = await getAcpSession({ bin: agyBin(env), cwd, env, signal: options?.signal, tools, toolLoop: new AcpToolLoop() });
      } catch (error) {
        if (transport !== "auto") throw error;
        const cause = error instanceof Error ? error.message : String(error);
        acpLog(`ACP initialize failed: ${cleanAgyText(cause, 200)}; falling back to headless agy`);
        await forwardHeadless(stream, model, context, options);
        return;
      }
      session.toolLoop.setTools(tools);
      const window = session.contextWindow ?? contextWindowForModel(model);
      if (window && window > 0) { model.contextWindow = window; learnedContextWindows.set(model.id, window); }
      const thinkingMap = thinkingLevelMapFromOptions([...session.configOptions]);
      if (Object.values(thinkingMap).some(Boolean)) { model.thinkingLevelMap = thinkingMap; learnedEfforts.set(model.id, thinkingMap); }

      const existing = session.toolLoop.turn;
      // Keep a settled turn until its parked calls have been consumed: their toolResult still belongs to it.
      const freshTurn = !existing || (existing.settled && !existing.hasUnansweredCalls());
      turn = freshTurn ? session.toolLoop.startTurn() : existing;
      turn.step++;
      const step = turn.step;

      // Answer parked calls from the toolResult messages Pi appended after the previous step. A call whose toolCall
      // was emitted by an earlier step but has no result gets an error result, so agy is never left waiting.
      const answers = new Map<string, BridgeToolResult>();
      for (const message of context.messages) if ((message as any)?.role === "toolResult") answers.set(String((message as any).toolCallId), bridgeResultFrom(message));
      for (const call of turn.calls.values()) {
        if (call.answered) continue;
        const answer = answers.get(call.id);
        if (answer) call.resolve(answer);
        else if (call.step < step) call.resolve(toolError(`Pi tool result missing for ${call.name} (${call.id})`));
      }

      start();
      const handleUpdate = (update: TurnUpdate) => {
        turn!.consumed++;
        const content = update.content as { type?: string; text?: string } | undefined;
        if (update.sessionUpdate === "agent_message_chunk" && content?.type === "text") delta("text", content.text ?? "");
        else if (update.sessionUpdate === "agent_thought_chunk" && content?.type === "text") delta("thinking", content.text ?? "");
        // tool_call updates are not Pi tool blocks: the bridge's parked MCP call is the authoritative request.
      };
      unsubscribe = turn.subscribe(handleUpdate, turn.consumed);

      const callsDetected = new Promise<void>((resolve) => { wakeCalls = resolve; });
      turn.setCallHandler(() => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => wakeCalls?.(), PARALLEL_WINDOW_MS);
      });
      const aborted = new Promise<void>((resolve) => {
        if (options?.signal?.aborted) resolve();
        else if (options?.signal) {
          onAbort = () => resolve();
          options.signal.addEventListener("abort", onAbort, { once: true });
        }
      });
      const emitParkedCalls = (): number => {
        let emitted = 0;
        for (const call of turn!.calls.values()) {
          if (call.emitted || call.answered) continue;
          const block = { type: "toolCall" as const, id: call.id, name: call.name, arguments: call.arguments as any };
          const index = output.content.push(block) - 1;
          stream.push({ type: "toolcall_start", contentIndex: index, partial: output } as never);
          stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(call.arguments), partial: output } as never);
          stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output } as never);
          call.emitted = true;
          emitted++;
        }
        return emitted;
      };

      if (freshTurn) {
        const promptText = buildAcpPrompt(context.messages, session.isFresh);
        void session.prompt(promptText, { modelId: model.id, reasoning: options?.reasoning, signal: options?.signal, timeoutMs: options?.timeoutMs })
          .then((result) => turn!.settle({ stopReason: result.stopReason }), (error) => turn!.settle({ error }));
      }

      const outcome: { kind: "end"; result: { stopReason?: string; error?: unknown } } | { kind: "call" } | { kind: "abort" } = await Promise.race([
        turn.waitForEnd().then((result) => ({ kind: "end" as const, result })),
        callsDetected.then(() => ({ kind: "call" as const })),
        aborted.then(() => ({ kind: "abort" as const })),
      ]);
      if (debounce) clearTimeout(debounce);
      unsubscribe(); unsubscribe = undefined;
      if (onAbort && options?.signal) options.signal.removeEventListener("abort", onAbort);

      if (outcome.kind === "abort") {
        session.cancelTurn("ACP turn cancelled");
        emitParkedCalls();
        endBlocks();
        output.stopReason = "aborted";
        output.errorMessage = "ACP turn cancelled";
        stream.push({ type: "error", reason: "aborted", error: output });
        stream.end();
        return;
      }
      if (outcome.kind === "call") {
        if (!emitParkedCalls()) throw new Error("ACP tool call had no parked Pi tool call");
        endBlocks();
        output.stopReason = "toolUse";
        output.rawStopReason = "tool_use";
        stream.push({ type: "done", reason: "toolUse", message: output });
        stream.end();
        return;
      }
      const end = outcome.result;
      // agy finished before Pi ran a parked tool: still hand the tool to Pi so the transcript stays consistent.
      turn.failCalls(end.error ? "ACP turn failed" : "ACP turn ended before the tool result arrived");
      if (emitParkedCalls()) {
        endBlocks();
        output.stopReason = "toolUse";
        stream.push({ type: "done", reason: "toolUse", message: output });
        stream.end();
        return;
      }
      if (end.error) throw end.error;
      if (options?.signal?.aborted || end.stopReason === "cancelled") {
        endBlocks();
        output.stopReason = "aborted";
        output.errorMessage = "ACP turn cancelled";
        stream.push({ type: "error", reason: "aborted", error: output });
        stream.end();
        return;
      }
      // ACP can announce the real window on first inference (usage_update), after the pre-prompt configuration.
      if (session.contextWindow && session.contextWindow > 0) { model.contextWindow = session.contextWindow; learnedContextWindows.set(model.id, session.contextWindow); }
      if (session.lastUsage) output.usage = session.lastUsage;
      endBlocks();
      if (end.stopReason === "max_tokens" || end.stopReason === "max_output_tokens") { output.stopReason = "length"; output.rawStopReason = end.stopReason; }
      else if (end.stopReason === "refusal") throw new AgyError("failed", "agy refused this ACP turn");
      else if (end.stopReason === "end_turn" || end.stopReason === "stop") { output.stopReason = "stop"; output.rawStopReason = end.stopReason; }
      else throw new AgyError("protocol", `ACP ended the turn with an unknown stop reason: ${cleanAgyText(String(end.stopReason))}`);
      stream.push({ type: "done", reason: output.stopReason as "stop", message: output });
      stream.end();
    } catch (error) {
      unsubscribe?.();
      if (debounce) clearTimeout(debounce);
      if (turn) turn.failCalls("ACP turn failed");
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
}

function contextWindowForModel(model: Model<any>): number | undefined {
  return learnedContextWindows.get(model.id) ?? (model.contextWindow && model.contextWindow !== ASSUMED_CONTEXT_WINDOW ? model.contextWindow : undefined);
}

export { forwardHeadless };
