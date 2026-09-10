import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getPrimaryHostIdentity, hasManagedTuiEnvironment } from "../src/primary-host.ts";
import { InboxConsumer, acceptedEntry, createPersistedReader, unixTransport } from "../src/ultraterm-inbox.ts";

// Loader copies share ownership, but never share SDK closures across reloads.
const ownersKey = Symbol.for("steak-pi.inbox-owners.v1");
const globals = globalThis as unknown as Record<symbol, WeakMap<object, object> | undefined>;
const owners = globals[ownersKey] ??= new WeakMap<object, object>();
if (!(owners instanceof WeakMap)) throw new Error("Incompatible inbox ownership registry");

export default function ultratermInbox(pi: ExtensionAPI): void {
  let consumer: InboxConsumer | undefined;
  let startup: ReturnType<typeof setTimeout> | undefined;
  const token = {};
  let manager: object | undefined;
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
      if (!host) { startup = setTimeout(attempt, 1000); startup.unref?.(); return; }
      if (!current()) return;
      consumer = new InboxConsumer({ host, current, idle: () => ctx.isIdle(), send: (m, o) => pi.sendMessage(m, o), evidence: createPersistedReader(host, undefined, () => !ctx.sessionManager.getEntries().some(e => e.type === "message" && e.message.role === "assistant")), accepted: m => acceptedEntry(ctx.sessionManager.getEntries(), m), transport: unixTransport() });
      consumer.start();
    };
    startup = setTimeout(attempt, 0);
    startup.unref?.();
  };
  pi.on("session_start", (_e, ctx) => start(ctx));
  pi.on("session_tree", (_e, ctx) => start(ctx));
  // Before-events can be cancelled: only committed lifecycle events stop us.
  pi.on("session_shutdown", stop);
  pi.on("agent_settled", () => { void consumer?.tick(); });
}
