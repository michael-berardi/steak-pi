/** Matched benchmark orchestration. Import-only: never resolves credentials or sends requests.
 * Supply a native SDK driver explicitly; test drivers must declare transport=offline.
 * Small fixtures are calibration, not evidence of speed/quality superiority or long-context gains.
 */
import { appendFile, mkdtemp, mkdir, writeFile, readFile, readdir, lstat, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { createPiWorkerRunner } from "../src/subagents/pi-worker.ts";
import { RelayBroker } from "../src/subagents/relay.ts";
import { USAP_VERSION, emptyUsage, type RunRecord, type TaskRecord } from "../src/subagents/types.ts";

export type AdapterMode = "off" | "dsh-minimal";
export const BENCHMARK_MODEL = "opencode-go/deepseek-v4.1-flash" as const;
export const BENCHMARK_SETTINGS = Object.freeze({ thinkingLevel: "high", maxTurns: 12,
  timeoutMs: 90_000, maxOutputTokens: 8192, nativeMaxRetries: 1, cacheWarming: "off",
  concurrency: 1, fallbackModels: [] as readonly string[] });
export interface Fixture {
  id: string; prompt: string; files: Readonly<Record<string, string>>;
  expected: Readonly<Record<string, string>>; writable: readonly string[]; answer: string; allowBash?: boolean;
}
const protectedFile = { "DO_NOT_EDIT.txt": "protected benchmark sentinel\n" };
export const FIXTURES: readonly Fixture[] = [
  { id: "read-reason", prompt: "Read ledger.csv. Sum amount only for rows whose status is paid. Do not edit any file. Report your calculated sum as ANSWER: <number>.",
    files: { ...protectedFile, "ledger.csv": "id,status,amount\na,paid,19\nb,pending,100\nc,paid,23\nd,void,-9\n" },
    expected: {}, writable: [], answer: "ANSWER: 42" },
  { id: "precise-edit", prompt: "In config.json change only retries from 2 to 3, preserving every other byte. Do not change any other file. Report ANSWER: retries=3 when complete.",
    files: { ...protectedFile, "config.json": "{\n  \"retries\": 2,\n  \"timeout\": 700,\n  \"label\": \"keep me\"\n}\n" },
    expected: { "config.json": "{\n  \"retries\": 3,\n  \"timeout\": 700,\n  \"label\": \"keep me\"\n}\n" }, writable: ["config.json"], answer: "ANSWER: retries=3" },
  { id: "multi-file-repair", prompt: "Repair the off-by-one in src/count.ts (inclusive upper bound) and update fixture.json's expected result for [2,4]. Change only the comparison operator and expected number; preserve formatting. Do not modify any other file. Report ANSWER: count=3 when complete.",
    files: { ...protectedFile, "src/count.ts": "export const count = (lo: number, hi: number) => {\n  let n = 0;\n  for (let i = lo; i < hi; i++) n++;\n  return n;\n};\n", "fixture.json": "{\"lo\":2,\"hi\":4,\"expected\":2}\n" },
    expected: { "src/count.ts": "export const count = (lo: number, hi: number) => {\n  let n = 0;\n  for (let i = lo; i <= hi; i++) n++;\n  return n;\n};\n", "fixture.json": "{\"lo\":2,\"hi\":4,\"expected\":3}\n" }, writable: ["src/count.ts", "fixture.json"], answer: "ANSWER: count=3" },
  { id: "shell-repair", prompt: "Run node check.cjs from the app directory first. Inspect its failure, fix the additive identity in calc.cjs by changing only the seed 1 to 0, preserving other bytes, then rerun the check. Do not modify check.cjs. Report the successful check's ANSWER line.", allowBash: true,
    files: { ...protectedFile, "app/calc.cjs": "exports.total = xs => xs.reduce((n, x) => n + x, 1);\n", "app/check.cjs": "const {total}=require('./calc.cjs'); if(total([1,2,3])!==6 || total([])!==0) { console.error('Bad additive identity'); process.exit(1); } console.log('ANSWER: shell=6');\n" },
    expected: { "app/calc.cjs": "exports.total = xs => xs.reduce((n, x) => n + x, 0);\n" }, writable: ["app/calc.cjs"], answer: "ANSWER: shell=6" },
];
// Prevent a driver from accidentally mutating the next arm's fixtures.
for (const fixture of FIXTURES) { Object.freeze(fixture.files); Object.freeze(fixture.expected); Object.freeze(fixture.writable); Object.freeze(fixture); }
Object.freeze(FIXTURES);
export interface Usage {
  input: number; output: number; cacheRead: number; cacheWrite: number;
  totalTokens: number; costUsd: number | null;
}
export interface UsageRecord { kind: "assistant" | "summary" | "aggregate"; usage: Usage }
export interface DriverRequest {
  cwd: string; stateDir: string; model: typeof BENCHMARK_MODEL; mode: AdapterMode;
  settings: typeof BENCHMARK_SETTINGS; prompt: string; writable: readonly string[];
  signal: AbortSignal; allowBash: boolean;
  /** Include all summary requests, including failed/retried calls with usage. */
  onUsage(record: UsageRecord): void;
}
export interface DriverResult {
  mode: AdapterMode; model: string; output: string;
  state: "done" | "failed" | "aborted" | "timed_out";
  turns: number; toolErrors: number; constraintViolations: string[];
  /** false means summary/assistant accounting is unavailable, NOT zero usage. */
  usageComplete: boolean;
}
export interface BenchmarkDriver {
  transport: "offline" | "provider";
  /** Must apply exactly the supplied settings, own/dispose a fresh SDK session,
   * isolate resources and credentials/state, restrict tools to cwd/writable paths,
   * and honor abort. Shell only for explicitly marked fixtures; no ambient extensions. */
  run(request: DriverRequest): Promise<DriverResult>;
}
export function totalUsage(records: readonly UsageRecord[], kind: UsageRecord["kind"]): Usage {
  const total: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 };
  for (const record of records.filter(r => r.kind === kind)) {
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
      if (!Number.isFinite(record.usage[key]) || record.usage[key] < 0) throw new Error("Invalid token accounting");
      total[key] += record.usage[key];
    }
    const cost = record.usage.costUsd;
    if (cost !== null && (!Number.isFinite(cost) || cost < 0)) throw new Error("Invalid cost accounting");
    total.costUsd = total.costUsd === null || cost === null ? null : total.costUsd + cost;
  }
  return total;
}
export function scoreFixture(fixture: Fixture, files: Record<string, string>, result: DriverResult) {
  const target = { ...fixture.files, ...fixture.expected };
  const answers = [...result.output.matchAll(/\bANSWER:\s*(?:[A-Za-z_-]+=\s*)?-?\d+(?:\.\d+)?(?![\w]|\.\d)/g)].map(m => m[0].replace(/\s+/g, " "));
  const outputCorrect = answers.at(-1) === fixture.answer;
  const fileCorrect = Object.entries(target).every(([path, content]) => files[path] === content);
  const constraintCompliant = result.constraintViolations.length === 0 &&
    Object.keys(files).every(path => path in fixture.files) &&
    Object.entries(fixture.files).every(([path, content]) => fixture.writable.includes(path) || files[path] === content);
  const completed = result.state === "done";
  return { completed, outputCorrect, fileCorrect, constraintCompliant,
    passed: completed && outputCorrect && fileCorrect && constraintCompliant };
}
async function snapshot(root: string, prefix = ""): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const name of await readdir(join(root, prefix))) {
    const path = prefix ? `${prefix}/${name}` : name;
    const stat = await lstat(join(root, path));
    if (stat.isSymbolicLink()) files[path] = "[forbidden symlink]";
    else if (stat.isDirectory()) Object.assign(files, await snapshot(root, path));
    else files[path] = stat.size <= 1_000_000 ? await readFile(join(root, path), "utf8") : "[oversized file]";
  }
  return files;
}
export async function runMatchedBenchmark(driver: BenchmarkDriver, options: {
  repetitions?: number; allowProviderRequests?: boolean;
  modes?: readonly [AdapterMode, AdapterMode];
  fixtureIds?: readonly string[];
  onRow?: (row: Readonly<Record<string, unknown>>) => void | Promise<void>;
} = {}) {
  if (driver.transport === "provider" && options.allowProviderRequests !== true) throw new Error("Provider requests require explicit authorization");
  const repetitions = options.repetitions ?? 1;
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 3) throw new Error("Repetitions must be 1..3");
  const modes = options.modes ?? ["off", "dsh-minimal"];
  if (modes.length !== 2 || new Set(modes).size !== 2 || !modes.includes("off") || !modes.includes("dsh-minimal")) throw new Error("Require matched off/dsh-minimal modes");
  const fixtures = options.fixtureIds ? FIXTURES.filter(f => options.fixtureIds!.includes(f.id)) : FIXTURES;
  if (!fixtures.length || options.fixtureIds?.some(id => !FIXTURES.some(f => f.id === id))) throw new Error("Unknown/empty fixture selection");
  const rows = [];
  for (let repetition = 0; repetition < repetitions; repetition++) {
    for (const [index, fixture] of fixtures.entries()) {
      // Deterministic counterbalanced order, no parallel arms or shared workspace.
      const order = (repetition + index) % 2 ? [...modes].reverse() : modes;
      for (const mode of order) {
        const cache = join(homedir(), ".cache", "steak-pi-bench");
        await mkdir(cache, { recursive: true, mode: 0o700 });
        const root = await mkdtemp(join(cache, "matched-"));
        const cwd = join(root, "work");
        const stateDir = join(root, "state");
        const records: UsageRecord[] = [];
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await mkdir(cwd); await mkdir(stateDir);
          for (const [path, content] of Object.entries(fixture.files)) {
            await mkdir(join(cwd, path, ".."), { recursive: true });
            await writeFile(join(cwd, path), content);
          }
          const started = performance.now();
          timer = setTimeout(() => controller.abort(new Error("Benchmark deadline exceeded")), BENCHMARK_SETTINGS.timeoutMs);
          let result: DriverResult;
          try {
            result = await driver.run({ cwd, stateDir, model: BENCHMARK_MODEL, mode,
              settings: BENCHMARK_SETTINGS, prompt: fixture.prompt + (fixture.allowBash ? "\nShell is authorized only for this local fixture. No network, delegation, or changes outside explicitly writable paths." : "\nNo shell, network, delegation, or changes outside explicitly writable paths.") + " Return the requested ANSWER line plus a concise report.",
              writable: fixture.writable, signal: controller.signal, allowBash: !!fixture.allowBash,
              onUsage(record) { records.push(structuredClone(record)); } });
          } catch (error) {
            result = { mode, model: BENCHMARK_MODEL, output: String(error), state: controller.signal.aborted ? "timed_out" : "failed", turns: 0, toolErrors: 0, constraintViolations: [], usageComplete: false };
          }
          const elapsedMs = performance.now() - started;
          clearTimeout(timer);
          if (result.mode !== mode || result.model !== BENCHMARK_MODEL) throw new Error("Driver mode/model mismatch");
          if (controller.signal.aborted) result.state = "timed_out";
          if (!Number.isInteger(result.turns) || result.turns < 0 || result.turns > BENCHMARK_SETTINGS.maxTurns) result.constraintViolations.push("turn budget");
          const score = scoreFixture(fixture, await snapshot(cwd), result);
          const row = { repetition, fixture: fixture.id, elapsedMs, ...result, ...score,
            assistantUsage: records.some(r => r.kind === "aggregate") ? null : totalUsage(records, "assistant"), summaryUsage: records.some(r => r.kind === "aggregate") ? null : totalUsage(records, "summary"), aggregateUsage: totalUsage(records, "aggregate"), usageRecords: records };
          rows.push(row);
          await options.onRow?.(row);
        } finally { clearTimeout(timer); controller.abort(); await rm(root, { recursive: true, force: true }); }
      }
    }
  }
  return { schemaVersion: 1, model: BENCHMARK_MODEL, settings: BENCHMARK_SETTINGS,
    transport: driver.transport, repetitions, rows,
    limitations: "Tiny fixed-fixture sample: descriptive paired calibration only; no significance, generalization, p95, superiority, or long-context efficacy claims. Counterbalancing reduces but does not eliminate cache/order effects. Native aggregate usage includes recorded summaries without a fabricated breakdown. SDK cost is not account billing. Shell is explicitly authorized and unsandboxed for its fixture; file scoring does not prove containment outside the workspace. Worker results do not measure the separate primary-extension bootstrap path." };
}

export async function createNativeDriver(): Promise<BenchmarkDriver> {
  const sdkRoot = process.env.ULTRATERM_PI_PACKAGE_ROOT;
  if (!sdkRoot) throw new Error("Set ULTRATERM_PI_PACKAGE_ROOT to the verified Pi 0.86.0 package");
  const metadata = JSON.parse(await readFile(join(sdkRoot, "package.json"), "utf8"));
  if (metadata.name !== "@earendil-works/pi-coding-agent" || metadata.version !== "0.86.0") throw new Error("Benchmark requires pinned Pi 0.86.0");
  const sdk = await import(pathToFileURL(join(sdkRoot, "dist/index.js")).href);
  const registry = await sdk.ModelRuntime.create();
  const available = await registry.getAvailable("opencode-go");
  const found = available.find((m: { provider: string; id: string }) => `${m.provider}/${m.id}` === BENCHMARK_MODEL);
  if (!found) throw new Error("Exact Go DeepSeek model/auth unavailable; no fallback permitted");
  const model = { ...found, maxTokens: BENCHMARK_SETTINGS.maxOutputTokens };
  const knownPricing = model.cost && Object.values(model.cost).some(v => typeof v === "number" && v > 0);
  return {
    transport: "provider",
    async run(input) {
      const id = `bench-${Date.now()}-${input.mode}`;
      const task: TaskRecord = { id: `${id}-task`, label: "matched fixture", task: input.prompt,
        role: "worker", mayEdit: input.writable.length > 0, ownedPaths: input.writable.map(p => join(input.cwd, p)),
        allowBash: input.allowBash, state: "running", output: "", turns: 0, usage: emptyUsage(), relaySent: 0, relayReceived: 0, truncated: false };
      const run: RunRecord = { version: USAP_VERSION, id, goal: input.prompt, constraints: ["Use only this fixture workspace; no network or delegation."],
        cwd: input.cwd, model: BENCHMARK_MODEL, thinkingLevel: input.settings.thinkingLevel, concurrency: 1,
        timeoutMs: input.settings.timeoutMs, maxTurns: input.settings.maxTurns, background: false,
        state: "running", createdAt: Date.now(), tasks: [task], usage: emptyUsage() };
      const relay = new RelayBroker(); relay.createRun(id, [task.id]);
      const runner = createPiWorkerRunner({ relay, resolveRuntime: () => ({ model, thinkingLevel: input.settings.thinkingLevel }), deepseekHarnessMode: input.mode });
      const result = await runner({ run, task, signal: input.signal, sessionDir: input.stateDir, onProgress() {} });
      if (result.cleanup) await result.cleanup;
      const toolTrace = Object.entries(await snapshot(input.stateDir)).filter(([path]) => path.endsWith(".jsonl")).flatMap(([, text]) => text.trim().split("\n").flatMap(line => {
        try {
          const message = JSON.parse(line).message;
          if (message?.role === "toolResult") return [{ role: message.role, toolName: message.toolName, isError: message.isError, content: message.content }];
          if (message?.role === "assistant") return (message.content ?? []).filter((c: { type?: string }) => c.type === "toolCall");
        } catch { /* non-message session records are not a tool trace */ }
        return [];
      }));
      input.onUsage({ kind: "aggregate", usage: { input: result.usage.input, output: result.usage.output,
        cacheRead: result.usage.cacheRead, cacheWrite: result.usage.cacheWrite, totalTokens: result.usage.totalTokens,
        costUsd: knownPricing ? result.usage.cost.total : null } });
      return { mode: input.mode, model: BENCHMARK_MODEL, output: result.output, state: result.state,
        turns: result.turns, toolErrors: result.toolErrors ?? 0, constraintViolations: [], usageComplete: result.state === "done", toolTrace };
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes("--live")) {
    console.log(JSON.stringify({ live: false, model: BENCHMARK_MODEL, settings: BENCHMARK_SETTINGS, fixtures: FIXTURES.map(f => f.id), instruction: "Use --live --output PATH [--repetitions 1..3] with a pinned SDK root to authorize real Go requests." }));
  } else {
    const args = process.argv.slice(2), output = args[args.indexOf("--output") + 1];
    if (!args.includes("--output") || !output || output.startsWith("--")) throw new Error("--output PATH required for retained evidence");
    const repetitions = args.includes("--repetitions") ? Number(args[args.indexOf("--repetitions") + 1]) : 1;
    await writeFile(output + ".jsonl", "", { mode: 0o600, flag: "wx" });
    const result = await runMatchedBenchmark(await createNativeDriver(), { repetitions, allowProviderRequests: true,
      onRow: row => appendFile(output + ".jsonl", JSON.stringify(row) + "\n", { mode: 0o600 }),
    });
    await writeFile(output, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify({ output, rows: result.rows.length, passed: result.rows.filter(r => r.passed).length }));
  }
}
