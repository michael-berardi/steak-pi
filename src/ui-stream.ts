import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getPrimaryHostIdentity, type PrimaryHostIdentity } from "./primary-host.ts";

const TEXT_LIMIT = 128 * 1024, FILE_LIMIT = 256 * 1024;
export interface UiStreamRecord {
  version: 1; pid: number; sessionId: string; generation: string; streamId: string;
  updatedAt: number; text: string; final: boolean;
}
/** Only assistant text blocks, never event deltas, thinking, tool inputs or metadata. */
export function assistantText(message: unknown): string | undefined {
  const m = message as { role?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
  if (m?.role !== "assistant" || !Array.isArray(m.content)) return;
  let text = "", bytes = 0;
  for (const block of m.content) {
    if (block.type !== "text" || typeof block.text !== "string") continue;
    const remaining = TEXT_LIMIT - bytes;
    if (!remaining) return text;
    // Bound allocation before UTF-8 conversion; avoid a per-codepoint loop on
    // every token update of an increasingly long assistant message.
    const prefix = block.text.slice(0, remaining).replace(/[\uD800-\uDBFF]$/u, "");
    const encoded = Buffer.from(prefix);
    let end = Math.min(encoded.length, remaining);
    while (end > 0 && end < encoded.length && (encoded[end] & 0xc0) === 0x80) end--;
    text += encoded.subarray(0, end).toString("utf8"); bytes += end;
    if (end < encoded.length || prefix.length < block.text.length) return text;
  }
  return text;
}

/** Synchronous bounded replacements serialize naturally; only one trailing timer exists.
 * Sidecars are presentation hints, never session persistence or delivery receipts.
 */
export function createUiStream(pi: Pick<ExtensionAPI, "appendEntry">, hostIdentity = getPrimaryHostIdentity,
  directory = join(homedir(), ".ultraterm", "ui-streams")) {
  let active: { host: PrimaryHostIdentity; manager: object; record: UiStreamRecord } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastWrite = -Infinity;
  let cleanup: ReturnType<typeof setTimeout> | undefined;
  let swept = false;
  const path = join(directory, `${process.pid}.json`);
  const uid = process.getuid?.();
  function privateDirectory() {
    if (uid === undefined) throw new Error("No owner identity");
    const parent = dirname(directory);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const base = lstatSync(parent);
    if (!base.isDirectory() || base.isSymbolicLink() || base.uid !== uid || (base.mode & 0o022) || realpathSync(parent) !== parent) throw new Error("Unsafe stream parent");
    mkdirSync(directory, { mode: 0o700 });
  }
  function checkDirectory() {
    try { privateDirectory(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const stat = lstatSync(directory);
    if (uid === undefined || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) || realpathSync(directory) !== directory) throw new Error("Unsafe stream directory");
  }
  function readOwned(): UiStreamRecord | undefined {
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > FILE_LIMIT) return;
      return JSON.parse(readFileSync(fd, "utf8"));
    } catch { return; } finally { if (fd !== undefined) closeSync(fd); }
  }
  function pruneStale() {
    if (swept) return;
    swept = true;
    try {
      checkDirectory();
      for (const name of readdirSync(directory).slice(0, 256)) {
        if (!/^[1-9]\d{0,9}\.json$/.test(name) || name === `${process.pid}.json`) continue;
        let fd: number | undefined;
        try {
          const file = join(directory, name);
          fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          const stat = fstatSync(fd);
          if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1 || (stat.mode & 0o077) || stat.size > FILE_LIMIT || Date.now() - stat.mtimeMs < 300_000) continue;
          const data = JSON.parse(readFileSync(fd, "utf8"));
          if (data.version !== 1 || `${data.pid}.json` !== name || typeof data.streamId !== "string") continue;
          let dead = false;
          try { process.kill(data.pid, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH"; }
          if (!dead) continue;
          const current = lstatSync(file);
          if (current.ino === stat.ino && current.dev === stat.dev) unlinkSync(file);
        } catch { /* Never touch unrecognized/changed files. */ }
        finally { if (fd !== undefined) closeSync(fd); }
      }
    } catch { /* Optional, bounded crash cleanup. */ }
  }
  function reset() {
    clearTimeout(timer); timer = undefined;
    clearTimeout(cleanup); cleanup = undefined;
    const previous = active; active = undefined;
    if (!previous) return;
    try {
      checkDirectory();
      const old = readOwned();
      if (old?.pid === process.pid && old.sessionId === previous.record.sessionId && old.generation === previous.record.generation && old.streamId === previous.record.streamId) unlinkSync(path);
    } catch { /* Best effort; readers reject stale records. */ }
  }
  function valid() {
    try {
      if (active && hostIdentity(active.manager) === active.host && active.host.pid === process.pid) return true;
    } catch { /* Registry unavailable/revoked. */ }
    reset(); return false;
  }
  function flush() {
    timer = undefined;
    if (!valid() || !active) return;
    let temporary: string | undefined;
    try {
      checkDirectory();
      // Only same-PID, owner-only regular files can be replaced, never links.
      try {
        lstatSync(path);
        if (readOwned()?.pid !== process.pid) return;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const record = { ...active.record, updatedAt: Date.now() };
      let encoded = JSON.stringify(record);
      while (Buffer.byteLength(encoded) > FILE_LIMIT) {
        record.text = record.text.slice(0, Math.floor(record.text.length * 0.9));
        // Avoid ending on an unmatched high surrogate after JSON-size trimming.
        record.text = record.text.replace(/[\uD800-\uDBFF]$/u, "");
        encoded = JSON.stringify(record);
      }
      temporary = join(directory, `.${process.pid}.${randomUUID()}.tmp`);
      writeFileSync(temporary, encoded, { mode: 0o600, flag: "wx" });
      renameSync(temporary, path); temporary = undefined;
    } catch { /* A presentation failure must never fail model processing. */ }
    finally {
      lastWrite = Date.now();
      if (temporary) { try { unlinkSync(temporary); } catch { /* bounded single temp */ } }
    }
  }
  function schedule() {
    if (timer || !valid()) return;
    const delay = Math.max(0, 100 - (Date.now() - lastWrite));
    if (!delay) flush();
    else { timer = setTimeout(flush, delay); timer.unref?.(); }
  }
  function start(message: unknown, ctx: Pick<ExtensionContext, "sessionManager">) {
    if (assistantText(message) === undefined) return;
    reset();
    try {
      const host = hostIdentity(ctx.sessionManager);
      if (!host || host.pid !== process.pid) return;
      pruneStale();
      const streamId = randomUUID();
      // Pi emits message_start before consuming assistant deltas. This marker
      // binds the next persisted assistant prose to the same live stream ID.
      pi.appendEntry("ultraterm.ui.stream.start", { streamId });
      active = { host, manager: ctx.sessionManager, record: { version: 1, pid: host.pid, sessionId: host.sessionId,
        generation: host.generation, streamId, updatedAt: Date.now(), text: assistantText(message)!, final: false } };
      schedule();
    } catch { reset(); }
  }
  function update(message: unknown, final = false) {
    const text = assistantText(message);
    if (text === undefined || !valid() || !active) return;
    active.record.text = text; active.record.final = final; schedule();
  }
  function end() {
    if (!valid() || !active) return;
    active.record.final = true; schedule();
    const finishing = active;
    clearTimeout(cleanup);
    cleanup = setTimeout(() => { if (active === finishing) reset(); }, 2000);
    cleanup.unref?.();
  }
  return { start, update, end, reset };
}
