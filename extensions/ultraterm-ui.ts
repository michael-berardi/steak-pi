import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { openSync, readSync, closeSync, realpathSync, statSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, resolve, relative, join } from "node:path";
import { getPrimaryHostIdentity } from "../src/primary-host.ts";
import { createUiStream } from "../src/ui-stream.ts";

const LIMIT = 1024 * 1024;
const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Thinking = typeof levels[number];
type Request = { version: 1; requestId?: string; sessionId: string; generation: string } & ({ action: "resume"; path: string } | ({ action: "message"; text: string } | { action: "model" }) & { model: { provider: string; id: string }; thinking: Thinking });
export type Profile = { profileId: string; label: string; provider: string; id: string; thinking: Thinking };
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

export function readProfiles(directory = join(homedir(), ".config/ultraterm/harnesses")): Profile[] {
  const out: Profile[] = [];
  for (const harness of ["steak-pi", "pi"]) {
    let raw: Buffer;
    try { raw = readFileSync(join(directory, `${harness}.json`)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (raw.length > LIMIT) fail("Profile config too large");
    const config = JSON.parse(raw.toString("utf8"));
    if (config.schemaVersion !== 1 || !Array.isArray(config.profiles)) fail("Unsupported profile schema");
    for (const p of config.profiles) {
      // Deliberately refuse tool/system-prompt/extension/launcher overrides: no profile transfer.
      if (!object(p) || !clean(p.id) || !clean(p.name) || !Array.isArray(p.args) || p.args.length !== 4 || p.args[0] !== "--model" || p.args[2] !== "--thinking" || !levels.includes(p.args[3]) || !clean(p.args[1]) || Object.keys(p).some(k => !["id", "name", "description", "args", "workerDefault"].includes(k))) continue;
      const slash = p.args[1].indexOf("/");
      if (slash < 1 || slash === p.args[1].length - 1) continue;
      const previous = out.findIndex(profile => profile.profileId === `${harness}/${p.id}`);
      if (previous >= 0) out.splice(previous, 1);
      out.push({ profileId: `${harness}/${p.id}`, label: p.name, provider: p.args[1].slice(0, slash), id: p.args[1].slice(slash + 1), thinking: p.args[3] });
    }
  }
  return [...new Map(out.map(profile => [`${profile.provider}/${profile.id}/${profile.thinking}`, profile])).values()];
}

// Exactly the native /model source; profile metadata cannot add routes.
function nativeModels(ctx: ExtensionContext) {
  return ctx.scopedModels.length ? ctx.scopedModels.map(s => s.model) : ctx.modelRegistry.getAvailable();
}
export function catalogModels(ctx: ExtensionContext, metadata: () => Profile[] = readProfiles): Profile[] {
  let labels: Profile[] = [];
  try { labels = metadata(); } catch { /* Optional metadata must not hide native choices. */ }
  return nativeModels(ctx).filter(model => ctx.modelRegistry.hasConfiguredAuth(model)).map(model => {
    const label = labels.find(p => p.provider === model.provider && p.id === model.id);
    const scoped = ctx.scopedModels.find(s => s.model.provider === model.provider && s.model.id === model.id);
    return { profileId: label?.profileId ?? `${model.provider}/${model.id}`, label: label?.label ?? model.name ?? model.id,
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

export function installUi(pi: ExtensionAPI, profiles: () => Profile[] = readProfiles, validatePath = validateSessionPath, hostIdentity = getPrimaryHostIdentity, builtins = builtinCommands) {
  const stream = createUiStream(pi, hostIdentity);
  pi.on("message_start", (event, ctx) => { stream.start(event.message, ctx); });
  pi.on("message_update", event => { stream.update(event.message); });
  pi.on("message_end", event => { stream.update(event.message, true); });
  pi.on("agent_end", (_event, ctx) => { stream.end(); publish(ctx); });
  let generation = 0;
  let queue = Promise.resolve();
  let publishTimer: ReturnType<typeof setTimeout> | undefined;
  pi.on("session_shutdown", () => { stream.reset(); generation++; clearTimeout(publishTimer); });
  const publish = (ctx: ExtensionContext, attempt = 0) => {
    const epoch = generation;
    clearTimeout(publishTimer);
    publishTimer = setTimeout(async () => {
      if (epoch !== generation) return;
      const host = hostIdentity(ctx.sessionManager);
      if (!host) { if (attempt < 30) publish(ctx, attempt + 1); return; }
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
  pi.on("session_start", (_event, ctx) => { stream.reset(); generation++; publish(ctx); });
  pi.on("session_tree", (_event, ctx) => { stream.reset(); generation++; publish(ctx); });
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
          const model = nativeModels(ctx).find(p => p.provider === r.model.provider && p.id === r.model.id);
          if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) fail("Model unavailable or credentials not configured");
          if (/gpt/i.test(model.id) && (model.provider !== "openai-codex" || model.api !== "openai-codex-responses" || !ctx.modelRegistry.isUsingOAuth(model))) fail("GPT requires paid openai-codex OAuth routing");
          const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
          if (!auth.ok) fail("Model credentials could not be resolved");
          guard();
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
