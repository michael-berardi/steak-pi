import { describe, expect, it } from "vitest";
import localModels, { createLocalHook } from "../extensions/local/index.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
const model = (provider: string, id: string) => ({ provider, id });

function harness(options: { failEnsure?: string } = {}) {
  const handlers = new Map<string, Handler>();
  const log: string[] = [];
  const notes: Array<[string, string]> = [];
  let releaseEnsure: (() => void) | undefined;
  const hook = createLocalHook({
    ensure: async (id) => {
      log.push(`ensure:${id}`);
      if (options.failEnsure) throw new Error(options.failEnsure);
      await new Promise<void>((resolve) => { releaseEnsure = resolve; });
      return { started: true, baseUrl: "http://127.0.0.1:1/v1" };
    },
    release: async () => { log.push("release"); },
  });
  hook({ on: (name: string, handler: Handler) => { handlers.set(name, handler); } } as never);
  const ctx = { model: undefined as unknown, ui: { notify: (text: string, kind: string) => notes.push([kind, text]) } };
  const fire = async (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx);
  return { fire, ctx, log, notes, finishEnsure: () => releaseEnsure?.(), handlers };
}

describe("local model hook", () => {
  it("ensures when a session starts on a local model and releases when it ends", async () => {
    const h = harness();
    h.ctx.model = model("local", "model-a");
    const started = h.fire("session_start", { reason: "startup" });
    await Promise.resolve();
    h.finishEnsure();
    await started;
    await h.fire("before_agent_start");
    expect(h.log).toEqual(["ensure:model-a"]);
    expect(h.notes.map(([, text]) => text).join(" ")).toMatch(/ready at http:\/\/127\.0\.0\.1:1\/v1/);
    await h.fire("session_shutdown", { reason: "quit" });
    expect(h.log).toEqual(["ensure:model-a", "release"]);
    await h.fire("session_shutdown", { reason: "quit" });
    expect(h.log).toHaveLength(2); // idempotent: never a second release
  });

  it("does nothing for a session on any other model", async () => {
    const h = harness();
    h.ctx.model = model("cloud", "model-a");
    await h.fire("session_start", {});
    await h.fire("model_select", { model: model("cloud", "other") });
    await h.fire("before_agent_start");
    await h.fire("session_shutdown", {});
    expect(h.log).toEqual([]);
    expect(h.notes).toEqual([]);
  });

  it("a switch to a local model mid-session ensures; a switch away or to another local model lets go first", async () => {
    const h = harness();
    h.ctx.model = model("cloud", "x");
    await h.fire("session_start", {});
    const toLocal = h.fire("model_select", { model: model("local", "model-a") });
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.finishEnsure();
    await toLocal;
    await h.fire("before_agent_start");
    expect(h.log).toEqual(["ensure:model-a"]);
    const toOther = h.fire("model_select", { model: model("local", "model-b") });
    await new Promise((resolve) => setTimeout(resolve, 0));
    h.finishEnsure();
    await toOther;
    await h.fire("before_agent_start");
    expect(h.log).toEqual(["ensure:model-a", "release", "ensure:model-b"]);
    await h.fire("model_select", { model: model("cloud", "x") });
    await h.fire("before_agent_start");
    expect(h.log).toEqual(["ensure:model-a", "release", "ensure:model-b", "release"]);
    await h.fire("session_shutdown", {});
    expect(h.log).toHaveLength(4);
    // Selecting the same local model again is not a second hold.
    const again = harness();
    again.ctx.model = model("local", "model-a");
    void again.fire("session_start", {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    again.finishEnsure();
    await again.fire("model_select", { model: model("local", "model-a") });
    await again.fire("before_agent_start");
    expect(again.log).toEqual(["ensure:model-a"]);
  });

  it("the first prompt waits for the server to come up", async () => {
    const h = harness();
    h.ctx.model = model("local", "model-a");
    void h.fire("session_start", {});
    let promptReleased = false;
    const prompt = h.fire("before_agent_start").then(() => { promptReleased = true; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(promptReleased).toBe(false);
    h.finishEnsure();
    await prompt;
    expect(promptReleased).toBe(true);
  });

  it("surfaces a refusal by its named cause and holds nothing afterwards", async () => {
    const h = harness({ failEnsure: "steak-pi local: REFUSED (disk-full): the disk is 95% used" });
    h.ctx.model = model("local", "model-a");
    await h.fire("session_start", {});
    await h.fire("before_agent_start");
    expect(h.notes.at(-1)).toEqual(["error", "steak-pi local: REFUSED (disk-full): the disk is 95% used"]);
    await h.fire("session_shutdown", {});
    expect(h.log).toEqual(["ensure:model-a"]); // no release for a hold that was never taken
  });

  it("is registered by the package's default export", () => {
    const events: string[] = [];
    localModels({ on: (name: string) => { events.push(name); } } as never);
    expect(events.sort()).toEqual(["before_agent_start", "model_select", "session_shutdown", "session_start"]);
  });
});
