import * as fs from "node:fs";
import * as path from "node:path";
export const MAX_REPORT_BYTES = 4 * 1024 * 1024;

/** Explicit Vitest JSON contract, not a regex over console output or a generic
 * test-runner adapter. Unknown/inconsistent shapes never authorize success. */
export function inspectVitestReport(text: string, exitCode: number | null): { failed: boolean; summary: string } {
  try {
    const r = JSON.parse(text);
    const count = (key: string, optional = false): number => {
      const n = optional && r[key] === undefined ? 0 : r[key];
      if (!Number.isSafeInteger(n) || n < 0) throw Error("invalid " + key);
      return n;
    };
    if (!r || typeof r !== "object" || Array.isArray(r)) throw Error("invalid report object");
    const total = count("numTotalTests"), passed = count("numPassedTests"), failed = count("numFailedTests");
    const pending = count("numPendingTests"), todo = count("numTodoTests", true);
    const suites = count("numFailedTestSuites"), runtime = count("numRuntimeErrorTestSuites", true);
    if (!Array.isArray(r.testResults)) throw Error("missing testResults");
    const statuses: string[] = [];
    let unsuccessfulFiles = 0;
    for (const file of r.testResults) {
      if (!file || !Array.isArray(file.assertionResults) || typeof file.status !== "string") throw Error("invalid file result");
      if (file.status !== "passed") unsuccessfulFiles++;
      for (const assertion of file.assertionResults) {
        const status = assertion?.status;
        if (!["passed", "failed", "pending", "todo", "skipped", "disabled"].includes(status)) throw Error("unknown assertion status");
        statuses.push(status);
      }
    }
    if (total !== statuses.length || total !== passed + failed + pending + todo ||
        statuses.filter(s => s === "passed").length !== passed || statuses.filter(s => s === "failed").length !== failed ||
        statuses.filter(s => s === "todo").length !== todo ||
        statuses.filter(s => ["pending", "skipped", "disabled"].includes(s)).length !== pending) throw Error("inconsistent assertion counts");
    const ok = exitCode === 0 && r.success === true && r.wasInterrupted !== true && passed > 0 &&
      !failed && !suites && !runtime && !unsuccessfulFiles;
    return { failed: !ok, summary: `Vitest report: ${passed}/${total} passed; ${failed} failed assertions; ${suites} failed suites; ${runtime} runtime errors; ${unsuccessfulFiles} unsuccessful files${passed ? "" : "; no passing tests"}.` };
  } catch (error) {
    // Never echo report bytes: reports may contain private application data.
    const reason = error instanceof SyntaxError ? "malformed JSON" : error instanceof Error ? error.message : "invalid shape";
    return { failed: true, summary: `Invalid Vitest report: ${reason.slice(0, 200)}.` };
  }
}

const fingerprint = (s: fs.BigIntStats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
export function prepareVitestReport(cwd: string, name: string) {
  const base = fs.realpathSync(cwd), file = path.resolve(base, name), rel = path.relative(base, file);
  if (!rel || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) throw Error("Vitest report must be inside the trusted project");
  const parents = () => {
    for (let p = path.dirname(file);; p = path.dirname(p)) {
      try { const s = fs.lstatSync(p); if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o022)) throw Error("unsafe report directory"); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
      if (p === base) break;
    }
  };
  parents();
  let previous: string | undefined;
  try { const s = fs.lstatSync(file, { bigint: true }); if (!s.isFile() || s.isSymbolicLink()) throw Error("unsafe report file"); previous = fingerprint(s); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  return () => {
    parents();
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const s = fs.fstatSync(fd, { bigint: true });
      if (!s.isFile() || s.nlink !== 1n || (s.mode & 0o022n) || (process.getuid && s.uid !== BigInt(process.getuid()))) throw Error("unsafe report file");
      if (fingerprint(s) === previous) throw Error("stale report; this command did not replace it");
      if (s.size > BigInt(MAX_REPORT_BYTES)) throw Error("report exceeds retained size limit");
      const bytes = Buffer.alloc(Number(s.size));
      let offset = 0;
      while (offset < bytes.length) { const n = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) throw Error("incomplete report"); offset += n; }
      if (fingerprint(fs.fstatSync(fd, { bigint: true })) !== fingerprint(s)) throw Error("report changed while reading");
      return bytes;
    } finally { fs.closeSync(fd); }
  };
}
