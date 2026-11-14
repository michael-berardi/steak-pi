import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { applyDefaultTheme, operatorChoseTheme } from "../src/default-theme.ts";

const theme = JSON.parse(readFileSync(new URL("../themes/steak.json", import.meta.url), "utf8")) as { vars: Record<string, string | number>; colors: Record<string, string | number> };
// xterm-256 greys the theme names by index.
const XTERM: Record<number, string> = { 240: "#585858", 245: "#8a8a8a", 249: "#b2b2b2", 255: "#eeeeee" };
function resolve(value: string | number): string {
  if (typeof value === "number") return XTERM[value] ?? (() => { throw new Error(`unmapped xterm index ${value}`); })();
  if (value === "" || value.startsWith("#")) return value;
  return resolve(theme.vars[value]!);
}
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return r! * 0.2126 + g! * 0.7152 + b! * 0.0722;
}
const ratio = (a: string, b: string) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

describe("steak theme follows the Steak DSH palette", () => {
  it("keeps the DSH palette values and roles", () => {
    expect(resolve("steakRed")).toBe("#e63946");
    expect(resolve("steakDeep")).toBe("#b02a37");
    expect(resolve("stem")).toBe("#2a9d5c");
    expect(resolve("stemSoft")).toBe("#1f7a46");
    expect(resolve("surface")).toBe("#16181d");
    expect(resolve("surfaceRaised")).toBe("#1d2026");
    expect(resolve("jackpot")).toBe("#f4c95d");
    expect(resolve(theme.vars.neutralDim!)).toBe("#8a8a8a"); // DSH's quiet neutral tier
    // Surfaces and brand accents land on the same roles DSH gives them.
    expect(resolve(theme.colors.borderAccent!)).toBe("#e63946");
    for (const token of ["userMessageBg", "toolPendingBg", "selectedBg"]) expect(resolve(theme.colors[token]!), token).toBe("#1d2026");
    for (const token of ["toolSuccessBg", "toolErrorBg"]) expect(resolve(theme.colors[token]!), token).toBe("#16181d");
    expect(resolve(theme.colors.success!)).toBe("#2a9d5c");
    expect(resolve(theme.colors.warning!)).toBe("#f4c95d");
    expect(resolve(theme.colors.mdHeading!)).toBe("#f4c95d");
    expect(resolve(theme.colors.toolDiffAdded!)).toBe("#2a9d5c");
    expect(theme.colors.toolTitle).toBe(theme.colors.accent);
    expect(theme.colors.mdListBullet).toBe(theme.colors.accent);
  });

  it("keeps a visible text hierarchy: text > muted > dim", () => {
    const l = (token: string) => luminance(resolve(theme.colors[token]!));
    expect(l("text")).toBeGreaterThan(l("muted"));
    expect(l("muted")).toBeGreaterThan(l("dim"));
  });

  it("reads at 4.5:1 for every text token on both authored surfaces", () => {
    const surfaces = [resolve(theme.colors.toolSuccessBg!), resolve(theme.colors.userMessageBg!)];
    const textTokens = ["accent", "success", "error", "warning", "muted", "dim", "text", "thinkingText", "toolTitle", "mdHeading", "mdLink",
      "mdLinkUrl", "mdCode", "mdQuote", "mdListBullet", "toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "syntaxComment", "syntaxKeyword",
      "syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation",
      "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "bashMode", "customMessageLabel"];
    for (const token of textTokens) for (const bg of surfaces) {
      expect(ratio(resolve(theme.colors[token]!), bg), `${token} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps borders visible at 3:1 on the surface", () => {
    for (const token of ["border", "borderMuted", "mdCodeBlockBorder", "mdQuoteBorder", "mdHr"]) {
      expect(ratio(resolve(theme.colors[token]!), "#16181d"), token).toBeGreaterThanOrEqual(3);
    }
    expect(ratio(resolve(theme.colors.borderAccent!), "#16181d")).toBeGreaterThanOrEqual(3);
  });

  it("defines every colour token Pi requires and no dangling variable", () => {
    expect(Object.keys(theme.colors)).toHaveLength(54);
    for (const value of Object.values(theme.colors)) expect(() => resolve(value)).not.toThrow();
  });
});

describe("default theme selection", () => {
  const dirs: string[] = [];
  function setup(settings?: unknown, project?: unknown) {
    const root = mkdtempSync(join(tmpdir(), "steak-theme-")); dirs.push(root);
    const agentDir = join(root, "agent"), cwd = join(root, "project");
    mkdirSync(agentDir); mkdirSync(join(cwd, ".pi"), { recursive: true });
    if (settings !== undefined) writeFileSync(join(agentDir, "settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
    if (project !== undefined) writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(project));
    return { agentDir, cwd, argv: ["node", "pi"], env: {} as Record<string, string> };
  }
  const ui = () => ({ getTheme: vi.fn((name: string) => name === "steak" ? { name } : undefined), setTheme: vi.fn(() => ({ success: true })) });

  it("applies the bundled theme when nothing is chosen, without persisting a setting", () => {
    const input = setup({ defaultProvider: "x" }), host = ui();
    expect(applyDefaultTheme(host, input)).toBe(true);
    expect(host.setTheme).toHaveBeenCalledWith({ name: "steak" });
  });
  it.each([
    ["global setting", { theme: "light" }],
    ["light/dark pair", { theme: "light/dark" }],
    ["system", { theme: "system" }],
    ["unreadable settings", "{not json"],
  ])("keeps the operator's %s", (_label, settings) => {
    const host = ui();
    expect(applyDefaultTheme(host, setup(settings))).toBe(false);
    expect(host.setTheme).not.toHaveBeenCalled();
  });
  it("keeps a project theme, --use-theme, --theme and STEAK_PI_THEME=off", () => {
    expect(operatorChoseTheme(setup({}, { theme: "dark" }))).toBe(true);
    expect(operatorChoseTheme({ ...setup(), argv: ["pi", "--use-theme", "light"] })).toBe(true);
    expect(operatorChoseTheme({ ...setup(), argv: ["pi", "--theme=./mine.json"] })).toBe(true);
    expect(operatorChoseTheme({ ...setup(), env: { STEAK_PI_THEME: "off" } })).toBe(true);
    expect(operatorChoseTheme(setup())).toBe(false);
  });
  it("never throws when the host has no theme API", () => {
    expect(applyDefaultTheme({} as never, setup())).toBe(false);
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
});
