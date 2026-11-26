import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** One log file for automatic installs, capped; never rotated into more files. */
export const MAX_AUTO_LOG_BYTES = 256 * 1024;
export const DEFAULT_AUTO_LOG = join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "steak-pi", "auto-update.log");

/** Keep only the newest whole lines that fit in `maxBytes`. */
export function boundLog(path: string, maxBytes = MAX_AUTO_LOG_BYTES): void {
  try {
    const size = statSync(path).size;
    if (size <= maxBytes) return;
    const tail = readFileSync(path).subarray(size - maxBytes);
    const start = tail.indexOf(0x0a);
    writeFileSync(path, start >= 0 ? tail.subarray(start + 1) : tail, { mode: 0o600 });
  } catch { /* A read-only log never blocks an update. */ }
}

export function boundedAppend(path: string, line: string, maxBytes = MAX_AUTO_LOG_BYTES): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${line.replace(/[\r\n]+$/, "")}\n`, { mode: 0o600 });
  } catch { return; }
  boundLog(path, maxBytes);
}
