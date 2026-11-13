import assert from "node:assert/strict";
import { test } from "vitest";
import { FALLBACK_DISCOVERY, modelFromDiscovery } from "../../extensions/claude-code/model-catalog.ts";

// Measured design: the `[1m]` suffix is not part of the registered id (canonicalModelId strips it), so a plain live row
// and its `[1m]` shipped row are the SAME registered model and share its window. A plain row that states no window
// therefore does take the shipped 1M window; that is intended (the earlier fix for the newest model listing at 200K).
// This test pins the behaviour so a change to it is a decision, not an accident.
test("a plain live row shares the window of the shipped [1m] row for the same model id", () => {
  const shipped = FALLBACK_DISCOVERY.find((row) => /\[1m\]$/u.test(row.value) && row.contextWindow !== undefined);
  assert.ok(shipped, "a shipped [1m] row with a stated window exists");
  const plain = modelFromDiscovery({ value: shipped.value.replace(/\[1m\]$/u, ""), resolvedModel: shipped.resolvedModel, displayName: shipped.displayName, description: "no window stated" });
  assert.equal(plain.contextWindow, shipped.contextWindow);
  assert.equal(plain.id, modelFromDiscovery(shipped).id);
});

test("a live row that states its own window keeps it, and an unrelated model never borrows a shipped window", () => {
  const shipped = FALLBACK_DISCOVERY.find((row) => row.contextWindow !== undefined)!;
  assert.equal(modelFromDiscovery({ value: shipped.value, resolvedModel: shipped.resolvedModel, displayName: "x", description: "x", contextWindow: 123_456, maxTokens: 7_000 }).contextWindow, 123_456);
  assert.equal(modelFromDiscovery({ value: "unrelated-model", resolvedModel: "unrelated-model", displayName: "x", description: "x" }).contextWindow, 200_000);
});
