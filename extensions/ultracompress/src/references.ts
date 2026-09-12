import { createHash } from "node:crypto";

/** Session-local, bounded original-text cache. No paths, shell calls, or disk writes. */
export class UcReferences {
  private entries = new Map<string, { text: string; bytes: number }>();
  private bytes = 0;
  private byText = new Map<string, string>();
  constructor(private maxBytes = 32 * 1024 * 1024, private maxEntries = 256) {}

  put(text: string): string | undefined {
    const known = this.byText.get(text);
    if (known !== undefined) {
      const entry = this.entries.get(known)!;
      this.entries.delete(known);
      this.entries.set(known, entry); // Preserve existing LRU refresh semantics.
      return known;
    }
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > this.maxBytes || this.maxEntries < 1) return undefined;
    const ref = `uc:${createHash("sha256").update(text).digest("hex")}`;
    const previous = this.entries.get(ref);
    if (previous) {
      this.entries.delete(ref);
      this.bytes -= previous.bytes;
    }
    this.entries.set(ref, { text, bytes });
    this.byText.set(text, ref);
    this.bytes += bytes;
    while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) {
      const first = this.entries.keys().next().value!;
      this.byText.delete(this.entries.get(first)!.text);
      this.bytes -= this.entries.get(first)!.bytes;
      this.entries.delete(first);
    }
    return ref;
  }

  get(ref: string): string | undefined {
    if (!/^uc:[a-f0-9]{64}$/.test(ref)) return undefined;
    return this.entries.get(ref)?.text;
  }

  clear(): void {
    this.entries.clear();
    this.byText.clear();
    this.bytes = 0;
  }
}

/** Accept exact references and both generations of archive marker. */
export function parseUcReference(packet: string): string | undefined {
  const text = packet.trim();
  if (/^uc:[a-f0-9]{64}$/.test(text)) return text;
  return /^\[UC (uc:[a-f0-9]{64})\]$/.exec(text)?.[1]
    ?? /^\[UC archived output: call ultracompress_uc with packet="(uc:[a-f0-9]{64})" for the exact original text\. This is deferred retrieval, not a summary\.\]$/.exec(text)?.[1];
}
