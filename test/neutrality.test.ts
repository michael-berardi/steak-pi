// Steak Pi is a neutral tool. Its shipped files carry no model, provider or fallback choice and no
// person's, client's or project's names: those belong in the operator's own routing.json and
// paid-routes.json. This test keeps it that way. test/ is out of scope (fixtures may name models).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// STEAK_PI_NEUTRALITY_ROOT lets a reviewer point the same scan at another checkout (for example a
// pre-change tree extracted with `git archive`) to prove the scan fails there.
const root = process.env.STEAK_PI_NEUTRALITY_ROOT ?? fileURLToPath(new URL("..", import.meta.url));
const SHIPPED_DIRS = ["src", "bin", "scripts", "extensions", "skills", "docs", "themes", "benchmarks"];
const TEXT = /\.(?:ts|mts|js|mjs|cjs|sh|py|md|json)$/;
// Legal attribution, not routing: LICENSE files (and package.json author/repository metadata,
// which is not scanned) may keep the author's name.
const LEGAL = /(?:^|\/)LICENSE(?:\.\w+)?$/;

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) return [];
    if (statSync(path).isDirectory()) return files(path);
    const rel = relative(root, path);
    if (LEGAL.test(rel)) return [];
    // bin/ entry points have no extension.
    return TEXT.test(name) || rel.startsWith("bin/") ? [path] : [];
  });
}
const ROOT_FILES = ["README.md", "CONTRIBUTING.md", "SECURITY.md"];
const shipped = [...SHIPPED_DIRS.flatMap((dir) => files(join(root, dir))), ...ROOT_FILES.map((name) => join(root, name))].filter(existsSync);

// Concrete model ids and routes only an operator should choose.
const MODEL_CHOICE = /\b(?:gpt-\d[\w.-]*|deepseek[\w./-]*|opencode-go\/|openrouter\/[\w~]|:exacto\b|mimo[-.]?v?\d|glm[-.]?\d|claude-[a-z]+-\d-\d|(?:GLM|MiMo|Codex|GPT|Opus|Sonnet|Haiku|Claude) [Vv]?[0-9][.0-9]*)/i;
// Adapter catalogs: provider adapter code that must name the provider's own models. No default
// selects any of them; automatic order comes only from routing.json.
const ADAPTER_CATALOGS = [
  "src/subagents/claude-code-models.ts", // Claude Code CLI adapter: pinned route spellings.
  "extensions/claude-code/model-catalog.ts", // Claude Code provider: the CLI's own model list.
  "docs/CLAUDE-CODE.md", // Documents that provider's catalog.
  "docs/CLAUDE-API-ROUTE.md", // The explicit Claude API adapter route; its example record is contract-tested.
  "docs/OPUS-5-5.md", // The adapter's candidate-model manifest notes.
  "docs/opus-5-5.models.json", // The adapter's candidate-model manifest.
];
// The Claude subscription adapter's two account display labels. The operator's account router
// supplies the ids; these labels are the adapter's own identity, checked to still exist.
const TECHNICAL_IDENTITY_LINES: { path: string; pattern: RegExp }[] = [
  { path: "src/subagents/claude-account.ts", pattern: /label: "Claude 2"/ },
];
const allowedTechnicalLine = (path: string, text: string) =>
  TECHNICAL_IDENTITY_LINES.some((entry) => entry.path === path && entry.pattern.test(text));

// Names of the people and organisations Steak Pi was first built for: never in the shipped tool.
// Matched case-insensitively; the only exemption is the checked distribution-URL allowlist below.
// The project's own distribution URLs must name the real GitHub owner so installs, badges,
// upgrades and vulnerability reports resolve. These are publication metadata like package.json
// "repository", not routing choices. Only these URL forms in these files are exempt, and each
// file is checked to still contain a real personal-name hit, so the exemption cannot cover
// nothing or silently widen.
const DISTRIBUTION_URL = /(?:https?:\/\/)?(?:github\.com\/michael-berardi\/(?:steak-pi|ultracompress)(?![\w-])[^\s)\]"']*|img\.shields\.io\/github\/(?:v\/release|license)\/michael-berardi\/steak-pi(?![\w-])[^\s)\]"']*|api\.github\.com\/repos\/michael-berardi\/steak-pi(?![\w-])[^\s)\]"']*|brew (?:install|upgrade) michael-berardi\/pareto-software-distribution\/steak-pi)/;
const DISTRIBUTION_FILES = [
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "bin/steak-pi",
  "src/update-check.ts",
  "extensions/ultracompress/index.ts",
];
// A line is allowed only when every personal-name hit on it sits inside a distribution URL.
// The shared regex is non-global so `.test()` is stateless; stripping uses a fresh case-insensitive
// global copy.
const allowedDistributionLine = (path: string, line: string) => {
  if (!DISTRIBUTION_FILES.includes(path)) return false;
  const rest = line.replace(new RegExp(DISTRIBUTION_URL.source, "gi"), "");
  return !PERSONAL.test(rest);
};
const PERSONAL = /\b(?:Mike|Berardi|Dana|Felix|acme|acme|Mouseia|acme)\b|libertydesign|Liberty Design|\/Users\/[A-Za-z]/i;

// Task classes are the operator's: the names the first local-model measurements used, and any literal class table
// in shipped source, would make a default of what routing.json owns. Docs use the placeholders class-a, class-b.
const CONCRETE_TASK_CLASS = /\b(?:leaf-edit|refactor-small|test-writing|scout-summary)\b/i;
const CLASS_TABLE_LITERAL = /\btaskClasses\s*[:=]\s*\{\s*["'`]?[a-z0-9]/;
const ENSURE_LITERAL = /\bensure\s*:\s*\{\s*command\s*:/;

// Operator-specific account spellings that once leaked into examples and fixtures. Use a neutral id such as
// "team-2" / "Claude (Team)" wherever an example registry account is needed.
const OPERATOR_ACCOUNT = /claude-kl|"kl"|Claude \(KL\)/i;

type Hit = { path: string; line: number; text: string };
const hits = (paths: readonly string[], pattern: RegExp): Hit[] => paths.flatMap((path) =>
  readFileSync(path, "utf8").split("\n").flatMap((text, index) =>
    pattern.test(text) ? [{ path: relative(root, path), line: index + 1, text }] : []));
const describeHit = (hit: Hit) => `${hit.path}:${hit.line}: ${hit.text.trim().slice(0, 140)}`;
const isAdapter = (path: string) => ADAPTER_CATALOGS.includes(relative(root, path));

/** CHANGELOG history is allowlisted: released entries record what earlier versions shipped. Only
 * the entry for the current package version must be neutral. */
function currentChangelogEntry(): string {
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  const start = changelog.indexOf(`## ${version}`);
  if (start < 0) return "";
  const next = changelog.indexOf("\n## ", start + 1);
  return changelog.slice(start, next < 0 ? undefined : next);
}

describe("shipped files are provider-neutral", () => {
  it("scans a real file set (vacuous-pass guard)", () => {
    const rel = shipped.map((path) => relative(root, path));
    expect(rel.length).toBeGreaterThan(100);
    for (const known of ["README.md", "bin/steak-pi", "src/model-route-policy.ts", "src/routing-config.ts",
      "extensions/ultraterm-subagents.ts", "docs/MODEL-ROUTING.md", "skills/ultraterm-subagent-protocol/SKILL.md"]) {
      expect(rel).toContain(known);
    }
    // The patterns really match what they guard against, and every allowlisted adapter catalog
    // exists and still needs its exception (a stale entry would silently widen the allowlist).
    for (const sample of ["openrouter/vendor/model", "opencode-go/x", "a-model:exacto", "gpt-6.1-x", "DeepSeek", "mimo-v2.6", "glm-5.3", "claude-opus-5-5", "Opus 5.5", "Sonnet 5.5", "Claude 1", "GLM 5.3", "MiMo V2.6", "Codex 6", "GPT 1"]) {
      expect(MODEL_CHOICE.test(sample), sample).toBe(true);
    }
    for (const sample of ["Mike", "Liberty Design", "/Users/alex", "berardi"]) expect(PERSONAL.test(sample), sample).toBe(true);
    for (const adapter of ADAPTER_CATALOGS) {
      expect(existsSync(join(root, adapter)), adapter).toBe(true);
      expect(hits([join(root, adapter)], MODEL_CHOICE).length, adapter).toBeGreaterThan(0);
    }
    for (const entry of TECHNICAL_IDENTITY_LINES) {
      const file = join(root, entry.path);
      expect(existsSync(file), entry.path).toBe(true);
      const lines = readFileSync(file, "utf8").split("\n");
      const line = lines.find((candidate) => entry.pattern.test(candidate));
      expect(line, `${entry.path} should still contain its technical-identity line`).toBeDefined();
      expect(MODEL_CHOICE.test(line!), `${entry.path} line should need the exemption`).toBe(true);
    }
  });

  it("ship no concrete model id, route or fallback choice outside adapter catalogs", () => {
    const model = hits(shipped, MODEL_CHOICE)
      .filter((hit) => !isAdapter(join(root, hit.path)) && !allowedTechnicalLine(hit.path, hit.text))
      .map(describeHit);
    expect(model).toEqual([]);
  });

  it("name no person, client or project", () => {
    const personal = hits(shipped, PERSONAL)
      .filter((hit) => !allowedDistributionLine(hit.path, hit.text))
      .map(describeHit);
    expect(personal).toEqual([]);
  });

  it("ship no task class, class chain or ensure hook of their own", () => {
    for (const sample of ["leaf-edit", "Refactor-Small", "test-writing", "scout-summary"]) expect(CONCRETE_TASK_CLASS.test(sample), sample).toBe(true);
    for (const sample of ["taskClasses: { x: { chain: [] } }", "taskClasses = {'x': {}}", "taskClasses: {\"leaf\": 1}"]) expect(CLASS_TABLE_LITERAL.test(sample), sample).toBe(true);
    for (const sample of ["class-a", "taskClasses?: Readonly<Record<string, TaskClassConfig>>", "config.taskClasses = parseTaskClasses(raw.taskClasses)"]) expect(CLASS_TABLE_LITERAL.test(sample), sample).toBe(false);
    expect(ENSURE_LITERAL.test("ensure: { command: [\"/x\"] }")).toBe(true);
    // No shipped file names a concrete class, and no shipped code (docs show placeholder examples) holds a class table or hook.
    expect(hits(shipped, CONCRETE_TASK_CLASS).map(describeHit)).toEqual([]);
    const code = shipped.filter((path) => /\.(?:ts|mts|js|mjs|cjs|sh|py)$/.test(path) || relative(root, path).startsWith("bin/"));
    expect(hits(code, CLASS_TABLE_LITERAL).map(describeHit)).toEqual([]);
    expect(hits(code, ENSURE_LITERAL).map(describeHit)).toEqual([]);
    // The scan is meaningful: the feature is shipped and documented under placeholder names.
    const docs = readFileSync(join(root, "docs/MODEL-ROUTING.md"), "utf8");
    expect(docs).toMatch(/taskClasses/);
    expect(docs).toMatch(/class-a/);
    expect(readFileSync(join(root, "src/routing-config.ts"), "utf8")).toMatch(/parseTaskClasses/);
  });

  it("ship no evidence-routing winner, route, model or prior of their own", () => {
    // Routing is learned from the operator's evidence store and priors: no shipped file may name a route that
    // would win, a vendor or model the benchmark favoured, or a literal priors table.
    const VENDOR_OR_MODEL = /\b(?:mercury[-\s.]?\d?|deepseek|flash-\d|v4\.\d)\b|\binception\//i;
    const PRIORS_LITERAL = /\bpriors\s*[:=]\s*\{\s*["'`][^"'`]*[\/][^"'`]*["'`]\s*:\s*\{\s*pass\s*:/;
    const HARDCODED_WINNER = /\b(?:preferred|favou?red|best|default)Route\s*=\s*["'`][a-z0-9-]+\/[a-z0-9.-]+["'`]/i;
    for (const sample of ["mercury-3", "Inception/mercury-3", "deepseek-v4.1-flash", "inception/"]) expect(VENDOR_OR_MODEL.test(sample), sample).toBe(true);
    for (const sample of ["priors?: Readonly<Record<string, RoutePrior>>", "route-a", "class-a"]) expect(VENDOR_OR_MODEL.test(sample), sample).toBe(false);
    expect(PRIORS_LITERAL.test('priors: { "p/m": { pass: 9, n: 10 } }')).toBe(true);
    expect(PRIORS_LITERAL.test("priors: Readonly<Record<string, RoutePrior>>")).toBe(false);
    expect(HARDCODED_WINNER.test('const preferredRoute = "p/m"')).toBe(true);
    expect(hits(shipped, VENDOR_OR_MODEL).map(describeHit)).toEqual([]);
    const code = shipped.filter((path) => /\.(?:ts|mts|js|mjs|cjs|sh|py)$/.test(path) || relative(root, path).startsWith("bin/"));
    expect(hits(code, PRIORS_LITERAL).map(describeHit)).toEqual([]);
    expect(hits(code, HARDCODED_WINNER).map(describeHit)).toEqual([]);
    // The scan is meaningful: the learned router is shipped, reads its priors from routing.json, and is documented
    // under placeholder names.
    const ranking = readFileSync(join(root, "src/subagents/route-ranking.ts"), "utf8");
    expect(ranking).toMatch(/Thompson/);
    expect(ranking).toMatch(/settings\.priors\[/);
    expect(ranking).not.toMatch(/\bconst\s+\w*(?:winner|best)\w*\s*=\s*["'`]/i);
    const docs = readFileSync(join(root, "docs/MODEL-ROUTING.md"), "utf8");
    expect(docs).toMatch(/route-a/);
    expect(docs).toMatch(/minPassRate/);
  });

  it("use no operator-specific Claude account id, label or folder in examples, docs or fixtures", () => {
    for (const sample of ["claude-kl", ".claude-kl/", '"kl"', "Claude (KL)", "CLAUDE (kl)"]) expect(OPERATOR_ACCOUNT.test(sample), sample).toBe(true);
    for (const sample of ["team-2", "Claude (Team)", ".claude-team-2", "kl-2x"]) expect(OPERATOR_ACCOUNT.test(sample), sample).toBe(false);
    // Shipped files, the whole CHANGELOG and every test fixture except this file (which names the patterns).
    const self = fileURLToPath(import.meta.url);
    const everywhere = [...shipped, join(root, "CHANGELOG.md"), ...files(join(root, "test")).filter((path) => path !== self)].filter(existsSync);
    expect(everywhere.some((path) => relative(root, path).startsWith("test/"))).toBe(true);
    expect(hits(everywhere, OPERATOR_ACCOUNT).map(describeHit)).toEqual([]);
  });

  it("keeps each allowlisted distribution file real and still naming the owner", () => {
    for (const path of DISTRIBUTION_FILES) {
      const file = join(root, path);
      expect(existsSync(file), path).toBe(true);
      const lines = readFileSync(file, "utf8").split("\n");
      const realHit = lines.some((line) => PERSONAL.test(line) && DISTRIBUTION_URL.test(line));
      expect(realHit, `${path} should still contain a distribution-URL hit`).toBe(true);
    }
  });

  it("keep the current CHANGELOG entry neutral (older entries are released history)", () => {
    const entry = currentChangelogEntry();
    expect(entry.length).toBeGreaterThan(0);
    const lines = entry.split("\n").filter((line) => MODEL_CHOICE.test(line) || PERSONAL.test(line));
    expect(lines).toEqual([]);
  });
});
