// The governor end to end, with a fake probe and a fake clock: a request start is delayed, the delay is reported, an
// abort cancels it, and the extension applies the request-size limits on the real hook path.
import { describe, expect, it } from "vitest";
import { createGovernor, resolveLimits, type ProbeSample } from "../src/local/limits.ts";
import { createLocalHook } from "../extensions/local/index.ts";
import { profileFor } from "./helpers/local-fixture.ts";

const util = (percent: number): ProbeSample => ({ kind: "util", percent });

function fakeClock() {
  const state = { t: 0 };
  return { state, now: () => state.t, sleep: async (ms: number) => { state.t += ms; } };
}

describe("governor with a fake probe and a fake clock", () => {
  it("delays a start while the GPU is hot, and reports the wait", async () => {
    const clock = fakeClock();
    const notices: string[] = [];
    const samples = [util(98), util(98), util(90), util(80), util(80)];
    const governor = createGovernor({
      limits: resolveLimits({ ctx: 32768, limits: { duty: "off" } }),
      probe: async () => samples.shift() ?? util(50),
      now: clock.now, sleep: clock.sleep, notice: (text) => notices.push(text),
    });
    const result = await governor.beforeRequest();
    expect(result).toEqual({ waitedMs: 8000, aborted: false }); // four 2 s samples of waiting
    expect(clock.state.t).toBe(8000);
    expect(notices[0]).toMatch(/GPU at 98% \(high-water 95%\); holding the request until it is at or below 85% for 2 samples, at most 30s/);
    expect(notices[1]).toMatch(/GPU headroom restored after 8s; starting the request/);
  });

  it("proceeds at the deferral cap and says so", async () => {
    const clock = fakeClock();
    const notices: string[] = [];
    const governor = createGovernor({
      limits: resolveLimits({ ctx: 32768, limits: { duty: "off", headroom: { maxDeferMs: 4000 } } }),
      probe: async () => util(99),
      now: clock.now, sleep: clock.sleep, notice: (text) => notices.push(text),
    });
    expect(await governor.beforeRequest()).toEqual({ waitedMs: 4000, aborted: false });
    expect(notices.at(-1)).toMatch(/GPU still at or above 95% after 4s; starting the request anyway \(limits\.headroom\.maxDeferMs\)/);
  });

  it("an abort cancels the wait instead of stalling the request", async () => {
    const clock = fakeClock();
    const controller = new AbortController();
    let probes = 0;
    const governor = createGovernor({
      limits: resolveLimits({ ctx: 32768, limits: { duty: "off" } }),
      probe: async () => { probes += 1; if (probes === 2) controller.abort(); return util(99); },
      now: clock.now,
      sleep: async (ms: number, signal?: AbortSignal) => { clock.state.t += ms; if (signal?.aborted) return; },
      notice: () => {},
    });
    const result = await governor.beforeRequest(controller.signal);
    expect(result.aborted).toBe(true);
    expect(probes).toBe(2); // it stopped sampling as soon as the request was aborted
  });
});

describe("the extension applies the local route's limits", () => {
  type Handler = (event: unknown, ctx: unknown) => unknown;
  function harness(profile = profileFor({ ctx: 32768 })) {
    const handlers = new Map<string, Handler>();
    const clock = fakeClock();
    const notices: Array<[string, string]> = [];
    const samples: ProbeSample[] = [util(98), util(98), util(80), util(80)];
    createLocalHook({
      ensure: async () => ({ started: false, baseUrl: "http://127.0.0.1:1/v1" }),
      release: async () => undefined,
      profile: () => profile,
      probe: async () => samples.shift() ?? util(50),
      now: clock.now,
      sleep: clock.sleep,
    })({ on: (name: string, handler: Handler) => { handlers.set(name, handler); } } as never);
    const aborts: string[] = [];
    const compacts: string[] = [];
    const ctx = {
      model: { provider: "local", id: "model-a" },
      signal: undefined as AbortSignal | undefined,
      abort: () => { aborts.push("abort"); },
      compact: () => { compacts.push("compact"); },
      ui: { notify: (text: string, kind: string) => notices.push([kind, text]) },
    };
    const fire = async (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx);
    return { fire, ctx, clock, notices, aborts, compacts };
  }

  it("holds the request for the headroom check and reports it, then lets it through", async () => {
    const h = harness();
    const payload = { messages: [{ role: "user", content: "hi" }], max_tokens: 4096 };
    const result = await h.fire("before_provider_request", { payload });
    expect(result).toBeUndefined(); // nothing to replace: the payload is unchanged
    expect(h.clock.state.t).toBe(6000); // two 2 s samples at 98%, then two at 80% (the second one clears it)
    expect(h.notices.map(([, text]) => text).join("\n")).toMatch(/holding the request until it is at or below 85%/);
    expect(h.notices.map(([, text]) => text).join("\n")).toMatch(/GPU headroom restored after 6s/);
  });

  it("clamps an over-large output request, says so once, and returns the rewritten payload", async () => {
    const h = harness();
    const payload = { messages: [{ role: "user", content: "hi" }], max_tokens: 16384 };
    const first = await h.fire("before_provider_request", { payload }) as { max_tokens: number };
    expect(first.max_tokens).toBe(4096);
    expect(h.notices.filter(([, text]) => /output capped at 4096 tokens per request \(asked for 16384\)/.test(text))).toHaveLength(1);
    await h.fire("before_provider_request", { payload: { messages: [], max_tokens: 16384 } });
    expect(h.notices.filter(([, text]) => /output capped at/.test(text))).toHaveLength(1); // said once per session
  });

  it("compacts an over-cap prompt through the existing path and refuses the request by name", async () => {
    const h = harness();
    const payload = { messages: [{ role: "user", content: "x".repeat(4 * 30_000) }], max_tokens: 4096 };
    await h.fire("before_provider_request", { payload });
    expect(h.compacts).toEqual(["compact"]);
    expect(h.aborts).toEqual(["abort"]);
    const rewritten = await h.fire("message_end", { message: { role: "assistant", stopReason: "aborted" } }) as { message: { stopReason: string; errorMessage: string } };
    expect(rewritten.message.stopReason).toBe("error");
    expect(rewritten.message.errorMessage).toMatch(/REFUSED \(prompt-over-cap\): the prompt is about 30001 tokens and the local route sends at most 24576 \(75% of the 32768-token context\)/);
  });

  it("never refuses the compaction request itself: that is the way out of an over-cap prompt", async () => {
    const h = harness();
    await h.fire("session_before_compact"); // a manual /compact: the extension holds the server and marks itself compacting
    const payload = { messages: [{ role: "user", content: "x".repeat(4 * 30_000) }], max_tokens: 4096 };
    await h.fire("before_provider_request", { payload });
    expect(h.compacts).toEqual([]); // no compact-again loop, no abort of the request that shrinks the session
    expect(h.aborts).toEqual([]);
  });

  it("paces the next request after the previous one's duration", async () => {
    const h = harness();
    const payload = { messages: [{ role: "user", content: "hi" }], max_tokens: 4096 };
    await h.fire("before_provider_request", { payload });
    h.clock.state.t += 105_000; // the request ran for 105 s
    await h.fire("message_end", { message: { role: "assistant", stopReason: "end" } });
    const before = h.clock.state.t;
    await h.fire("before_provider_request", { payload });
    expect(h.clock.state.t - before).toBe(10_000); // the 10 s cap on the duty-cycle gap
    expect(h.notices.map(([, text]) => text).join("\n")).toMatch(/holding the next request 10s to keep the GPU at a 85% duty cycle/);
  });

  it("moves the per-turn route-availability line behind the conversation, so the prefix stays reusable", async () => {
    const h = harness();
    const availability = "USAP route availability: route-a: up; route-b: COOLING until Mon 03:42. Next usable route: route-a.";
    const head = `You are a coding agent.\n\n<rules>\n- Be concise\n</rules>\n\n${availability}`;
    const payload = { messages: [{ role: "system", content: head }, { role: "user", content: "hi" }], max_tokens: 4096 };
    const result = await h.fire("before_provider_request", { payload }) as { messages: Array<{ role: string; content: string }> };
    expect(result).not.toBe(payload); // a new request body, not a mutation of Pi's payload
    expect(result.messages[0]).toEqual({ role: "system", content: "You are a coding agent.\n\n<rules>\n- Be concise\n</rules>" });
    expect(result.messages.at(-1)).toEqual({ role: "system", content: availability });
    expect((payload.messages[0] as { content: string }).content).toBe(head); // the caller's payload is untouched
  });

  it("leaves a request with no per-turn block exactly as it was", async () => {
    const h = harness();
    const payload = { messages: [{ role: "system", content: "stable prompt" }, { role: "user", content: "hi" }], max_tokens: 4096 };
    expect(await h.fire("before_provider_request", { payload })).toBeUndefined();
    expect(payload.messages[0]!.content).toBe("stable prompt");
  });

  it("leaves a remote model alone", async () => {
    const h = harness();
    h.ctx.model = { provider: "somewhere-else", id: "model-a" };
    expect(await h.fire("before_provider_request", { payload: { messages: [], max_tokens: 16384 } })).toBeUndefined();
    expect(h.clock.state.t).toBe(0);
    expect(h.notices).toHaveLength(0);
  });
});
