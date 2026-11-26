import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

/**
 * End-to-end against the real UltraCompress binary: the live path only works if the
 * archived middle survives as decodable PNG frames. Skipped when no binary is built;
 * point ULTRACOMPRESS_BIN at one to run it.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = process.env.ULTRACOMPRESS_BIN ?? path.join(here, "..", "target", "release", "ultracompress");
const hasBinary = fs.existsSync(BIN);

// Drive the adapter with the real binary and inline placement so the frames land in
// the tool result itself; the factory stays lazy so the path is read after load.
vi.mock("../extensions/ultracompress/src/settings.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../extensions/ultracompress/src/settings.ts")>();
  return {
    ...actual,
    loadSettings: () => ({
      ...structuredClone(actual.DEFAULT_SETTINGS),
      snapshot: { ...structuredClone(actual.DEFAULT_SETTINGS.snapshot), enabled: false },
      snap: { ...structuredClone(actual.DEFAULT_SETTINGS.snap), placement: "inline" as const, minChars: 600 },
    }),
    resolveUltraCompressBin: () => BIN,
    isUltraCompressBinAvailable: (bin: string) => fs.existsSync(bin),
  };
});

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const warnings = Array.from({ length: 200 }, (_, i) => `warning: unused variable row_${i} in src/lib.rs`).join("\n");

describe.skipIf(!hasBinary)("real binary transform", () => {
  it("serializes snap frames as png_base64", () => {
    const stdout = execFileSync(BIN, ["transform", "--policy", "auto", "--vision", "on"], {
      input: JSON.stringify({
        messages: [{ type: "message", id: "rc1", message: { role: "toolResult", content: [{ type: "text", text: warnings }] } }],
        policy: "auto",
        vision: "on",
        modelVision: true,
        snapMinChars: 600,
      }),
      encoding: "utf8",
    });
    const response = JSON.parse(stdout) as { ops: Array<{ frames: Array<Record<string, unknown>> }> };
    const frames = response.ops.flatMap((op) => op.frames);
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(typeof frame.png_base64).toBe("string");
      expect(String(frame.png_base64).length).toBeGreaterThan(0);
    }
  });

  it("emits an image block whose payload decodes to a PNG signature", async () => {
    const { default: ultraCompressExtension } = await import("../extensions/ultracompress/index.ts");
    const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
    ultraCompressExtension({
      on(name: string, handler: any) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
      registerCommand() {},
      registerTool() {},
    } as never);
    const messages = [
      { role: "user", content: "run the build" },
      { role: "toolResult", toolName: "bash", content: [{ type: "text", text: warnings }] },
      { role: "assistant", content: "done" },
    ];
    const result = await handlers.get("context")![1]({ messages }, { model: { provider: "anthropic", input: ["text", "image"] } });
    expect(result).toBeDefined();
    const content = result.messages[1].content as Array<Record<string, unknown>>;
    const images = content.filter((block) => block.type === "image");
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      expect(image.mimeType).toBe("image/png");
      const data = String(image.data ?? "");
      expect(data).not.toBe("undefined");
      // Base64 of a real PNG must decode to the 8-byte PNG signature.
      expect([...Buffer.from(data, "base64").subarray(0, 8)]).toEqual(PNG_SIGNATURE);
    }
    // The archived middle is still announced in the same replacement.
    expect(JSON.stringify(content)).toContain("image frame(s) hold the archived middle");
  });
});
