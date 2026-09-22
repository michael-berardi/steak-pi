import { describe, expect, it, vi } from "vitest";
import { eligibleGoFallback, withOpenCodeGoRouting } from "../src/opencode-go-routing.ts";
const { createAssistantMessageEventStream } = await import(new URL("../node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
type Provider = Parameters<typeof withOpenCodeGoRouting>[0];
// Resolve the SDK's own pi-ai: 0.86 requires normalization before provider dispatch.
const { normalizeContext } = await import(/* @vite-ignore */ new URL(
  "../node_modules/@earendil-works/pi-ai/dist/index.js",
  import.meta.resolve("@earendil-works/pi-coding-agent"),
).href);
function emptyContext(): Parameters<Provider["streamSimple"]>[1] {
  // 0.85 accepts Context directly and does not export normalizeContext.
  const normalize = typeof normalizeContext === "function" ? normalizeContext : (context: { messages: never[] }) => context;
  return normalize({ messages: [] });
}

const primary = { id: "deepseek-v4.1-flash", provider: "opencode-go", api: "openai-completions" } as any;
const fallback = { ...primary, id: "glm-5.3-flash" };
const message = (model: any, errorMessage?: string) => ({ role: "assistant", content: [], provider: model.provider, model: model.id,
  api: model.api, timestamp: 1, stopReason: errorMessage ? "error" : "stop", errorMessage,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
function setup(error?: string, partial = false, fallbackError?: string) {
  const stream = vi.fn((model: any) => {
    const result = createAssistantMessageEventStream();
    const failure = model.id === primary.id ? error : fallbackError;
    const m = message(model, failure);
    result.push({ type: "start", partial: m });
    if (partial) result.push({ type: "text_start", contentIndex: 0, partial: m });
    result.push(failure ? { type: "error", reason: "error", error: m } : { type: "done", reason: "stop", message: m });
    result.end(); return result;
  });
  const provider = { id: "opencode-go", name: "Go", getModels: () => [primary, fallback], stream, streamSimple: stream } as unknown as Provider;
  return { wrapped: withOpenCodeGoRouting(provider), stream };
}
describe("authorized OpenCode Go routing", () => {
  it("keeps success on primary and sets stable per-conversation headers", async () => {
    const { wrapped, stream } = setup();
    for (const sessionId of ["one", "one", "two"]) {
      expect((await wrapped.streamSimple(primary, emptyContext(), { sessionId }).result()).model).toBe(primary.id);
    }
    expect(stream.mock.calls.map((call: any) => call[2].headers["x-opencode-session"])).toEqual(["one", "one", "two"]);
    expect((stream.mock.calls[0] as any)[2].headers["User-Agent"]).toContain("UltraTerm");
  });
  it("fails closed without a session id", () => {
    const { wrapped, stream } = setup();
    expect(() => wrapped.streamSimple(primary, emptyContext())).toThrow("sessionId"); expect(stream).not.toHaveBeenCalled();
  });
  it.each(["429 rate limit", "503 Service Unavailable", "temporarily overloaded"])("falls back once for %s", async (error) => {
    const { wrapped, stream } = setup(error);
    const result = await wrapped.streamSimple(primary, emptyContext(), { sessionId: "one" }).result();
    expect(result.model).toBe(fallback.id); expect(stream).toHaveBeenCalledTimes(2);
  });
  it.each(["401 auth failed", "403 RegionError", "400 invalid context", "404 model unavailable", "cancelled", "unknown failure"])("does not retry %s", async (error) => {
    const { wrapped, stream } = setup(error);
    expect((await wrapped.streamSimple(primary, emptyContext(), { sessionId: "one" }).result()).stopReason).toBe("error");
    expect(stream).toHaveBeenCalledTimes(1);
  });
  it("never retries after content starts", async () => {
    const { wrapped, stream } = setup("503", true);
    await wrapped.streamSimple(primary, emptyContext(), { sessionId: "one" }).result(); expect(stream).toHaveBeenCalledTimes(1);
  });
  it("does not retry an aborted request", async () => {
    const { wrapped, stream } = setup("503"); const controller = new AbortController(); controller.abort();
    await wrapped.streamSimple(primary, emptyContext(), { sessionId: "one", signal: controller.signal }).result();
    expect(stream).toHaveBeenCalledTimes(1);
  });
  it("does not loop after fallback failure", async () => {
    const { wrapped, stream } = setup("503", false, "429");
    const result = await wrapped.streamSimple(primary, emptyContext(), { sessionId: "one" }).result();
    expect(result.model).toBe(fallback.id); expect(result.stopReason).toBe("error"); expect(stream).toHaveBeenCalledTimes(2);
  });
  it("never treats permission errors with transient wording as eligible", () => expect(eligibleGoFallback("403 temporarily unavailable region")).toBe(false));
  it("leaves an exhausted plan to the outer chain instead of retrying the same plan", async () => {
    // Same-plan retry cannot succeed on exhaustion, so it stays ineligible here;
    // the ordered chain may leave the plan for a separately approved route.
    expect(eligibleGoFallback("subscription_quota_exceeded")).toBe(false);
    const { wrapped, stream } = setup("subscription_quota_exceeded");
    const result = await wrapped.streamSimple(primary, emptyContext(), { sessionId: "one" }).result();
    expect(result.model).toBe(primary.id);
    expect(result.stopReason).toBe("error");
    expect(stream).toHaveBeenCalledTimes(1);
  });
});
