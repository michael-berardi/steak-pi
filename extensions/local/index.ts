import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ensure, pidHolder, release, systemDeps, type EnsureResult } from "../../src/local/runtime.ts";
import { localDir } from "../../src/local/store.ts";

type Model = ExtensionContext["model"];
export interface LocalHookDeps {
  ensure(id: string): Promise<EnsureResult>;
  release(): Promise<unknown>;
}

/** The provider the local module writes to `models.json`; a model on it is served by an on-demand llama-server. */
const LOCAL_PROVIDER = "local";

/**
 * Keep the local model server up while this Pi process is on a `local/...` model: take one lease when a session
 * starts on one (or the model is switched to one), let go when the model is switched away or the session ends.
 * The server stops by itself after an idle grace once the last lease is gone. Sessions on any other model are
 * untouched: no file is read and nothing is started.
 */
export function createLocalHook(deps: LocalHookDeps): (pi: ExtensionAPI) => void {
  return (pi) => {
    let held: string | undefined;
    let pending: Promise<void> = Promise.resolve();

    const sync = (model: Model, ctx: ExtensionContext) => {
      const wanted = model?.provider === LOCAL_PROVIDER ? model.id : undefined;
      if (wanted === held) return;
      const previous = held;
      held = wanted;
      pending = pending.then(async () => {
        if (previous) await deps.release().catch(() => undefined);
        if (!wanted) return;
        ctx.ui.notify(`Starting local model ${wanted}; the first start loads the weights and can take a minute.`, "info");
        try {
          const result = await deps.ensure(wanted);
          if (result.started) ctx.ui.notify(`Local model ${wanted} is ready at ${result.baseUrl}.`, "info");
        } catch (error) {
          if (held === wanted) held = undefined;
          const text = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(text, "error");
          if (ctx.hasUI === false) process.stderr.write(`${text}\n`); // print mode has no notification area
        }
      });
    };

    pi.on("session_start", (_event, ctx) => { sync(ctx.model, ctx); });
    pi.on("model_select", (event, ctx) => { sync(event.model, ctx); });
    // The first prompt of a session must not race the server coming up.
    pi.on("before_agent_start", async () => { await pending; });
    pi.on("session_shutdown", async () => {
      await pending;
      if (held !== undefined) { held = undefined; await deps.release().catch(() => undefined); }
    });
  };
}

export default function localModels(pi: ExtensionAPI): void {
  const holder = pidHolder(process.pid);
  const system = () => systemDeps(localDir());
  createLocalHook({ ensure: (id) => ensure(system(), id, holder), release: () => release(system(), holder) })(pi);
}
