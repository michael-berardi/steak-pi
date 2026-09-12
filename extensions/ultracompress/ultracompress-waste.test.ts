import { expect, it } from "vitest";
import { mergeSettings } from "./src/settings";
import { collectCandidates, applyTransforms, ucReplacement, type UcOp } from "./src/transforms";
import { UcReferences, parseUcReference } from "./src/references";
import { capSummary } from "./src/compact-hook";
import { recallArgs } from "./src/recall";
it("uses bounded configurable waste defaults", () => {
  const s = mergeSettings({ uc: { minChars: NaN }, summaryMaxBytes: Infinity });
  expect(s.uc.minChars).toBe(8192); expect(s.snap.minChars).toBe(8192);
  expect(s.uc.exemptFreshBash).toBe(true); expect(s.summaryMaxBytes).toBe(16384);
  expect(mergeSettings({ summaryMaxBytes: 1 }).summaryMaxBytes).toBe(1024);
});
it("exempts fresh bash even on a cache hit, but permits opt-out and old results", () => {
  const messages = [{ role: "toolResult", toolName: "bash", content: [{ type: "text", text: "x".repeat(8192) }] }];
  expect(collectCandidates(messages, 8192, () => "k")).toHaveLength(0);
  expect(collectCandidates(messages, 8192, () => "k", false)).toHaveLength(1);
  expect(collectCandidates([...messages, { role: "assistant", content: [] }], 8192, () => "k")).toHaveLength(1);
  const op: UcOp = { op: "uc", message_index: 0, block_index: 0, stub: "", packet: "", tokens_before: 1, tokens_after: 1 };
  expect(applyTransforms(messages, new Map([["k", { op, blocks: [] }]]), () => "k", "inline").ucApplied).toBe(0);
});
it("round trips short and legacy markers without native decode", () => {
  const refs = new UcReferences(); const reference = refs.put("exact 日本語")!;
  const marker = ucReplacement({ op: "uc", message_index: 0, block_index: 0, reference, stub: "", packet: "", tokens_before: 1, tokens_after: 1 })[0].text as string;
  expect(marker.length).toBeLessThanOrEqual(80); expect(refs.get(parseUcReference(marker)!)).toBe("exact 日本語");
  expect(parseUcReference(`[UC archived output: call ultracompress_uc with packet="${reference}" for the exact original text. This is deferred retrieval, not a summary.]`)).toBe(reference);
  expect(parseUcReference("[UC ../../bad]")).toBeUndefined();
});
it("caps UTF-8 summaries and sets an explicit bounded recall excerpt", () => {
  const summary = capSummary("日本語".repeat(10000), 1024);
  expect(Buffer.byteLength(summary)).toBeLessThanOrEqual(1024); expect(summary).not.toContain("�"); expect(summary).toContain("ultracompress_recall");
  expect(recallArgs({ query: "test" }, { getSessionFile: () => "/session", getLeafId: () => null })).toContain("4000");
});
