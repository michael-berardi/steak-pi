import { describe, expect, it } from "vitest";
import {
  renderStatusline,
  gitBranch,
  shortModel,
  baseName,
  type StatusParts,
} from "../extensions/statusline.ts";
import {
  terminalBackgroundFor,
  DARK_TERMINAL_THEME,
  WHITE_TERMINAL_THEME,
  TERMINAL_THEMES,
} from "../src/lib/terminalThemes.ts";

describe("statusline renderer", () => {
  const parts: StatusParts = {
    model: "glm5.3flash",
    thinking: "high",
    branch: "main",
    dir: "steak-pi",
    compression: "auto",
    compacted: 2,
  };

  it("renders all segments in order with separators", () => {
    const line = renderStatusline(parts);
    expect(line).toContain("◆ glm5.3flash");
    expect(line).toContain("✦ high");
    expect(line).toContain("⑂ main");
    expect(line).toContain("steak-pi");
    expect(line).toContain("⚡ auto");
    expect(line).toContain("⊞ 2");
    expect(line.split("│").length).toBe(6);
  });

  it("omits empty segments", () => {
    const line = renderStatusline({ ...parts, branch: "", compression: null, compacted: 0, thinking: "off" });
    expect(line).not.toContain("⑂");
    expect(line).not.toContain("⚡");
    expect(line).not.toContain("✦");
    expect(line).not.toContain("⊞");
  });
});

describe("statusline helpers", () => {
  it("shortens model ids", () => {
    expect(shortModel({ id: "zai/glm-5.3-flash" })).toBe("glm5.3-flash");
    expect(shortModel(undefined)).toBe("pi");
  });

  it("basename handles trailing slashes", () => {
    expect(baseName("/tmp/proj/")).toBe("proj");
    expect(baseName("/")).toBe("~");
  });

  it("gitBranch fails silent outside a repo", () => {
    const b = gitBranch("/tmp");
    expect(typeof b).toBe("string");
  });
});

describe("terminal themes (UltraTerm bridge)", () => {
  it("flagship OLED is true black with bright text", () => {
    expect(DARK_TERMINAL_THEME.background).toBe("#000000");
    expect(DARK_TERMINAL_THEME.foreground).toBe("#f2f4f8");
    expect(terminalBackgroundFor("oled")).toBe(DARK_TERMINAL_THEME);
  });

  it("light base is a real white surface", () => {
    expect(WHITE_TERMINAL_THEME.light).toBe(true);
    expect(parseInt(WHITE_TERMINAL_THEME.background.slice(1, 3), 16)).toBeGreaterThan(0xf0);
  });

  it("resolves the full corpus with OLED fallback", () => {
    for (const name of [
      "oled", "white", "obsidian-rite", "nord-frost", "crystal",
      "vapor", "frutiger-aero", "frutiger-dark", "oel-drive",
    ]) {
      expect(TERMINAL_THEMES[name]).toBeDefined();
    }
    expect(terminalBackgroundFor("nonexistent").name).toBe("steak-oled");
  });

  it("every theme keeps steak accent lineage", () => {
    for (const t of Object.values(TERMINAL_THEMES)) {
      expect(t.accent).toMatch(/^#[0-9a-f]{6}$/i);
      expect(t.foreground).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
