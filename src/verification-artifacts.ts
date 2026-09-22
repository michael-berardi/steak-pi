import * as fs from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export const MAX_CONSOLE_BYTES = 8 * 1024 * 1024;
const MAX_RUNS = 32;
const TTL_MS = 7 * 86400_000;
const NAMES = new Set(["stdout.log", "stderr.log", "result.json", "native-report.json"]);
function owned(file: string, directory = false) {
  const s = fs.lstatSync(file);
  if (s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile()) ||
      (process.getuid && s.uid !== process.getuid()) || (s.mode & 0o077) || (!directory && s.nlink !== 1)) {
    throw Error("unsafe verification artifact path");
  }
  return s;
}
function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Private, fixed-capacity, log-first storage. Never sweeps unrelated directories.
 * Admission is serialized across Pi processes. A dead owner's lock is recoverable;
 * a live or ambiguous lock fails closed instead of guessing or spinning.
 */
export function beginVerification(root = join(homedir(), ".cache", "steak-pi", "verification")) {
  root = resolve(root);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  owned(root, true);
  if (fs.realpathSync(root) !== root) throw Error("symlink verification artifact root");
  const lock = join(root, ".admission-lock");
  let lockFd: number;
  try { lockFd = fs.openSync(lock, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const before = owned(lock);
    if (before.size > 128) throw Error("invalid verification cache lock");
    const pid = Number(fs.readFileSync(lock, "utf8"));
    if (alive(pid)) throw Error("verification artifact admission busy; no command started");
    if (owned(lock).ino !== before.ino) throw Error("verification cache lock changed");
    fs.unlinkSync(lock);
    lockFd = fs.openSync(lock, "wx", 0o600);
  }
  let directory: string;
  try {
    fs.writeSync(lockFd, String(process.pid));
    const runs = fs.readdirSync(root).filter(n => /^run-[0-9a-f-]{36}$/.test(n)).map(name => {
      const dir = join(root, name), stat = owned(dir, true);
      let finished = false;
      try {
        const file = join(dir, "result.json");
        if (owned(file).size <= 4096) {
          const state = JSON.parse(fs.readFileSync(file, "utf8"));
          finished = state.finished === true || (Date.now() - stat.mtimeMs > 3600_000 && !alive(state.pid));
        }
      } catch { /* Unrecognized or incomplete state is not eviction authority. */ }
      return { dir, time: stat.mtimeMs, finished };
    }).sort((a, b) => a.time - b.time);
    let count = runs.length;
    for (const run of runs) {
      if (!run.finished || (count < MAX_RUNS && Date.now() - run.time < TTL_MS)) continue;
      const files = fs.readdirSync(run.dir);
      if (files.some(name => !NAMES.has(name))) continue;
      for (const name of files) owned(join(run.dir, name));
      for (const name of files) fs.unlinkSync(join(run.dir, name));
      fs.rmdirSync(run.dir); count--;
    }
    if (count >= MAX_RUNS) throw Error("verification artifact capacity reached; no command started");
    directory = join(root, "run-" + randomUUID());
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(join(directory, "result.json"), JSON.stringify({ pid: process.pid, started: Date.now(), finished: false }), { mode: 0o600, flag: "wx" });
  } finally { fs.closeSync(lockFd); fs.unlinkSync(lock); }
  const stdout = fs.openSync(join(directory, "stdout.log"), "wx", 0o600);
  let stderr: number;
  try { stderr = fs.openSync(join(directory, "stderr.log"), "wx", 0o600); }
  catch (e) { fs.closeSync(stdout); throw e; }
  let bytes = 0, closed = false;
  return {
    directory,
    write(stream: "stdout" | "stderr", chunk: string | Buffer) {
      if (closed) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes + data.length > MAX_CONSOLE_BYTES) throw Error("verification output limit exceeded; retained output is incomplete");
      let offset = 0;
      while (offset < data.length) {
        const written = fs.writeSync(stream === "stdout" ? stdout : stderr, data, offset, data.length - offset);
        if (written <= 0) throw Error("verification output write made no progress");
        offset += written;
      }
      bytes += data.length;
    },
    retainReport(bytes: Buffer) {
      if (closed || bytes.length > 4 * 1024 * 1024) throw Error("cannot retain verification report");
      fs.writeFileSync(join(directory, "native-report.json"), bytes, { flag: "wx", mode: 0o600 });
    },
    finish(result: { failed: boolean; exitCode: number | null; complete: boolean; reason?: string }) {
      if (closed) return;
      closed = true;
      fs.closeSync(stdout); fs.closeSync(stderr);
      fs.writeFileSync(join(directory, "result.json"), JSON.stringify({ ...result, pid: process.pid, finished: true, bytes, ended: Date.now() }), { mode: 0o600 });
    },
  };
}
