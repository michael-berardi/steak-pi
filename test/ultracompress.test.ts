import { describe, expect, it } from "vitest";
import { mergeSettings, DEFAULT_SETTINGS } from "../extensions/ultracompress/src/settings.ts";
import {
  applyTransforms,
  collectCandidates,
  type SnapOp,
  type UcOp,
  type AgentLikeMessage,
} from "../extensions/ultracompress/src/transforms.ts";
import { buildSnap, snapFileName } from "../extensions/ultracompress/src/snapshot.ts";
import { parseUltraCompressArgs } from "../extensions/ultracompress/src/compact-hook.ts";

describe("ultracompress settings", () => {
  it("defaults survive junk and merge partials", () => {
    expect(mergeSettings("junk")).toEqual(DEFAULT_SETTINGS);
    const s = mergeSettings({ policy: "vcc", uc: { enabled: false } });
    expect(s.policy).toBe("vcc");
    expect(s.uc.enabled).toBe(false);
    expect(s.snapshot.enabled).toBe(true);
  });

  it("snap frames are provider-gated by default", () => {
    expect(DEFAULT_SETTINGS.snap.providers).toEqual(["anthropic", "google"]);
  });
});

describe("ultracompress live transforms", () => {
  const snapOp: SnapOp = {
    op: "snap",
    message_index: 0,
    block_index: 0,
    head: "h",
    tail: "t",
    frames: [{ id: "f1", width: 10, height: 10, pngBase64: "aGk=" }],
    tokens_before: 10,
    tokens_after: 5,
  };
  const ucOp: UcOp = {
    op: "uc",
    message_index: 0,
    block_index: 0,
    stub: "[UC packet]",
    packet: "@UC1",
    tokens_before: 10,
    tokens_after: 5,
  };

  it("collects oversized toolResult blocks only", () => {
    const msgs: AgentLikeMessage[] = [
      { role: "user", content: "x".repeat(7000) },
      { role: "toolResult", content: [{ type: "text", text: "x".repeat(7000) }] },
      { role: "toolResult", content: [{ type: "text", text: "tiny" }] },
    ];
    expect(collectCandidates(msgs, 6000, (t) => t.slice(0, 8))).toHaveLength(1);
  });

  it("applies UC inline and snap frames to next user message", () => {
    const msgs: AgentLikeMessage[] = [
      { role: "user", content: "go" },
      { role: "toolResult", content: [{ type: "text", text: "x".repeat(7000) }] },
      { role: "user", content: "next" },
    ];
    applyTransforms(msgs, new Map([["uc", { op: ucOp, blocks: [{ type: "text", text: "stub @UC1" }] }]]), () => "uc", "nextUser");
    const ucContent = msgs[1].content as Array<Record<string, unknown>>;
    expect(String(ucContent[0].text)).toContain("@UC1");
    applyTransforms(msgs, new Map([["s", { op: snapOp, blocks: [{ type: "text", text: "edges" }] }]]), () => "s", "nextUser");
    const userContent = msgs[2].content as Array<Record<string, unknown>>;
    expect(userContent.some((b) => b.type === "image")).toBe(true);
  });
});

describe("ultracompress snapshot guarantee (instant-snap replacement)", () => {
  it("serializes full pre-compaction state", () => {
    const { meta, payload } = buildSnap([{ type: "message" }, { type: "message" }], "threshold", 1234);
    expect(meta.compactor).toBe("ultracompress");
    expect(meta.entries).toBe(2);
    expect(JSON.parse(payload).entries).toHaveLength(2);
    expect(snapFileName(1234)).toMatch(/^snap-.*\.json$/);
  });
});

describe("ultracompress command args", () => {
  it("parses /ultracompress keep:N policy:p prompt", () => {
    const r = parseUltraCompressArgs("keep:3 policy:uc rerun the failing suite");
    expect(r).toEqual({ keep: 3, policy: "uc", prompt: "rerun the failing suite" });
  });
});
