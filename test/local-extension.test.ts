import { describe, expect, it } from "vitest";
import { LocalError } from "../src/local/store.ts";
import localModels, { createLocalHook } from "../extensions/local/index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
const model = (provider: string, id: string) => ({ provider, id });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(options: { fail?: () => string | undefined } = {}) {
  const handlers = new Map<string, Handler>();
  const log: string[] = [];
  const notes: Array<[string, string]> = [];
  createLocalHook({
    ensure: async (id) => {
      log.push(`ensure:${id}`);
      const failure = options.fail?.();
      if (failure) throw new LocalError("insufficient-memory", failure);
      return { started: true, baseUrl: "http://127.0.0.1:1/v1" };
    },
    release: async () => { log.push("release"); },
  })({ on: (name: string, handler: Handler) => { handlers.set(name, handler); } } as never);
  const aborts: string[] = [];
  const ctx = { model: undefined as unknown, abort: () => { aborts.push("abort"); }, ui: { notify: (text: string, kind: string) => notes.push([kind, text]) } };
  const fire = async (name: string, event: unknown = {}) => { const result = await handlers.get(name)?.(event, ctx); await tick(); return result as { message?: Record<string, unknown> } | undefined; };
  return { fire, ctx, log, notes, aborts };
}

describe("local model hook", () => {
  it("a session at its prompt holds nothing: a run holds the server from its start until Pi settles", async () => {
    const h = harness();
    h.ctx.model = model("local", "model-a");
    await h.fire("session_start", { reason: "startup" });
    expect(h.log).toEqual(["ensure:model-a", "release"]); // warmed, then let go: the idle grace runs from here
    await h.fire("before_agent_start");
    expect(h.log).toEqual(["ensure:model-a", "release", "ensure:model-a"]);
    await h.fire("agent_settled");
    expect(h.log).toEqual(["ensure:model-a", "release", "ensure:model-a", "release"]);
    await h.fire("agent_settled");
    await h.fire("session_shutdown", { reason: "quit" });
    expect(h.log).toHaveLength(4); // never a release without a hold
  });

  it("a session that quits mid-run lets go once", async () => {
    const h = harness();
    h.ctx.model = model("local", "model-a");
    await h.fire("session_start");
    await h.fire("before_agent_start");
    await h.fire("session_shutdown");
    await h.fire("session_shutdown");
    expect(h.log.filter((entry) => entry === "release")).toHaveLength(2); // the warm-up and the run, nothing more
  });

  it("a manual /compact outside a run holds the server for the summary, then lets go; inside a run it adds nothing", async () => {
    const h = harness();
    h.ctx.model = model("local", "model-a");
    await h.fire("session_start");
    await h.fire("session_before_compact");
    expect(h.log).toEqual(["ensure:model-a", "release", "ensure:model-a"]);
    await h.fire("session_compact");
    expect(h.log.at(-1)).toBe("release");
    await h.fire("session_before_compact");
    await h.fire("session_compact_failed");
    expect(h.log.slice(-2)).toEqual(["ensure:model-a", "release"]);
    const before = h.log.length;
    await h.fire("before_agent_start");
    await h.fire("session_before_compact"); // auto-compaction during a run: the run's lease covers it
    await h.fire("session_compact");
    expect(h.log).toHaveLength(before + 1);
    await h.fire("agent_settled");
    expect(h.log).toHaveLength(before + 2);
  });

  it("does nothing for a session on any other model", async () => {
    const h = harness();
    h.ctx.model = model("cloud", "model-a");
    await h.fire("session_start");
    await h.fire("model_select", { model: model("cloud", "other") });
    await h.fire("before_agent_start");
    await h.fire("agent_settled");
    await h.fire("session_before_compact");
    await h.fire("session_compact");
    await h.fire("session_shutdown");
    expect(h.log).toEqual([]);
    expect(h.notes).toEqual([]);
  });

  it("a switch warms the new local model once; a run on it holds it; a switch away during a run lets go", async () => {
    const h = harness();
    h.ctx.model = model("cloud", "x");
    await h.fire("session_start");
    await h.fire("model_select", { model: model("local", "model-a") });
    await h.fire("model_select", { model: model("local", "model-a") }); // the same selection again: no second start
    expect(h.log).toEqual(["ensure:model-a", "release"]);
    h.ctx.model = model("local", "model-a");
    await h.fire("before_agent_start");
    await h.fire("model_select", { model: model("cloud", "x") });
    expect(h.log).toEqual(["ensure:model-a", "release", "ensure:model-a", "release"]);
    h.ctx.model = model("cloud", "x");
    await h.fire("before_agent_start");
    await h.fire("agent_settled");
    expect(h.log).toHaveLength(4);
  });

  it("the first prompt waits for the server to come up", async () => {
    let finish!: () => void;
    const handlers = new Map<string, Handler>();
    createLocalHook({
      ensure: () => new Promise((resolve) => { finish = () => resolve({ started: true, baseUrl: "u" }); }),
      release: async () => undefined,
    })({ on: (name: string, handler: Handler) => { handlers.set(name, handler); } } as never);
    const ctx = { model: model("local", "model-a"), ui: { notify: () => undefined } };
    let released = false;
    const prompt = Promise.resolve(handlers.get("before_agent_start")!({}, ctx)).then(() => { released = true; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(released).toBe(false);
    finish();
    await prompt;
    expect(released).toBe(true);
  });

  it("a refused start stops the run before any request with the refusal as its error, holds nothing, and tries again on the next prompt", async () => {
    let failing = true;
    const reason = "starting swift-1-5 needs about 16.4 GiB but only 14.2 GiB is free or reclaimable";
    const h = harness({ fail: () => (failing ? reason : undefined) });
    h.ctx.model = model("local", "model-a");
    await h.fire("session_start");
    h.notes.length = 0;
    await h.fire("before_agent_start");
    expect(h.aborts).toEqual([]); // an abort this early would be a no-op in Pi: it comes once the run has started
    await h.fire("agent_start");
    expect(h.aborts).toEqual(["abort"]);
    const aborted = { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Request was aborted" };
    const replaced = await h.fire("message_end", { message: aborted });
    expect(replaced?.message).toMatchObject({ role: "assistant", stopReason: "error", errorMessage: `steak-pi local: REFUSED (insufficient-memory): ${reason}` });
    expect(await h.fire("message_end", { message: aborted })).toBeUndefined(); // only that run's message
    expect(h.notes).toEqual([]); // the run's error is the notice, not a second one
    expect(h.log).toEqual(["ensure:model-a", "ensure:model-a"]);
    await h.fire("agent_settled");
    expect(h.log).not.toContain("release"); // no release for a hold that was never taken
    failing = false;
    await h.fire("before_agent_start");
    await h.fire("agent_start");
    expect(h.aborts).toHaveLength(1); // the retry started, so this run is not aborted
    expect(await h.fire("message_end", { message: { role: "assistant", stopReason: "stop" } })).toBeUndefined();
    expect(h.log).toEqual(["ensure:model-a", "ensure:model-a", "ensure:model-a"]);
    await h.fire("agent_settled");
    expect(h.log.at(-1)).toBe("release");
  });

  it("a warm-up refusal is still only a notification", async () => {
    const h = harness({ fail: () => "no memory" });
    h.ctx.model = model("local", "model-a");
    await h.fire("session_start");
    expect(h.notes.at(-1)).toEqual(["error", "steak-pi local: REFUSED (insufficient-memory): no memory"]);
    expect(h.aborts).toEqual([]);
  });

  it("is registered by the package's default export", () => {
    const events: string[] = [];
    localModels({ on: (name: string) => { events.push(name); } } as never);
    expect(events.sort()).toEqual(["agent_settled", "agent_start", "before_agent_start", "message_end", "model_select", "session_before_compact", "session_compact", "session_compact_failed", "session_shutdown", "session_start"]);
  });
});
