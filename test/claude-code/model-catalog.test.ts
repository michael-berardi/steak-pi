import assert from "node:assert/strict";
import { resolveCliModel } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import {
  CLAUDE_CODE_MODELS,
  isClaudeCodeCatalogModel,
  modelForDiscoveredRoute,
  modelFromDiscovery,
  nativeModel,
  supportsAdaptiveThinking,
  supportsNativeToolChanges,
} from "../../extensions/claude-code/model-catalog.ts";
import { createClaudeCodeProvider } from "../../extensions/claude-code/provider.ts";

test("fallback catalog matches Claude Code's selectable model families", () => {
  assert.deepEqual(
    CLAUDE_CODE_MODELS.map((model) => model.id),
    [
      "default",
      "claude-opus-5-5",
      "claude-fable-5-2",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
    ],
  );
  assert.equal(nativeModel("default"), "default");
  assert.equal(nativeModel("claude-opus-5-5"), "opus[1m]");
  assert.equal(nativeModel("claude-sonnet-5-5"), "sonnet");
  assert.equal(supportsNativeToolChanges("default"), true);
  assert.equal(supportsNativeToolChanges("claude-opus-5-5"), true);
  assert.equal(supportsNativeToolChanges("claude-sonnet-5-5"), true);
});

test("replaces Fable 5.1 with exactly one Fable 5.2 row, in the Opus position", () => {
  const fables = CLAUDE_CODE_MODELS.filter((model) => /fable/u.test(model.id));
  assert.deepEqual(fables.map((model) => model.id), ["claude-fable-5-2"]);
  // The row sits where the Fable entry sat on 0.23.19: right after the Opus entries.
  assert.deepEqual(CLAUDE_CODE_MODELS.slice(0, 3).map((model) => model.id), ["default", "claude-opus-5-5", "claude-fable-5-2"]);
  const fable = fables[0];
  assert.equal(fable.name, "Fable (Claude Code)");
  assert.equal(fable.provider, "claude-code");
  // 1M context, the Fable max output budget and its reasoning flags, registered for Pi's picker and requests.
  assert.equal(fable.contextWindow, 1_000_000);
  assert.equal(fable.maxTokens, 128_000);
  assert.equal(fable.reasoning, true);
  assert.deepEqual(fable.input, ["text", "image"]);
  assert.equal(fable.thinkingLevelMap?.max, "max");
  assert.equal(fable.thinkingLevelMap?.xhigh, "xhigh");
  // No Fable 5.1 row, id or alias survives the replacement.
  assert.equal(modelForDiscoveredRoute("claude-fable-5-1"), undefined);
  assert.equal(isClaudeCodeCatalogModel("claude-fable-5-1"), false);
});

test("the fable alias selects Fable 5.2", () => {
  assert.equal(modelForDiscoveredRoute("fable")?.id, "claude-fable-5-2");
  assert.equal(modelForDiscoveredRoute("claude-fable-5-2")?.id, "claude-fable-5-2");
  assert.equal(nativeModel("fable"), "claude-fable-5-2");
  assert.equal(supportsAdaptiveThinking("fable"), true);
  assert.equal(isClaudeCodeCatalogModel("fable"), false);
});

test("every catalog model is registered before Pi resolves --model, so none warns as a custom id", () => {
  // The startup warning comes from Pi's CLI resolver reading the provider's registered model list
  // before live CLI discovery: the shipped catalog must already carry each id.
  const provider = createClaudeCodeProvider();
  const registered = provider.getModels();
  const modelRuntime = { getModels: () => registered, hasConfiguredAuth: () => true } as never;
  for (const model of CLAUDE_CODE_MODELS) {
    const route = `claude-code/${model.id}`;
    const resolved = resolveCliModel({ cliModel: route, modelRuntime });
    assert.equal(resolved.warning, undefined, route);
    assert.equal(resolved.model?.id, model.id, route);
    assert.equal(resolved.model?.provider, "claude-code", route);
  }
});

test("maps discovered aliases to stable canonical Pi model ids", () => {
  const opus = modelFromDiscovery({
    value: "opus[1m]",
    resolvedModel: "claude-opus-5-5[1m]",
    displayName: "Opus (1M context)",
    description: "Opus 5.5 with 1M context",
    supportsEffort: true,
    supportedEffortLevels: ["low", "high", "max"],
    supportsAdaptiveThinking: true,
  });
  assert.equal(opus.id, "claude-opus-5-5");
  assert.equal(opus.name, "Claude Opus 5.5");
  assert.equal(opus.contextWindow, 1_000_000);
  assert.deepEqual(opus.cost, { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
  assert.deepEqual(opus.thinkingLevelMap, {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  });

  const future = modelFromDiscovery({
    value: "future",
    resolvedModel: "claude-future-1",
    displayName: "Future",
    description: "A newly available model",
  });
  assert.equal(future.id, "claude-future-1");
  assert.equal(future.cost.input, 0);
});
