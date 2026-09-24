import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../bin/steak-pi", import.meta.url));
const envOf = (env: Record<string, string>) => Object.fromEntries(
  execFileSync("sh", [cli, "env"], { env: { PATH: process.env.PATH ?? "", HOME: "/home/test", ...env }, encoding: "utf8" })
    .trim().split("\n").map((line) => line.split(/=(.*)/s).slice(0, 2)),
);

describe("steak-pi run runtime defaults", () => {
  it("applies compile cache, arena cap and a small young generation by default", () => {
    expect(envOf({})).toEqual({
      NODE_COMPILE_CACHE: "/home/test/.cache/steak-pi/node-compile-cache",
      MALLOC_ARENA_MAX: "2",
      NODE_OPTIONS: "--max-semi-space-size=2",
    });
  });

  it("never overrides operator settings and keeps existing NODE_OPTIONS", () => {
    const env = envOf({ NODE_COMPILE_CACHE: "/c", MALLOC_ARENA_MAX: "4", NODE_OPTIONS: "--max-old-space-size=4096", XDG_CACHE_HOME: "/x" });
    expect(env).toEqual({ NODE_COMPILE_CACHE: "/c", MALLOC_ARENA_MAX: "4", NODE_OPTIONS: "--max-semi-space-size=2 --max-old-space-size=4096" });
    expect(envOf({ NODE_OPTIONS: "--max-semi-space-size=16" }).NODE_OPTIONS).toBe("--max-semi-space-size=16");
  });
});
