import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BENCHMARK_MODEL, FIXTURES, runMatchedBenchmark, scoreFixture, totalUsage, type BenchmarkDriver, type DriverResult } from "../scripts/benchmark-deepseek-harness.ts";

const result: DriverResult = { mode: "off", model: BENCHMARK_MODEL, state: "done", output: "ANSWER: 42", turns: 1, toolErrors: 0, constraintViolations: [], usageComplete: true };
describe("matched DeepSeek benchmark", () => {
  it("blocks live drivers without explicit authorization", async () => {
    let invoked = false;
    const driver: BenchmarkDriver = { transport: "provider", async run() { invoked = true; return result; } };
    await expect(runMatchedBenchmark(driver)).rejects.toThrow("explicit authorization");
    expect(invoked).toBe(false);
  });
  it("scores bytes, protected files and completion independently of claims", () => {
    const fixture = FIXTURES[0];
    expect(scoreFixture(fixture, { ...fixture.files }, { ...result, output: "Evidence: ANSWER: 42" }).passed).toBe(true);
    expect(scoreFixture(fixture, { ...fixture.files, "DO_NOT_EDIT.txt": "changed" }, result).passed).toBe(false);
    expect(scoreFixture(fixture, { ...fixture.files }, { ...result, state: "failed" }).passed).toBe(false);
    expect(scoreFixture(fixture, { ...fixture.files }, { ...result, output: "ANSWER: 41" }).passed).toBe(false);
  });
  it("retains unknown cost rather than treating it as fresh zero", () => {
    const usage = { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, costUsd: null };
    expect(totalUsage([{ kind: "aggregate", usage }], "aggregate")).toEqual(usage);
  });
  it("uses isolated matched arms and counterbalanced order with scored fixtures", async () => {
    const calls: Array<{ cwd: string; mode: string; shell: boolean }> = [];
    const driver: BenchmarkDriver = { transport: "offline", async run(input) {
      calls.push({ cwd: input.cwd, mode: input.mode, shell: input.allowBash });
      const fixture = FIXTURES.find(f => input.prompt.startsWith(f.prompt))!;
      for (const [path, text] of Object.entries(fixture.expected)) await writeFile(join(input.cwd, path), text);
      input.onUsage({ kind: "aggregate", usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, costUsd: null } });
      return { ...result, mode: input.mode, output: fixture.answer };
    } };
    const report = await runMatchedBenchmark(driver, { repetitions: 2 });
    expect(report.rows).toHaveLength(FIXTURES.length * 4);
    expect(report.rows.every(r => r.passed)).toBe(true);
    expect(new Set(calls.map(c => c.cwd)).size).toBe(calls.length);
    expect(calls.slice(0, 4).map(c => c.mode)).toEqual(["off", "dsh-minimal", "dsh-minimal", "off"]);
    expect(calls.filter(c => c.shell)).toHaveLength(4);
    expect(report.rows.every(r => r.assistantUsage === null && r.summaryUsage === null && r.aggregateUsage.totalTokens === 5)).toBe(true);
  });
});
