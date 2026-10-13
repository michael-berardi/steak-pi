/**
 * Explicit Claude API route for USAP (`claude-code-api/<model>`).
 *
 * This is a DISTINCT route, not a variant of the subscription route. The
 * subscription route (`claude-code/<model>`, claude-worker.ts) strips every API
 * credential and requires a claude.ai login; it is the only Claude route that
 * default, automatic and fallback routing may ever reach. This route is reachable
 * only when a caller names it exactly, and only while an operator-authored,
 * task-scoped approval record admits it.
 *
 * Why it exists: Anthropic's monthly API credits for Max and Team plans cover the
 * Claude API, the Agent SDK and `claude -p` that you run yourself with an API key
 * from the linked Console organization. They do NOT cover interactive Claude Code
 * (terminal, IDE, desktop, web) or runs started by the GitHub Action, an IDE
 * extension or the desktop app, even with -p. Source:
 * https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans
 * Headless `claude -p` under the official coordinator is therefore the supported
 * use; no header or client spoofing is involved, and the launch is the unmodified
 * official CLI in `--bare` mode (OAuth and keychain are never read).
 *
 * Secret handling: this module reads only STRUCTURE from the settings file. The
 * API key stays behind the settings' `apiKeyHelper`, which the CLI itself runs;
 * USAP never executes the helper, never reads its output, and never places a key,
 * header or helper path in a prompt, log, receipt or error message.
 */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CLAUDE_CODE_OPUS_MODEL, CLAUDE_CODE_SONNET_MODEL, claudeCodeModelOf, type ClaudeCodeModel } from "./model-selection.ts";
import type { ClaudeApiReceipt, ModelSelection } from "./types.ts";

export const CLAUDE_API_PROVIDER = "claude-code-api" as const;
export const CLAUDE_API_SONNET_ROUTE = `${CLAUDE_API_PROVIDER}/${CLAUDE_CODE_SONNET_MODEL}` as const;
export const CLAUDE_API_OPUS_ROUTE = `${CLAUDE_API_PROVIDER}/${CLAUDE_CODE_OPUS_MODEL}` as const;
export const CLAUDE_API_ROUTES: readonly string[] = [CLAUDE_API_SONNET_ROUTE, CLAUDE_API_OPUS_ROUTE];
/** Task roles an approval can scope to (verification is the reviewer role). */
export const CLAUDE_API_ROLES: readonly string[] = ["scout", "worker", "reviewer"];
export const CLAUDE_API_CONFIG_ENV = "USAP_CLAUDE_API_CONFIG";
export const CLAUDE_API_DEFAULT_CONFIG_PATH = join(homedir(), ".config", "ultraterm", "usap-claude-api.json");
export const CLAUDE_API_OFFICIAL_SOURCE = "https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans";

/** Hard ceilings no approval record can raise. */
export const CLAUDE_API_MAX_LEAF_USD = 10;
export const CLAUDE_API_MAX_RUN_USD = 25;
/** Below this a leaf cannot do useful work; refuse rather than launch a doomed child. */
export const CLAUDE_API_MIN_LEAF_USD = 0.05;
/** Finite credits: an API wave runs at most this wide, whatever the dispatch asked for. */
export const CLAUDE_API_MAX_CONCURRENCY = 3;
/** Approvals are time-boxed to roughly one monthly credit cycle. */
export const CLAUDE_API_MAX_APPROVAL_DAYS = 31;

const CONFIG_MAX_BYTES = 16 * 1024;
const SETTINGS_MAX_BYTES = 8 * 1024;
const SAFE_TEXT = /^[A-Za-z0-9][A-Za-z0-9 ._:@\/+,()-]{0,199}$/;
const WORKSPACE_HEADER = /^anthropic-workspace-id: wrkspc_[A-Za-z0-9]{8,64}$/;
const HELPER_PATH = /^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/;

export type ClaudeApiAdmissionCode =
  | "route-not-api" | "approval-missing" | "approval-invalid" | "approval-expired" | "route-not-approved" | "role-not-approved"
  | "settings-invalid" | "budget-invalid" | "budget-exhausted" | "unsupported-feature";

/** Named, value-free failure. The message is safe to show, log and persist. */
export class ClaudeApiAdmissionError extends Error {
  readonly code: ClaudeApiAdmissionCode;
  constructor(code: ClaudeApiAdmissionCode, message: string) {
    super(`ClaudeApiAdmissionError[${code}]: ${message}; no subscription, Sol or other fallback was selected`);
    this.name = "ClaudeApiAdmissionError";
    this.code = code;
  }
}

/** The pinned model behind an exact `claude-code-api/…` route; never prefix or fuzzy. */
export function claudeApiModelOf(route: string | undefined): ClaudeCodeModel | undefined {
  if (route === CLAUDE_API_SONNET_ROUTE) return CLAUDE_CODE_SONNET_MODEL;
  if (route === CLAUDE_API_OPUS_ROUTE) return CLAUDE_CODE_OPUS_MODEL;
  return undefined;
}
export const isClaudeApiRoute = (route: string | undefined): boolean => claudeApiModelOf(route) !== undefined;
/** Model of either Claude route family (subscription or explicit API). */
export function anyClaudeRouteModelOf(route: string | undefined): ClaudeCodeModel | undefined {
  return claudeCodeModelOf(route) ?? claudeApiModelOf(route);
}

export function resolveClaudeApiSelection(model: ClaudeCodeModel): ModelSelection {
  // Images are not admitted on this route in phase A (fail closed in admission).
  return { provider: CLAUDE_API_PROVIDER, modelId: model, source: "override", harness: "claude-code", images: false, tools: true };
}

export interface ClaudeApiConfig {
  path: string;
  /** First 12 hex of the approval record's SHA-256; names this exact record version. */
  approvalId: string;
  approval: { approvedBy: string; source: string; task: string; approvedAt: string; expiresAt: string };
  routes: readonly string[];
  /** Task roles the operator approved for this route; any other role is refused. */
  roles: readonly string[];
  settingsPath: string;
  /** First 12 hex of the settings file's SHA-256 (structure fingerprint, not a secret). */
  settingsDigest: string;
  budget: { maxLeafUsd: number; maxRunUsd: number };
}

export interface ClaudeApiConfigOptions {
  env?: NodeJS.ProcessEnv;
  /** Explicit approval record path; wins over the environment and the default. */
  configPath?: string;
  now?: () => number;
  /** Test seam for ownership checks. */
  uid?: number;
}

function fail(code: ClaudeApiAdmissionCode, message: string): never { throw new ClaudeApiAdmissionError(code, message); }

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function strictKeys(value: Record<string, unknown>, allowed: readonly string[], where: string, code: ClaudeApiAdmissionCode): void {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  // Key NAMES are reported (they are schema, not secret); values never are.
  if (extra.length > 0) fail(code, `${where} has unsupported key(s) ${extra.slice(0, 4).map((key) => JSON.stringify(key.slice(0, 40))).join(", ")}`);
}

/** The directory that holds a trusted file must be one nobody else can rename or replace entries in. */
function assertSafeDirectory(file: string, what: string, code: ClaudeApiAdmissionCode, uid: number | undefined): void {
  let stat;
  try { stat = lstatSync(dirname(file)); } catch { fail(code, `the directory of the ${what} could not be inspected`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(code, `the directory of the ${what} must be a real directory`);
  if (uid !== undefined && stat.uid !== uid) fail(code, `the directory of the ${what} must be owned by the current user`);
  if ((stat.mode & 0o022) !== 0) fail(code, `the directory of the ${what} must not be writable by group or others`);
}

/** Open with O_NOFOLLOW and judge the opened descriptor: regular file, current user, no group/other access. */
function readPrivateFile(path: string, maxBytes: number, what: string, code: ClaudeApiAdmissionCode, uid: number | undefined): Buffer {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile()) fail(code, `${what} must be a regular file`);
    if (stat.size > maxBytes) fail(code, `${what} exceeds ${maxBytes} bytes`);
    if (uid !== undefined && stat.uid !== uid) fail(code, `${what} must be owned by the current user`);
    if ((stat.mode & 0o077) !== 0) fail(code, `${what} must not be accessible by group or others (chmod 600)`);
    assertSafeDirectory(path, what, code, uid);
    return readFileSync(fd);
  } catch (error) {
    if (error instanceof ClaudeApiAdmissionError) throw error;
    const errno = (error as NodeJS.ErrnoException).code;
    if (errno === "ENOENT") fail(code === "approval-invalid" ? "approval-missing" : code, `${what} does not exist`);
    if (errno === "ELOOP") fail(code, `${what} must not be a symbolic link`);
    return fail(code, `${what} could not be read (${errno ?? "error"})`);
  } finally { if (fd !== undefined) closeSync(fd); }
}

function parseObject(bytes: Buffer, what: string, code: ClaudeApiAdmissionCode): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { fail(code, `${what} is not valid JSON`); }
  if (!isRecord(value)) fail(code, `${what} must be a JSON object`);
  return value;
}

const digest = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex").slice(0, 12);
const safeText = (value: unknown, where: string): string => {
  if (typeof value !== "string" || !SAFE_TEXT.test(value)) fail("approval-invalid", `${where} must be 1-200 plain characters`);
  return value;
};
const isoTime = (value: unknown, where: string): number => {
  const ms = typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(ms)) fail("approval-invalid", `${where} must be a UTC ISO-8601 timestamp (YYYY-MM-DDTHH:MM:SSZ)`);
  return ms;
};
const usd = (value: unknown, where: string, max: number): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < CLAUDE_API_MIN_LEAF_USD || value > max) {
    fail("budget-invalid", `${where} must be a number from ${CLAUDE_API_MIN_LEAF_USD} to ${max} USD`);
  }
  return Math.round(value * 100) / 100;
};

/**
 * Validate the approved settings file STRUCTURE. Exactly `apiKeyHelper` (an
 * absolute path to an executable the current user owns and nobody else can
 * write) and `env.ANTHROPIC_CUSTOM_HEADERS` (one Console workspace header) are
 * allowed. Anything else — a base URL, a key, a token, a provider switch, hooks,
 * permissions, MCP servers — would let the file redirect or widen the route and
 * is rejected by name without echoing any value.
 */
function validateSettings(path: string, uid: number | undefined): string {
  if (typeof path !== "string" || !path.startsWith("/") || path.length > 512 || /[\u0000-\u001f\u007f]/.test(path)) fail("settings-invalid", "settingsPath must be an absolute path");
  const bytes = readPrivateFile(path, SETTINGS_MAX_BYTES, "settings file", "settings-invalid", uid);
  const settings = parseObject(bytes, "settings file", "settings-invalid");
  strictKeys(settings, ["apiKeyHelper", "env"], "settings file", "settings-invalid");
  const helper = settings.apiKeyHelper;
  if (typeof helper !== "string" || !HELPER_PATH.test(helper) || helper.split("/").includes("..")) {
    fail("settings-invalid", "settings.apiKeyHelper must be an absolute path to an approved helper executable (no arguments, no shell syntax)");
  }
  let stat;
  try { stat = lstatSync(helper); } catch { fail("settings-invalid", "settings.apiKeyHelper does not exist"); }
  if (!stat.isFile() || stat.isSymbolicLink()) fail("settings-invalid", "settings.apiKeyHelper must be a regular, non-symlink file");
  if (uid !== undefined && stat.uid !== uid) fail("settings-invalid", "settings.apiKeyHelper must be owned by the current user");
  if ((stat.mode & 0o022) !== 0) fail("settings-invalid", "settings.apiKeyHelper must not be writable by group or others");
  if ((stat.mode & 0o100) === 0) fail("settings-invalid", "settings.apiKeyHelper must be executable");
  assertSafeDirectory(helper, "settings.apiKeyHelper", "settings-invalid", uid);
  const env = settings.env;
  if (!isRecord(env)) fail("settings-invalid", "settings.env must hold the Console workspace header (ANTHROPIC_CUSTOM_HEADERS)");
  strictKeys(env, ["ANTHROPIC_CUSTOM_HEADERS"], "settings.env", "settings-invalid");
  if (typeof env.ANTHROPIC_CUSTOM_HEADERS !== "string" || !WORKSPACE_HEADER.test(env.ANTHROPIC_CUSTOM_HEADERS)) {
    fail("settings-invalid", "settings.env.ANTHROPIC_CUSTOM_HEADERS must be exactly one anthropic-workspace-id header");
  }
  return digest(bytes);
}

/** Load and fully validate the task-scoped approval record. */
export function loadClaudeApiConfig(options: ClaudeApiConfigOptions = {}): ClaudeApiConfig {
  const env = options.env ?? process.env;
  const path = options.configPath ?? (env[CLAUDE_API_CONFIG_ENV]?.trim() || CLAUDE_API_DEFAULT_CONFIG_PATH);
  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  if (!path.startsWith("/")) fail("approval-invalid", `${CLAUDE_API_CONFIG_ENV} must be an absolute path`);
  let bytes: Buffer;
  try { bytes = readPrivateFile(path, CONFIG_MAX_BYTES, "API route approval record", "approval-invalid", uid); }
  catch (error) {
    if (error instanceof ClaudeApiAdmissionError && error.code === "approval-missing") {
      fail("approval-missing", `the Claude API route is not approved: no operator approval record at ${path}. Create it (mode 600) with an approval, routes, settingsPath and budget, or set ${CLAUDE_API_CONFIG_ENV}; USAP never writes this record or ~/.pi/agent/paid-routes.json`);
    }
    throw error;
  }
  const record = parseObject(bytes, "API route approval record", "approval-invalid");
  strictKeys(record, ["version", "approval", "routes", "roles", "settingsPath", "budget"], "approval record", "approval-invalid");
  if (record.version !== 1) fail("approval-invalid", "approval record version must be 1");
  if (!isRecord(record.approval)) fail("approval-invalid", "approval record needs an approval object");
  strictKeys(record.approval, ["approvedBy", "source", "task", "approvedAt", "expiresAt"], "approval", "approval-invalid");
  const approval = {
    approvedBy: safeText(record.approval.approvedBy, "approval.approvedBy"),
    source: safeText(record.approval.source, "approval.source"),
    task: safeText(record.approval.task, "approval.task"),
    approvedAt: String(record.approval.approvedAt), expiresAt: String(record.approval.expiresAt),
  };
  const approvedMs = isoTime(record.approval.approvedAt, "approval.approvedAt");
  const expiresMs = isoTime(record.approval.expiresAt, "approval.expiresAt");
  if (expiresMs <= approvedMs) fail("approval-invalid", "approval.expiresAt must be after approval.approvedAt");
  if (expiresMs - approvedMs > CLAUDE_API_MAX_APPROVAL_DAYS * 86_400_000) fail("approval-invalid", `approval may last at most ${CLAUDE_API_MAX_APPROVAL_DAYS} days`);
  const now = (options.now ?? Date.now)();
  if (approvedMs > now + 60_000) fail("approval-invalid", "approval.approvedAt is in the future");
  if (now >= expiresMs) fail("approval-expired", `the operator approval expired at ${approval.expiresAt}; renew it explicitly`);
  if (!Array.isArray(record.routes) || record.routes.length < 1 || record.routes.length > CLAUDE_API_ROUTES.length
    || !record.routes.every((route) => typeof route === "string" && CLAUDE_API_ROUTES.includes(route)) || new Set(record.routes).size !== record.routes.length) {
    fail("approval-invalid", `routes must list each approved route once from: ${CLAUDE_API_ROUTES.join(", ")}`);
  }
  if (!Array.isArray(record.roles) || record.roles.length < 1 || record.roles.length > CLAUDE_API_ROLES.length
    || !record.roles.every((role) => typeof role === "string" && CLAUDE_API_ROLES.includes(role)) || new Set(record.roles).size !== record.roles.length) {
    fail("approval-invalid", `roles must list each approved task role once from: ${CLAUDE_API_ROLES.join(", ")}`);
  }
  if (!isRecord(record.budget)) fail("budget-invalid", "approval record needs a budget object");
  strictKeys(record.budget, ["maxLeafUsd", "maxRunUsd"], "budget", "budget-invalid");
  const maxLeafUsd = usd(record.budget.maxLeafUsd, "budget.maxLeafUsd", CLAUDE_API_MAX_LEAF_USD);
  const maxRunUsd = usd(record.budget.maxRunUsd, "budget.maxRunUsd", CLAUDE_API_MAX_RUN_USD);
  if (maxLeafUsd > maxRunUsd) fail("budget-invalid", "budget.maxLeafUsd cannot exceed budget.maxRunUsd");
  const settingsDigest = validateSettings(record.settingsPath as string, uid);
  return {
    path, approvalId: digest(bytes), approval, routes: [...record.routes as string[]], roles: [...record.roles as string[]],
    settingsPath: record.settingsPath as string, settingsDigest, budget: { maxLeafUsd, maxRunUsd },
  };
}

export interface ClaudeApiAdmissionInput {
  route: string | undefined;
  taskCount: number;
  /** Spend already booked against this leaf (automatic or bounded explicit resume). */
  priorSpendUsd?: number;
  /** Role of every task in the wave; each must be one the operator approved. */
  roles?: readonly string[];
  /** Ceiling fixed at the ORIGINAL dispatch; a resume can lower but never raise it. */
  leafCapLimitUsd?: number;
  requireImages?: boolean;
}
export interface ClaudeApiAdmission {
  route: string;
  model: ClaudeCodeModel;
  settingsPath: string;
  settingsDigest: string;
  approval: { id: string; task: string; approvedBy: string; source: string; roles: string[]; expiresAt: string };
  /** `--max-budget-usd` for ONE leaf session, after prior spend. */
  leafBudgetUsd: number;
  leafCapUsd: number;
  runCapUsd: number;
  priorSpendUsd: number;
}

/** Per-leaf ceiling: the leaf cap, further limited so every leaf of the run fits the run cap. */
export function claudeApiLeafCapUsd(config: Pick<ClaudeApiConfig, "budget">, taskCount: number): number {
  if (!Number.isSafeInteger(taskCount) || taskCount < 1) fail("budget-invalid", "a run needs at least one task");
  const share = Math.floor((config.budget.maxRunUsd / taskCount) * 100) / 100;
  const cap = Math.min(config.budget.maxLeafUsd, share);
  if (cap < CLAUDE_API_MIN_LEAF_USD) fail("budget-invalid", `the run budget (${config.budget.maxRunUsd} USD) leaves under ${CLAUDE_API_MIN_LEAF_USD} USD for each of ${taskCount} tasks; dispatch fewer tasks or raise the approved run budget`);
  return cap;
}

/** Dispatch width for an API wave: the requested (or task-count) width, never above the credit-protecting cap. */
export function claudeApiConcurrency(requested: number | undefined, taskCount: number): number {
  const wanted = Number.isInteger(requested) && (requested as number) >= 1 ? requested as number : taskCount;
  return Math.max(1, Math.min(wanted, taskCount, CLAUDE_API_MAX_CONCURRENCY));
}

/** The one admission decision, re-run at dispatch and again at every CLI launch. */
export function admitClaudeApiRoute(input: ClaudeApiAdmissionInput, options: ClaudeApiConfigOptions = {}): ClaudeApiAdmission {
  const model = claudeApiModelOf(input.route);
  if (model === undefined) fail("route-not-api", `${JSON.stringify(String(input.route).slice(0, 80))} is not an exact Claude API route (${CLAUDE_API_ROUTES.join(" or ")})`);
  if (input.requireImages === true) fail("unsupported-feature", "image review is not enabled on the Claude API route; use the subscription route for image review");
  const config = loadClaudeApiConfig(options);
  if (!config.routes.includes(input.route!)) fail("route-not-approved", `${input.route} is not listed in the approval record (approved: ${config.routes.join(", ")})`);
  for (const role of new Set(input.roles ?? [])) {
    if (!config.roles.includes(role)) fail("role-not-approved", `task role ${JSON.stringify(String(role).slice(0, 20))} is not approved for this route (approved roles: ${config.roles.join(", ")}); the approval is scoped to its stated work, not a blanket paid-route grant`);
  }
  const prior = typeof input.priorSpendUsd === "number" && Number.isFinite(input.priorSpendUsd) && input.priorSpendUsd > 0 ? input.priorSpendUsd : 0;
  const limit = typeof input.leafCapLimitUsd === "number" && Number.isFinite(input.leafCapLimitUsd) && input.leafCapLimitUsd > 0 ? input.leafCapLimitUsd : Number.POSITIVE_INFINITY;
  const leafCapUsd = Math.min(claudeApiLeafCapUsd(config, input.taskCount), limit);
  const remaining = Math.floor((leafCapUsd - prior) * 100) / 100;
  if (remaining < CLAUDE_API_MIN_LEAF_USD) fail("budget-exhausted", `this leaf already spent ${prior.toFixed(2)} of its ${leafCapUsd.toFixed(2)} USD ceiling`);
  return {
    route: input.route!, model, settingsPath: config.settingsPath, settingsDigest: config.settingsDigest,
    approval: { id: config.approvalId, task: config.approval.task, approvedBy: config.approval.approvedBy, source: config.approval.source, roles: [...config.roles], expiresAt: config.approval.expiresAt },
    leafBudgetUsd: remaining, leafCapUsd, runCapUsd: config.budget.maxRunUsd, priorSpendUsd: prior,
  };
}

/** Fix the admitted per-leaf ceiling on every task so resumes cannot widen it. */
export function stampClaudeApiRun<T extends { tasks: Array<{ apiLeafCapUsd?: number }> }>(run: T, admission: Pick<ClaudeApiAdmission, "leafCapUsd">): T {
  for (const task of run.tasks) task.apiLeafCapUsd = admission.leafCapUsd;
  return run;
}

/** What `claude --bare --settings <approved> auth status --json` must report. */
export function assertClaudeApiStatus(value: unknown): void {
  const status = isRecord(value) ? value : {};
  if (status.loggedIn !== true || status.authMethod !== "api_key_helper" || status.apiProvider !== "firstParty" || status.apiKeySource !== "apiKeyHelper") {
    throw new Error("Claude Code API route requires the approved apiKeyHelper credential on the first-party API; the CLI did not report it, so no inference started");
  }
}

const RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,79}$/;
/** Keep only bounded identifier-shaped strings; everything else is dropped, never echoed. */
export function receiptText(value: unknown): string | undefined {
  return typeof value === "string" && RECEIPT_ID.test(value) ? value : undefined;
}

export function claudeApiReceipt(input: {
  admission: ClaudeApiAdmission; sessionId: string; servedModels: readonly string[]; cliVersion?: unknown;
  preflight: boolean; init: boolean; spentUsd?: number;
}): ClaudeApiReceipt {
  const spent = typeof input.spentUsd === "number" && Number.isFinite(input.spentUsd) && input.spentUsd >= 0 ? Math.round(input.spentUsd * 1e6) / 1e6 : undefined;
  const version = receiptText(input.cliVersion);
  return {
    kind: "claude-code-api",
    route: input.admission.route,
    model: input.admission.model,
    auth: { method: "api_key_helper", provider: "firstParty", keySource: "apiKeyHelper" },
    attested: { preflight: input.preflight, init: input.init },
    servedModels: [...new Set(input.servedModels.map(receiptText).filter((value): value is string => value !== undefined))].slice(0, 4),
    ...(version ? { cliVersion: version } : {}),
    settingsDigest: input.admission.settingsDigest,
    approval: { ...input.admission.approval, roles: [...input.admission.approval.roles] },
    budget: { leafCapUsd: input.admission.leafCapUsd, runCapUsd: input.admission.runCapUsd, priorSpendUsd: input.admission.priorSpendUsd, ...(spent === undefined ? {} : { spentUsd: spent }) },
    sessionId: input.sessionId,
  };
}

export function formatClaudeApiReceipt(receipt: ClaudeApiReceipt): string {
  const spend = receipt.budget.spentUsd === undefined ? "spend unreported" : `spent $${receipt.budget.spentUsd.toFixed(4)}`;
  return `api receipt: auth=${receipt.auth.method} (${receipt.auth.provider}, key source ${receipt.auth.keySource}); model ${receipt.servedModels.join(",") || "unattested"}; ${spend} of $${receipt.budget.leafCapUsd.toFixed(2)} leaf cap; approval ${receipt.approval.id} (${receipt.approval.task}; by ${receipt.approval.approvedBy}; source ${receipt.approval.source}; roles ${receipt.approval.roles.join("+")}; expires ${receipt.approval.expiresAt}); attested preflight=${receipt.attested.preflight} init=${receipt.attested.init}`;
}
