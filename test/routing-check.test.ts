import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = (file: string) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, ["--no-warnings", join(__dirname, "../src/routing-check.ts"), file], { encoding: "utf8", stdio: "pipe" }) };
  } catch (error) {
    const e = error as { status: number; stderr: string };
    return { code: e.status, out: e.stderr };
  }
};

describe("steak-pi routing check", () => {
  const dir = mkdtempSync(join(tmpdir(), "routing-check-"));
  const write = (name: string, value: unknown) => { const p = join(dir, name); writeFileSync(p, JSON.stringify(value)); return p; };
  const classes = (note: string) => ({ taskClasses: { "quick-edit": { chain: ["openrouter/inception/mercury-3"], requiresTestGate: false, note } } });
  it("accepts a valid file", () => {
    expect(run(write("ok.json", classes("short summary")))).toMatchObject({ code: 0 });
  });
  it("rejects a task-class note over 400 characters, naming the key (the 2026-11-08 outage)", () => {
    const result = run(write("long.json", classes("x".repeat(401))));
    expect(result.code).toBe(1);
    expect(result.out).toContain("taskClasses.quick-edit.note");
  });
  it("validates freeRoutes: accepts a listed route and rejects a missing evidence field", () => {
    expect(run(write("free-ok.json", { freeRoutes: [{ route: "provider-a/model-a", source: "catalog", evidence: "price page" }] })).code).toBe(0);
    const bad = run(write("free-bad.json", { freeRoutes: [{ route: "provider-a/model-a", source: "catalog" }] }));
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("freeRoutes[0].evidence");
  });
  it("validates verificationGates.mode: accepts fix and review, rejects anything else naming the key", () => {
    for (const mode of ["fix", "review"]) {
      expect(run(write(`gate-${mode}.json`, { verificationGates: [{ match: "^prov/", reviewer: "rev/expert", mode }] })).code).toBe(0);
    }
    const bad = run(write("gate-bad.json", { verificationGates: [{ match: "^prov/", reviewer: "rev/expert", mode: "findings" }] }));
    expect(bad.code).not.toBe(0);
    expect(bad.out).toContain("verificationGates[0].mode");
  });
  it("accepts a valid claudeCodeDefaults.effort map and rejects a bad effort", () => {
    const good = write("effort-ok.json", { claudeCodeDefaults: { worker: "claude-code/model-b", effort: { "model-a": "xhigh", "model-b": "high" } } });
    expect(run(good)).toMatchObject({ code: 0 });
    const badEffort = run(write("effort-bad.json", { claudeCodeDefaults: { effort: { "model-a": "extreme" } } }));
    expect(badEffort.code).toBe(1);
    expect(badEffort.out).toContain("claudeCodeDefaults.effort.model-a");
    const badShape = run(write("effort-shape.json", { claudeCodeDefaults: { effort: ["xhigh"] } }));
    expect(badShape.code).toBe(1);
    expect(badShape.out).toContain("claudeCodeDefaults.effort");
  });
  it("rejects a file that is not JSON", () => {
    const p = join(dir, "broken.json"); writeFileSync(p, "{");
    expect(run(p).code).toBe(1);
  });
  it("accepts a valid interactiveChainModel key", () => {
    const result = run(write("interactive-ok.json", { interactiveChainModel: { provider: "provider-a", id: "chain", name: "Operator chain" }, textWorkerChain: ["provider-a/model-name"] }));
    expect(result).toMatchObject({ code: 0 });
  });
  it("rejects a malformed interactiveChainModel key, naming it", () => {
    const missingName = run(write("interactive-bad-name.json", { interactiveChainModel: { provider: "provider-a", id: "chain" } }));
    expect(missingName.code).toBe(1);
    expect(missingName.out).toContain("interactiveChainModel.name");
    const badChain = run(write("interactive-bad-chain.json", { interactiveChainModel: { provider: "provider-a", id: "chain", name: "Operator chain", chain: "otherChain" } }));
    expect(badChain.code).toBe(1);
    expect(badChain.out).toContain("interactiveChainModel.chain");
  });
});
