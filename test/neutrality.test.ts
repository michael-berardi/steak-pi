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
const shipped = [...SHIPPED_DIRS.flatMap((dir) => files(join(root, dir))), join(root, "README.md")].filter(existsSync);

// Concrete model ids and routes only an operator should choose.
const MODEL_CHOICE = /\b(?:gpt-\d[\w.-]*|deepseek[\w./-]*|opencode-go\/|openrouter\/[\w~]|:exacto\b|mimo[-.]?v?\d|glm[-.]?\d|claude-[a-z]+-\d-\d)/i;
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
// Names of the people and organisations Steak Pi was first built for: never in the shipped tool.
// Matched case-sensitively, as in Carl's neutrality test: the lowercase GitHub owner slug in the
// project's own repository and release URLs (README install lines, bin/steak-pi and
// src/update-check.ts update source) is publication metadata like package.json "repository".
const PERSONAL = /\b(?:Mike|Berardi|Dana|Felix|acme|acme|Mouseia|acme)\b|libertydesign|Liberty Design|\/Users\/[A-Za-z]/;

const hits = (paths: readonly string[], pattern: RegExp) => paths
  .flatMap((path) => readFileSync(path, "utf8").split("\n").map((line, index) => [path, index + 1, line] as const))
  .filter(([, , line]) => pattern.test(line))
  .map(([path, line, text]) => `${relative(root, path)}:${line}: ${text.trim().slice(0, 140)}`);
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
    for (const sample of ["openrouter/vendor/model", "opencode-go/x", "a-model:exacto", "gpt-6.1-x", "DeepSeek", "mimo-v2.6", "glm-5.3", "claude-opus-5-5"]) {
      expect(MODEL_CHOICE.test(sample), sample).toBe(true);
    }
    for (const sample of ["Mike", "Liberty Design", "/Users/alex"]) expect(PERSONAL.test(sample), sample).toBe(true);
    for (const adapter of ADAPTER_CATALOGS) {
      expect(existsSync(join(root, adapter)), adapter).toBe(true);
      expect(hits([join(root, adapter)], MODEL_CHOICE).length, adapter).toBeGreaterThan(0);
    }
  });

  it("ship no concrete model id, route or fallback choice outside adapter catalogs", () => {
    expect(hits(shipped.filter((path) => !isAdapter(path)), MODEL_CHOICE)).toEqual([]);
  });

  it("name no person, client or project", () => {
    expect(hits(shipped, PERSONAL)).toEqual([]);
  });

  it("keep the current CHANGELOG entry neutral (older entries are released history)", () => {
    const entry = currentChangelogEntry();
    expect(entry.length).toBeGreaterThan(0);
    const lines = entry.split("\n").filter((line) => MODEL_CHOICE.test(line) || PERSONAL.test(line));
    expect(lines).toEqual([]);
  });
});
