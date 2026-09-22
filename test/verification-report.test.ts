import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { inspectVitestReport, MAX_REPORT_BYTES, prepareVitestReport } from "../src/verification-report.ts";
const report = () => ({ success: true, numTotalTests: 4, numPassedTests: 4, numFailedTests: 0, numPendingTests: 0, numFailedTestSuites: 0, testResults: [{ status: "passed", assertionResults: Array.from({ length: 4 }, () => ({ status: "passed" })) }] });
const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) fs.rmSync(p, { recursive: true, force: true }); });
it("requires producer success and consistent native assertions", () => {
  expect(inspectVitestReport(JSON.stringify(report()), 0).failed).toBe(false);
  expect(inspectVitestReport(JSON.stringify(report()), 1).failed).toBe(true);
  expect(inspectVitestReport(JSON.stringify(report()), null).failed).toBe(true);
  expect(inspectVitestReport("{}", 0).failed).toBe(true);
  expect(inspectVitestReport("{", 0).failed).toBe(true);
  expect(inspectVitestReport(JSON.stringify({ ...report(), numPassedTests: 3 }), 0).failed).toBe(true);
});
it("rejects a failed suite even with four passing and zero failing assertions", () => {
  const r = report(); r.numFailedTestSuites = 1;
  r.testResults.push({ status: "failed", assertionResults: [] });
  expect(inspectVitestReport(JSON.stringify(r), 0).failed).toBe(true);
  r.numFailedTestSuites = 0;
  expect(inspectVitestReport(JSON.stringify(r), 0).failed).toBe(true);
  expect(inspectVitestReport(JSON.stringify({ ...report(), numRuntimeErrorTestSuites: 1 }), 0).failed).toBe(true);
});
it("requires a fresh regular report inside the project without deleting old evidence", () => {
  const p = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "verification-report-"))); roots.push(p);
  const file = join(p, "report.json"), text = JSON.stringify(report());
  fs.writeFileSync(file, text);
  const read = prepareVitestReport(p, "report.json");
  expect(() => read()).toThrow("stale");
  expect(fs.readFileSync(file, "utf8")).toBe(text);
  fs.renameSync(file, join(p, "old.json")); fs.writeFileSync(file, text);
  expect(read().toString()).toBe(text);
  expect(() => prepareVitestReport(p, "../outside.json")).toThrow("inside");
  fs.symlinkSync(file, join(p, "link.json"));
  expect(() => prepareVitestReport(p, "link.json")).toThrow("unsafe");
});
it("refuses an over-limit report and a group/other-writable report", () => {
  const p = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "verification-report-"))); roots.push(p);
  const oversized = prepareVitestReport(p, "big.json");
  fs.writeFileSync(join(p, "big.json"), Buffer.alloc(MAX_REPORT_BYTES + 1, 0x20), { mode: 0o600 });
  expect(() => oversized()).toThrow("size limit");
  const writable = prepareVitestReport(p, "writable.json");
  fs.writeFileSync(join(p, "writable.json"), JSON.stringify(report()));
  fs.chmodSync(join(p, "writable.json"), 0o666);
  expect(() => writable()).toThrow("unsafe report file");
});
