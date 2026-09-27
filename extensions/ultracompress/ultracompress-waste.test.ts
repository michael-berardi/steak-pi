import { expect, it } from "vitest";
import { mergeSettings } from "./src/settings";
import { collectCandidates, applyTransforms, type SnapOp } from "./src/transforms";
import { capSummary } from "./src/compact-hook";
import { recallArgs } from "./src/recall";
it("uses bounded configurable waste defaults", () => {
  const s = mergeSettings({ snap: { minChars: NaN }, summaryMaxBytes: Infinity });
  expect(s.snap.minChars).toBe(8192);
  expect(s.summaryMaxBytes).toBe(16384);
  expect(mergeSettings({ summaryMaxBytes: 1 }).summaryMaxBytes).toBe(1024);
});
it("exempts fresh bash even on a cache hit, but archives old results", () => {
  const messages = [{ role: "toolResult", toolName: "bash", content: [{ type: "text", text: "x".repeat(8192) }] }];
  expect(collectCandidates(messages, 8192, () => "k")).toHaveLength(0);
  expect(collectCandidates([...messages, { role: "assistant", content: [] }], 8192, () => "k")).toHaveLength(1);
  const op: SnapOp = { op: "snap", message_index: 0, block_index: 0, head: "", tail: "", frames: [], tokens_before: 1, tokens_after: 1 };
  expect(applyTransforms(messages, new Map([["k", { op, blocks: [] }]]), () => "k", "inline").snapApplied).toBe(0);
});
it("caps UTF-8 summaries and sets an explicit bounded recall excerpt", () => {
  const summary = capSummary("日本語".repeat(10000), 1024);
  expect(Buffer.byteLength(summary)).toBeLessThanOrEqual(1024); expect(summary).not.toContain("�"); expect(summary).toContain("ultracompress_recall");
  expect(recallArgs({ query: "test" }, { getSessionFile: () => "/session", getLeafId: () => null })).toContain("4000");
});
