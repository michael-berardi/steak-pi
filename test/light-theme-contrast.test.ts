import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const theme = JSON.parse(readFileSync(new URL("../themes/steak-light.json", import.meta.url), "utf8"));
function resolve(value: string | number): string {
  if (typeof value !== "string") throw new Error("Numeric values are xterm palette indexes, not gray intensities");
  if (value === "" || value.startsWith("#")) return value;
  return resolve(theme.vars[value]);
}
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

describe("Steak light palette", () => {
  it("uses actual neutral RGB colors rather than saturated xterm indexes", () => {
    for (const token of ["text", "muted", "dim", "thinkingText"]) {
      const color = resolve(theme.colors[token]);
      expect(color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(color.slice(1, 3)).toBe(color.slice(3, 5));
      expect(color.slice(3, 5)).toBe(color.slice(5, 7));
    }
  });
  it("keeps primary, secondary, status and syntax text at 4.5:1 on authored light surfaces", () => {
    const backgrounds = ["#ffffff", resolve(theme.colors.selectedBg), resolve(theme.colors.toolSuccessBg)];
    for (const token of ["text", "muted", "dim", "thinkingText", "accent", "success", "warning", "error", "syntaxFunction", "syntaxType"]) {
      const foreground = resolve(theme.colors[token]);
      for (const background of backgrounds) {
        const a = luminance(foreground), b = luminance(background);
        expect((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), `${token} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
