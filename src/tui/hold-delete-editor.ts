import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isKeyRelease, isKeyRepeat, matchesKey } from "@earendil-works/pi-tui";
import { PasteSafeEditor } from "./paste-safe-editor.ts";

/** Pi's agent folder: PI_CODING_AGENT_DIR when set, else ~/.pi/agent (resolved here so the editor needs no SDK call at startup). */
function agentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR;
  return configured && configured.trim() ? configured : join(homedir(), ".pi", "agent");
}

/** Read once at editor creation; malformed or missing settings retain the default. */
export function holdDeleteEnabled(path?: string): boolean {
  try {
    path ??= join(agentDir(), "steak-pi.json");
    return JSON.parse(readFileSync(path, "utf8")).holdDeleteClearsInput !== false;
  } catch {
    return true;
  }
}

/** How long Backspace must be held before the whole input clears (1.5 s since 0.18.8; was 2 s). */
export const HOLD_DELETE_CLEAR_MS = 1500;

export class HoldDeleteEditor extends PasteSafeEditor {
  wantsKeyRelease = true;
  private holdStarted: number | undefined;
  private lastBackspace = 0;
  private cleared = false;
  private inPaste = false;
  private readonly holdDeleteEnabled = holdDeleteEnabled();

  override handleInput(data: string): void {
    // Never interpret bytes within a bracketed paste as keyboard events.
    if (this.inPaste || data.includes("\x1b[200~")) {
      this.inPaste = !data.includes("\x1b[201~");
      this.holdStarted = undefined;
      super.handleInput(data);
      return;
    }
    // tmux forwards a held Backspace as plain DEL (0x7f) autorepeat and may
    // batch several bytes into one read. Count each byte as its own event so
    // the hold still accumulates instead of inserting the bytes as text.
    if (/^[\x7f\x08]+$/.test(data) && data.length > 1) {
      for (const byte of data) {
        this.handleBackspaceEvent(byte);
      }
      return;
    }
    this.handleBackspaceEvent(data);
  }

  private handleBackspaceEvent(data: string): void {
    const release = isKeyRelease(data);
    const backspace = data === "\x7f" || data === "\x08" || matchesKey(data, "backspace");
    if (!this.holdDeleteEnabled || !backspace || release) {
      this.holdStarted = undefined;
      // Native TUI normally filters releases; preserve that behavior.
      if (!release) super.handleInput(data);
      return;
    }
    const now = Date.now();
    const kittyRepeat = /^\x1b\[127;\d+:2u$/.test(data) && isKeyRepeat(data);
    // 200ms exceeds normal macOS autorepeat intervals but separates deliberate taps.
    // Kitty repeat/release events explicitly identify a hold, regardless of gaps;
    // unflagged events fall back to timing because repeat reporting may be off.
    // A kitty press event starts a hold or continues one: terminals that report
    // event types but label every repeat as a press (flag 2 not implemented)
    // would otherwise reset on each event and delete char-by-char forever. Only
    // a release or a gap that separates deliberate taps ends a hold.
    if (this.holdStarted === undefined || (!kittyRepeat && now - this.lastBackspace >= 200)) {
      this.holdStarted = now;
      this.cleared = false;
    }
    this.lastBackspace = now;
    if (this.cleared) return;
    if (now - this.holdStarted > HOLD_DELETE_CLEAR_MS) {
      this.cleared = true;
      this.setText("");
      return;
    }
    super.handleInput(data);
  }
}
