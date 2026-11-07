import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ensure, pidHolder, release, systemDeps, type EnsureResult } from "../../src/local/runtime.ts";
import { LocalError, localDir } from "../../src/local/store.ts";

/** The one-line cause of a refused or failed start, in the form the CLI and the USAP profile-ensure hook print. */
export const refusalText = (error: unknown): string =>
  error instanceof LocalError ? `steak-pi local: REFUSED (${error.code}): ${error.message}` : `steak-pi local: ${error instanceof Error ? error.message : String(error)}`;

type Model = ExtensionContext["model"];
export interface LocalHookDeps {
  ensure(id: string): Promise<EnsureResult>;
  release(): Promise<unknown>;
}

/** The provider the local module writes to `models.json`; a model on it is served by an on-demand llama-server. */
const LOCAL_PROVIDER = "local";

/**
 * Keep the local model server up only while this Pi process is really using it: one lease from the start of a run on a
 * `local/...` model (`before_agent_start`) until Pi settles (`agent_settled`: nothing more will run on its own). Between
 * prompts a session holds nothing, so a pane left open at its prompt no longer pins gigabytes of weights and memory; the
 * server stops after its idle grace once the last run anywhere has settled (2026-11-05: one idle pane kept a model loaded
 * for seven hours). Selecting a local model (session start or a switch) warms the server with a lease it lets go at once,
 * so the first prompt does not wait for the weights unless the grace has already passed. Other models are untouched.
 */
export function createLocalHook(deps: LocalHookDeps): (pi: ExtensionAPI) => void {
  return (pi) => {
    let held: string | undefined; // the model this process holds a lease on: only while a run is active
    let warmed: string | undefined; // the selected local model already warmed, so a repeat selection is not a second start
    let compacting = false; // a lease taken only for a compaction outside a run (manual /compact)
    let pending: Promise<void> = Promise.resolve();
    const queue = (step: () => Promise<void>): Promise<void> => (pending = pending.then(step, step));

    const report = (ctx: ExtensionContext, error: unknown) => {
      const text = refusalText(error);
      ctx.ui.notify(text, "error");
      if (ctx.hasUI === false) process.stderr.write(`${text}\n`); // print mode has no notification area
    };
    const letGo = async () => {
      if (held === undefined) return;
      held = undefined;
      await deps.release().catch(() => undefined);
    };
    let refusal: string | undefined; // why the run that is starting must not reach the dead endpoint; shown as its error
    const take = async (id: string, ctx: ExtensionContext, inRun = false): Promise<boolean> => {
      try {
        const result = await deps.ensure(id);
        if (result.started) ctx.ui.notify(`Local model ${id} is ready at ${result.baseUrl}.`, "info");
        return true;
      } catch (error) {
        if (inRun) refusal = refusalText(error); // the run's own error carries it: no second notice
        else report(ctx, error);
        return false;
      }
    };
    const localId = (model: Model) => (model?.provider === LOCAL_PROVIDER ? model.id : undefined);

    /** A local model was selected: start it in the background and let go at once, so its idle grace runs from now. */
    const select = (model: Model, ctx: ExtensionContext) => {
      const wanted = localId(model);
      if (wanted === warmed) return;
      warmed = wanted;
      void queue(async () => {
        if (held !== undefined && held !== wanted) await letGo();
        if (!wanted || held === wanted) return;
        ctx.ui.notify(`Starting local model ${wanted}; the first start loads the weights and can take a minute.`, "info");
        if (await take(wanted, ctx)) await deps.release().catch(() => undefined);
        else if (warmed === wanted) warmed = undefined;
      });
    };

    pi.on("session_start", (_event, ctx) => { select(ctx.model, ctx); });
    pi.on("model_select", (event, ctx) => { select(event.model, ctx); });
    // A run holds the server: the prompt waits for it to be up (the weights reload if it stopped while idle), and a start
    // that failed (memory, a busy port, another server) is tried again on the next prompt instead of until /reload.
    //
    // A start that cannot happen must stop this run before any request: Pi swallows an error thrown from
    // `before_agent_start` and sends the prompt anyway, and an abort that early is a no-op (the run resets it). So the
    // refusal is remembered here, the run is aborted the moment it starts (`agent_start`, before the provider call), and
    // the aborted assistant message is finalized as an error carrying the refusal text (`message_end`), so the screen and
    // the session history name the cause instead of `Connection error`.
    pi.on("before_agent_start", async (_event, ctx) => {
      const wanted = localId(ctx.model);
      refusal = undefined;
      await queue(async () => {
        if (held !== undefined && held !== wanted) await letGo();
        if (!wanted || held === wanted) return;
        if (await take(wanted, ctx, true)) { held = wanted; warmed = wanted; }
      });
    });
    pi.on("agent_start", async (_event, ctx) => { if (refusal !== undefined) ctx.abort(); });
    pi.on("message_end", async (event) => {
      if (refusal === undefined || event.message.role !== "assistant") return undefined;
      const text = refusal;
      refusal = undefined;
      return { message: { ...event.message, stopReason: "error", errorMessage: text } };
    });
    // Pi will not continue on its own: the run is over and this process no longer uses the server.
    pi.on("agent_settled", async () => { compacting = false; refusal = undefined; await queue(letGo); });
    // A manual /compact summarizes with the session model outside any run: hold the server for it, then let go.
    pi.on("session_before_compact", async (_event, ctx) => {
      const wanted = localId(ctx.model);
      await queue(async () => {
        if (!wanted || held !== undefined) return;
        if (await take(wanted, ctx)) { held = wanted; compacting = true; }
      });
    });
    const compacted = async () => { if (compacting) { compacting = false; await queue(letGo); } };
    pi.on("session_compact", compacted);
    pi.on("session_compact_failed", compacted);
    pi.on("session_shutdown", async () => { await queue(letGo); });
  };
}

export default function localModels(pi: ExtensionAPI): void {
  const holder = pidHolder(process.pid);
  const system = () => systemDeps(localDir());
  createLocalHook({ ensure: (id) => ensure(system(), id, holder), release: () => release(system(), holder) })(pi);
}
