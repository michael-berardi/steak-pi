import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("run --lean leaves out the dispatch, hub and todo tools and passes the rest through", () => {
    const dir = mkdtempSync(join(tmpdir(), "steak-pi-lean-"));
    try {
      const fake = join(dir, "pi");
      writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
      chmodSync(fake, 0o755);
      const run = (...args: string[]) => execFileSync("sh", [cli, "run", ...args], {
        env: { PATH: `${dir}:${process.env.PATH ?? ""}`, HOME: dir }, encoding: "utf8",
      }).trim().split("\n");
      expect(run("--lean", "-p", "do it")).toEqual(["--exclude-tools", "ultraterm_subagents,ultraterm_hub,todo", "-p", "do it"]);
      expect(run("-p", "do it")).toEqual(["-p", "do it"]);
      // Only the first argument is the launcher's: a later --lean belongs to pi or the prompt.
      expect(run("-p", "--lean")).toEqual(["-p", "--lean"]);
      expect(execFileSync("sh", [cli, "lean-args"], { env: { PATH: process.env.PATH ?? "", HOME: dir }, encoding: "utf8" }).trim())
        .toBe("--exclude-tools ultraterm_subagents,ultraterm_hub,todo");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
