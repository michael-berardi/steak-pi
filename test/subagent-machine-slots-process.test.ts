import { fork } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";

it("respects machine caps across eight real processes racing to reclaim dead leases", async () => {
  const root = mkdtempSync(join(tmpdir(), "usap-slot-process-"));
  const moduleUrl = new URL("../src/subagents/machine-slots.ts", import.meta.url).href;
  const config = { session: { providers: {}, global: 8 }, machine: { providers: { zai: 2, "opencode-go": 2 }, global: 3 } };
  for (const [bucket, cap] of [["zai", 2], ["opencode-go", 2], ["global", 3]] as const) {
    mkdirSync(join(root, bucket));
    for (let i = 0; i < cap; i++) writeFileSync(join(root, bucket, `${i}.lock`), JSON.stringify({ pid: 2147483646, born: 1, nonce: `${bucket}-${i}` }));
  }
  const script = join(root, "worker.mjs");
  writeFileSync(script, `
import { MachineSlots } from ${JSON.stringify(moduleUrl)};
const provider = process.argv[2];
const slots = new MachineSlots({dir:${JSON.stringify(root)},config:${JSON.stringify(config)}});
const ack = (phase) => new Promise(resolve => { process.once('message', resolve); process.send({phase,provider}); });
for(let i=0;i<15;i++) {
  const release = await slots.acquire(provider, new AbortController().signal, 10000);
  if(!release) throw new Error('Admission timed out');
  try { await ack('enter'); await new Promise(r=>setTimeout(r,5)); await ack('exit'); }
  finally { release(); }
}
process.disconnect();
`);
  const children: ReturnType<typeof fork>[] = [];
  const active = new Map<number, string>();
  const violations: string[] = [];
  let completed = 0;
  let peak = 0;
  const jobs: Promise<void>[] = [];
  try {
    for (let i = 0; i < 8; i++) {
      const child = fork(script, [i % 2 ? "zai" : "opencode-go"], { execArgv: ["--experimental-strip-types"], stdio: ["ignore", "ignore", "pipe", "ipc"], timeout: 15000 });
      children.push(child);
      let stderr = "";
      child.stderr?.on("data", data => { stderr = (stderr + String(data)).slice(-2000); });
      child.on("message", (raw) => {
        const message = raw as { phase: string; provider: string };
        if (message.phase === "enter") {
          if (active.has(i)) violations.push("duplicate entry");
          active.set(i, message.provider);
          peak = Math.max(peak, active.size);
          if (active.size > 3) violations.push("global cap exceeded");
          if ([...active.values()].filter(p => p === message.provider).length > 2) violations.push("provider cap exceeded");
        } else {
          if (!active.delete(i)) violations.push("exit without entry");
          completed++;
        }
        child.send({ ack: true });
      });
      jobs.push(new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`Slot worker failed (${code}): ${stderr}`)));
      }));
    }
    await Promise.all(jobs);
    expect(violations).toEqual([]);
    expect(completed).toBe(120);
    expect(active.size).toBe(0);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(3);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.allSettled(jobs);
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
