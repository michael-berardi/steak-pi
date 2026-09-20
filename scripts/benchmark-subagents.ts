#!/usr/bin/env node
/** Offline host-overhead benchmark; no model requests. Not provider or OMP speed. */
import { performance } from "node:perf_hooks";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { renderSubagentResult } from "../src/subagents/render.ts";
import { emptyUsage, type RunRecord, type WorkerContext } from "../src/subagents/types.ts";

const source = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL("../", import.meta.url));
const moduleAt = (name: string) => pathToFileURL(join(source, name)).href;
const { normalizeDispatch } = await import(moduleAt("src/subagents/policy.ts"));
const { SubagentCoordinator } = await import(moduleAt("src/subagents/coordinator.ts"));
const { NoopSlots } = await import(moduleAt("src/subagents/machine-slots.ts"));
const { renderRunResult } = await import(moduleAt("extensions/ultraterm-subagents.ts"));
const hasCheckpoints = existsSync(join(source, "src/subagents/checkpoints.ts"));

const root = mkdtempSync(join(tmpdir(), "usap-benchmark-"));
const store = hasCheckpoints ? new (await import(moduleAt("src/subagents/checkpoints.ts"))).CheckpointStore(join(root, "parent.jsonl"), join(root, "checkpoints")) : undefined;
const cpu = process.cpuUsage();
const started = performance.now();
let progressEvents = 0;
let snapshots = 0;
const coordinator = new SubagentCoordinator(async ({ onProgress }: WorkerContext) => {
  for (let i = 0; i < 32; i++) {
    onProgress({ state: "running", currentTool: "read", turns: i + 1 });
    progressEvents++;
    await Promise.resolve();
  }
  return { state: "done", turns: 32, output: "Verified bounded benchmark fixture", usage: emptyUsage() };
}, { machineSlots: new NoopSlots(), onChange(run: RunRecord) { snapshots++; store?.save(run, run.state !== "running"); } });
try {
  let last!: RunRecord;
  for (let wave = 0; wave < 16; wave++) {
    const run = normalizeDispatch({ goal: "Offline benchmark", concurrency: 8, tasks: Array.from({ length: 8 }, (_, i) => ({ label: `Verify assignment ${i + 1}`, task: "Synthetic worker" })) }, root, "zai/glm-5.3-flash", "medium", Date.now(), () => `benchmark-${wave}`);
    last = coordinator.start(run);
    await coordinator.wait(last.id, "all");
  }
  const executionMs = performance.now() - started;
  const formatStarted = performance.now();
  for (let i = 0; i < 3000; i++) renderRunResult(last);
  const commonTextFormatMs = performance.now() - formatStarted;
  const render = renderSubagentResult({ details: { run: last } }, { isPartial: false, expanded: true });
  const samples: number[] = [];
  for (let i = 0; i < 100; i++) render.render(120);
  for (let i = 0; i < 3000; i++) {
    const at = performance.now();
    render.render([40, 80, 120][i % 3]);
    samples.push(performance.now() - at);
  }
  samples.sort((a, b) => a - b);
  function disk(path: string): number { return readdirSync(path).reduce((n, name) => { const p = join(path, name); const s = statSync(p); return n + (s.isDirectory() ? disk(p) : s.size); }, 0); }
  const usedCpu = process.cpuUsage(cpu);
  console.log(JSON.stringify({ scope: "offline host overhead; no provider calls; not an OMP comparison", source, hasCheckpoints, commonTextFormatMs, expandedRenderer: "candidate only", tasks: 128, progressEvents, checkpointObservations: snapshots, executionMs, renderSamples: samples.length, renderP50Ms: samples[1500], renderP95Ms: samples[2850], renderMaxMs: samples.at(-1), cpuMs: (usedCpu.user + usedCpu.system) / 1000, rssMiB: process.memoryUsage().rss / 1048576, checkpointBytes: disk(root) }, null, 2));
} finally {
  await coordinator.shutdown();
  store?.close();
  rmSync(root, { recursive: true, force: true });
}
