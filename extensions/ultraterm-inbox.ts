import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getPrimaryHostIdentity, hasManagedTuiEnvironment } from "../src/primary-host.ts";
import { randomUUID } from "node:crypto";
import { InboxConsumer, acceptedEntry, createPersistedReader, unixTransport } from "../src/ultraterm-inbox.ts";

// Loader copies share ownership, but never share SDK closures across reloads.
const ownersKey = Symbol.for("steak-pi.inbox-owners.v1");
const globals = globalThis as unknown as Record<symbol, WeakMap<object, object> | undefined>;
const owners = globals[ownersKey] ??= new WeakMap<object, object>();
if (!(owners instanceof WeakMap)) throw new Error("Incompatible inbox ownership registry");
// One inbox instance id per host identity (pid, session, generation) across extension reloads: UltraTerm accepts
// a hold or record of a claim only from the instance that claimed it, so a fresh random id after /reload left a
// busy recipient's held note released and unrecordable (Opus review 2026-11-13, finding 2).
const instancesKey = Symbol.for("steak-pi.inbox-instances.v1");
const instanceGlobals = globalThis as unknown as Record<symbol, Map<string, string> | undefined>;
const instances = instanceGlobals[instancesKey] ??= new Map<string, string>();
if (!(instances instanceof Map)) throw new Error("Incompatible inbox instance registry");

export default function ultratermInbox(pi: ExtensionAPI): void {
  let consumer: InboxConsumer | undefined;
  let startup: ReturnType<typeof setTimeout> | undefined;
  const token = {};
  let manager: object | undefined;
  let settles = 0;
  const stop = () => {
    clearTimeout(startup); consumer?.stop(); consumer = undefined;
    if (manager && owners.get(manager) === token) owners.delete(manager);
    manager = undefined;
  };
  const start = (ctx: ExtensionContext) => {
    stop();
    // Defer until all session_start publishers have completed; never fabricate proof.
    if (ctx.mode !== "tui" || !ctx.hasUI || !hasManagedTuiEnvironment()) return;
    if (owners.has(ctx.sessionManager)) return;
    manager = ctx.sessionManager;
    owners.set(manager, token);
    const attempt = () => {
      const host = getPrimaryHostIdentity(ctx.sessionManager);
      const current = () => ctx.mode === "tui" && ctx.hasUI && host !== undefined
        && host.pid === process.pid && getPrimaryHostIdentity(ctx.sessionManager) === host
        && ctx.sessionManager.getSessionId() === host.sessionId
        && ctx.sessionManager.getSessionFile() === host.sessionFile;
      if (!host || !current()) { startup = setTimeout(attempt, 1000); startup.unref?.(); return; }
      const key = `${host.pid}\0${host.sessionId}\0${host.generation}`;
      let instanceId = instances.get(key);
      if (!instanceId) { instanceId = randomUUID(); instances.set(key, instanceId); }
      consumer = new InboxConsumer({ host, current, instanceId, settled: () => settles, pending: () => ctx.hasPendingMessages(), idle: () => ctx.isIdle(), send: (m, o) => pi.sendMessage(m, o), evidence: createPersistedReader(host, undefined, () => !ctx.sessionManager.getEntries().some(e => e.type === "message" && e.message.role === "assistant")), accepted: m => acceptedEntry(ctx.sessionManager.getEntries(), m), transport: unixTransport() });
      consumer.start();
      // A republished identity (compaction, /tree, reload of the publisher) replaces the host object, and the
      // consumer stops for good on the old one. While this manager is still ours, start again on the new identity:
      // otherwise the terminal's inbox stays unregistered and every peer message is refused (2026-10-29).
      const watch = () => {
        if (manager !== ctx.sessionManager || owners.get(ctx.sessionManager) !== token) return;
        if (consumer && consumer.phase !== "stopped") { startup = setTimeout(watch, 1000); startup.unref?.(); return; }
        consumer = undefined; attempt();
      };
      startup = setTimeout(watch, 1000); startup.unref?.();
    };
    startup = setTimeout(attempt, 0);
    startup.unref?.();
  };
  pi.on("session_start", (_e, ctx) => start(ctx));
  pi.on("session_tree", (_e, ctx) => start(ctx));
  // Before-events can be cancelled: only committed lifecycle events stop us.
  pi.on("session_shutdown", stop);
  pi.on("agent_settled", () => { settles += 1; void consumer?.tick(); });
}
