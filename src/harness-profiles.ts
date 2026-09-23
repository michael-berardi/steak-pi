/**
 * Curated model scope: the UltraTerm sidebar's profile list, not the whole
 * authenticated provider library.
 *
 * The sidebar renders the profiles of the *selected harness* after the same
 * merge the app catalog performs (native `harnesses.rs`): the app-bundled
 * manifest catalog plus the live operator manifest directory. Native `/model`
 * and the UltraTerm composer picker must show that same effective set, so this
 * module is the one reader of the manifest metadata both pickers share:
 * `~/.config/ultraterm/harnesses/{selected harness}.json` (live, operator-owned)
 * merged over the app-bundled manifest directory. Adding a profile therefore
 * reaches both pickers without a code change and without any route being
 * hard-coded here, while a removed or invalid external manifest falls back to
 * the bundled catalog instead of replacing it — the app never drops its
 * built-in profiles, so neither does this reader.
 *
 * Only exact `--model provider/model` profiles with an explicit valid
 * `--thinking` level are native routes; the profile label and effort are
 * metadata. Nothing else in a manifest is consumed, executed or transferred —
 * tools, system prompts, extensions, launchers and credentials are refused.
 *
 * When no manifest exists anywhere the scope is *unknown* (`undefined`), and
 * callers keep the previous availability instead of hiding every model in a
 * broken install. An effective catalog that exists is authority, including when
 * it resolves no native route at all.
 */
import { lstatSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LIMIT = 1024 * 1024;
export const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = typeof levels[number];
export type HarnessProfile = { profileId: string; label: string; provider: string; id: string; thinking: Thinking };
/** Harness identity metadata already exported by the launcher/runtime. */
export const HARNESS_ID_VARS = ["ULTRATERM_HARNESS_ID", "ULTRATERM_HARNESS"] as const;
/** Live operator manifest directory; override for tests and packaged layouts. */
export const HARNESS_DIR_VAR = "ULTRATERM_HARNESS_DIR";
/** Bundled (app-owned) manifest catalog merged under the live one. */
export const HARNESS_RESOURCES_VAR = "ULTRATERM_HARNESS_RESOURCES";
export const DEFAULT_HARNESS_ID = "steak-pi";
export const HARNESS_SCHEMA_VERSION = 1;

export class HarnessProfileError extends Error {}

// Manifest limits and identity rules mirrored from the native harnesses.rs
// validation, so a manifest the app catalog rejects is rejected here too.
const MAX_LABEL_BYTES = 256;
const MAX_ARGUMENT_BYTES = 4096;
const MAX_ARGUMENTS = 64;
const MAX_MANIFEST_BYTES = 128 * 1024;
/** First-party Steak Pi profile retired in 2.2.0; the bundled catalog ships the
 * same route as the canonical `opencode-go` profile without the removed flag. */
const STEAK_PI_HARNESS = "steak-pi";
const RETIRED_STEAK_PI_PROFILES = new Set(["opencode-go-dsh", "claude-opus-5-5"]);

const object = (x: unknown): x is Record<string, any> => !!x && typeof x === "object" && !Array.isArray(x);
const clean = (x: unknown): x is string => typeof x === "string" && x.length > 0 && !/[\x00-\x1f\x7f-\x9f]/u.test(x);
const level = (x: unknown): x is Thinking => typeof x === "string" && (levels as readonly string[]).includes(x);
const byteLength = (x: string) => Buffer.byteLength(x, "utf8");
const nativeId = (x: unknown): x is string =>
  typeof x === "string" && x.length > 0 && x.length <= 48 && !x.startsWith("-") && !x.endsWith("-") &&
  !x.includes("--") && /^[a-z0-9-]+$/.test(x);
const nativeLabel = (x: unknown): x is string => typeof x === "string" && x.trim().length > 0 && byteLength(x) <= MAX_LABEL_BYTES;
const nativeText = (x: unknown): x is string => typeof x === "string" && x.trim().length > 0 && byteLength(x) <= MAX_ARGUMENT_BYTES && !x.includes("\0");

export const routeKey = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;

/** The harness identity UltraTerm launched this session for. */
export function activeHarnessId(env: NodeJS.ProcessEnv = process.env): string {
  for (const name of HARNESS_ID_VARS) if (clean(env[name]) && env[name]!.length <= 128) return env[name]!;
  return DEFAULT_HARNESS_ID;
}

/** Bundled (app-owned) manifest directory: the compiled-in catalog natively,
 * the resources directory the launcher exports here. */
export function bundledHarnessDir(env: NodeJS.ProcessEnv = process.env): string {
  return clean(env[HARNESS_RESOURCES_VAR])
    ? env[HARNESS_RESOURCES_VAR]!
    : join(dirname(fileURLToPath(import.meta.url)), "..", "resources", "harnesses");
}

/** Live operator manifests first, then the bundled catalog they merge onto. */
export function harnessProfileDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const live = clean(env[HARNESS_DIR_VAR]) ? env[HARNESS_DIR_VAR]! : join(homedir(), ".config", "ultraterm", "harnesses");
  return [...new Set([live, bundledHarnessDir(env)])];
}

/** Candidate manifest paths for the selected harness, in precedence order. */
export function harnessManifestPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const harness = activeHarnessId(env);
  return harnessProfileDirs(env).map(directory => join(directory, `${harness}.json`));
}

/** mtime/size revision of the selected harness manifest(s) across BOTH sources —
 * the live directory and the bundled catalog — including absence, so a created,
 * edited or deleted manifest on either side (bundle or operator file) is
 * observable without reading it twice. */
export function harnessManifestRevision(env: NodeJS.ProcessEnv = process.env): string {
  return `${activeHarnessId(env)}:${harnessManifestPaths(env).map(fileRevision).join("|")}`;
}

function fileRevision(path: string): string {
  try {
    const stat = statSync(path, { throwIfNoEntry: false });
    return `${path}:${stat ? `${stat.mtimeMs}:${stat.size}` : "absent"}`;
  } catch {
    // Unreadable stays distinguishable from absent so a later readable revision
    // is still detected; never throw into a picker or config watcher.
    return `${path}:unreadable`;
  }
}

function sourcesOf(sources: string | readonly string[]): readonly string[] {
  return typeof sources === "string" ? [sources] : sources;
}

/** True only for the retired first-party Steak Pi DSH profile. Every other
 * harness and profile id — including a custom harness that happens to reuse the
 * retired string — is user-owned and is never rewritten or dropped. */
function isRetiredFirstPartyProfile(harness: string, profileId: unknown): boolean {
  return harness === STEAK_PI_HARNESS && typeof profileId === "string" && RETIRED_STEAK_PI_PROFILES.has(profileId);
}

/** The native `validate()` rules a manifest must satisfy, minus
 * `profile_routes::validate_args`: model-flag policy stays with the runtime
 * policy modules, and the curated extraction below only ever consumes exact
 * `--model`/`--thinking` pairs. */
function nativeManifestError(config: Record<string, any>, builtIn: boolean): string | undefined {
  if (config.schemaVersion !== HARNESS_SCHEMA_VERSION || !nativeId(config.id)) {
    return "schemaVersion must be 1 and id must be lowercase kebab-case";
  }
  if (!nativeLabel(config.name) || !nativeText(config.description) || !nativeText(config.executable)) {
    return "name, description, and executable are invalid";
  }
  if (config.launcher !== "generic" && config.launcher !== "omp") return "launcher must be generic or omp";
  if (!builtIn && config.launcher !== "generic") return "external manifests may only use the generic launcher";
  if (config.profileSource !== "static" && config.profileSource !== "omp") return "profileSource must be static or omp";
  if (!builtIn && config.profileSource !== "static") return "external manifests must use static profiles";
  if (!Array.isArray(config.profiles)) return "profiles must be an array";
  if (config.profileSource === "static" && config.profiles.length === 0) return "static harnesses require at least one profile";
  const ids = new Set<string>();
  for (const p of config.profiles) {
    if (!object(p) || !nativeId(p.id) || !nativeLabel(p.name) || !nativeText(p.description) ||
        !Array.isArray(p.args) || !p.args.every(clean)) return "every profile requires a valid id, name, and description";
    if (ids.has(p.id)) return `duplicate profile id: ${p.id}`;
    ids.add(p.id);
    if (p.args.length > MAX_ARGUMENTS || p.args.some(a => byteLength(a) > MAX_ARGUMENT_BYTES || a.includes("\0"))) {
      return "profile arguments exceed the manifest limits";
    }
  }
  return undefined;
}

/** Shape gate shared by every manifest read: same refusal as before, now reused
 * by both the curated-only parse and the effective merge. */
function parseManifestConfig(raw: Buffer): Record<string, any> {
  if (raw.length > LIMIT) throw new HarnessProfileError("Profile config too large");
  let config: any;
  try { config = JSON.parse(raw.toString("utf8")); } catch { throw new HarnessProfileError("Unsupported harness manifest JSON"); }
  if (!object(config) || config.schemaVersion !== HARNESS_SCHEMA_VERSION || !Array.isArray(config.profiles)) {
    throw new HarnessProfileError("Unsupported profile schema");
  }
  return config;
}

/**
 * Parse one harness manifest into native routes. Metadata only: profile entries
 * that carry any other override (extension, tool, system prompt, launcher) or an
 * incompatible `--model`/`--thinking` shape are skipped, never transferred. A
 * launch-only paid flag is recognized solely as an authorization hint naming the
 * same route; it is not a native route of its own.
 */
export function parseHarnessProfiles(raw: Buffer | string, harness: string): HarnessProfile[] {
  return curatedProfiles(parseManifestConfig(typeof raw === "string" ? Buffer.from(raw, "utf8") : raw), harness);
}

/** Curated route extraction over already-validated manifest profiles. */
function curatedProfiles(config: Record<string, any>, harness: string): HarnessProfile[] {
  const out: HarnessProfile[] = [];
  for (const p of config.profiles) {
    // Deliberately refuse tool/system-prompt/extension/launcher overrides: no profile transfer.
    if (!object(p) || !clean(p.id) || !clean(p.name) || !Array.isArray(p.args) || !p.args.every(clean) ||
        Object.keys(p).some(k => !["id", "name", "description", "args", "workerDefault", "reviewerDefault"].includes(k))) continue;
    // This flag authorizes the launch, not a transferable tool/prompt override.
    // Recognize it only when it names the same model; execution remains guarded.
    const args: string[] = [], grants: string[] = [];
    for (let i = 0; i < p.args.length; i++) {
      const arg = p.args[i] as string;
      if (arg === "--steak-pi-paid-route") grants.push(p.args[++i] ?? "");
      else if (arg.startsWith("--steak-pi-paid-route=")) grants.push(arg.slice("--steak-pi-paid-route=".length));
      else args.push(arg);
    }
    if (args.length !== 4 || args[0] !== "--model" || args[2] !== "--thinking" || !level(args[3]) ||
        grants.length > 1 || grants.some(route => route !== args[1])) continue;
    const slash = args[1].indexOf("/");
    if (slash < 1 || slash === args[1].length - 1) continue;
    const previous = out.findIndex(profile => profile.profileId === `${harness}/${p.id}`);
    if (previous >= 0) out.splice(previous, 1);
    out.push({ profileId: `${harness}/${p.id}`, label: p.name, provider: args[1].slice(0, slash), id: args[1].slice(slash + 1), thinking: args[3] });
  }
  return [...new Map(out.map(profile => [`${profile.provider}/${profile.id}/${profile.thinking}`, profile])).values()];
}

type Candidate = { path: string; config: Record<string, any> };
type Resolved = { manifest: string; profiles: HarnessProfile[] };

/** The bundled candidate stands in for a compiled-in resource: present means
 * authority, so a manifest that cannot be read or parsed fails the catalog
 * instead of being silently skipped. */
function bundledCandidate(harness: string): Candidate | undefined {
  const path = join(bundledHarnessDir(), `${harness}.json`);
  let raw: Buffer;
  try { raw = readFileSync(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  return { path, config: parseManifestConfig(raw) };
}

/** An external candidate mirrors the native directory scan: a regular file (never
 * a symlink) of at most 128 KiB, and any read/parse/validation failure ignores
 * the manifest instead of failing the catalog. */
function externalCandidate(directory: string, harness: string): Candidate | undefined {
  const path = join(directory, `${harness}.json`);
  try {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat || !stat.isFile() || stat.size > MAX_MANIFEST_BYTES) return undefined;
    return { path, config: parseManifestConfig(readFileSync(path)) };
  } catch {
    return undefined;
  }
}

/** The effective catalog for the selected harness: the bundled manifest merged
 * with at most one unambiguous external manifest, exactly like the app catalog
 * (`manifests_at`/`merge_external_profiles`/`add_external_manifests`). The
 * external manifest may only *append* profiles to a bundled harness with the
 * same identity, a generic launcher, static profiles and the same executable;
 * colliding profile ids keep the bundled route, the retired first-party DSH
 * profile is normalized away, and an invalid, incompatible or ambiguous
 * external manifest is ignored so the bundled catalog survives intact. An
 * external manifest without a bundled counterpart is a registered custom
 * harness and stands alone. A harness with no manifest anywhere is *unknown*.
 */
function resolveHarnessManifest(sources: string | readonly string[], harness: string): Resolved {
  const bundledDir = bundledHarnessDir();
  const bundled = bundledCandidate(harness);
  const externals = [...new Set(sourcesOf(sources))]
    .filter(directory => directory !== bundledDir)
    .map(directory => externalCandidate(directory, harness))
    .filter((candidate): candidate is Candidate => !!candidate);
  const standalone = externals[0];
  if (!bundled) {
    if (!standalone) throw new HarnessProfileError(`Harness manifest ${harness}.json was not found`);
    // Registered custom harness: the app validated it at write time.
    return { manifest: standalone.path, profiles: curatedProfiles(standalone.config, harness) };
  }
  const bundledError = nativeManifestError(bundled.config, true);
  if (bundledError) throw new HarnessProfileError(`Invalid bundled harness manifest ${bundled.path}: ${bundledError}`);
  // More than one external manifest for one id has no unambiguous precedence:
  // every merge for that id is skipped and the bundled catalog stands alone.
  const compatible = externals.length === 1 && !!standalone && !nativeManifestError(standalone.config, false) &&
    standalone.config.id === bundled.config.id &&
    bundled.config.launcher === "generic" && bundled.config.profileSource === "static" &&
    bundled.config.executable === standalone.config.executable;
  if (!compatible) return { manifest: bundled.path, profiles: curatedProfiles(bundled.config, harness) };
  const bundledIds = new Set(bundled.config.profiles.map((p: any) => p?.id));
  const merged = [
    ...bundled.config.profiles,
    ...standalone.config.profiles.filter((p: any) => !isRetiredFirstPartyProfile(harness, p?.id) && !bundledIds.has(p?.id)),
  ];
  return { manifest: standalone.path, profiles: curatedProfiles({ ...bundled.config, profiles: merged }, harness) };
}

/** Effective curated profile routes for the selected harness: bundled catalog
 * plus operator additions. Throws when the selected harness has no readable
 * manifest; a manifest with no native route yields []. */
export function readHarnessProfiles(sources: string | readonly string[] = harnessProfileDirs(), harness: string = activeHarnessId()): HarnessProfile[] {
  return resolveHarnessManifest(sources, harness).profiles;
}

type ScopeEntry = { key: string; revision: string; scope: Set<string> | undefined };
let cachedScope: ScopeEntry | undefined;

/**
 * The one curated route set both pickers render, or `undefined` when the selected
 * harness has no manifest yet (callers keep previous availability). Cached by
 * manifest revision — which watches the live directory AND the bundled catalog —
 * so a profile add/remove/rename on either side is picked up on the next
 * registry refresh without re-reading unchanged files on every call.
 */
export function curatedPickerScope(env: NodeJS.ProcessEnv = process.env): Set<string> | undefined {
  const harness = activeHarnessId(env);
  const sources = harnessProfileDirs(env);
  const key = `${harness}\u0000${sources.join("\u0000")}`;
  const revision = harnessManifestRevision(env);
  if (cachedScope && cachedScope.key === key && cachedScope.revision === revision) return cachedScope.scope;
  let scope: Set<string> | undefined;
  try {
    // An effective catalog that exists is authority even when it names no native route.
    scope = new Set(resolveHarnessManifest(sources, harness).profiles.map(routeKey));
  } catch {
    // Malformed metadata must never hide a healthy native catalog.
    scope = undefined;
  }
  cachedScope = { key, revision, scope };
  return scope;
}
