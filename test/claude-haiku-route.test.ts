/**
 * J-0340: claude-code/claude-haiku-5-5, the explicit opt-in routine tier.
 * Every fixture here is SYNTHETIC: scripted stream-json frames through an
 * injected fake spawn, never real inference. The streams are shaped after the
 * real paired trial (init model, assistant model per frame, result modelUsage),
 * and the trial itself is the only real-runtime evidence.
 */
import { describe, expect, it } from "vitest";
import { RetiredModelSelectionError } from "../src/retired-model-selection.ts";
import { transientFailure } from "../src/subagents/auto-resume.ts";
import { claudeWorkerArgs, createClaudeWorkerRunner, parseClaudeStreamLine, type ClaudeSpawnHandle } from "../src/subagents/claude-worker.ts";
import {
  assertClaudeCodeSelector, claudeCodeDefaultEffort, claudeCodeModelName, claudeCodeModelOf, CLAUDE_CODE_HAIKU_EFFORT,
  CLAUDE_CODE_HAIKU_MODEL, CLAUDE_CODE_HAIKU_ROUTE, CLAUDE_CODE_OPUS_ROUTE, CLAUDE_CODE_ROUTES, CLAUDE_CODE_SONNET_ROUTE,
  defaultClaudeCodeRoute, resolveClaudeCodeEffort, resolveClaudeCodeSelection, resolveWorkerSelection,
} from "../src/subagents/model-selection.ts";
import { emptyUsage, USAP_VERSION, type RunRecord, type TaskRecord } from "../src/subagents/types.ts";

const HAIKU = "claude-haiku-5-5";
const SONNET = "claude-sonnet-5-5";
const OPUS = "claude-opus-5-5";

function run(model: string, thinkingLevel: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    version: USAP_VERSION, id: "run-haiku-test", goal: "Synthetic bounded extraction", constraints: [],
    cwd: "/repo", model, harness: "claude-code", thinkingLevel,
    concurrency: 1, timeoutMs: 60_000, maxTurns: 8, background: false, state: "running",
    createdAt: 0, tasks: [], usage: emptyUsage(), ...overrides,
  };
}
const haikuRun = (overrides: Partial<RunRecord> = {}) => run(CLAUDE_CODE_HAIKU_ROUTE, "medium", overrides);

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "run-haiku-test-task-1", label: "Extract", task: "Extract the explicit contact fields", role: "worker",
    mayEdit: false, ownedPaths: [], allowBash: false, state: "running", output: "",
    turns: 0, usage: emptyUsage(), relaySent: 0, relayReceived: 0, truncated: false, ...overrides,
  };
}

class FakeClaudeProcess implements ClaudeSpawnHandle {
  private static nextPid = 9100;
  pid = FakeClaudeProcess.nextPid++;
  exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
  stdoutListeners: Array<(chunk: string) => void> = [];
  stdinChunks: string[] = [];
  signals: string[] = [];
  onExit(listener: (code: number | null, signal: string | null) => void) { this.exitListeners.push(listener); }
  onError() {}
  onStdout(listener: (chunk: string) => void) { this.stdoutListeners.push(listener); }
  onStderr() {}
  writeStdin(text: string) { this.stdinChunks.push(text); }
  endStdin() {}
  kill(signal?: string) {
    this.signals.push(signal ?? "SIGTERM");
    if (signal === "SIGKILL") queueMicrotask(() => this.exit(null, "SIGKILL"));
    return true;
  }
  stdout(chunk: string) { for (const listener of this.stdoutListeners) listener(chunk); }
  exit(code: number | null = 0, signal: string | null = null) { for (const listener of this.exitListeners) listener(code, signal); }
}

function fakeSpawn(script: (child: FakeClaudeProcess) => void) {
  const calls: Array<{ command: string; args: string[]; child: FakeClaudeProcess }> = [];
  const spawn = ({ command, args }: { command: string; args: string[] }) => {
    const child = new FakeClaudeProcess();
    calls.push({ command, args, child });
    queueMicrotask(() => script(child));
    return child;
  };
  return { spawn: spawn as never, calls };
}

const frame = (value: unknown) => `${JSON.stringify(value)}\n`;
let sequence = 0;
const init = (model: string) => frame({ type: "system", subtype: "init", model });
const assistant = (model: string | undefined, extra: Record<string, unknown> = {}, content: unknown[] = [{ type: "text", text: "ok" }]) =>
  frame({ type: "assistant", ...extra, message: { id: `synthetic-msg-${++sequence}`, ...(model === undefined ? {} : { model }), content } });
const toolUse = (id: string) => [{ type: "tool_use", id, name: "Read", input: { file_path: "/repo/brief.txt" } }];
const toolResult = (id: string) => frame({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, is_error: false, content: "brief" }] } });
const result = (modelUsage?: Record<string, unknown>, text = "report") => frame({
  type: "result", subtype: "success", is_error: false, result: text, num_turns: 2, total_cost_usd: 0.01,
  usage: { input_tokens: 3, output_tokens: 4 }, ...(modelUsage ? { modelUsage } : {}),
});

const options = (spawn: unknown) => ({ spawn, abortGraceMs: 20 }) as Parameters<typeof createClaudeWorkerRunner>[0];
const go = (spawn: unknown, r: RunRecord, t: TaskRecord = task()) =>
  createClaudeWorkerRunner(options(spawn))({ run: r, task: t, signal: new AbortController().signal, onProgress: () => {} });
const flagValue = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe("synthetic: Haiku 5.5 route selection", () => {
  it("resolves the exact Haiku route as an explicit override and never as a default", () => {
    expect(CLAUDE_CODE_HAIKU_ROUTE).toBe("claude-code/claude-haiku-5-5");
    expect(claudeCodeModelOf(CLAUDE_CODE_HAIKU_ROUTE)).toBe(HAIKU);
    expect(claudeCodeModelName(CLAUDE_CODE_HAIKU_MODEL)).toBe("Haiku 5.5");
    expect(CLAUDE_CODE_ROUTES).toEqual([CLAUDE_CODE_SONNET_ROUTE, CLAUDE_CODE_OPUS_ROUTE, CLAUDE_CODE_HAIKU_ROUTE]);
    expect(resolveClaudeCodeSelection(HAIKU)).toEqual({ provider: "claude-code", modelId: HAIKU, source: "override", harness: "claude-code", images: false, tools: true });
    // Never fuzzy: only the exact spelling resolves.
    for (const near of ["claude-code/claude-haiku-5-5-latest", "claude-code/claude-haiku-4-5", "claude-code/haiku", "claude-haiku-5-5", "anthropic/claude-haiku-5-5", "claude-code/CLAUDE-HAIKU-5-5"]) {
      expect(claudeCodeModelOf(near)).toBeUndefined();
    }
    // Implicit routing keeps its operator defaults: reviewers Opus, everything else Sonnet.
    for (const tasks of [[], [{ role: "worker" }], [{ role: "scout" }], [{}], [{ role: "worker" }, { role: "reviewer" }]]) {
      expect(defaultClaudeCodeRoute(tasks)).toBe(CLAUDE_CODE_SONNET_ROUTE);
    }
    expect(defaultClaudeCodeRoute([{ role: "reviewer" }])).toBe(CLAUDE_CODE_OPUS_ROUTE);
  });

  it("defaults Haiku to medium effort, lets an explicit effort win, and keeps Sonnet/Opus at xhigh", () => {
    expect(CLAUDE_CODE_HAIKU_EFFORT).toBe("medium");
    expect(claudeCodeDefaultEffort(HAIKU)).toBe("medium");
    expect(resolveClaudeCodeEffort(HAIKU)).toBe("medium");
    for (const effort of ["medium", "high", "xhigh"]) expect(resolveClaudeCodeEffort(HAIKU, effort)).toBe(effort);
    for (const bad of ["low", "max", "off", "", "XHIGH"]) expect(() => resolveClaudeCodeEffort(HAIKU, bad)).toThrow(/Haiku 5\.5 accepts medium, high or xhigh/);
    for (const model of [SONNET, OPUS] as const) {
      expect(claudeCodeDefaultEffort(model)).toBe("xhigh");
      expect(resolveClaudeCodeEffort(model)).toBe("xhigh");
      expect(resolveClaudeCodeEffort(model, "xhigh")).toBe("xhigh");
      for (const other of ["medium", "high"]) expect(() => resolveClaudeCodeEffort(model, other)).toThrow(/requires xhigh effort/);
    }
  });

  it("builds Haiku CLI args on the subscription CLI with no bare mode and no fallback model", () => {
    const args = claudeWorkerArgs(6, { mayEdit: true, ownedPaths: ["/repo/fixture"] }, (value) => value, HAIKU);
    expect(flagValue(args, "--model")).toBe(HAIKU);
    expect(flagValue(args, "--effort")).toBe("medium");
    expect(flagValue(claudeWorkerArgs(undefined, {}, undefined, HAIKU, undefined, "high"), "--effort")).toBe("high");
    for (const forbidden of ["--bare", "--fallback-model", "--betas", "--append-system-prompt", "--dangerously-skip-permissions"]) expect(args).not.toContain(forbidden);
    expect(args.join(" ")).not.toMatch(/fallback/i);
    expect(args).toContain("--strict-mcp-config");
    // Existing routes are unchanged.
    expect(claudeWorkerArgs(undefined, {}, undefined, SONNET).slice(4, 8)).toEqual(["--model", SONNET, "--effort", "xhigh"]);
    expect(claudeWorkerArgs().slice(4, 8)).toEqual(["--model", OPUS, "--effort", "xhigh"]);
    expect(() => claudeWorkerArgs(undefined, {}, undefined, SONNET, undefined, "medium")).toThrow(/cannot run at "medium" effort/);
    expect(() => claudeWorkerArgs(undefined, {}, undefined, HAIKU, undefined, "low")).toThrow(/cannot run at "low" effort/);
    expect(() => claudeWorkerArgs(undefined, {}, undefined, "claude-haiku-4-5" as never)).toThrow(/unknown claude-code model/);
  });

  it("names unknown ids and keeps the retired Sol 6.0 and GLM refusals", () => {
    for (const model of ["claude-code/claude-haiku-4-5", "claude-code/claude-haiku-5-5-latest", "claude-haiku-5-5", "anthropic/claude-haiku-5-5"]) {
      expect(() => assertClaudeCodeSelector({ model })).toThrow(/unknown claude-code model .*no fallback was selected/);
    }
    expect(() => assertClaudeCodeSelector({ profile: "claude-code/haiku-5-5" })).toThrow(/unknown claude-code profile/);
    expect(() => assertClaudeCodeSelector({ model: CLAUDE_CODE_HAIKU_ROUTE })).not.toThrow();
    expect(() => assertClaudeCodeSelector({ model: CLAUDE_CODE_SONNET_ROUTE })).not.toThrow();
    expect(() => assertClaudeCodeSelector({ model: CLAUDE_CODE_OPUS_ROUTE })).not.toThrow();
    for (const sol of ["openai-codex/gpt-6-sol", "gpt-6.0-sol", "steak-pi/gpt-6-sol"]) {
      expect(() => assertClaudeCodeSelector({ model: sol })).toThrow(RetiredModelSelectionError);
    }
    expect(() => assertClaudeCodeSelector({ profile: "steak-pi/gpt-6-sol" })).toThrow(RetiredModelSelectionError);
    for (const glm of ["zai/glm-5.3", "zai/glm-5.3-flash", "glm-5.3"]) {
      expect(() => assertClaudeCodeSelector({ model: glm })).toThrow(/retired: GLM 5\.3 and the Z\.ai plan/);
    }
  });

  it("keeps the native Pi path closed to claude-code and to retired routes", () => {
    const parent = { provider: "openai-codex", id: "gpt-6.1-sol" } as never;
    const registry = { find: () => undefined, getAvailable: () => [], isUsingOAuth: () => true } as never;
    expect(() => resolveWorkerSelection(parent, "high", { harness: "claude-code", tasks: [{ label: "a", task: "b" }] } as never, registry, []))
      .toThrow(/does not resolve through the native Pi registry/);
    for (const model of ["openai-codex/gpt-6-sol", "zai/glm-5.3"]) {
      expect(() => resolveWorkerSelection(parent, "high", { model, tasks: [{ label: "a", task: "b" }] } as never, registry, [])).toThrow();
    }
  });
});

describe("synthetic: Haiku 5.5 worker stream and effective-model verification", () => {
  it("runs the pinned Haiku route at medium and accepts a stream whose assistant model and modelUsage match", async () => {
    const { spawn, calls } = fakeSpawn((child) => {
      child.stdout(init(HAIKU));
      child.stdout(assistant(HAIKU, {}, toolUse("t1")));
      child.stdout(toolResult("t1"));
      child.stdout(assistant(HAIKU));
      child.stdout(result({ [HAIKU]: { canonicalModel: HAIKU } }));
      child.exit(0);
    });
    const outcome = await go(spawn, haikuRun(), task({ id: "t", mayEdit: true, ownedPaths: ["/repo/fixture"] }));
    expect(outcome.state).toBe("done");
    expect(outcome.toolSuccesses).toBe(1);
    expect(outcome.toolErrors).toBe(0);
    expect(calls).toHaveLength(1);
    expect(flagValue(calls[0].args, "--model")).toBe(HAIKU);
    expect(flagValue(calls[0].args, "--effort")).toBe("medium");
    expect(calls[0].args).not.toContain("--bare");
    expect(calls[0].args).not.toContain("--fallback-model");
  });

  it("passes an explicit Haiku effort through to the CLI", async () => {
    const { spawn, calls } = fakeSpawn((child) => { child.stdout(assistant(HAIKU)); child.stdout(result({ [HAIKU]: {} })); child.exit(0); });
    const outcome = await go(spawn, run(CLAUDE_CODE_HAIKU_ROUTE, "high"));
    expect(outcome.state).toBe("done");
    expect(flagValue(calls[0].args, "--effort")).toBe("high");
  });

  it("fails an effective model mismatch by name, in both directions, and never accepts the init label as proof", async () => {
    const cases: Array<[string, RecordedScript, RegExp]> = [
      ["haiku requested, sonnet served", (c) => { c.stdout(init(HAIKU)); c.stdout(assistant(SONNET)); c.stdout(result({ [SONNET]: {} })); },
        /^effective model mismatch: requested claude-haiku-5-5, got claude-sonnet-5-5/],
      ["haiku requested, opus served", (c) => { c.stdout(assistant(OPUS)); }, /^effective model mismatch: requested claude-haiku-5-5, got claude-opus-5-5/],
      ["haiku requested, older haiku served as main", (c) => { c.stdout(assistant("claude-haiku-4-5-20251001")); },
        /^effective model mismatch: requested claude-haiku-5-5, got claude-haiku-4-5-20251001/],
      ["init label differs", (c) => { c.stdout(init(SONNET)); }, /^effective model mismatch: requested claude-haiku-5-5, got claude-sonnet-5-5/],
      ["modelUsage shows only an older haiku", (c) => { c.stdout(result({ "claude-haiku-4-5-20251001": {} })); },
        /^effective model mismatch: requested claude-haiku-5-5, got claude-haiku-4-5-20251001/],
      ["modelUsage shows another model alongside", (c) => { c.stdout(assistant(HAIKU)); c.stdout(result({ [HAIKU]: {}, [OPUS]: {} })); },
        /^effective model mismatch: requested claude-haiku-5-5, got claude-opus-5-5/],
      ["init label and success but no assistant or modelUsage", (c) => { c.stdout(init(HAIKU)); c.stdout(result()); },
        /^effective model unverified: requested claude-haiku-5-5; Claude CLI did not attest the pinned route model/],
      ["main assistant frame names no model", (c) => { c.stdout(init(HAIKU)); c.stdout(assistant(undefined)); c.stdout(result({ [HAIKU]: {} })); },
        /^effective model unverified: requested claude-haiku-5-5; a main assistant frame carries no model/],
    ];
    for (const [name, script, expected] of cases) {
      const { spawn, calls } = fakeSpawn((child) => { script(child); child.exit(0); });
      const outcome = await go(spawn, haikuRun());
      expect(outcome.state, name).toBe("failed");
      expect(outcome.error, name).toMatch(expected);
      expect(calls, name).toHaveLength(1);
      // A mismatch is a decision, never an automatic retry.
      expect(transientFailure(outcome.error, 0), name).toBeUndefined();
    }
  });

  it("names the mismatch for Sonnet and Opus routes too", async () => {
    for (const [route, requested, served] of [[CLAUDE_CODE_SONNET_ROUTE, SONNET, HAIKU], [CLAUDE_CODE_OPUS_ROUTE, OPUS, SONNET], [CLAUDE_CODE_SONNET_ROUTE, SONNET, OPUS]]) {
      const { spawn } = fakeSpawn((child) => { child.stdout(assistant(served)); child.stdout(result({ [served]: {} })); child.exit(0); });
      const outcome = await go(spawn, run(route, "xhigh"));
      expect(outcome.state).toBe("failed");
      expect(outcome.error).toMatch(new RegExp(`^effective model mismatch: requested ${requested}, got ${served}`));
    }
  });

  it("ignores Claude's own Haiku helper accounting only outside the main turns", async () => {
    const helper = "claude-haiku-4-5-20251001";
    const accepted = fakeSpawn((child) => {
      child.stdout(init(HAIKU));
      child.stdout(assistant(helper, { parent_tool_use_id: "toolu_1" }, []));
      child.stdout(assistant(HAIKU));
      child.stdout(result({ [HAIKU]: {}, [helper]: {} }));
      child.exit(0);
    });
    expect((await go(accepted.spawn, haikuRun())).state).toBe("done");
    // The same Sonnet route still accepts the Haiku helper beside Sonnet and refuses Haiku as its main model.
    const sonnet = fakeSpawn((child) => { child.stdout(assistant(SONNET)); child.stdout(result({ [SONNET]: {}, [HAIKU]: {} })); child.exit(0); });
    expect((await go(sonnet.spawn, run(CLAUDE_CODE_SONNET_ROUTE, "xhigh"))).state).toBe("done");
    const mainOnly = fakeSpawn((child) => { child.stdout(assistant(HAIKU)); child.stdout(result({ [HAIKU]: {} })); child.exit(0); });
    const refused = await go(mainOnly.spawn, run(CLAUDE_CODE_SONNET_ROUTE, "xhigh"));
    expect(refused.state).toBe("failed");
    expect(refused.error).toMatch(/^effective model mismatch: requested claude-sonnet-5-5, got claude-haiku-5-5/);
  });

  it("refuses an unknown route or an effort the route does not accept before launching anything", async () => {
    const { spawn, calls } = fakeSpawn((child) => child.exit(0));
    const unknown = await go(spawn, run("claude-code/claude-haiku-4-5", "medium"));
    expect(unknown.state).toBe("failed");
    expect(unknown.error).toMatch(/unknown claude-code model "claude-code\/claude-haiku-4-5".*no fallback was selected/);
    for (const [route, effort] of [[CLAUDE_CODE_HAIKU_ROUTE, "low"], [CLAUDE_CODE_HAIKU_ROUTE, "max"], [CLAUDE_CODE_SONNET_ROUTE, "medium"], [CLAUDE_CODE_OPUS_ROUTE, "high"]]) {
      const refused = await go(spawn, run(route, effort));
      expect(refused.state).toBe("failed");
      expect(refused.error).toMatch(/cannot run at/);
    }
    expect(calls).toHaveLength(0);
  });

  it("resumes Haiku on the same exact model and effort, or fails closed when the resumed stream is another model", async () => {
    const id = "0b5e1c2a-1111-4222-8333-944455556666";
    const resumed = fakeSpawn((child) => { child.stdout(assistant(HAIKU)); child.stdout(result({ [HAIKU]: {} })); child.exit(0); });
    const ok = await go(resumed.spawn, haikuRun(), task({ claudeSessionId: id }));
    expect(ok.state).toBe("done");
    const args = resumed.calls[0].args;
    expect(args).toEqual(expect.arrayContaining(["--resume", id]));
    expect(args).not.toContain("--session-id");
    expect(flagValue(args, "--model")).toBe(HAIKU);
    expect(flagValue(args, "--effort")).toBe("medium");
    expect(resumed.calls[0].child.stdinChunks.join("")).toContain("was resumed from its history");

    const swapped = fakeSpawn((child) => { child.stdout(assistant(SONNET)); child.stdout(result({ [SONNET]: {} })); child.exit(0); });
    const refused = await go(swapped.spawn, haikuRun(), task({ claudeSessionId: id }));
    expect(refused.state).toBe("failed");
    expect(refused.error).toMatch(/^effective model mismatch: requested claude-haiku-5-5, got claude-sonnet-5-5/);
    expect(swapped.calls).toHaveLength(1);
  });
});

type RecordedScript = (child: FakeClaudeProcess) => void;

describe("synthetic: unavailable allowance and model responses never substitute another model", () => {
  const synthetic = (text: string, extra: Record<string, unknown> = {}) => frame({
    type: "assistant", parent_tool_use_id: null, ...extra,
    message: { id: `synthetic-error-${++sequence}`, model: "<synthetic>", content: [{ type: "text", text }], usage: { input_tokens: 0, output_tokens: 0 } },
  });

  it.each([
    ["rate_limit code", synthetic("Request rejected", { error: "rate_limit" }), /^Claude allowance unavailable for claude-haiku-5-5: quota limit reached; no fallback model was selected/],
    ["weekly limit text with reset", synthetic("You've hit your weekly limit · resets Oct 8 at 5pm (America/New_York)"),
      /^Claude allowance unavailable for claude-haiku-5-5: quota limit reached; resets Oct 8 at 5pm \(America\/New_York\); no fallback model was selected/],
    ["billing_error code", synthetic("Request rejected", { error: "billing_error" }), /^Claude allowance unavailable for claude-haiku-5-5: billing or extra usage required; included allowance unavailable; no fallback model was selected/],
    ["credit balance text", synthetic("Credit balance is too low"), /^Claude allowance unavailable for claude-haiku-5-5: billing or extra usage required/],
    ["unknown model text", synthetic("There's an issue with the selected model (claude-haiku-5-5). It may not exist or you may not have access to it."),
      /^Claude model unavailable: requested claude-haiku-5-5 is unknown or not accessible to this login; no fallback model was selected/],
  ])("fails %s with a named error and a single launch", async (_name, errorFrame, expected) => {
    const { spawn, calls } = fakeSpawn((child) => {
      child.stdout(init(HAIKU));
      child.stdout(errorFrame);
      // Later buffered frames cannot turn the refusal into success or another model.
      child.stdout(assistant(SONNET));
      child.stdout(result({ [SONNET]: {} }));
      child.exit(1);
    });
    const outcome = await go(spawn, haikuRun());
    expect(outcome.state).toBe("failed");
    expect(outcome.error).toMatch(expected);
    expect(outcome.error).not.toMatch(/mismatch|sonnet|gpt/i);
    expect(outcome.error!.length).toBeLessThan(320);
    expect(outcome.output).toBe("");
    expect(outcome.turns).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].args.join(" ")).not.toContain("fallback");
    // Allowance and model refusals are decisions, not transient faults.
    expect(transientFailure(outcome.error, 0)).toBeUndefined();
  });

  it("treats an allowance error code as a refusal even when the frame names the model", async () => {
    const { spawn } = fakeSpawn((child) => {
      child.stdout(frame({ type: "assistant", error: "rate_limit", message: { id: "m-named", model: HAIKU, content: [{ type: "text", text: "limit" }] } }));
      child.exit(0);
    });
    const outcome = await go(spawn, haikuRun());
    expect(outcome.state).toBe("failed");
    expect(outcome.error).toMatch(/^Claude allowance unavailable for claude-haiku-5-5/);
    expect(outcome.output).toBe("");
  });

  it("does not echo secrets from an allowance diagnostic", async () => {
    const { spawn } = fakeSpawn((child) => {
      child.stdout(synthetic("Extra usage required sk-ant-secret https://private.invalid?token=secret", { error: "billing_error" }));
      child.exit(1);
    });
    const outcome = await go(spawn, haikuRun());
    expect(outcome.error).toMatch(/^Claude allowance unavailable/);
    expect(outcome.error).not.toMatch(/sk-ant-secret|private\.invalid|token=secret/);
  });

  it("parses the assistant error code from the frame or its message and ignores non-strings", () => {
    expect(parseClaudeStreamLine(frame({ type: "assistant", error: "rate_limit", message: { id: "a", content: [] } }))).toMatchObject({ kind: "assistant", apiError: "rate_limit" });
    expect(parseClaudeStreamLine(frame({ type: "assistant", message: { id: "a", error: "billing_error", content: [] } }))).toMatchObject({ apiError: "billing_error" });
    expect(parseClaudeStreamLine(frame({ type: "assistant", error: 429, message: { id: "a", content: [] } }))).not.toHaveProperty("apiError");
  });

  it("keeps the existing Sonnet allowance wording compatible", async () => {
    const { spawn } = fakeSpawn((child) => { child.stdout(synthetic("You've hit your weekly limit")); child.exit(1); });
    const outcome = await go(spawn, run(CLAUDE_CODE_SONNET_ROUTE, "xhigh"));
    expect(outcome.error).toContain("synthetic frame is not a model response or approval");
    expect(outcome.error).toMatch(/^Claude allowance unavailable for claude-sonnet-5-5: quota limit reached/);
  });
});
