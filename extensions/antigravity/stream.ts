// Streaming one turn: request out, Server-Sent Events back, Pi events up. Text, thinking and tool calls are separate
// blocks; a tool call whose arguments arrive in pieces is assembled and only ends when the provider says it is complete.
import { calculateCost, createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Model, type SimpleStreamOptions, type StopReason, type ToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { call, type Session } from "./client.ts";
import type { AntigravityConfig } from "./config.ts";
import { AntigravityError, providerMessage } from "./errors.ts";
import { parseKey } from "./oauth.ts";
import { buildRequest } from "./request.ts";

function emptyUsage(): AssistantMessage["usage"] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

const STOP: Record<string, StopReason> = { STOP: "stop", MAX_TOKENS: "length" };

interface Part { text?: string; thought?: boolean; thoughtSignature?: string; functionCall?: { id?: string; name?: string; args?: unknown; willContinue?: boolean } }
interface Chunk {
  response?: Chunk;
  error?: { code?: number; message?: string; status?: string };
  candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; cachedContentTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number; totalTokenCount?: number };
  modelVersion?: string;
  responseId?: string;
}

const asArgs = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** Turns provider chunks into Pi stream events. Exported so the mapping is testable without a network. */
export class Translator {
  private current?: { type: "text" | "thinking"; index: number };
  private pending?: { index: number; call: ToolCall };
  finishReason?: string;
  sawContent = false;

  constructor(private model: Model<any>, readonly output: AssistantMessage, private stream: AssistantMessageEventStream) {}

  private started = false;
  private start() { if (!this.started) { this.started = true; this.stream.push({ type: "start", partial: this.output }); } }

  private closeCurrent() {
    const cur = this.current;
    if (!cur) return;
    const block = this.output.content[cur.index];
    if (block.type === "text") this.stream.push({ type: "text_end", contentIndex: cur.index, content: block.text, partial: this.output });
    else if (block.type === "thinking") this.stream.push({ type: "thinking_end", contentIndex: cur.index, content: block.thinking, partial: this.output });
    this.current = undefined;
  }

  private closePending() {
    const p = this.pending;
    if (!p) return;
    this.stream.push({ type: "toolcall_end", contentIndex: p.index, toolCall: p.call, partial: this.output });
    this.pending = undefined;
  }

  private text(part: Part) {
    const type = part.thought === true ? "thinking" : "text";
    this.closePending();
    if (!this.current || this.current.type !== type) {
      this.closeCurrent();
      this.output.content.push(type === "thinking" ? { type: "thinking", thinking: "" } : { type: "text", text: "" });
      this.current = { type, index: this.output.content.length - 1 };
      this.start();
      this.stream.push({ type: type === "thinking" ? "thinking_start" : "text_start", contentIndex: this.current.index, partial: this.output });
    }
    const block = this.output.content[this.current.index];
    const delta = part.text ?? "";
    if (block.type === "thinking") { block.thinking += delta; if (part.thoughtSignature) block.thinkingSignature = part.thoughtSignature; }
    else if (block.type === "text") { block.text += delta; if (part.thoughtSignature) block.textSignature = part.thoughtSignature; }
    this.stream.push({ type: type === "thinking" ? "thinking_delta" : "text_delta", contentIndex: this.current.index, delta, partial: this.output });
  }

  private functionCall(part: Part) {
    const fc = part.functionCall!;
    this.closeCurrent();
    const piece = asArgs(fc.args);
    let pending = this.pending;
    // A continuation carries the id of the call it extends (or none): its pieces merge into the call in progress.
    if (!pending || (fc.id !== undefined && fc.id !== pending.call.id)) {
      this.closePending();
      if (typeof fc.name !== "string" || !fc.name) throw new AntigravityError("protocol", "Antigravity sent a tool call with no name");
      const call: ToolCall = { type: "toolCall", id: fc.id ?? `call_${this.output.content.length}`, name: fc.name, arguments: {}, ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}) };
      this.output.content.push(call);
      pending = { index: this.output.content.length - 1, call };
      this.pending = pending;
      this.start();
      this.stream.push({ type: "toolcall_start", contentIndex: pending.index, partial: this.output });
    }
    Object.assign(pending.call.arguments, piece);
    if (Object.keys(piece).length) this.stream.push({ type: "toolcall_delta", contentIndex: pending.index, delta: JSON.stringify(piece), partial: this.output });
    if (fc.willContinue !== true) this.closePending();
  }

  chunk(raw: Chunk) {
    if (raw.error) {
      const status = typeof raw.error.code === "number" ? raw.error.code : undefined;
      const quota = status === 429 || raw.error.status === "RESOURCE_EXHAUSTED";
      throw new AntigravityError(quota ? "rate-limited" : "http", `Antigravity reported an error mid-stream${status ? ` (${status})` : ""}: ${providerMessage(JSON.stringify({ error: raw.error }))}`, { status });
    }
    const data = raw.response ?? raw;
    if (data.modelVersion) this.output.responseModel = data.modelVersion;
    if (data.responseId) this.output.responseId = data.responseId;
    const candidate = data.candidates?.[0];
    for (const part of candidate?.content?.parts ?? []) {
      if (part.functionCall) { this.sawContent = true; this.functionCall(part); }
      else if (part.text !== undefined) { this.sawContent = true; this.text(part); }
    }
    if (candidate?.finishReason) this.finishReason = candidate.finishReason;
    const u = data.usageMetadata;
    if (u) {
      const cached = u.cachedContentTokenCount ?? 0;
      const thoughts = u.thoughtsTokenCount ?? 0;
      const usage = this.output.usage;
      usage.input = (u.promptTokenCount ?? 0) - cached;
      usage.cacheRead = cached;
      usage.output = (u.candidatesTokenCount ?? 0) + thoughts;
      usage.reasoning = thoughts;
      usage.totalTokens = u.totalTokenCount ?? usage.input + usage.output + cached;
      calculateCost(this.model, usage);
    }
  }

  /** Close open blocks and settle the stop reason. Throws a named error when the stream ended without a finish reason. */
  finish() {
    this.closeCurrent();
    this.closePending();
    if (!this.finishReason) throw new AntigravityError("protocol", `Antigravity ended the stream without a finish reason${this.sawContent ? " after a partial reply" : " and without any reply"}; the connection was probably cut. Try again`);
    this.output.rawStopReason = this.finishReason;
    const hasTool = this.output.content.some((b) => b.type === "toolCall");
    const mapped = STOP[this.finishReason];
    if (mapped) this.output.stopReason = hasTool && mapped === "stop" ? "toolUse" : mapped;
    else {
      this.output.stopReason = "error";
      this.output.errorMessage = `Antigravity stopped the reply with "${this.finishReason}" (not a normal end)`;
    }
    this.start();
  }
}

/** Split an SSE byte stream into JSON data payloads. A line that is not valid JSON is a named error, never skipped. */
export async function* sseData(chunks: AsyncIterable<Buffer>): AsyncGenerator<Chunk> {
  let buffer = "";
  const decoder = new TextDecoder();
  const lines = function* (final: boolean) {
    let at: number;
    while ((at = buffer.indexOf("\n")) >= 0) { yield buffer.slice(0, at).replace(/\r$/, ""); buffer = buffer.slice(at + 1); }
    if (final && buffer) { yield buffer; buffer = ""; }
  };
  const parse = (line: string): Chunk | undefined => {
    if (!line.startsWith("data:")) return undefined;
    const json = line.slice(5).trim();
    if (!json || json === "[DONE]") return undefined;
    try { return JSON.parse(json) as Chunk; }
    catch { throw new AntigravityError("protocol", "Antigravity sent a stream event that is not valid JSON"); }
  };
  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    for (const line of lines(false)) { const parsed = parse(line); if (parsed) yield parsed; }
  }
  buffer += decoder.decode();
  for (const line of lines(true)) { const parsed = parse(line); if (parsed) yield parsed; }
}

export function createStream(config: AntigravityConfig) {
  return function streamAntigravity(model: Model<any>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    const output: AssistantMessage = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: emptyUsage(), stopReason: "pending", timestamp: Date.now() };
    void (async () => {
      try {
        const session: Session = parseKey(options?.apiKey);
        const built = buildRequest(model, context, session.projectId, options);
        const replaced = await options?.onPayload?.(built.envelope, model);
        const payload = replaced === undefined ? built.envelope : replaced;
        const reply = await call(config, session, "/v1internal:streamGenerateContent?alt=sse", payload, "stream", { signal: options?.signal, timeoutMs: options?.timeoutMs });
        await options?.onResponse?.({ status: reply.status, headers: Object.fromEntries(Object.entries(reply.headers).flatMap(([k, v]) => typeof v === "string" ? [[k, v]] : Array.isArray(v) ? [[k, v.join(", ")]] : [])) }, model);
        const translator = new Translator(model, output, stream);
        for await (const data of sseData(reply.chunks())) {
          await options?.onProviderStreamEvent?.(data, model);
          translator.chunk(data);
        }
        translator.finish();
        if (output.stopReason === "error") throw new AntigravityError("protocol", output.errorMessage ?? "Antigravity ended with an error");
        stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
        stream.end();
      } catch (error) {
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = options?.signal?.aborted ? "Antigravity request aborted" : error instanceof Error ? error.message : String(error);
        stream.push({ type: "error", reason: output.stopReason, error: output });
        stream.end();
      }
    })();
    return stream;
  };
}
