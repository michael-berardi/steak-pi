// Translate one ACP prompt turn into Pi stream events. Text and thinking stream as they arrive; tool calls run inside
// agy's turn but are executed by Pi through the MCP bridge, which emits the normal Pi tool_call/tool_result events.
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Model, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { AgyError, cleanAgyText } from "../errors.ts";
import { agyBin } from "../process.ts";
import { ASSUMED_CONTEXT_WINDOW } from "../models.ts";
import { PROMPT_MAX_BYTES, tailBytes } from "../prompt.ts";
import { streamAgy } from "../stream.ts";
import { learnedContextWindows, learnedEfforts, thinkingLevelMapFromOptions } from "./options.ts";
import { getAcpSession, type TurnUpdate } from "./session.ts";
import { acpLog, probeAcpSupport, resolveTransport } from "./transport.ts";

const byteLength = (s: string) => Buffer.byteLength(s, "utf8");
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part: any) => part?.type === "text" ? part.text : part?.type === "thinking" ? part.thinking : "").filter(Boolean).join("\n");
  return "";
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

  void (async () => {
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
      let session;
      try {
        session = await getAcpSession({ bin: agyBin(env), cwd, env, signal: options?.signal });
      } catch (error) {
        if (transport !== "auto") throw error;
        const cause = error instanceof Error ? error.message : String(error);
        acpLog(`ACP initialize failed: ${cleanAgyText(cause, 200)}; falling back to headless agy`);
        await forwardHeadless(stream, model, context, options);
        return;
      }
      const window = session.contextWindow ?? contextWindowForModel(model);
      if (window && window > 0) { model.contextWindow = window; learnedContextWindows.set(model.id, window); }
      const thinkingMap = thinkingLevelMapFromOptions([...session.configOptions]);
      if (Object.values(thinkingMap).some(Boolean)) { model.thinkingLevelMap = thinkingMap; learnedEfforts.set(model.id, thinkingMap); }

      start();
      const onUpdate = (update: TurnUpdate) => {
        const content = update.content as { type?: string; text?: string } | undefined;
        if (update.sessionUpdate === "agent_message_chunk" && content?.type === "text") delta("text", content.text ?? "");
        else if (update.sessionUpdate === "agent_thought_chunk" && content?.type === "text") delta("thinking", content.text ?? "");
        // tool_call / tool_call_update are deliberately not emitted as Pi toolcall blocks: the bridge has already
        // run the tool through ctx.executeTool(), so Pi's own tool events carry it. Emitting a block would run it twice.
      };
      const result = await session.prompt(buildAcpPrompt(context.messages, session.isFresh), {
        modelId: model.id,
        reasoning: options?.reasoning,
        signal: options?.signal,
        onUpdate,
      });
      if (options?.signal?.aborted || result.stopReason === "cancelled") {
        output.stopReason = "aborted";
        output.errorMessage = "ACP turn cancelled";
        stream.push({ type: "error", reason: "aborted", error: output });
        stream.end();
        return;
      }
      // ACP can announce the real window on first inference (usage_update), after the pre-prompt configuration.
      if (session.contextWindow && session.contextWindow > 0) { model.contextWindow = session.contextWindow; learnedContextWindows.set(model.id, session.contextWindow); }
      if (session.lastUsage) output.usage = session.lastUsage;
      if (thinkingIndex >= 0) {
        const part = output.content[thinkingIndex] as { thinking?: string } | undefined;
        stream.push({ type: "thinking_end", contentIndex: thinkingIndex, content: part?.thinking ?? "", partial: output } as never);
      }
      if (textIndex >= 0) {
        const part = output.content[textIndex] as { text?: string } | undefined;
        stream.push({ type: "text_end", contentIndex: textIndex, content: part?.text ?? "", partial: output } as never);
      }
      if (result.stopReason === "max_tokens" || result.stopReason === "max_output_tokens") { output.stopReason = "length"; output.rawStopReason = result.stopReason; }
      else if (result.stopReason === "refusal") throw new AgyError("failed", "agy refused this ACP turn");
      else if (result.stopReason === "end_turn" || result.stopReason === "stop") { output.stopReason = "stop"; output.rawStopReason = result.stopReason; }
      else throw new AgyError("protocol", `ACP ended the turn with an unknown stop reason: ${cleanAgyText(result.stopReason)}`);
      stream.push({ type: "done", reason: output.stopReason as "stop", message: output });
      stream.end();
    } catch (error) {
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
