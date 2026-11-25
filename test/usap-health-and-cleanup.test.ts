import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyFailure, type TaskEvidence } from "../src/subagents/route-evidence.ts";
import { routeHealth, type RankSettings } from "../src/subagents/route-ranking.ts";
import { routeQuotaBlock, routeUnsupportedBlock, type QuotaSnapshot } from "../src/subagents/provider-quota.ts";
import { computeAvailability } from "../src/subagents/route-availability.ts";
import { sweepDeadNamespaces } from "../src/subagents/checkpoints.ts";

const SETTINGS: RankSettings = {
  timeWeight: 0.0005,
  minPassRate: 0.6,
  explore: 0.1,
  demoteAfter: 3,
  window: 5,
  cooldownMs: 30 * 60_000,
  qualityGate: 0,
  selfReportWeight: 1,
  priors: {},
};

function task(overrides: Partial<TaskEvidence>): TaskEvidence {
  return {
    v: 1,
    kind: "task",
    at: 1000,
    runId: "run-1",
    taskId: "t-1",
    label: "l",
    taskClass: "scout",
    route: "provider-a/model-1",
    outcome: "pass",
    source: "worker-state",
    wallSeconds: 10,
    costUsd: 0.01,
    tokens: 100,
    ...overrides,
  };
}

describe("USAP health classification, unsupported block, and namespace cleanup", () => {
  it("classifies unsupported-plan config errors and stream stalls separately from other", () => {
    expect(classifyFailure("signed in with a free plan, which cannot run the worker models; sign in again")).toBe("provider-config");
    expect(classifyFailure("model foo is not supported for your account")).toBe("provider-config");
    expect(classifyFailure("No model or tool activity for 300s")).toBe("stalled-stream");
  });

  it("excludes content-filter from demotion while stalled-stream and provider-config still demote broken routes", () => {
    const contentFilterOnly: TaskEvidence[] = [
      task({ at: 1, outcome: "pass" }),
      task({ at: 2, outcome: "pass" }),
      task({ at: 3, outcome: "fail", failureKind: "content-filter" }),
      task({ at: 4, outcome: "fail", failureKind: "content-filter" }),
      task({ at: 5, outcome: "fail", failureKind: "content-filter" }),
    ];
    expect(routeHealth(contentFilterOnly, [], SETTINGS, 10_000).state).toBe("healthy");

    const repeatedStalls: TaskEvidence[] = [
      task({ at: 1, outcome: "fail", failureKind: "stalled-stream" }),
      task({ at: 2, outcome: "fail", failureKind: "stalled-stream" }),
      task({ at: 3, outcome: "fail", failureKind: "stalled-stream" }),
    ];
    const stalled = routeHealth(repeatedStalls, [], SETTINGS, 10_000);
    expect(stalled.state).toBe("demoted");
    expect(stalled.cause).toContain("stalled-stream");
  });

  it("keeps proven-free routes UP on exhausted tiers while blocking unsupported providers", () => {
    const exhaustedSnapshot: QuotaSnapshot = {
      known: true,
      providers: {
        "opencode-go": {
          provider: "opencode-go",
          accounts: 1,
          exhausted: true,
          unconfigured: false,
          ineligible: false,
          unsupported: false,
          cause: "quota exhausted",
          rows: [],
        },
      },
    };
    const freeStep = { provider: "opencode-go", id: "worker-free", route: "opencode-go/worker-free" };
    const availExhausted = computeAvailability({
      chain: [freeStep],
      snapshot: exhaustedSnapshot,
      policy: {},
      isFree: () => true,
    });
    expect(availExhausted.steps[0]?.state).toBe("up");
    expect(routeUnsupportedBlock(exhaustedSnapshot, freeStep)).toBeUndefined();

    const unsupportedSnapshot: QuotaSnapshot = {
      known: true,
      providers: {
        "opencode-go": {
          provider: "opencode-go",
          accounts: 1,
          exhausted: true,
          unconfigured: false,
          ineligible: true,
          unsupported: true,
          cause: "plan unsupported for worker models",
          rows: [],
        },
      },
    };
    const availUnsupported = computeAvailability({
      chain: [freeStep],
      snapshot: unsupportedSnapshot,
      policy: {},
      isFree: () => true,
    });
    expect(availUnsupported.steps[0]?.state).toBe("unavailable");
    expect(routeUnsupportedBlock(unsupportedSnapshot, freeStep)).toBe("plan unsupported for worker models");
    expect(routeQuotaBlock(unsupportedSnapshot, freeStep)).toBe("plan unsupported for worker models");
  });

  it("sweepDeadNamespaces removes expired dead namespaces, serializes on .claim, fails closed on missing pid, checks sessions/ mtime, and skips symlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "usap-ns-sweep-"));
    try {
      const deadOld = join(root, "b".repeat(64));
      const deadRecentSession = join(root, "c".repeat(64));
      const liveOwned = join(root, "d".repeat(64));
      const missingPidLock = join(root, "e".repeat(64));
      const claimedDir = join(root, "f".repeat(64));
      const symlinkTarget = join(root, "target");
      const symlinkNs = join(root, "1".repeat(64));
      const unrelated = join(root, "checkpoint");
      for (const d of [deadOld, deadRecentSession, liveOwned, missingPidLock, claimedDir, symlinkTarget, unrelated]) {
        mkdirSync(d, { recursive: true, mode: 0o700 });
      }
      symlinkSync(symlinkTarget, symlinkNs);

      writeFileSync(join(deadOld, "owner.json"), JSON.stringify({ pid: 99999999 }), { mode: 0o600 });
      chmodSync(join(deadOld, "owner.json"), 0o600);
      writeFileSync(join(deadOld, "run-1.json"), "{}", { mode: 0o600 });

      mkdirSync(join(deadRecentSession, "sessions"), { recursive: true, mode: 0o700 });
      writeFileSync(join(deadRecentSession, "sessions", "recent.jsonl"), "{}\n", { mode: 0o600 });

      writeFileSync(join(liveOwned, "owner.json"), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
      chmodSync(join(liveOwned, "owner.json"), 0o600);

      writeFileSync(join(missingPidLock, "owner.json"), JSON.stringify({ token: "no-pid" }), { mode: 0o600 });
      chmodSync(join(missingPidLock, "owner.json"), 0o600);

      mkdirSync(join(claimedDir, ".claim"), { mode: 0o700 });
      writeFileSync(join(unrelated, "keep.json"), "{}", { mode: 0o600 });

      const now = Date.now();
      const oldSec = (now - 10 * 86_400_000) / 1000;
      const sixDaysAgoSec = (now - 6 * 86_400_000) / 1000;
      for (const p of [
        join(deadOld, "owner.json"), join(deadOld, "run-1.json"), deadOld,
        deadRecentSession, join(deadRecentSession, "sessions"),
        join(missingPidLock, "owner.json"), missingPidLock,
        claimedDir,
      ]) {
        utimesSync(p, oldSec, oldSec);
      }
      utimesSync(join(deadRecentSession, "sessions", "recent.jsonl"), sixDaysAgoSec, sixDaysAgoSec);
      const mtimeBefore = statSync(deadRecentSession).mtimeMs;

      const removed = sweepDeadNamespaces(root, { maxAgeMs: 7 * 86_400_000, now });
      expect(removed).toBe(1);
      expect(existsSync(deadOld)).toBe(false);
      expect(existsSync(deadRecentSession)).toBe(true); // protected by 6d-old sessions/recent.jsonl
      expect(statSync(deadRecentSession).mtimeMs).toBe(mtimeBefore); // sweep did NOT bump dir mtime
      expect(existsSync(liveOwned)).toBe(true);
      expect(existsSync(missingPidLock)).toBe(true); // fail closed when pid missing
      expect(existsSync(claimedDir)).toBe(true); // .claim held -> skipped
      expect(existsSync(symlinkTarget)).toBe(true);
      expect(existsSync(unrelated)).toBe(true);

      // 1.5 days later the 6d-old session crosses the 7d TTL (would have stayed if pass 1 had bumped dir mtime)
      const laterRemoved = sweepDeadNamespaces(root, { maxAgeMs: 7 * 86_400_000, now: now + 1.5 * 86_400_000 });
      expect(laterRemoved).toBe(1);
      expect(existsSync(deadRecentSession)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
