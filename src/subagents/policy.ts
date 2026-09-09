import { lstatSync, realpathSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_TIMEOUT_MS,
  MAX_CONCURRENCY,
  MAX_TASKS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  USAP_VERSION,
  emptyUsage,
  type DispatchInput,
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

function pathUnderCwd(cwd: { lexical: string; physical: string }, inputPath: unknown, field: string): {
  lexical: string;
  physical: string;
} {
  const supplied = nonemptyString(inputPath, field);
  assertNoTraversal(supplied, field);
  const lexical = resolve(cwd.lexical, supplied);
  if (!isWithin(cwd.lexical, lexical)) fail(`${field} is outside cwd`);

  const physical = physicalProjection(lexical, field);
  if (!isWithin(cwd.physical, physical)) fail(`${field} escapes cwd through a symlink`);
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
): RunRecord {
  if (input === null || typeof input !== "object") fail("input must be an object");
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
  const background = booleanOrDefault(input.background, false, "background");
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

    const ownedPaths = suppliedPaths.map((ownedPath, ownedIndex) => {
      const normalized = pathUnderCwd(root, ownedPath, `${field}.ownedPaths[${ownedIndex}]`);
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
      allowBash,
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
    thinkingLevel: thinking.trim(),
    concurrency,
    timeoutMs,
    background,
    state: "running",
    createdAt: now,
    tasks,
    usage: emptyUsage(),
  };
}
