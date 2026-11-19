// One agy turn: spawn `agy -p ... --output-format stream-json`, translate its events into Pi stream events.
// agy runs its own agent loop and tools, so its tool steps are shown as read-only progress lines, never as Pi tool calls.
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Model, type SimpleStreamOptions, type TranscriptContext } from "@earendil-works/pi-ai";
import { AgyError, cleanAgyText, errorFromResult } from "./errors.ts";
import { PROVIDER_ID } from "./models.ts";
import { buildPrompt, knownConversations, PROGRESS_MARK } from "./prompt.ts";
import { runAgy } from "./process.ts";

export const MODES = ["accept-edits", "auto", "plan"] as const;
export const DEFAULT_TIMEOUT_MS = 30 * 60_000;

/** Pi thinking level -> agy `--effort`. Undefined means Pi sent none: agy keeps the model's own default. */
export function effortFor(level: string | undefined): string | undefined {
  switch (level) {
    case "off": case "minimal": case "low": return "low";
    case "medium": case "high": case "xhigh": case "max": return level;
    default: return undefined;
  }
}

export function buildArgs(input: { prompt: string; model: string; cwd: string; effort?: string; mode?: string; conversation?: string }): string[] {
  const args = ["-p", input.prompt, "--model", input.model, "--output-format", "stream-json"];
  if (input.effort) args.push("--effort", input.effort);
  if (input.mode) args.push("--mode", input.mode);
  if (input.conversation) args.push("--conversation", input.conversation);
  args.push("--add-dir", input.cwd);
  // Never --dangerously-skip-permissions: agy's own permission rules stay in force.
  return args;
}

function agyMode(env: Record<string, string | undefined>): string | undefined {
  const mode = env.STEAK_PI_AGY_MODE?.trim();
  if (!mode) return undefined;
  if (!(MODES as readonly string[]).includes(mode)) throw new AgyError("failed", `STEAK_PI_AGY_MODE must be one of ${MODES.join(", ")} (got "${cleanAgyText(mode, 40)}")`);
  return mode;
}

const emptyUsage = (): AssistantMessage["usage"] => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

interface RawUsage { input_tokens?: number; output_tokens?: number; thinking_tokens?: number; cache_read_tokens?: number; total_tokens?: number }
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** agy's input_tokens include the cached part; Pi's `input` does not. */
function addUsage(into: AssistantMessage["usage"], u: RawUsage) {
  const cached = n(u.cache_read_tokens);
  into.input += Math.max(0, n(u.input_tokens) - cached);
  into.cacheRead += cached;
  into.output += n(u.output_tokens);
  into.reasoning = (into.reasoning ?? 0) + n(u.thinking_tokens);
  into.totalTokens += n(u.total_tokens) || n(u.input_tokens) + n(u.output_tokens);
}

const PARAM_KEYS = ["CommandLine", "command", "AbsolutePath", "TargetFile", "path", "file", "Url", "url", "Query", "query", "pattern"];
export function progressLine(name: string, info: { parameters?: unknown; error?: { message?: unknown } } | undefined): string {
  const params = info?.parameters && typeof info.parameters === "object" ? (info.parameters as Record<string, unknown>) : {};
  const key = PARAM_KEYS.find((k) => typeof params[k] === "string");
  const detail = key ? String(params[key]) : Object.keys(params).length ? JSON.stringify(params) : "";
  const failed = info?.error ? ` (failed: ${cleanAgyText(String(info.error.message ?? "error"), 120)})` : "";
  const oneLine = cleanAgyText(detail.replace(/\s+/g, " "), 160);
  return `${PROGRESS_MARK}${cleanAgyText(name, 60) || "tool"}${oneLine ? `: ${oneLine}` : ""}${failed}`;
}

export function streamAgy(model: Model<any>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider || PROVIDER_ID, model: model.id, usage: emptyUsage(), stopReason: "pending", timestamp: Date.now() };
  let started = false, textIndex = -1;
  const start = () => { if (!started) { started = true; stream.push({ type: "start", partial: output }); } };
  const append = (delta: string) => {
    if (!delta) return;
    start();
    if (textIndex < 0) { output.content.push({ type: "text", text: "" }); textIndex = output.content.length - 1; stream.push({ type: "text_start", contentIndex: textIndex, partial: output }); }
    const block = output.content[textIndex];
    if (block.type !== "text") return;
    block.text += delta;
    stream.push({ type: "text_delta", contentIndex: textIndex, delta, partial: output });
  };
  const text = () => { const b = textIndex >= 0 ? output.content[textIndex] : undefined; return b?.type === "text" ? b.text : ""; };

  void (async () => {
    try {
      const env = process.env;
      const cwd = process.cwd();
      const built = buildPrompt(context.messages, model.id);
      const args = buildArgs({ prompt: built.prompt, model: model.id, cwd, effort: effortFor(options?.reasoning), mode: agyMode(env), conversation: built.conversation });
      const timeoutMs = options?.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : Number(env.STEAK_PI_AGY_TIMEOUT_MS) > 0 ? Number(env.STEAK_PI_AGY_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
      let result: Record<string, any> | undefined, conversationId: string | undefined, streamed = "", sawStepUsage = false;
      const seenTools = new Set<number>(), usedSteps = new Set<number>();
      const onLine = (line: string) => {
        let event: any;
        try { event = JSON.parse(line); } catch { return; }
        if (!event || typeof event !== "object") return;
        if (event.event === "init") conversationId = event.conversation_id ?? conversationId;
        else if (event.event === "step_update" && event.step_update) {
          const s = event.step_update;
          conversationId = s.conversation_id || conversationId;
          if (s.step_type === "agent_response" && typeof s.text_delta === "string") { streamed += s.text_delta; append(s.text_delta); }
          if (s.step_type === "tool" && typeof s.step_index === "number" && !seenTools.has(s.step_index) && (s.state === "DONE" || s.tool_info)) {
            // One line per step: at DONE, or earlier when the running step already names its parameters.
            seenTools.add(s.step_index);
            const cur = text();
            append(`${cur && !cur.endsWith("\n") ? "\n" : ""}${progressLine(s.tool_name ?? s.tool_info?.name ?? "tool", s.tool_info)}\n`);
          }
          if (s.state === "DONE" && s.usage && typeof s.step_index === "number" && !usedSteps.has(s.step_index)) { usedSteps.add(s.step_index); addUsage(output.usage, s.usage); sawStepUsage = true; }
        } else if (event.event === "result" && event.result) result = event.result;
      };
      const run = await runAgy({ args, cwd, env, signal: options?.signal, timeoutMs, onLine });
      if (run.aborted || options?.signal?.aborted) { output.stopReason = "aborted"; output.errorMessage = "agy run cancelled"; stream.push({ type: "error", reason: "aborted", error: output }); stream.end(); return; }
      if (run.timedOut) throw new AgyError("timeout", `agy timed out after ${Math.round(timeoutMs / 1000)} s and was stopped (set STEAK_PI_AGY_TIMEOUT_MS to change the limit)`);
      if (!result) {
        const err = cleanAgyText(run.stderr.split("\n").filter((l) => l.trim()).slice(-2).join(" "), 300);
        if (run.code === 0) throw new AgyError("protocol", "agy exited without a result event; its stream-json output was not as documented");
        const named = errorFromResult(run.stderr, model.id);
        throw named.kind === "failed" ? new AgyError("failed", `agy exited with code ${run.code} and no result${err ? `: ${err}` : ""}`) : named;
      }
      const id = (result.conversation_id as string) || conversationId;
      if (id) output.responseId = id;
      if (!sawStepUsage && result.usage) addUsage(output.usage, result.usage);
      output.rawStopReason = String(result.status);
      switch (result.status) {
        case "SUCCESS": break;
        case "ERROR": throw errorFromResult(String(result.error ?? ""), model.id);
        case "CANCELED": throw new AgyError("cancelled", "agy reported the run as CANCELED (not by Steak Pi's abort)");
        case "INTERRUPTED": throw new AgyError("interrupted", "agy reported the run as INTERRUPTED (it received an interrupt signal)");
        case "WAITING": throw new AgyError("failed", "agy stopped WAITING for input it cannot get in headless mode; allow the action in agy's settings (permissions.allow) or run it in agy directly");
        default: throw new AgyError("failed", `agy ended with status ${String(result.status)}${result.error ? `: ${cleanAgyText(String(result.error))}` : ""}`);
      }
      if (!streamed && typeof result.response === "string" && result.response) append(result.response);
      if (textIndex >= 0) stream.push({ type: "text_end", contentIndex: textIndex, content: text(), partial: output });
      start();
      output.stopReason = "stop";
      if (id) knownConversations.set(id, output.timestamp);
      stream.push({ type: "done", reason: "stop", message: output });
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
