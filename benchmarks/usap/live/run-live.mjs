#!/usr/bin/env node
/**
 * Live paid mirror benchmark: stock Pi vs Steak Pi (USAP), GLM-5.3-Flash.
 *
 * Mirrors the frozen controls of results/glm53-live-calibration-2026-09-04.md:
 * - model zai/glm-5.3-flash, thinking high, no fallback
 * - fresh fixture + ephemeral session per run, sequential top-level runs
 * - balanced arm ordering, identical prompts and file sets per case
 * - deterministic post-run verification, raw JSONL retained locally
 *
 * Arms: stock (pi with no extensions) and steak (pi with Steak Pi extensions).
 * Operator approval for paid runs: Michael, 2026-09-09 session.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = "/tmp/audit/steak-usap-live-" + new Date().toISOString().replace(/[:.]/g, "-");
const PI = "pi";
const MODEL = "glm-5.3-flash";
const PROVIDER = "zai";
const STEAK_EXT = [
  "-e", join(process.env.HOME, "dev/steak-pi/extensions/ultraterm-subagents.ts"),
  "-e", join(process.env.HOME, "dev/steak-pi/extensions/todo.ts"),
  "-e", join(process.env.HOME, "dev/steak-pi/extensions/verify-after-edit.ts"),
  "-e", join(process.env.HOME, "dev/steak-pi/extensions/model-route-policy.ts"),
];

function fixtureFiles(caseId) {
  if (caseId === "direct") {
    return {
      "edge.ts": [
        "export function clamp(value: number, low: number, high: number): number {",
        "  // BUG: bounds are swapped, so values inside the range get clamped to the wrong side.",
        "  if (value < high) return high;",
        "  if (value > low) return low;",
        "  return value;",
        "}",
        "",
      ].join("\n"),
    };
  }
  if (caseId === "tiny") {
    return {
      "a.ts": "export const TIMEOUT_MS = 1000;\n",
      "b.ts": "export const RETRIES = 2;\n",
    };
  }
  if (caseId === "gate") {
    const files = {};
    for (let i = 1; i <= 8; i++) files[`c${i}.ts`] = `export const SLOT_${i} = ${i * 100};\n`;
    return files;
  }
  // modules: four independent pure modules with exact contracts
  return {
    "README.md": "# Fixture: implement the four modules below exactly as specified.\n",
  };
}

const MODULES_SPEC = ["slug", "title", "clamp01", "sum"];

const CASES = {
  direct: {
    prompt: [
      "Fix the clamp function in edge.ts: bounds are currently swapped.",
      "clamp(v, low, high) must return low when v < low, high when v > high, and v otherwise.",
      "Change nothing else in the file.",
    ].join(" "),
    verify(dir) {
      const f = readFileSync(join(dir, "edge.ts"), "utf8");
      const ok = /if \(value < low\) return low;/.test(f)
        && /if \(value > high\) return high;/.test(f)
        && /return value;/.test(f)
        && !/if \(value < high\)/.test(f);
      return { ok, note: ok ? "clamp corrected" : "clamp not corrected" };
    },
  },
  tiny: {
    prompt: [
      "Two independent constant fixes in this directory:",
      "in a.ts set TIMEOUT_MS to 1500, and in b.ts set RETRIES to 5.",
      "Change nothing else.",
    ].join(" "),
    verify(dir) {
      const a = readFileSync(join(dir, "a.ts"), "utf8");
      const b = readFileSync(join(dir, "b.ts"), "utf8");
      const ok = /TIMEOUT_MS = 1500;/.test(a) && /RETRIES = 5;/.test(b);
      return { ok, note: ok ? "both constants fixed" : "constant fix missing" };
    },
  },
  gate: {
    prompt: [
      "Eight independent constant fixes in this directory:",
      "in c1.ts set SLOT_1 to 11, in c2.ts set SLOT_2 to 22, in c3.ts set SLOT_3 to 33, in c4.ts set SLOT_4 to 44,",
      "in c5.ts set SLOT_5 to 55, in c6.ts set SLOT_6 to 66, in c7.ts set SLOT_7 to 77, in c8.ts set SLOT_8 to 88.",
      "Change nothing else.",
    ].join(" "),
    verify(dir) {
      const expected = [11, 22, 33, 44, 55, 66, 77, 88];
      const bad = [];
      for (let i = 1; i <= 8; i++) {
        const text = readFileSync(join(dir, `c${i}.ts`), "utf8");
        if (!text.includes(`SLOT_${i} = ${expected[i - 1]};`)) bad.push(`c${i}.ts`);
      }
      return { ok: bad.length === 0, note: bad.length === 0 ? "all eight constants fixed" : `bad: ${bad.join(",")}` };
    },
  },
  modules: {
    prompt: [
      "Implement four independent modules in this directory, one file per module, exports exactly as named:",
      "1) slug.ts: export function slug(input: string): string — lowercase, trim, collapse non-alphanumeric runs to single hyphens, strip leading/trailing hyphens.",
      "2) title.ts: export function titleCase(input: string): string — capitalize the first letter of every whitespace-separated word, leave the rest untouched.",
      "3) clamp01.ts: export function clamp01(value: number): number — smallest value in [0, 1] bounds.",
      "4) sum.ts: export function digitSum(value: number): number — sum of the decimal digits of the absolute integer value.",
      "Pure TypeScript, no dependencies, no test files, no README changes.",
    ].join(" "),
    verify(dir) {
      const need = MODULES_SPEC.map((m) => `${m}.ts`);
      const missing = need.filter((f) => !existsSync(join(dir, f)));
      if (missing.length > 0) return { ok: false, note: `missing ${missing.join(",")}` };
      // Behavioral verification: execute the exact contract with node type stripping.
      const script = [
        `import { slug } from "${join(dir, "slug.ts")}";`,
        `import { titleCase } from "${join(dir, "title.ts")}";`,
        `import { clamp01 } from "${join(dir, "clamp01.ts")}";`,
        `import { digitSum } from "${join(dir, "sum.ts")}";`,
        `import assert from "node:assert/strict";`,
        `assert.equal(slug("  Hello, WORLD! "), "hello-world");`,
        `assert.equal(slug("a--b  c"), "a-b-c");`,
        `assert.equal(titleCase("hello foo BAR"), "Hello Foo BAR");`,
        `assert.equal(clamp01(-0.5), 0);`,
        `assert.equal(clamp01(0.25), 0.25);`,
        `assert.equal(clamp01(2), 1);`,
        `assert.equal(digitSum(-907), 16);`,
        `assert.equal(digitSum(0), 0);`,
        `console.log("MODULES-VERIFY-OK");`,
      ].join("\n");
      const scriptPath = join(dir, "..", `verify-${dir.split("/").pop()}.mjs`);
      writeFileSync(scriptPath, script);
      const proc = spawnSync("node", ["--experimental-strip-types", scriptPath], {
        encoding: "utf8", timeout: 30_000,
      });
      rmSync(scriptPath, { force: true });
      const ok = proc.status === 0 && (proc.stdout || "").includes("MODULES-VERIFY-OK");
      return { ok, note: ok ? "behavioral contract pass" : `behavioral fail: ${(proc.stderr || "").split("\n")[0]?.slice(0, 200)}` };
    },
  },
};

function runArm(arm, caseId, dir, prompt) {
  const args = [
    "-ne", "-ns", "-np", "-nc", "--no-session", "--mode", "json",
    "--provider", PROVIDER, "--model", MODEL, "--thinking", "high",
  ];
  if (arm === "steak") args.push(...STEAK_EXT);
  // forced: instruction to delegate (Sept calibration methodology).
  // doctrine: no instruction — the shipped Steak Pi guidelines decide.
  const mode = process.env.DELEGATION_MODE === "doctrine" ? "doctrine" : "forced";
  const fullPrompt = arm === "steak" && mode === "forced"
    ? `${prompt} Use ultraterm_subagents for the implementation work: one dispatch, tasks split by independent file.`
    : prompt;
  args.push("-p", fullPrompt);
  const t0 = Date.now();
  const proc = spawnSync(PI, args, { cwd: dir, encoding: "utf8", timeout: 15 * 60_000, maxBuffer: 64 * 1024 * 1024 });
  const wallMs = Date.now() - t0;
  const stdout = proc.stdout || "";
  // Retain the raw provider stream for audit: the results doc's retention claim.
  writeFileSync(join(dir, "..", `${dir.split("/").pop()}.raw.jsonl`), stdout);
  const lines = stdout.split("\n").filter((l) => l.startsWith("{"));
  let agentEnd = null;
  let sawModel = false;
  let parentTokens = 0;
  let nestedTokens = 0;
  let toolErrors = 0;
  let dispatchStates = [];
  for (const line of lines) {
    let evt;
    try { evt = JSON.parse(line); } catch { continue; }
    if (evt.type === "agent_end" && evt.messages) {
      agentEnd = evt;
      for (const msg of evt.messages) {
        if (msg.role === "assistant" && msg.usage) parentTokens += msg.usage.totalTokens || 0;
        if (msg.role === "assistant" && msg.provider === PROVIDER && msg.model === MODEL) sawModel = true;
        if (msg.role === "toolResult") {
          if (msg.isError) toolErrors += 1;
          if (msg.toolName === "ultraterm_subagents" && msg.usage) {
            nestedTokens += msg.usage.totalTokens || 0;
            const run = msg.details && msg.details.run;
            if (run && Array.isArray(run.tasks)) dispatchStates = run.tasks.map((t) => t.state);
          }
        }
      }
    }
  }
  return { wallMs, parentTokens, nestedTokens, sawModel, toolErrors, dispatchStates, stderr: (proc.stderr || "").slice(0, 400), exit: proc.status };
}

function main() {
  const caseIds = process.argv.slice(2).filter((a) => CASES[a]);
  const selected = caseIds.length > 0 ? caseIds : Object.keys(CASES);
  const N = Number(process.env.N || 3);
  const arms = (process.env.ARMS || "stock,steak").split(",");
  const tag = process.env.TAG || "main";
  mkdirSync(ROOT, { recursive: true });
  const results = [];
  // Balanced order: alternate which arm opens each round.
  for (const caseId of selected) {
    for (let i = 0; i < N; i++) {
      for (const arm of i % 2 === 0 ? arms : [...arms].reverse()) {
        const dir = join(ROOT, `${tag}-${caseId}-${arm}-${i}`);
        mkdirSync(dir, { recursive: true });
        const files = fixtureFiles(caseId);
        for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
        const prompt = CASES[caseId].prompt;
        const run = { caseId, arm, round: i, tag, mode: process.env.DELEGATION_MODE === "doctrine" ? "doctrine" : "forced", ...runArm(arm, caseId, dir, prompt) };
        run.verify = CASES[caseId].verify(dir);
        // First-pass requires deterministic verification, the resolved route,
        // clean process exit, and zero tool errors.
        run.firstPass = run.verify.ok && run.sawModel && run.exit === 0 && run.toolErrors === 0;
        results.push(run);
        console.log(`${tag} ${caseId} ${arm} #${i}: wall=${(run.wallMs / 1000).toFixed(1)}s tok=${run.parentTokens}+${run.nestedTokens} ok=${run.firstPass} ${run.verify.note}`);
        writeFileSync(join(ROOT, `results-${tag}.json`), JSON.stringify(results, null, 2));
      }
    }
  }
  console.log(`\nSaved ${results.length} runs to ${ROOT}/results-${tag}.json`);
}

main();
