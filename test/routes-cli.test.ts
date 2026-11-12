// `steak-pi routes`: the same ranker and evidence store a USAP dispatch uses, for a job queue that launches whole agent
// panes. Every name is synthetic; the store and the config are temp files.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { runRoutesCli } from "../src/routes-cli.ts";
import { RouteEvidenceStore } from "../src/subagents/route-evidence.ts";

const dir = mkdtempSync(join(tmpdir(), "steak-pi-routes-cli-"));
let files = 0;
afterEach(() => { vi.unstubAllEnvs(); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

const PANE_A = "harness-a/profile-x";
const PANE_B = "harness-b/profile-x";
const PANE_C = "harness-c/profile-y";
function configure(extra: Record<string, unknown> = {}): string {
  const file = join(dir, `routing-${++files}.json`);
  writeFileSync(file, JSON.stringify({ taskClasses: { "class-q": { chain: [PANE_A, PANE_B, PANE_C], requiresTestGate: false, explore: 0, ...extra } } }));
  vi.stubEnv("STEAK_PI_ROUTING_CONFIG", file);
  return file;
}
const newStore = () => new RouteEvidenceStore(join(dir, `evidence-${++files}.jsonl`));
const rng = () => 0.999;
const NOW = 5_000_000;
const cli = (argv: string[], store: RouteEvidenceStore) => runRoutesCli(argv, { store, rng, now: () => NOW });
function record(store: RouteEvidenceStore, route: string, harness: string, outcomes: Array<"pass" | "fail">, extra: string[] = []): void {
  outcomes.forEach((outcome, index) => {
    const result = cli(["record", "--class", "class-q", "--run", `job-${route}-${index}`, "--task", "job", "--route", route, "--harness", harness, "--outcome", outcome,
      "--source", "verification", "--seconds", "100", "--cost", "0.5", ...(outcome === "fail" ? ["--failure-kind", "timeout"] : []), ...extra], store);
    expect(result.code, result.err).toBe(0);
  });
}

describe("rank", () => {
  it("uses the chain order with no evidence, and names the winner's harness", () => {
    configure();
    const result = cli(["rank", "--class", "class-q", "--candidate", `${PANE_B}=harness-b`, "--candidate", `${PANE_A}=harness-a`, "--json"], newStore());
    expect(result.code, result.err).toBe(0);
    const body = JSON.parse(result.out);
    // The caller's candidate order does not matter: ties keep the operator's chain order.
    expect(body).toMatchObject({ taskClass: "class-q", winner: PANE_A, harness: "harness-a", order: [PANE_A, PANE_B] });
    expect(body.decision.mode).toBe("chain-order");
  });
  it("follows recorded job outcomes, keeps a credibly worse candidate out of the pick, and ranks only the candidates passed", () => {
    configure();
    const store = newStore();
    record(store, PANE_A, "harness-a", Array.from({ length: 12 }, (_, index) => index % 2 === 0 ? "pass" : "fail"));
    record(store, PANE_B, "harness-b", Array.from({ length: 12 }, () => "pass"));
    const body = JSON.parse(cli(["rank", "--class", "class-q", "--candidate", `${PANE_A}=harness-a`, "--candidate", `${PANE_B}=harness-b`, "--json"], store).out);
    expect(body.winner).toBe(PANE_B);
    expect(body.harness).toBe("harness-b");
    expect(body.decision.estimates.find((item: { entry: string }) => item.entry === PANE_A).status).toBe("gated");
    expect(body.decision.estimates.map((item: { entry: string }) => item.entry)).not.toContain(PANE_C);
    expect(body.why).toMatch(/on harness harness-b/);
  });
  it("refuses an unconfigured class or a candidate outside the class chain, by name", () => {
    configure();
    expect(cli(["rank", "--class", "class-x"], newStore())).toMatchObject({ code: 2, err: expect.stringMatching(/task class class-x is not configured/) });
    expect(cli(["rank", "--class", "class-q", "--candidate", "other/thing"], newStore())).toMatchObject({ code: 2, err: expect.stringMatching(/not in this class's chain/) });
  });
  it("fails with the config error, never as an empty config, when routing.json is malformed", () => {
    const file = join(dir, `routing-${++files}.json`);
    writeFileSync(file, "{ not json");
    vi.stubEnv("STEAK_PI_ROUTING_CONFIG", file);
    expect(cli(["rank", "--class", "class-q"], newStore())).toMatchObject({ code: 2, err: expect.stringMatching(/cannot be read or parsed/) });
  });
});

describe("record and verdict", () => {
  it("keeps the harness and a timeout on the record, and a later verdict overrides a self-report", () => {
    configure();
    const store = newStore();
    expect(cli(["record", "--class", "class-q", "--run", "job-1", "--task", "job-1", "--route", PANE_C, "--harness", "harness-c", "--outcome", "pass", "--seconds", "30", "--cost", "0.1"], store).code).toBe(0);
    record(store, PANE_A, "harness-a", ["fail"]);
    const rows = store.view().tasks;
    expect(rows[0]).toMatchObject({ route: PANE_C, harness: "harness-c", outcome: "pass", source: "worker-state", wallSeconds: 30, costUsd: 0.1 });
    expect(rows[1]).toMatchObject({ route: PANE_A, outcome: "fail", failureKind: "timeout" });
    expect(cli(["verdict", "--run", "job-1", "--outcome", "fail", "--source", "verification", "--note", "review found a defect"], store).code).toBe(0);
    expect(store.view().tasks[0]).toMatchObject({ outcome: "fail", source: "verification" });
  });
  it("refuses a record for a route outside the class chain, a bad failure kind and a bad source", () => {
    configure();
    const store = newStore();
    const base = ["record", "--class", "class-q", "--run", "r", "--task", "t", "--outcome", "pass"];
    expect(cli([...base, "--route", "other/thing"], store)).toMatchObject({ code: 2, err: expect.stringMatching(/not in class class-q's chain/) });
    expect(cli([...base, "--route", PANE_A, "--failure-kind", "melted"], store)).toMatchObject({ code: 2, err: expect.stringMatching(/--failure-kind must be one of/) });
    expect(cli([...base, "--route", PANE_A, "--source", "vibes"], store).code).toBe(2);
    expect(cli(["verdict", "--run", "r", "--outcome", "pass", "--source", "worker-state"], store).code).toBe(2);
    expect(store.view().tasks).toHaveLength(0);
  });
});

describe("report and the installed command", () => {
  it("prints the per-class table with the harnesses each entry ran on", () => {
    configure();
    const store = newStore();
    record(store, PANE_A, "harness-a", ["pass", "pass"]);
    const result = cli(["report", "--class", "class-q"], store);
    expect(result.out).toMatch(/harness-a\/profile-x \[harness-a\]: healthy/);
    expect(result.out).toMatch(/quality gate 95%/);
  });
  it("runs through bin/steak-pi routes", () => {
    const config = configure();
    const evidence = join(dir, `evidence-${++files}.jsonl`);
    const out = execFileSync("sh", [join(import.meta.dirname, "..", "bin", "steak-pi"), "routes", "rank", "--class", "class-q", "--json"],
      { env: { ...process.env, STEAK_PI_ROUTING_CONFIG: config, STEAK_PI_ROUTE_EVIDENCE: evidence }, encoding: "utf8" });
    expect(JSON.parse(out)).toMatchObject({ winner: PANE_A, decision: { mode: "chain-order" } });
  });
});
