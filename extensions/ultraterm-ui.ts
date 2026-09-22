import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { openSync, readSync, closeSync, realpathSync, statSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, resolve, relative, join } from "node:path";
import { getPrimaryHostIdentity } from "../src/primary-host.ts";
import { activeHarnessId, harnessManifestPaths, harnessProfileDirs, levels, readHarnessProfiles, type HarnessProfile, type Thinking } from "../src/harness-profiles.ts";
import { isModelRouteAllowed } from "../src/model-route-policy.ts";
import { curatedPickerModels, sharedPickerModels } from "../src/model-visibility.ts";
import { createUiStream } from "../src/ui-stream.ts";

const LIMIT = 1024 * 1024;
type Request = { version: 1; requestId?: string; sessionId: string; generation: string } & ({ action: "resume"; path: string } | ({ action: "message"; text: string } | { action: "model" }) & { model: { provider: string; id: string }; thinking: Thinking });
/** Curated picker profile: one exact native route from the selected harness manifest. */
export type Profile = HarnessProfile;
class UiError extends Error {}
function fail(message: string): never { throw new UiError(message); }
const object = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
const clean = (x: unknown): x is string => typeof x === "string" && x.length > 0 && !/[\x00-\x1f\x7f-\x9f]/u.test(x);
export function decodeRequest(encoded: string): Request {
  if (encoded.length > Math.ceil(LIMIT * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(encoded)) fail("Invalid base64url payload");
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.length > LIMIT || bytes.toString("base64url") !== encoded) fail("Invalid payload size or encoding");
  let r: any;
  try { r = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { fail("Invalid JSON payload"); }
  if (!object(r) || r.version !== 1 || !["resume", "message", "model"].includes(r.action)) fail("Unsupported UI request");
  if (r.requestId !== undefined && (!clean(r.requestId) || r.requestId.length > 128)) fail("Invalid requestId");
  if (!clean(r.sessionId) || r.sessionId.length > 128 || !clean(r.generation) || r.generation.length > 128) fail("Missing expected session identity");
  const keys = ["version", "action", "requestId", "sessionId", "generation", ...(r.action === "resume" ? ["path"] : [...(r.action === "message" ? ["text"] : []), "model", "thinking"])];
  if (Object.keys(r).some(k => !keys.includes(k))) fail("Unexpected request field");
  if (r.action === "resume") {
    if (!clean(r.path) || !isAbsolute(r.path) || resolve(r.path) !== r.path || !r.path.endsWith(".jsonl")) fail("Invalid session path");
  } else if ((r.action === "message" && (typeof r.text !== "string" || !r.text.trim())) || !object(r.model) || Object.keys(r.model).sort().join() !== "id,provider" || !clean(r.model.provider) || !clean(r.model.id) || !levels.includes(r.thinking)) fail("Invalid model/message request");
  return r as Request;
}

/**
 * Curated profile metadata for the selected harness: the live operator manifest
 * under `~/.config/ultraterm/harnesses/{harness}.json`, else the app-bundled
 * manifest. The selected harness identity comes from the existing launcher env
 * metadata (`ULTRATERM_HARNESS_ID` / `ULTRATERM_HARNESS`). A manifest that exists
 * is authority, so adding, renaming or removing a profile changes both pickers
 * with no code change; when none exists the caller keeps native choices.
 */
export function readProfiles(sources: string | readonly string[] = harnessProfileDirs(), harness: string = activeHarnessId()): Profile[] {
  return readHarnessProfiles(sources, harness);
}

// A running Pi session composes models.json/auth.json into an in-memory
// registry snapshot, so a model or credential configured after the session
// started would stay invisible until restart. The native registry exposes the
// same local reload `/model` relies on: ModelRegistry.refresh() re-reads
// models.json and re-checks the credential store. We call it only when the
// native config files actually changed on disk, always with allowNetwork:false
// (never a remote catalog refresh), once per observed revision, with a
// caller-owned deadline and bounded retry backoff.
const NATIVE_CONFIG_FILES = ["models.json", "auth.json", "models-store.json"] as const;
/** Bounded mtime poll used to notice config changes in an otherwise idle session. */
export const CONFIG_POLL_MS = 1500;
const REFRESH_TIMEOUT_MS = 3000;
const REFRESH_BACKOFF_MS = 2000;
const REFRESH_BACKOFF_MAX_MS = 30_000;
export type NativeReloadOptions = { allowNetwork?: boolean; signal?: AbortSignal };
export type RefreshableRegistry = { refresh?: (options?: NativeReloadOptions) => Promise<unknown>; getError?: () => string | undefined };
/** The agent directory Pi loads models.json/auth.json from. */
export function nativeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PI_CODING_AGENT_DIR;
  if (!configured) return join(homedir(), ".pi", "agent");
  return configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured;
}
/** mtime/size revision of exactly the files Pi composes into the native registry. */
export function configRevision(directory = nativeConfigDir(), manifests: readonly string[] = harnessManifestPaths()): string {
  const native = NATIVE_CONFIG_FILES.map(name => {
    try {
      const stat = statSync(join(directory, name), { throwIfNoEntry: false });
      return `${name}:${stat ? `${stat.mtimeMs}:${stat.size}` : "absent"}`;
    } catch {
      // Unreadable must stay distinguishable from unchanged so a later readable
      // revision is still detected; never throw into the catalog publisher.
      return `${name}:unreadable`;
    }
  });
  // The selected harness manifest is part of the picker's input, so a profile
  // add, rename or removal must be observable as a new revision and reach both
  // pickers on the same bounded offline reload as a native config change.
  const curated = [`harness:${activeHarnessId()}`, ...manifests.map(path => {
    try {
      const stat = statSync(path, { throwIfNoEntry: false });
      return `harness:${path}:${stat ? `${stat.mtimeMs}:${stat.size}` : "absent"}`;
    } catch {
      return `harness:${path}:unreadable`;
    }
  })];
  return [...native, ...curated].join("|");
}
export interface ConfigRefresh {
  /** Whether the on-disk native config differs from the last applied/attempted revision. */
  changed(): boolean;
  /** Apply one bounded offline reload; reject while native configuration is unhealthy. */
  sync(registry: RefreshableRegistry): Promise<void>;
  /** Abort a bounded in-flight reload on session teardown; the refresher stays usable. */
  stop(): void;
}
export function createConfigRefresher(options: { directory?: string; timeoutMs?: number; backoffMs?: number; manifests?: readonly string[] } = {}): ConfigRefresh {
  const directory = options.directory ?? nativeConfigDir();
  const manifests = options.manifests ?? harnessManifestPaths();
  const timeoutMs = options.timeoutMs ?? REFRESH_TIMEOUT_MS;
  const backoffMs = options.backoffMs ?? REFRESH_BACKOFF_MS;
  let applied = configRevision(directory, manifests), attempted = applied, retryAt = 0, failures = 0;
  let inFlight: Promise<void> | undefined;
  let controller: AbortController | undefined;
  let seq = 0;
  let unhealthy = false;
  const unavailable = () => { throw new UiError("Native model configuration unavailable; use native /model"); };
  const changed = () => {
    const current = configRevision(directory, manifests);
    return current !== applied && (current !== attempted || Date.now() >= retryAt);
  };
  const sync = async (registry: RefreshableRegistry): Promise<void> => {
    if (inFlight) return inFlight;
    if (!changed()) {
      if (unhealthy || registry.getError?.()) unavailable();
      return;
    }
    const current = configRevision(directory, manifests);
    const refresh = registry.refresh;
    // Compatible Pi facades expose this method. If it is missing, keep the last
    // good native snapshot rather than fabricating a registry of our own.
    if (typeof refresh !== "function") { unhealthy = true; unavailable(); }
    const epoch = ++seq;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    timer.unref?.();
    controller = abort;
    const run = (async () => {
      // The reload must cooperate with the signal; the race below still bounds
      // our own wait so a slow provider cannot stall catalog publication.
      const call = Promise.resolve().then(() => refresh!.call(registry, { allowNetwork: false, signal: abort.signal })).then(result => {
        // Native config/composition errors live in getError(), separately from
        // provider refresh errors. A resolved promise alone is not success.
        return object(result) && result.aborted === false && result.errors instanceof Map && result.errors.size === 0
          && !abort.signal.aborted && !registry.getError?.();
      }).catch(() => false);
      const outcome = await Promise.race([call, new Promise<boolean>(resolve => {
        if (abort.signal.aborted) resolve(false);
        else abort.signal.addEventListener("abort", () => resolve(false), { once: true });
      })]);
      if (epoch !== seq) unavailable();
      unhealthy = !outcome;
      if (outcome) { applied = current; attempted = current; retryAt = 0; failures = 0; }
      else {
        // Malformed, slow or aborted config: keep the last good publication and
        // retry rarely (bounded exponential backoff) instead of spinning.
        attempted = current;
        retryAt = Date.now() + Math.min(backoffMs * 2 ** failures, REFRESH_BACKOFF_MAX_MS);
        failures++;
        unavailable();
      }
    })().finally(() => {
      clearTimeout(timer);
      if (epoch !== seq) return;
      inFlight = undefined;
      if (controller === abort) controller = undefined;
    });
    inFlight = run;
    await run;
  };
  return {
    changed,
    sync,
    stop() {
      seq++;
      controller?.abort();
      controller = undefined;
      inFlight = undefined;
      retryAt = 0;
      failures = 0;
    },
  };
}

// Only the native availability snapshot can add picker choices, and the selected
// harness manifest narrows that snapshot to its own exact configured routes. A
// stale launch scope must never resurrect a model removed from configuration;
// scope supplies only the thinking preference when an available curated model
// matches it.
function nativeModels(ctx: ExtensionContext) {
  return ctx.modelRegistry.getAvailable();
}
/**
 * The composer picker list: exact curated profile routes of the selected harness
 * that are authenticated and policy-valid, published from the same native
 * availability snapshot native `/model` renders. Profile labels and effort are
 * metadata. A readable manifest is authority even when it names no route (empty
 * picker, parity with the sidebar); unreadable/unknown metadata keeps the native
 * choices instead of hiding them, and the native snapshot fails open the same way.
 */
export function catalogModels(ctx: ExtensionContext, metadata: () => Profile[] = readProfiles): Profile[] {
  let curated: Profile[] | undefined;
  try { curated = metadata(); } catch { /* Optional metadata must not hide native choices. */ }
  const native = curatedPickerModels(
    sharedPickerModels(nativeModels(ctx)).filter(model => ctx.modelRegistry.hasConfiguredAuth(model)).filter(isModelRouteAllowed),
    curated && new Set(curated.map(profile => `${profile.provider}/${profile.id}`)),
  );
  const roster = new Map((curated ?? []).map(profile => [`${profile.provider}/${profile.id}`, profile]));
  return native.map(model => {
    const key = `${model.provider}/${model.id}`;
    const label = roster.get(key);
    const scoped = ctx.scopedModels.find(s => s.model.provider === model.provider && s.model.id === model.id);
    return { profileId: label?.profileId ?? key, label: label?.label ?? model.name ?? model.id,
      provider: model.provider, id: model.id, thinking: scoped?.thinkingLevel ?? label?.thinking ?? (model.reasoning ? "medium" : "off") };
  });
}

export async function builtinCommands(): Promise<Array<{ name: string; description: string; source: string }>> {
  // The app pins Pi's compatible component version. Resolve its actual installed
  // inventory rather than maintaining a stale second slash-command list.
  const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const module = await import(new URL("./core/slash-commands.js", entry).href);
  if (!Array.isArray(module.BUILTIN_SLASH_COMMANDS)) fail("Pi command inventory unavailable");
  return module.BUILTIN_SLASH_COMMANDS.map((command: any) => ({ name: command.name, description: command.description ?? "", source: "builtin" }));
}
const inside = (root: string, path: string) => { const r = relative(root, path); return !!r && r !== ".." && !r.startsWith("../") && !isAbsolute(r); };
export function validateSessionPath(path: string, configuredDir: string): string {
  if (!clean(path) || !isAbsolute(path) || resolve(path) !== path || !path.endsWith(".jsonl")) fail("Invalid session path");
  const defaultRoot = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent"), "sessions");
  const root = inside(resolve(defaultRoot), resolve(configuredDir)) ? defaultRoot : configuredDir;
  const canonicalRoot = realpathSync(root);
  const canonical = realpathSync(path);
  if (canonical !== path || !inside(canonicalRoot, canonical) || !statSync(canonical).isFile()) fail("Session must be canonical and inside the session directory");
  const fd = openSync(canonical, "r");
  try {
    const buf = Buffer.alloc(65536);
    const count = readSync(fd, buf, 0, buf.length, 0);
    const line = buf.subarray(0, count).toString("utf8").split("\n")[0];
    const header = JSON.parse(line);
    if (header.type !== "session" || !clean(header.id) || !isAbsolute(header.cwd) || ![2, 3].includes(header.version)) fail("Invalid Pi session header");
  } finally { closeSync(fd); }
  return canonical;
}

export async function publishCatalog(pi: ExtensionAPI, pane: string, host: unknown, encoded: string) {
  if (!/^%\d+$/.test(pane) || Buffer.byteLength(encoded) > 128 * 1024) fail("Invalid UI catalog publication");
  const tmux = process.env.TMUX_BIN || "tmux";
  if (Buffer.byteLength(encoded) < 8 * 1024) return pi.exec(tmux, ["set-option", "-pq", "-t", pane, "@pi-ui-catalog", encoded], { timeout: 1000 });
  // tmux's client command IPC rejects large argv payloads ("command too long").
  // The server can parse a bounded source file instead. Never truncate discovery.
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
  const literal = (s: string) => s.replaceAll("#", "##").replaceAll(",", "#,").replaceAll("}", "#}");
  const dir = mkdtempSync(join(tmpdir(), "ultraterm-ui-catalog-"));
  try {
    const path = join(dir, "catalog.conf");
    const command = `set-option -pq -t ${pane} @pi-ui-catalog ${quote(encoded)}`;
    const expected = `#{==:#{@pi-primary-host},${literal(JSON.stringify(host))}}`;
    writeFileSync(path, `if-shell -F -t ${pane} ${quote(expected)} ${quote(command)} ''\n`, { mode: 0o600 });
    return await pi.exec(tmux, ["source-file", path], { timeout: 1000 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export function installUi(pi: ExtensionAPI, profiles: () => Profile[] = readProfiles, validatePath = validateSessionPath, hostIdentity = getPrimaryHostIdentity, builtins = builtinCommands, refreshFactory: () => ConfigRefresh = createConfigRefresher) {
  const stream = createUiStream(pi, hostIdentity);
  pi.on("message_start", (event, ctx) => { stream.start(event.message, ctx); });
  pi.on("message_update", event => { stream.update(event.message); });
  pi.on("message_end", event => { stream.update(event.message, true); });
  pi.on("agent_end", (_event, ctx) => { stream.end(); publish(ctx); });
  let generation = 0;
  let queue = Promise.resolve();
  let publishTimer: ReturnType<typeof setTimeout> | undefined;
  const refresher = refreshFactory();
  let configWatch: ReturnType<typeof setInterval> | undefined;
  let watchContext: ExtensionContext | undefined;
  const stopConfigWatch = () => {
    if (configWatch !== undefined) { clearInterval(configWatch); configWatch = undefined; }
    watchContext = undefined;
    refresher.stop();
  };
  const proven = (ctx: ExtensionContext) => { try { return !!hostIdentity(ctx.sessionManager); } catch { return false; } };
  const startConfigWatch = (ctx: ExtensionContext) => {
    // Sub-agent sessions share this extension instance; never let one without a
    // host-proven identity displace the session the catalog is published for.
    if (!watchContext || !proven(watchContext) || proven(ctx)) watchContext = ctx;
    if (configWatch !== undefined) return;
    // Bounded unref'd mtime poll: a config change must reach a running session
    // that is otherwise idle and therefore emits no publication event at all.
    configWatch = setInterval(() => { if (watchContext && refresher.changed()) publish(watchContext); }, CONFIG_POLL_MS);
    configWatch.unref?.();
  };
  pi.on("session_shutdown", () => { stream.reset(); generation++; clearTimeout(publishTimer); stopConfigWatch(); });
  const publish = (ctx: ExtensionContext, attempt = 0) => {
    const epoch = generation;
    clearTimeout(publishTimer);
    publishTimer = setTimeout(async () => {
      if (epoch !== generation) return;
      const host = hostIdentity(ctx.sessionManager);
      if (!host) { if (attempt < 30) publish(ctx, attempt + 1); return; }
      // Bounded, offline native reload so a freshly configured model or
      // credential is visible in this already-running session. It never selects
      // a model, changes thinking, touches scopes, or performs network work.
      // Never re-publish the native partial/error snapshot over last-good UI
      // data. This preserves publication only, not stale native credentials.
      try { await refresher.sync(ctx.modelRegistry); } catch { return; }
      if (epoch !== generation || hostIdentity(ctx.sessionManager) !== host) return;
      let models: Profile[] = [], commands: Array<{ name: string; description: string; source: string }> = [], commandsAvailable = true;
      try { models = catalogModels(ctx, profiles); } catch { /* Fail closed; no model choices. */ }
      try { commands = await builtins(); } catch { commandsAvailable = false; }
      if (epoch !== generation || hostIdentity(ctx.sessionManager) !== host) return;
      const extensionCommands = pi.getCommands().filter(command => command.name !== "ut-ui").map(({ name, description, source }) => ({ name, description: description ?? "", source }));
      commands = [...new Map([...commands, ...extensionCommands].map(command => [command.name, command])).values()];
      const catalog = { version: 1, generation: host.generation, sessionId: host.sessionId, pid: host.pid, commandsAvailable, commands, models, actions: ["resume", "message", "model"],
        ...(ctx.model ? { currentModel: { provider: ctx.model.provider, id: ctx.model.id, thinking: pi.getThinkingLevel() } } : {}) };
      // A new Pi session deliberately has no disk file yet. Publish bounded,
      // identity-bound capabilities separately; this is NOT a delivery receipt.
      const encoded = JSON.stringify(catalog);
      if (models.length > 512 || Buffer.byteLength(encoded) > 128 * 1024) {
        ctx.ui.notify("UI catalog exceeds publication size limit or 512 models; use native /model", "error");
        return;
      }
      pi.appendEntry("ultraterm.ui.catalog", catalog);
      if (/^%\d+$/.test(process.env.TMUX_PANE ?? "")) {
        // Use the same pinned executable as primary-host publication. A PATH
        // tmux can target an incompatible server and leave new sessions locked
        // until buffered history is written by their first message.
        try {
          const result = await publishCatalog(pi, process.env.TMUX_PANE!, host, encoded);
          if (result.code !== 0 && attempt < 30 && epoch === generation && hostIdentity(ctx.sessionManager) === host) publish(ctx, attempt + 1);
        } catch {
          if (attempt < 30 && epoch === generation && hostIdentity(ctx.sessionManager) === host) publish(ctx, attempt + 1);
        }
      }
    }, attempt ? 100 : 0);
    publishTimer.unref?.();
  };
  pi.on("session_start", (_event, ctx) => { stream.reset(); generation++; startConfigWatch(ctx); publish(ctx); });
  pi.on("session_tree", (_event, ctx) => { stream.reset(); generation++; startConfigWatch(ctx); publish(ctx); });
  pi.on("model_select", (_event, ctx) => publish(ctx));
  pi.on("thinking_level_select", (_event, ctx) => publish(ctx));
  pi.on("agent_start", (_event, ctx) => publish(ctx));
  pi.registerCommand("ut-ui", {
    description: "UltraTerm machine UI control (base64url JSON v1)",
    handler: async (encoded, ctx: ExtensionCommandContext) => {
      const epoch = generation, sm = ctx.sessionManager, id = sm.getSessionId(), file = sm.getSessionFile(), host = hostIdentity(sm);
      const same = () => { try { return !!host && hostIdentity(sm) === host && epoch === generation && ctx.sessionManager === sm && sm.getSessionId() === id && sm.getSessionFile() === file; } catch { return false; } };
      const guard = () => { if (!same()) fail("Session changed while UI request was queued"); if (!ctx.isIdle()) fail("Agent is no longer idle; no control applied"); };
      let request: Request | undefined;
      const result = (ok: boolean, message: string) => { if (!same()) return; try { ctx.ui.notify(message, ok ? "info" : "error"); pi.appendEntry("ultraterm.ui.result", { version: 1, requestId: request?.requestId, action: request?.action, ok, ...(ok ? { message } : { error: message }) }); } catch { /* Old runtime is revoked; never write into a replacement session. */ } };
      const run = async () => {
        try {
          request = decodeRequest(encoded);
          if (!host || request.sessionId !== host.sessionId || request.generation !== host.generation) fail("The target session changed before the request arrived");
          await ctx.waitForIdle(); guard();
          if (request.action === "resume") {
            const path = validatePath(request.path, sm.getSessionDir()); guard();
            // No old SDK closure may run against the replacement. The UI
            // confirms success from the new primary-host identity and snapshot,
            // not a queued receipt or an injected model-context message.
            const switched = await ctx.switchSession(path);
            if (switched.cancelled) result(false, "Session resume cancelled");
            return;
          }
          const r = request;
          // A catalog published before the change may already be stale: apply the
          // same bounded offline reload before resolving the native route.
          try { await refresher.sync(ctx.modelRegistry); } catch { fail("Native model configuration unavailable; use native /model"); }
          const scopeRevision = () => JSON.stringify(ctx.scopedModels.map(s => [s.model.provider, s.model.id, s.thinkingLevel]));
          const requestedScope = scopeRevision();
          const model = nativeModels(ctx).find(p => p.provider === r.model.provider && p.id === r.model.id);
          if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) fail("Model unavailable or credentials not configured");
          if (/gpt/i.test(model.id) && (model.provider !== "openai-codex" || model.api !== "openai-codex-responses" || !ctx.modelRegistry.isUsingOAuth(model))) fail("GPT requires paid openai-codex OAuth routing");
          const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
          if (!auth.ok) fail("Model credentials could not be resolved");
          guard();
          if (scopeRevision() !== requestedScope) fail("Model scope changed while credentials were resolving; retry the selection");
          if (!nativeModels(ctx).some(p => p.provider === model.provider && p.id === model.id) || !ctx.modelRegistry.hasConfiguredAuth(model)) fail("Model no longer available in native scope");
          const previous = ctx.model, effort = pi.getThinkingLevel();
          if (!previous) fail("Cannot safely restore an unknown previous model");
          let attempted = false, delivered = false;
          try {
            attempted = true;
            if (!await pi.setModel(model)) fail("Model selection failed");
            guard();
            pi.setThinkingLevel(r.thinking);
            guard();
            if (ctx.model?.provider !== model.provider || ctx.model?.id !== model.id || pi.getThinkingLevel() !== r.thinking) fail("Model/effort verification failed");
            if (r.action === "message") pi.sendUserMessage(r.text, { expandPromptTemplates: false });
            delivered = true;
          } catch (error) {
            if (attempted && !delivered && same() && ctx.isIdle() && ctx.model?.provider === model.provider && ctx.model?.id === model.id) {
              if (!await pi.setModel(previous!)) fail("Control failed; previous model could not be restored");
              guard(); pi.setThinkingLevel(effort);
              if (ctx.model?.provider !== previous.provider || ctx.model?.id !== previous.id || pi.getThinkingLevel() !== effort) fail("Control failed; previous model/effort could not be restored");
              publish(ctx);
            }
            throw error;
          }
          publish(ctx);
          result(true, r.action === "model" ? "Model and effort selected; tools and system prompt unchanged" : "Message submitted with selected model and effort; tools and system prompt unchanged");
        } catch (error) {
          // Never relay provider errors: they may contain credential material.
          const safe = error instanceof UiError ? error.message : "UI control failed; no further effects applied";
          result(false, safe);
        }
      };
      const next = queue.then(run, run); queue = next.catch(() => {}); await next;
    },
  });
}
export default function ultratermUi(pi: ExtensionAPI) { installUi(pi); }
