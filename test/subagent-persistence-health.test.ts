import { describe, expect, it } from "vitest";
import { checkpointFailureCause, PersistenceHealth } from "../src/subagents/persistence-health.ts";

describe("bounded nonsecret checkpoint causes", () => {
  it.each(["ENOSPC", "EACCES", "EPERM", "UNKNOWN"])("retains %s without echoing error payloads", (code) => {
    const cause = checkpointFailureCause(Object.assign(new Error("secret=/private/transcript token=abc"), { code, syscall: "write" }), "lifecycle");
    expect(cause).toMatchObject({ code, syscall: "write", stage: "lifecycle", name: "Error" });
    expect(JSON.stringify(cause)).not.toMatch(/secret|private\/transcript|abc/);
  });
  it("never infers ENOSPC from a generic historical warning or untrusted fields", () => {
    expect(checkpointFailureCause(new Error("Checkpoint write failed; inspect disk space"), "initial").code).toBe("UNKNOWN");
    const cause = checkpointFailureCause({ code: "ENOSPC token=abc", syscall: "/secret", name: "payload", message: "ENOSPC" }, "retry");
    expect(cause).toMatchObject({ code: "UNKNOWN", syscall: null, name: "Error" });
  });
  it("validates each failed run independently and retains first and latest failure evidence", () => {
    const health = new PersistenceHealth();
    health.failed("a", { code: "ENOSPC" }, "lifecycle");
    health.failed("b", { code: "EPERM" }, "receipt");
    health.saved("a");
    expect(health.blocked).toBe(true);
    health.saved("other");
    expect(health.blocked).toBe(true);
    health.saved("b");
    expect(health.diagnose()).toMatchObject({ state: "validated-save", pendingRuns: 0,
      retainedFailure: { first: { code: "ENOSPC" }, latest: { code: "EPERM" }, count: 2 } });
  });
});
