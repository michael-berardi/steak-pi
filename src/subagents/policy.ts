import { assertActiveModelSelector } from "../retired-model-selection.ts";
import { TASK_CLASS_MAX_LENGTH, TASK_CLASS_PATTERN } from "../routing-config.ts";
import { isClaudeAccountId } from "./claude-account.ts";
import { claudeOwnedPathRules } from "./claude-owned-paths.ts";
import { normalizeReadPath } from "./read-paths.ts";
import { claudeApiModelOf } from "./claude-api-route.ts";
import { claudeCodeModelOf } from "./model-selection.ts";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_TURNS,
  DEFAULT_TIMEOUT_MS,
  HARNESS_IDS,
  MAX_CONCURRENCY,
  MAX_MAX_TURNS,
  MAX_TASKS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  USAP_VERSION,
  emptyUsage,
  type DispatchInput,
  type HarnessId,
  type RunRecord,
  type SubagentRole,
} from "./types.ts";

export type OwnedPathMode = "read" | "write";
export type IdFactory = () => string;

export class SubagentPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubagentPolicyError";
  }
}

function fail(message: string): never {
  throw new SubagentPolicyError(message);
}

function nonemptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(`${field} must be a nonempty string`);
  }
  return value.trim();
}

function booleanOrDefault(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") fail(`${field} must be a boolean`);
  return value;
}

function integerInRange(value: unknown, fallback: number, min: number, max: number, field: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) {
    fail(`${field} must be an integer from ${min} to ${max}`);
  }
  return value as number;
}

function comparablePath(value: string): string {
  const normalized = process.platform === "darwin" ? value.normalize("NFC") : value;
  return process.platform === "darwin" || process.platform === "win32"
    ? normalized.toLowerCase()
    : normalized;
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(comparablePath(parent), comparablePath(child));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function assertNoTraversal(inputPath: string, field: string): void {
  if (inputPath.includes("\0")) fail(`${field} contains a null byte`);
  if (inputPath.split(/[\\/]/).includes("..")) fail(`${field} contains traversal`);
}

/**
 * Resolve a path through its nearest existing ancestor. This detects symlinks
 * even when the final path does not exist. A dangling ancestor symlink is
 * rejected because its eventual destination cannot be proven safe.
 */
function physicalProjection(target: string, field: string): string {
  let current = target;
  const missing: string[] = [];

  while (true) {
    try {
      lstatSync(current);
      let real: string;
      try {
        real = realpathSync.native(current);
      } catch {
        fail(`${field} has an unresolved symlink ancestor`);
      }
      return resolve(real, ...missing);
    } catch (error) {
      if (error instanceof SubagentPolicyError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        fail(`${field} cannot be inspected`);
      }
      const parent = dirname(current);
      if (parent === current) fail(`${field} has no existing ancestor`);
      missing.unshift(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      current = parent;
    }
  }
}

function normalizedCwd(cwd: string): { lexical: string; physical: string } {
  const lexical = resolve(nonemptyString(cwd, "cwd"));
  try {
    if (!statSync(lexical).isDirectory()) fail("cwd must be a directory");
    return { lexical, physical: realpathSync.native(lexical) };
  } catch (error) {
    if (error instanceof SubagentPolicyError) throw error;
    fail("cwd must be an existing directory");
  }
}

/** The overflow root TrimReaper declares (`offload.root` in its config: `$TRIMREAPER_CONFIG`, else
 * `~/.config/trimreaper/config.json`), or undefined when none is declared or the config is unreadable. */
function declaredOverflowRoot(): string | undefined {
  const override = process.env.TRIMREAPER_CONFIG;
  const configPath = override
    ? (override.startsWith("~/") ? join(homedir(), override.slice(2)) : override)
    : join(homedir(), ".config", "trimreaper", "config.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return undefined;
  }
  const offload = typeof parsed === "object" && parsed !== null ? (parsed as { offload?: unknown }).offload : undefined;
  const root = typeof offload === "object" && offload !== null ? (offload as { root?: unknown }).root : undefined;
  return typeof root === "string" && isAbsolute(root) && !root.includes("\0") ? resolve(root) : undefined;
}

/** TrimReaper moves a folder below home to `<offload.root>/home/<same path below home>` and leaves a symlink
 * at the original place. A symlink at `lexical` (below home) may resolve only into that declared mirror of
 * its own relative path; any other escaping target, including another overflow folder, stays refused. */
function isDeclaredOverflowMirror(lexical: string, physical: string, field: string): boolean {
  const home = resolve(homedir());
  if (!isWithin(home, lexical) || lexical === home) return false;
  const root = declaredOverflowRoot();
  if (root === undefined) return false;
  try {
    return isWithin(physicalProjection(join(root, "home", relative(home, lexical)), field), physical);
  } catch {
    return false;
  }
}

/** Longest path an ownedPath error prints in full (the dispatcher bounds the whole message at the same order). */
const OWNED_PATH_ERROR_LIMIT = 2000;

/** When a relative ownedPath is refused, say what it was resolved against and how to fix it. Empty for absolute input. */
function relativeOwnedPathHint(supplied: unknown, cwd: string, resolved?: string): string {
  if (typeof supplied !== "string" || supplied.trim() === "" || isAbsolute(supplied.trim()) || supplied.includes("\0")) return "";
  const input = supplied.trim();
  const full = resolved ?? resolve(cwd, input);
  return ` [owned path ${JSON.stringify(input.slice(0, OWNED_PATH_ERROR_LIMIT))} resolved to ${JSON.stringify(full.slice(0, OWNED_PATH_ERROR_LIMIT))} (relative to the run cwd ${JSON.stringify(cwd.slice(0, OWNED_PATH_ERROR_LIMIT))}); pass an absolute path or set the run cwd]`;
}

function pathUnderCwd(cwd: { lexical: string; physical: string }, inputPath: unknown, field: string): {
  lexical: string;
  physical: string;
} {
  const supplied = nonemptyString(inputPath, field);
  assertNoTraversal(supplied, field);
  const lexical = resolve(cwd.lexical, supplied);
  if (!isWithin(cwd.lexical, lexical)) fail(`${field} is outside cwd`);

  const physical = physicalProjection(lexical, field);
  if (!isWithin(cwd.physical, physical) && !isDeclaredOverflowMirror(lexical, physical, field)) {
    fail(`${field} escapes cwd through a symlink`);
  }
  return { lexical, physical };
}

/**
 * Assert that a read remains under cwd, or that a write remains under one of
 * the task's owned paths. Returns the normalized absolute lexical path.
 */
export function assertOwnedPath(
  cwd: string,
  inputPath: string,
  ownedPaths: readonly string[],
  mode: OwnedPathMode,
): string {
  if (mode !== "read" && mode !== "write") fail("mode must be read or write");
  if (!Array.isArray(ownedPaths)) fail("ownedPaths must be an array");

  const root = normalizedCwd(cwd);
  const candidate = pathUnderCwd(root, inputPath, "inputPath");
  if (mode === "read") return candidate.lexical;
  if (ownedPaths.length === 0) fail("writes require an owned path");

  const owners = ownedPaths.map((ownedPath, index) =>
    pathUnderCwd(root, ownedPath, `ownedPaths[${index}]`),
  );
  const authorized = owners.some(
    (owner) => isWithin(owner.lexical, candidate.lexical) && isWithin(owner.physical, candidate.physical),
  );
  if (!authorized) fail("write path is outside the task's ownership");
  return candidate.lexical;
}

function normalizeHarness(value: unknown, field: string): HarnessId {
  if (value === undefined) return "pi";
  if (typeof value !== "string" || !(HARNESS_IDS as readonly string[]).includes(value)) {
    fail(`${field} must be one of ${HARNESS_IDS.join(", ")}`);
  }
  return value as HarnessId;
}

/** A task class is a lowercase slug. A well-formed class the operator did not configure is routed as no class. */
function normalizeTaskClass(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !TASK_CLASS_PATTERN.test(value) || value.length > TASK_CLASS_MAX_LENGTH) {
    fail(`${field} must be a lowercase slug of at most ${TASK_CLASS_MAX_LENGTH} characters (letters, digits and single hyphens)`);
  }
  return value;
}

function normalizeRole(value: unknown, field: string): SubagentRole {
  if (value === undefined) return "worker";
  if (value !== "scout" && value !== "worker" && value !== "reviewer") {
    fail(`${field} must be scout, worker, or reviewer`);
  }
  return value;
}

function safeDisplayId(raw: unknown): string {
  const source = nonemptyString(raw, "idFactory result");
  const safe = source
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 64);
  if (safe.length === 0) fail("idFactory result has no display-safe characters");
  return safe;
}

export function normalizeDispatch(
  input: DispatchInput,
  cwd: string,
  model: string,
  thinking: string,
  now: number = Date.now(),
  idFactory: IdFactory = randomUUID,
  home: string = homedir(),
): RunRecord {
  if (input === null || typeof input !== "object") fail("input must be an object");
  assertActiveModelSelector(input.model);
  assertActiveModelSelector(input.profile);
  assertActiveModelSelector(model);
  const root = normalizedCwd(cwd);
  const goal = nonemptyString(input.goal, "goal");
  nonemptyString(model, "model");
  nonemptyString(thinking, "thinking");
  if (!Number.isFinite(now) || !Number.isInteger(now) || now < 0) {
    fail("now must be a nonnegative integer timestamp");
  }
  if (typeof idFactory !== "function") fail("idFactory must be a function");
  if (!Array.isArray(input.tasks) || input.tasks.length < 1 || input.tasks.length > MAX_TASKS) {
    fail(`tasks must contain 1 to ${MAX_TASKS} entries`);
  }

  const constraints = input.constraints === undefined
    ? []
    : (() => {
        if (!Array.isArray(input.constraints)) fail("constraints must be an array");
        return input.constraints.map((value, index) => nonemptyString(value, `constraints[${index}]`));
      })();
  const contract = input.contract === undefined ? undefined : nonemptyString(input.contract, "contract");
  // Adaptive wave sizing: an unsized dispatch launches one wave as wide as its
  // task count (capped), so N disjoint leaves run N-wide by default instead of
  // trickling through a fixed quarter-cap. Explicit concurrency still wins.
  const taskCount = Array.isArray(input.tasks) ? input.tasks.length : 0;
  const concurrencyFallback = Math.min(MAX_CONCURRENCY, Math.max(1, taskCount || DEFAULT_CONCURRENCY));
  const concurrency = integerInRange(
    input.concurrency,
    concurrencyFallback,
    1,
    MAX_CONCURRENCY,
    "concurrency",
  );
  const timeoutMs = integerInRange(
    input.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    MIN_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
    "timeoutMs",
  );
  // Long-horizon leaves carry their own bounded turn budget; an unsized
  // dispatch still gets the 64-turn default rather than an unbounded child.
  const maxTurns = integerInRange(
    input.maxTurns,
    DEFAULT_MAX_TURNS,
    1,
    MAX_MAX_TURNS,
    "maxTurns",
  );
  const background = booleanOrDefault(input.background, false, "background");
  const harness = normalizeHarness(input.harness, "harness");
  if (input.claudeAccount !== undefined) {
    if (!isClaudeAccountId(input.claudeAccount)) fail("claudeAccount must be a Claude account id from claude-accounts.json, such as primary, b or team-2");
    if (harness !== "claude-code" || claudeCodeModelOf(model) === undefined) fail("claudeAccount requires an exact Claude subscription route; no API or Pi account was selected");
  }
  const runId = `run-${safeDisplayId(idFactory())}`;
  const labels = new Set<string>();
  const ownership: Array<{ task: string; lexical: string; physical: string }> = [];

  const tasks = input.tasks.map((source, index) => {
    if (source === null || typeof source !== "object") fail(`tasks[${index}] must be an object`);
    const field = `tasks[${index}]`;
    const label = nonemptyString(source.label, `${field}.label`);
    const labelKey = label.toLowerCase();
    if (labels.has(labelKey)) fail(`task label ${JSON.stringify(label)} is not unique`);
    labels.add(labelKey);

    const task = nonemptyString(source.task, `${field}.task`);
    const role = normalizeRole(source.role, `${field}.role`);
    const mayEdit = booleanOrDefault(source.mayEdit, false, `${field}.mayEdit`);
    const allowBash = booleanOrDefault(source.allowBash, false, `${field}.allowBash`);
    const taskClass = normalizeTaskClass(source.taskClass, `${field}.taskClass`);
    // harness claude-code enforces ownedPaths through CLI permission rules
    // (claude-worker.ts) and allowBash through its tool allowlist, so write and
    // shell leaves follow the same policy as Pi leaves.
    if (source.ownedPaths !== undefined && !Array.isArray(source.ownedPaths)) {
      fail(`${field}.ownedPaths must be an array`);
    }
    const suppliedPaths = source.ownedPaths ?? [];
    if (!mayEdit && suppliedPaths.length > 0) {
      fail(`${field} is read-only and cannot own writable paths`);
    }
    if (mayEdit && suppliedPaths.length === 0) {
      fail(`${field} may edit and requires at least one owned path`);
    }
    if (source.readPaths !== undefined && !Array.isArray(source.readPaths)) {
      fail(`${field}.readPaths must be an array`);
    }
    const suppliedReadPaths = source.readPaths ?? [];
    if (suppliedReadPaths.length > 0 && mayEdit) {
      fail(`${field} may edit and cannot also read outside cwd; readPaths is read-only and never combines with writable ownership`);
    }
    // The explicit API route's argv forbids --add-dir, so the grant cannot be
    // enforced there: refuse the whole wave here, before any checkpoint.
    if (suppliedReadPaths.length > 0 && claudeApiModelOf(model) !== undefined) {
      fail(`${field}.readPaths cannot be granted on the explicit API route (its argv forbids --add-dir); use a Claude subscription route or the Pi harness`);
    }
    const readPaths: string[] = [];
    for (const [readIndex, readPath] of suppliedReadPaths.entries()) {
      const readField = `${field}.readPaths[${readIndex}]`;
      // Refused here, before any checkpoint, relay peer or worker exists: a
      // reviewer never starts with a grant that does not apply.
      let normalized: string;
      try {
        normalized = normalizeReadPath(readPath, readField, home);
      } catch (error) {
        fail(error instanceof Error ? error.message : `${readField} was refused`);
      }
      if (!readPaths.includes(normalized)) readPaths.push(normalized);
    }

    const ownedPaths = suppliedPaths.map((ownedPath, ownedIndex) => {
      const ownedField = `${field}.ownedPaths[${ownedIndex}]`;
      let normalized: { lexical: string; physical: string };
      try {
        normalized = pathUnderCwd(root, ownedPath, ownedField);
      } catch (error) {
        if (error instanceof SubagentPolicyError) fail(`${error.message}${relativeOwnedPathHint(ownedPath, root.lexical)}`);
        throw error;
      }
      if (harness === "claude-code") {
        // Validate the entire wave before any checkpoint, registration or worker
        // launch. Use the projection even if the final path does not yet exist.
        try {
          claudeOwnedPathRules([normalized.lexical], () => normalized.physical);
        } catch (error) {
          const reason = error instanceof Error ? error.message : "claude-code owned path cannot be enforced exactly";
          fail(`${ownedField} (task ${JSON.stringify(label.slice(0, 40))}): ${reason}${relativeOwnedPathHint(ownedPath, root.lexical, normalized.lexical)}`);
        }
      }
      for (const existing of ownership) {
        const lexicalOverlap =
          isWithin(existing.lexical, normalized.lexical) || isWithin(normalized.lexical, existing.lexical);
        const physicalOverlap =
          isWithin(existing.physical, normalized.physical) || isWithin(normalized.physical, existing.physical);
        if (lexicalOverlap || physicalOverlap) {
          fail(`${field}.ownedPaths[${ownedIndex}] overlaps ownership held by ${existing.task}`);
        }
      }
      ownership.push({ task: label, ...normalized });
      return normalized.lexical;
    });

    return {
      id: `${runId}-task-${index + 1}`,
      label,
      task,
      role,
      mayEdit,
      ownedPaths,
      readPaths,
      allowBash,
      ...(taskClass === undefined ? {} : { taskClass }),
      state: "queued" as const,
      output: "",
      turns: 0,
      usage: emptyUsage(),
      relaySent: 0,
      relayReceived: 0,
      truncated: false,
    };
  });

  return {
    version: USAP_VERSION,
    id: runId,
    goal,
    constraints,
    ...(contract === undefined ? {} : { contract }),
    cwd: root.lexical,
    model: model.trim(),
    ...(harness === "pi" ? {} : { harness }),
    ...(input.claudeAccount === undefined ? {} : { claudeAccount: input.claudeAccount }),
    thinkingLevel: thinking.trim(),
    concurrency,
    timeoutMs,
    maxTurns,
    background,
    state: "running",
    createdAt: now,
    tasks,
    usage: emptyUsage(),
  };
}
