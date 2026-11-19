import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AssistantMessage, Model, TranscriptContext } from "@earendil-works/pi-ai";
import { listModels, modelFromEntry } from "../../extensions/antigravity/models.ts";
import { createStream } from "../../extensions/antigravity/stream.ts";
import { sessionKey, json, sse, startFake, testConfig, type Fake } from "./fixture.ts";

let fake: Fake;
beforeEach(async () => { fake = await startFake(); });
afterEach(() => fake.close());

const STREAM = "/v1internal:streamGenerateContent";
const LIST = "/v1internal:fetchAvailableModels";

function model(overrides: Partial<Model<any>> = {}): Model<any> {
  return { id: "m-one", name: "M One", api: "antigravity-cloud-code", provider: "antigravity", baseUrl: fake.url, input: ["text", "image"], reasoning: true, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4_000, ...overrides } as Model<any>;
}
const user = (content: unknown) => ({ role: "user", content, timestamp: 1 });
const ctx = (messages: unknown[], tools: unknown[] = [], system = "Be brief."): TranscriptContext =>
  ({ messages: [{ role: "system", content: system, toolsAdded: tools, timestamp: 0 }, ...messages] }) as never;

async function run(config: ReturnType<typeof testConfig>, m: Model<any>, context: TranscriptContext, options: Record<string, unknown> = {}) {
  const stream = createStream(config)(m, context, { apiKey: sessionKey(), ...options } as never);
  const events: { type: string; [k: string]: unknown }[] = [];
  for await (const event of stream) events.push(event as never);
  const last = events[events.length - 1];
  const message = (last.type === "done" ? last.message : last.error) as AssistantMessage;
  return { events, message, types: events.map((e) => e.type) };
}
const chunk = (parts: unknown[], extra: Record<string, unknown> = {}) => ({ response: { candidates: [{ content: { parts }, ...extra }], modelVersion: "served-1" } });

describe("antigravity model list", () => {
  it("builds the list from the provider's reply and drops what is not a chat model", async () => {
    fake.on(LIST, (req, res) => json(res, 200, { models: {
      "alpha": { displayName: "Alpha", maxTokens: 200000, maxOutputTokens: 16000, supportsThinking: true, supportsImages: true },
      "beta": { supportsThinking: false },
      "gamma-image": {}, "chat_internal": {}, "MODEL_PLACEHOLDER_1": {}, "off": { disabled: true }, "bad id": {},
    } }));
    const models = await listModels(testConfig(fake), { token: "t", projectId: "p-1" });
    expect(models.map((m) => m.id)).toEqual(["alpha", "beta"]);
    expect(models[0]).toMatchObject({ name: "Alpha", reasoning: true, input: ["text", "image"], contextWindow: 200000, maxTokens: 16000, provider: "antigravity" });
    expect(models[1]).toMatchObject({ name: "beta", reasoning: false, input: ["text"] });
    expect(JSON.parse(fake.seen[0].body)).toEqual({ project: "p-1" });
  });

  it("names an empty or malformed list instead of registering nothing quietly", async () => {
    fake.on(LIST, (req, res) => json(res, 200, { models: {} }));
    await expect(listModels(testConfig(fake), { token: "t", projectId: "p" })).rejects.toThrow(/no usable chat models/);
    fake.on(LIST, (req, res) => json(res, 200, { nope: 1 }));
    await expect(listModels(testConfig(fake), { token: "t", projectId: "p" })).rejects.toThrow(/no `models` object/);
  });

  it("a model entry that names no limits gets the documented assumed ones", () => {
    expect(modelFromEntry(testConfig(fake), "x", {})).toMatchObject({ contextWindow: 128_000, maxTokens: 8_192 });
  });
});

describe("antigravity streamed turn", () => {
  it("streams thinking, text, a tool call in pieces and usage, and maps them to Pi events", async () => {
    fake.on(STREAM, (req, res) => sse(res, [
      chunk([{ text: "Let me ", thought: true }]),
      chunk([{ text: "think.", thought: true, thoughtSignature: "sig-think" }]),
      chunk([{ text: "Hello " }]),
      chunk([{ text: "there." }]),
      chunk([{ functionCall: { id: "c1", name: "read", args: { path: "a.txt" }, willContinue: true } }]),
      chunk([{ functionCall: { id: "c1", args: { limit: 5 }, willContinue: true } }]),
      chunk([{ functionCall: { id: "c1", args: { offset: 2 } } }]),
      chunk([{ functionCall: { name: "write", args: { path: "b.txt" } }, thoughtSignature: "sig-call" }], { finishReason: "STOP" }),
      { response: { usageMetadata: { promptTokenCount: 120, cachedContentTokenCount: 20, candidatesTokenCount: 30, thoughtsTokenCount: 10, totalTokenCount: 160 } } },
    ]));
    const tools = [{ name: "read", description: "Read", parameters: { type: "object", properties: { path: { type: "string" } } } }];
    const { events, message, types } = await run(testConfig(fake), model(), ctx([user("hi")], tools), { reasoning: "medium", onPayload: undefined });
    expect(types[0]).toBe("start");
    expect(types.at(-1)).toBe("done");
    expect(message.content.map((b) => b.type)).toEqual(["thinking", "text", "toolCall", "toolCall"]);
    expect(message.content[0]).toMatchObject({ thinking: "Let me think.", thinkingSignature: "sig-think" });
    expect(message.content[1]).toMatchObject({ text: "Hello there." });
    expect(message.content[2]).toMatchObject({ id: "c1", name: "read", arguments: { path: "a.txt", limit: 5, offset: 2 } });
    expect(message.content[3]).toMatchObject({ name: "write", arguments: { path: "b.txt" }, thoughtSignature: "sig-call" });
    // Pieces arrive as separate deltas; a call ends only when the provider says it is complete.
    const deltas = events.filter((e) => e.type === "toolcall_delta" && e.contentIndex === 2);
    expect(deltas).toHaveLength(3);
    expect(events.filter((e) => e.type === "toolcall_end")).toHaveLength(2);
    expect(message.stopReason).toBe("toolUse");
    expect(message.rawStopReason).toBe("STOP");
    expect(message.responseModel).toBe("served-1");
    expect(message.usage).toMatchObject({ input: 100, cacheRead: 20, output: 40, reasoning: 10, totalTokens: 160 });
    // Block events are balanced.
    for (const kind of ["thinking", "text"]) expect(types.filter((t) => t === `${kind}_start`)).toHaveLength(types.filter((t) => t === `${kind}_end`).length);
  });

  it("sends the request envelope: project, model, system, tools, thinking, limits, and the configured agent", async () => {
    fake.on(STREAM, (req, res) => sse(res, [chunk([{ text: "ok" }], { finishReason: "STOP" })]));
    const tools = [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }];
    const seenPayloads: unknown[] = [];
    await run(testConfig(fake), model(), ctx([user("hi")], tools), { reasoning: "high", maxTokens: 9_999, temperature: 0.2, toolChoice: "none", sessionId: "s-1", onPayload: (p: unknown) => { seenPayloads.push(p); } });
    const request = fake.seen[0];
    expect(request.url).toBe(`${STREAM}?alt=sse`);
    expect(request.headers.authorization).toBe("Bearer tok-live-1");
    expect(request.headers["user-agent"]).toMatch(/^steak-pi-antigravity\//);
    const body = JSON.parse(request.body);
    expect(seenPayloads).toHaveLength(1);
    expect(body).toMatchObject({ project: "proj-1", model: "m-one", requestType: "agent" });
    expect(body.request.systemInstruction.parts[0].text).toBe("Be brief.");
    expect(body.request.generationConfig).toMatchObject({ temperature: 0.2, maxOutputTokens: 4_000, thinkingConfig: { includeThoughts: true, thinkingBudget: 16384 } });
    expect(body.request.tools[0].functionDeclarations[0]).toMatchObject({ name: "read", description: "Read a file" });
    expect(body.request.toolConfig).toEqual({ functionCallingConfig: { mode: "NONE" } });
    expect(body.request.contents).toEqual([{ role: "user", parts: [{ text: "hi" }] }]);
  });

  it("replays history: signed thinking, tool calls, one user turn for a round of tool results, images in results", async () => {
    fake.on(STREAM, (req, res) => sse(res, [chunk([{ text: "ok" }], { finishReason: "STOP" })]));
    const messages = [
      user("go"),
      { role: "assistant", stopReason: "toolUse", content: [{ type: "thinking", thinking: "hm", thinkingSignature: "s1" }, { type: "thinking", thinking: "foreign" }, { type: "toolCall", id: "a", name: "t1", arguments: { x: 1 }, thoughtSignature: "s2" }, { type: "toolCall", id: "b", name: "t2", arguments: {} }], timestamp: 2 },
      { role: "toolResult", toolCallId: "a", toolName: "t1", content: [{ type: "text", text: "A" }], isError: false, timestamp: 3 },
      { role: "toolResult", toolCallId: "b", toolName: "t2", content: [{ type: "text", text: "boom" }, { type: "image", data: "QQ==", mimeType: "image/png" }], isError: true, timestamp: 4 },
      { role: "assistant", stopReason: "error", content: [{ type: "text", text: "half" }], timestamp: 5 },
    ];
    await run(testConfig(fake), model(), ctx(messages));
    const contents = JSON.parse(fake.seen[0].body).request.contents;
    expect(contents).toEqual([
      { role: "user", parts: [{ text: "go" }] },
      { role: "model", parts: [{ text: "hm", thought: true, thoughtSignature: "s1" }, { functionCall: { id: "a", name: "t1", args: { x: 1 } }, thoughtSignature: "s2" }, { functionCall: { id: "b", name: "t2", args: {} } }] },
      { role: "user", parts: [{ functionResponse: { id: "a", name: "t1", response: { output: "A" } } }, { functionResponse: { id: "b", name: "t2", response: { error: "boom" } } }, { inlineData: { mimeType: "image/png", data: "QQ==" } }] },
    ]);
  });

  it("sends an image-bearing turn as inlineData, and refuses one for a text-only model with a named error before any request", async () => {
    fake.on(STREAM, (req, res) => sse(res, [chunk([{ text: "a cat" }], { finishReason: "STOP" })]));
    const turn = [user([{ type: "text", text: "what is this" }, { type: "image", data: "aGk=", mimeType: "image/jpeg" }])];
    const ok = await run(testConfig(fake), model(), ctx(turn));
    expect(ok.message.stopReason).toBe("stop");
    expect(JSON.parse(fake.seen[0].body).request.contents[0].parts).toEqual([{ text: "what is this" }, { inlineData: { mimeType: "image/jpeg", data: "aGk=" } }]);
    fake.seen.length = 0;
    const refused = await run(testConfig(fake), model({ input: ["text"] }), ctx(turn));
    expect(refused.message.stopReason).toBe("error");
    expect(refused.message.errorMessage).toMatch(/does not accept images/);
    expect(fake.seen).toHaveLength(0);
  });

  it("refuses thinking on a model the provider lists without it", async () => {
    const r = await run(testConfig(fake), model({ reasoning: false }), ctx([user("hi")]), { reasoning: "low" });
    expect(r.message.errorMessage).toMatch(/does not support thinking/);
    expect(fake.seen).toHaveLength(0);
  });

  it("maps stop reasons: length, and a refusal-type reason is a named error", async () => {
    fake.on(STREAM, (req, res) => sse(res, [chunk([{ text: "cut" }], { finishReason: "MAX_TOKENS" })]));
    expect((await run(testConfig(fake), model(), ctx([user("hi")]))).message.stopReason).toBe("length");
    fake.on(STREAM, (req, res) => sse(res, [chunk([], { finishReason: "SAFETY" })]));
    const r = await run(testConfig(fake), model(), ctx([user("hi")]));
    expect(r.message.stopReason).toBe("error");
    expect(r.message.errorMessage).toMatch(/"SAFETY"/);
  });

  it("a stream that ends without a finish reason is a named error, not a quiet success", async () => {
    fake.on(STREAM, (req, res) => sse(res, [chunk([{ text: "part" }])]));
    const r = await run(testConfig(fake), model(), ctx([user("hi")]));
    expect(r.message.stopReason).toBe("error");
    expect(r.message.errorMessage).toMatch(/without a finish reason after a partial reply/);
  });

  it("an error event inside the stream is named, with its status", async () => {
    fake.on(STREAM, (req, res) => sse(res, [{ error: { code: 500, message: "internal glitch" } }]));
    const r = await run(testConfig(fake), model(), ctx([user("hi")]));
    expect(r.message.errorMessage).toMatch(/mid-stream \(500\).*internal glitch/);
  });

  it("a signed-out turn names the sign-in step", async () => {
    const stream = createStream(testConfig(fake))(model(), ctx([user("hi")]), {} as never);
    const events = []; for await (const e of stream) events.push(e);
    expect((events.at(-1) as { error: AssistantMessage }).error.errorMessage).toMatch(/No Antigravity sign-in.*\/login antigravity/);
  });
});

describe("antigravity failures", () => {
  it("401: refreshes once, retries with the new token, and succeeds", async () => {
    fake.on("/token", (req, res) => json(res, 200, { access_token: "tok-new", expires_in: 3600 }));
    fake.on(STREAM, (req, res, n) => n === 1 ? json(res, 401, { error: { message: "token expired" } }) : sse(res, [chunk([{ text: "ok" }], { finishReason: "STOP" })]));
    const r = await run(testConfig(fake), model(), ctx([user("hi")]), { apiKey: sessionKey({ refresh: "ref-1" }) });
    expect(r.message.stopReason).toBe("stop");
    const streams = fake.seen.filter((s) => s.url.startsWith(STREAM));
    expect(streams.map((s) => s.headers.authorization)).toEqual(["Bearer tok-live-1", "Bearer tok-new"]);
    expect(fake.seen.filter((s) => s.url === "/token")).toHaveLength(1);
  });

  it("401 again after the one refresh is a named expiry (no second refresh)", async () => {
    fake.on("/token", (req, res) => json(res, 200, { access_token: "tok-new", expires_in: 3600 }));
    fake.on(STREAM, (req, res) => json(res, 401, { error: { message: "token expired" } }));
    const r = await run(testConfig(fake), model(), ctx([user("hi")]), { apiKey: sessionKey({ refresh: "ref-1" }) });
    expect(r.message.errorMessage).toMatch(/rejected the access token \(HTTP 401.*even after one refresh.*\/login antigravity/);
    expect(fake.seen.filter((s) => s.url === "/token")).toHaveLength(1);
    expect(fake.seen.filter((s) => s.url.startsWith(STREAM))).toHaveLength(2);
    expect(r.message.errorMessage).not.toMatch(/tok-/);
  });

  it("401 without a refresh token is a named expiry at once", async () => {
    fake.on(STREAM, (req, res) => json(res, 401, { error: { message: "expired" } }));
    const r = await run(testConfig(fake), model(), ctx([user("hi")]));
    expect(r.message.errorMessage).toMatch(/rejected the access token.*\/login antigravity/);
    expect(fake.seen).toHaveLength(1);
  });

  it("429 with Retry-After: waits the stated time (bounded), then succeeds", async () => {
    const waits: number[] = [];
    fake.on(STREAM, (req, res, n) => n === 1 ? json(res, 429, { error: { message: "Rate limit, slow down" } }, { "Retry-After": "2" }) : sse(res, [chunk([{ text: "ok" }], { finishReason: "STOP" })]));
    const { call } = await import("../../extensions/antigravity/client.ts");
    const reply = await call(testConfig(fake), { token: "t", projectId: "p" }, `${STREAM}?alt=sse`, {}, "stream", { sleep: async (ms) => { waits.push(ms); } });
    expect(reply.status).toBe(200);
    expect(waits).toEqual([2000]);
    reply.destroy();
  });

  it("429 whose wait is longer than the bound fails at once with when to retry", async () => {
    const waits: number[] = [];
    fake.on(STREAM, (req, res) => json(res, 429, { error: { message: "Individual quota reached. Resets in 2h3m" } }, { "Retry-After": "7380" }));
    const r = await run(testConfig(fake), model(), ctx([user("hi")]));
    expect(r.message.errorMessage).toMatch(/quota reached \(HTTP 429\).*retry in 2 h 3 min/);
    expect(waits).toEqual([]);
    expect(fake.seen).toHaveLength(1);
  });

  it("429 that keeps coming is retried only the configured number of times, then named", async () => {
    const waits: number[] = [];
    fake.on(STREAM, (req, res) => json(res, 429, { error: { message: "Too many requests" } }, { "Retry-After": "1" }));
    const { call } = await import("../../extensions/antigravity/client.ts");
    const error = await call(testConfig(fake, { maxRateLimitRetries: 2 }), { token: "t", projectId: "p" }, STREAM, {}, "stream", { sleep: async (ms) => { waits.push(ms); } }).catch((e) => e);
    expect(error.code).toBe("rate-limited");
    expect(error.message).toMatch(/rate limit \(HTTP 429 after 2 bounded waits\).*retry in 1 s/);
    expect(error.retryAfterMs).toBe(1000);
    expect(waits).toEqual([1000, 1000]);
    expect(fake.seen).toHaveLength(3);
  });

  it("429 with no retry time says so", async () => {
    fake.on(STREAM, (req, res) => json(res, 429, { error: { message: "Resource has been exhausted" } }));
    const r = await run(testConfig(fake), model(), ctx([user("hi")]));
    expect(r.message.errorMessage).toMatch(/the provider gave no retry time/);
  });

  it("a wait for a rate limit can be cancelled", async () => {
    const controller = new AbortController();
    fake.on(STREAM, (req, res) => json(res, 429, { error: { message: "Rate limit" } }, { "Retry-After": "4" }));
    const pending = run(testConfig(fake), model(), ctx([user("hi")]), { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const r = await pending;
    expect(r.message.stopReason).toBe("aborted");
  });

  it("403 and 404 are named with their cause", async () => {
    fake.on(STREAM, (req, res) => json(res, 403, { error: { message: "Verify your account" } }));
    expect((await run(testConfig(fake), model(), ctx([user("hi")]))).message.errorMessage).toMatch(/refused access \(HTTP 403: Verify your account\)/);
    fake.on(STREAM, (req, res) => json(res, 404, { error: { message: "Requested entity was not found" } }));
    expect((await run(testConfig(fake), model(), ctx([user("hi")]))).message.errorMessage).toMatch(/not found \(HTTP 404.*model may not be available/);
  });

  it("a stalled stream is cut at the idle limit with the silence stated", async () => {
    fake.on(STREAM, (req, res) => { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.write(`data: ${JSON.stringify(chunk([{ text: "a" }]))}\n\n`); });
    const started = Date.now();
    const r = await run(testConfig(fake), model(), ctx([user("hi")]), { timeoutMs: 120 });
    expect(r.message.stopReason).toBe("error");
    expect(r.message.errorMessage).toMatch(/stream idle for \d+ s \(\d+ bytes received\)/);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(r.message.content[0]).toMatchObject({ text: "a" });
  });

  it("a connection that never answers is cut at the first-byte limit", async () => {
    fake.on(STREAM, () => { /* never responds */ });
    const r = await run(testConfig(fake), model(), ctx([user("hi")]), { timeoutMs: 120 });
    expect(r.message.errorMessage).toMatch(/no response for \d+ s after the request was sent/);
  });

  it("abort mid-stream ends as aborted", async () => {
    const controller = new AbortController();
    fake.on(STREAM, (req, res) => { res.writeHead(200); res.write(`data: ${JSON.stringify(chunk([{ text: "a" }]))}\n\n`); setTimeout(() => controller.abort(), 30); });
    const r = await run(testConfig(fake), model(), ctx([user("hi")]), { signal: controller.signal });
    expect(r.message.stopReason).toBe("aborted");
  });

  it("falls to the next configured endpoint only when the first cannot be reached", async () => {
    fake.on(STREAM, (req, res) => sse(res, [chunk([{ text: "ok" }], { finishReason: "STOP" })]));
    const dead = "http://127.0.0.1:9";
    const r = await run(testConfig(fake, { baseUrls: [dead, fake.url] }), model(), ctx([user("hi")]));
    expect(r.message.stopReason).toBe("stop");
    // A refusal from a reachable endpoint is NOT passed on to the next one.
    fake.seen.length = 0;
    fake.on(STREAM, (req, res) => json(res, 403, { error: { message: "no" } }));
    const refused = await run(testConfig(fake, { baseUrls: [fake.url, dead] }), model(), ctx([user("hi")]));
    expect(refused.message.errorMessage).toMatch(/403/);
    expect(fake.seen).toHaveLength(1);
  });

  it("no request goes to any host but the configured ones", async () => {
    fake.on(STREAM, (req, res) => sse(res, [chunk([{ text: "ok" }], { finishReason: "STOP" })]));
    await run(testConfig(fake), model(), ctx([user("hi")]));
    expect(fake.seen.every((s) => s.headers.host === new URL(fake.url).host)).toBe(true);
  });
});
