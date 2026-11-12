// `steak-pi routes <rank|record|verdict|report>`: the task-class ranking and its evidence store for a caller outside a
// Pi session, such as a job queue that launches whole agent panes. It is the same ranker and the same append-only
// `route-evidence.jsonl` a USAP dispatch uses, so a job queue and USAP leaves learn from one memory.
//
// A candidate is a class chain entry the operator configured (a `harness/profile` id, a `provider/model` route or a
// harness-qualified route) plus the harness the caller would run it on. The caller filters first: it passes only the
// candidates it can launch for this job (`--candidate`), after its own capability, quota and project-policy checks, so
// an unavailable candidate is never scored as a loss. The ranker then applies the class's quality gate, cost and time
// weights, exploration and re-probe exactly as at dispatch. Nothing here names a harness, model or provider: every
// name comes from the operator's routing.json or the caller.
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { routingConfig, TASK_CLASS_PATTERN } from "./routing-config.ts";
import { FAILURE_KINDS, parseEvidenceLine, RouteEvidenceStore, type TaskEvidence } from "./subagents/route-evidence.ts";
import { classReport, describeDecision, formatClassReport, rankClassRoutes, settingsOf, type RankCandidate, type Rng } from "./subagents/route-ranking.ts";

export interface RoutesCliDeps { store?: RouteEvidenceStore; rng?: Rng; now?: () => number }
export interface RoutesCliResult { code: number; out: string; err: string }

const USAGE = [
  "usage: steak-pi routes <command> [options]",
  "  rank    --class C [--candidate ENTRY[=HARNESS] ...] [--json]   rank the launchable candidates of a class (default: its whole chain)",
  "  record  --class C --run ID --task ID --route ENTRY [--harness H] --outcome pass|fail|unknown [--source S] [--seconds N] [--cost USD] [--tokens N] [--failure-kind K] [--label L]",
  "  verdict --run ID [--task ID] --outcome pass|fail --source verification|test-gate|operator [--note TEXT]",
  "  report  [--class C] [--json]                                    the read-only per-class estimate table",
].join("\n");

class CliError extends Error {}
const fail = (message: string): never => { throw new CliError(message); };

function number(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) fail(`--${name} must be a non-negative number, got ${JSON.stringify(value)}`);
  return parsed;
}

function configuredClass(name: string | undefined) {
  if (name === undefined) return fail("--class is required");
  if (!TASK_CLASS_PATTERN.test(name)) fail(`--class ${JSON.stringify(name)} is not a class slug`);
  const classes = routingConfig().taskClasses ?? {};
  if (!Object.hasOwn(classes, name)) fail(`task class ${name} is not configured in routing.json (taskClasses); configured: ${Object.keys(classes).join(", ") || "none"}`);
  return { name: name!, config: classes[name!] };
}

/** `ENTRY` or `ENTRY=HARNESS`; the entry must be one of the class chain's own entries. */
function candidatesOf(values: readonly string[], chain: readonly string[]): RankCandidate[] {
  if (values.length === 0) return chain.map((entry) => ({ entry, route: entry }));
  const seen = new Set<string>();
  return values.map((value) => {
    const at = value.lastIndexOf("=");
    const entry = at > 0 ? value.slice(0, at) : value;
    const harness = at > 0 ? value.slice(at + 1) : undefined;
    if (!chain.includes(entry)) fail(`candidate ${JSON.stringify(entry)} is not in this class's chain (${chain.join(", ")}); only operator-configured candidates are ranked`);
    if (harness !== undefined && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(harness)) fail(`candidate ${entry}: harness ${JSON.stringify(harness)} must be a lowercase id`);
    if (seen.has(entry)) fail(`candidate ${entry} appears more than once`);
    seen.add(entry);
    return { entry, route: entry, ...(harness !== undefined ? { harness } : {}) };
  // The ranker breaks ties by the order it is given: keep the operator's chain order, not the caller's.
  }).sort((a, b) => chain.indexOf(a.entry) - chain.indexOf(b.entry));
}

export function runRoutesCli(argv: readonly string[], deps: RoutesCliDeps = {}): RoutesCliResult {
  const [command, ...rest] = argv;
  try {
    const { values } = parseArgs({
      args: [...rest], allowPositionals: false, strict: true,
      options: {
        class: { type: "string" }, candidate: { type: "string", multiple: true }, json: { type: "boolean" },
        run: { type: "string" }, task: { type: "string" }, route: { type: "string" }, harness: { type: "string" },
        outcome: { type: "string" }, source: { type: "string" }, seconds: { type: "string" }, cost: { type: "string" },
        tokens: { type: "string" }, "failure-kind": { type: "string" }, label: { type: "string" }, note: { type: "string" },
      },
    });
    const store = deps.store ?? new RouteEvidenceStore();
    const now = (deps.now ?? Date.now)();
    if (command === "rank") {
      const { name, config } = configuredClass(values.class);
      const candidates = candidatesOf(values.candidate ?? [], config.chain);
      const result = rankClassRoutes(name, candidates, settingsOf(config), store.view(), deps.rng ?? Math.random, now);
      // A re-probe is one pick: its marker starts the cooldown again, exactly as at a USAP dispatch.
      if (result.decision.mode === "probe") store.recordProbe({ taskClass: name, route: result.decision.winner, at: now });
      const body = { taskClass: name, winner: result.decision.winner, ...(result.decision.winnerHarness !== undefined ? { harness: result.decision.winnerHarness } : {}), order: result.order, excluded: result.excluded, decision: result.decision, why: describeDecision(result.decision) };
      return { code: 0, out: values.json ? JSON.stringify(body) : `${body.why}\norder: ${result.order.join(" > ") || "none (every candidate is held out)"}`, err: "" };
    }
    if (command === "record") {
      const { name } = configuredClass(values.class);
      const line = JSON.stringify({
        v: 1, kind: "task", at: now, runId: values.run, taskId: values.task, label: values.label ?? values.task, taskClass: name, route: values.route,
        ...(values.harness !== undefined ? { harness: values.harness } : {}), outcome: values.outcome, source: values.source ?? "worker-state",
        wallSeconds: number(values.seconds, "seconds") ?? 0, costUsd: number(values.cost, "cost") ?? 0, tokens: number(values.tokens, "tokens") ?? 0,
        ...(values["failure-kind"] !== undefined ? { failureKind: values["failure-kind"] } : {}),
      });
      const record = parseEvidenceLine(line);
      if (record === undefined || record.kind !== "task") return fail("record needs --run, --task, --route and --outcome pass|fail|unknown, and --source worker-state|verification|test-gate|operator");
      const task = record as TaskEvidence;
      if (values["failure-kind"] !== undefined && task.failureKind === undefined) fail(`--failure-kind must be one of ${FAILURE_KINDS.join(", ")}`);
      if (!routingConfig().taskClasses![name].chain.includes(task.route)) fail(`route ${task.route} is not in class ${name}'s chain; evidence is kept only for configured candidates`);
      if (!store.append(task)) fail(`could not append to ${store.path}: ${store.lastError}`);
      return { code: 0, out: values.json ? JSON.stringify(task) : `recorded ${task.outcome} for ${task.route}${task.harness ? ` on ${task.harness}` : ""} in class ${name}`, err: "" };
    }
    if (command === "verdict") {
      const line = JSON.stringify({ v: 1, kind: "verdict", at: now, runId: values.run, ...(values.task !== undefined ? { taskId: values.task } : {}), outcome: values.outcome, source: values.source, ...(values.note !== undefined ? { note: values.note } : {}) });
      const record = parseEvidenceLine(line);
      if (record === undefined || record.kind !== "verdict") return fail("verdict needs --run, --outcome pass|fail and --source verification|test-gate|operator");
      if (!store.append(record)) fail(`could not append to ${store.path}: ${store.lastError}`);
      return { code: 0, out: values.json ? JSON.stringify(record) : `recorded verdict ${record.outcome} (${record.source}) for run ${record.runId}${record.taskId ? ` task ${record.taskId}` : ""}`, err: "" };
    }
    if (command === "report") {
      const classes = routingConfig().taskClasses ?? {};
      const names = values.class !== undefined ? [configuredClass(values.class).name] : Object.keys(classes);
      const reports = names.map((name) => classReport(name, classes[name].chain, settingsOf(classes[name]), store.view(), now));
      return { code: 0, out: values.json ? JSON.stringify(reports) : reports.map(formatClassReport).join("\n") || "no task classes are configured", err: "" };
    }
    return { code: command === undefined || command === "help" || command === "--help" ? 0 : 2, out: USAGE, err: command === undefined || command === "help" || command === "--help" ? "" : `steak-pi routes: unknown command ${JSON.stringify(command)}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { code: 2, out: "", err: `steak-pi routes ${command ?? ""}: ${message}` };
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = runRoutesCli(process.argv.slice(2));
  if (result.out) console.log(result.out);
  if (result.err) console.error(result.err);
  process.exitCode = result.code;
}
