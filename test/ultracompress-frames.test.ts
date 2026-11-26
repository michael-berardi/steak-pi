import { describe, expect, it } from "vitest";
import {
  applyTransforms,
  snapFrameBlocks,
  type AgentLikeMessage,
  type SnapOp,
} from "../extensions/ultracompress/src/transforms.ts";

/**
 * Snap frames must carry payload data or not be applied at all: the archived
 * middle only reaches the model as an image part, so a frame without data is a
 * silent loss of tool output. The core serializes frames as `png_base64`.
 */

const long = "L".repeat(7000);
const text = (value: string) => ({ type: "text", text: value });
const snapWith = (frames: SnapOp["frames"]): SnapOp => ({
  op: "snap",
  message_index: 0,
  block_index: 0,
  head: "head\n",
  tail: "\ntail",
  frames,
  tokens_before: 2000,
  tokens_after: 20,
});

describe("snap frame payloads", () => {
  it("reads the snake_case payload the core emits", () => {
    const op = snapWith([{ id: "f1", width: 8, height: 8, png_base64: "aGVsbG8=" }]);
    const blocks = snapFrameBlocks(op);
    expect(blocks).not.toBeNull();
    expect(blocks![0]).toEqual({
      type: "text",
      text: "[ultracompress: archived tool output follows as image frame(s) — verbatim, read in order]",
    });
    expect(blocks![1]).toEqual({ type: "image", data: "aGVsbG8=", mimeType: "image/png" });
  });

  it("still reads the legacy camelCase payload", () => {
    const blocks = snapFrameBlocks(snapWith([{ id: "f1", width: 8, height: 8, pngBase64: "bGVnYWN5" }]));
    expect(blocks![1]).toEqual({ type: "image", data: "bGVnYWN5", mimeType: "image/png" });
  });

  it("reports no frame blocks when a frame carries no payload", () => {
    expect(snapFrameBlocks(snapWith([{ id: "f1", width: 8, height: 8, png_base64: "" }]))).toBeNull();
    expect(snapFrameBlocks(snapWith([{ id: "f1", width: 8, height: 8 }]))).toBeNull();
    expect(snapFrameBlocks(snapWith([]))).toBeNull();
  });
});

describe("applyTransforms refuses replacements it cannot deliver", () => {
  const keyFn = () => "k";
  const cached = (op: SnapOp) => new Map([["k", { op, blocks: [] }]]);

  it.each(["inline", "nextUser"] as const)("leaves the archived text in place when a frame has no data (%s)", (placement) => {
    const messages: AgentLikeMessage[] = [
      { role: "user", content: "go" },
      { role: "toolResult", content: [text(long)] },
      { role: "user", content: "next" },
    ];
    const op = snapWith([{ id: "f1", width: 8, height: 8 }]); // payload never decoded
    const result = applyTransforms(messages, cached(op), keyFn, placement);
    expect(result.snapApplied).toBe(0);
    expect(messages[1].content).toEqual([text(long)]);
    expect(messages[2].content).toBe("next");
  });

  it("replaces the block once the frame payload is present", () => {
    const messages: AgentLikeMessage[] = [
      { role: "user", content: "go" },
      { role: "toolResult", content: [text(long)] },
      { role: "user", content: "next" },
    ];
    const op = snapWith([{ id: "f1", width: 8, height: 8, png_base64: "aGVsbG8=" }]);
    const result = applyTransforms(messages, cached(op), keyFn, "nextUser");
    expect(result.snapApplied).toBe(1);
    expect(messages[1].content).toEqual([
      { type: "text", text: "head\n\n[ultracompress: 1 image frame(s) hold the archived middle — f1]\ntail" },
    ]);
    const userContent = messages[2].content as Array<Record<string, unknown>>;
    expect(userContent[0]).toEqual(text("next"));
    expect(userContent[1]).toEqual({
      type: "text",
      text: "[ultracompress: archived tool output follows as image frame(s) — verbatim, read in order]",
    });
    expect(userContent[2]).toEqual({ type: "image", data: "aGVsbG8=", mimeType: "image/png" });
  });

  it("leaves the block untouched when no user message can carry the frames", () => {
    const messages: AgentLikeMessage[] = [{ role: "toolResult", content: [text(long)] }];
    const op = snapWith([{ id: "f1", width: 8, height: 8, png_base64: "aGVsbG8=" }]);
    const result = applyTransforms(messages, cached(op), keyFn, "nextUser");
    expect(result.snapApplied).toBe(0);
    expect(messages[0].content).toEqual([text(long)]);
  });
});
