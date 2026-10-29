import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";

it("respects machine caps across eight real processes racing to reclaim dead leases", async () => {
  const root = mkdtempSync(join(tmpdir(), "usap-slot-process-"));
  const moduleUrl = new URL("../src/subagents/machine-slots.ts", import.meta.url).href;
  const config = { session: { providers: {}, global: 8 }, machine: { providers: { zai: 2, "opencode-go": 2 }, global: 3 } };
  // Real admission uses polling/FIFO queues. 120 admissions can exceed 15s even
  // without suite contention; bound the fixture, not each worker's whole run.
  const fixtureTimeoutMs = 60_000;
  const acquireTimeoutMs = 30_000;
  for (const [bucket, cap] of [["zai", 2], ["opencode-go", 2], ["global", 3]] as const) {
    mkdirSync(join(root, bucket));
    for (let i = 0; i < cap; i++) writeFileSync(join(root, bucket, `${i}.lock`), JSON.stringify({ pid: 2147483646, born: 1, nonce: `${bucket}-${i}` }));
  }
  const script = join(root, "worker.mjs");
  writeFileSync(script, `
import { MachineSlots } from ${JSON.stringify(moduleUrl)};
const provider = process.argv[2];
const slots = new MachineSlots({dir:${JSON.stringify(root)},config:${JSON.stringify(config)}});
const ack = (phase, iteration) => new Promise(resolve => { process.once('message', resolve); process.send({phase,provider,iteration}); });
await ack('ready', 0);
for(let i=0;i<15;i++) {
  process.send({phase:'waiting',provider,iteration:i});
  const release = await slots.acquire(provider, new AbortController().signal, ${acquireTimeoutMs});
  try { await ack('enter', i); await new Promise(r=>setTimeout(r,5)); await ack('exit', i); }
  finally { release(); }
}
process.disconnect();
`);
  const workers: {
    child: ReturnType<typeof fork>;
    startedAt: number;
    phase: string;
    iteration: number;
    completed: number;
    stderr: string;
    closed: Promise<void>;
  }[] = [];
  const active = new Map<number, string>();
  const violations: string[] = [];
  let completed = 0;
  let peak = 0;
  let ready = 0;
  let stopping = false;
  const jobs: Promise<void>[] = [];
  const diagnostics = () => workers.map(w =>
    `pid=${w.child.pid} started=${new Date(w.startedAt).toISOString()} elapsed=${Date.now() - w.startedAt}ms phase=${w.phase} iteration=${w.iteration} completed=${w.completed} code=${w.child.exitCode} signal=${w.child.signalCode} stderr=${JSON.stringify(w.stderr)}`
  ).join("\n");
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    for (let i = 0; i < 8; i++) {
      const startedAt = Date.now();
      const child = fork(script, [i % 2 ? "zai" : "opencode-go"], { execPath: process.execPath, execArgv: ["--experimental-strip-types"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
      const worker = { child, startedAt, phase: "starting", iteration: -1, completed: 0, stderr: "", closed: new Promise<void>(resolve => child.once("close", () => resolve())) };
      workers.push(worker);
      child.stderr?.on("data", data => { worker.stderr = (worker.stderr + String(data)).slice(-2000); });
      jobs.push(new Promise<void>((resolve, reject) => {
        const send = (target: ReturnType<typeof fork>) => {
          if (stopping) return;
          target.send({ ack: true }, error => {
            if (error && !stopping) reject(new Error(`Slot worker IPC failed: ${error.message}\n${diagnostics()}`));
          });
        };
        child.on("message", (raw) => {
          if (stopping) return;
          const message = raw as { phase: string; provider: string; iteration: number };
          worker.phase = message.phase;
          worker.iteration = message.iteration;
          if (message.phase === "ready") {
            // Start together after imports, so all eight race the dead leases.
            if (++ready === 8) for (const peer of workers) send(peer.child);
            return;
          }
          if (message.phase === "waiting") return;
          if (message.phase === "enter") {
            if (active.has(i)) violations.push("duplicate entry");
            active.set(i, message.provider);
            peak = Math.max(peak, active.size);
            if (active.size > 3) violations.push("global cap exceeded");
            if ([...active.values()].filter(p => p === message.provider).length > 2) violations.push("provider cap exceeded");
          } else if (message.phase === "exit") {
            if (!active.delete(i)) violations.push("exit without entry");
            completed++;
            worker.completed++;
          } else {
            reject(new Error(`Unexpected slot worker phase: ${message.phase}\n${diagnostics()}`));
            return;
          }
          send(child);
        });
        child.once("error", error => reject(new Error(`Slot worker error: ${error.message}\n${diagnostics()}`)));
        child.once("close", (code, signal) => code === 0 ? resolve() : reject(new Error(`Slot worker failed (code=${code}, signal=${signal}):\n${diagnostics()}`)));
      }));
    }
    await Promise.race([
      Promise.all(jobs),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error(`Slot fixture exceeded ${fixtureTimeoutMs}ms (completed=${completed}/120):\n${diagnostics()}`)), fixtureTimeoutMs);
      }),
    ]);
    expect(violations).toEqual([]);
    expect(completed).toBe(120);
    expect(active.size).toBe(0);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
  } finally {
    stopping = true;
    clearTimeout(deadline);
    // These exact child handles are owned by this fixture; never search/kill
    // other processes. Await close (not merely job rejection) before removing
    // their isolated slot directory, and escalate only these children.
    for (const { child } of workers) if (child.exitCode === null && child.signalCode === null) child.kill();
    const force = setTimeout(() => {
      for (const { child } of workers) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 2000);
    try { await Promise.all(workers.map(w => w.closed)); }
    finally { clearTimeout(force); }
    await Promise.allSettled(jobs);
    rmSync(root, { recursive: true, force: true });
  }
}, 70_000);
