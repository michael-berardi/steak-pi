import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findLocalIdentities } from "../scripts/check-commit-identity.mjs";

const SCRIPT = resolve(import.meta.dirname, "..", "scripts", "check-commit-identity.mjs");
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

/** A hermetic repo with one commit per identity; env pins author and committer so the host's git config is never read. */
function repoWithCommit(name: string, email: string): string {
  const dir = mkdtempSync(join(tmpdir(), "steak-identity-"));
  roots.push(dir);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", HOME: dir };
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { env, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "file.txt"), name);
  git("add", "file.txt");
  execFileSync("git", ["-C", dir, "-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-q", "-m", name], {
    env: { ...env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email },
  });
  return dir;
}

function runGuard(repo: string, range = "HEAD") {
  return spawnSync(process.execPath, [SCRIPT, "--repo", repo, range], { encoding: "utf8" });
}

describe("commit identity guard", () => {
  it("refuses a commit authored as worker@localhost", () => {
    const repo = repoWithCommit("Steak Pi worker", "worker@localhost");
    const r = runGuard(repo);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/author uses a machine-local identity/);
    expect(r.stderr).not.toContain("worker@localhost");
  });

  it("refuses @local and *.local addresses for committer and author", () => {
    expect(findLocalIdentities(["abc\tdev@host.local\tok@example.com"]).map((x: { role: string }) => x.role)).toEqual(["author"]);
    expect(findLocalIdentities(["abc\tok@example.com\tbuild@local"]).map((x: { role: string }) => x.role)).toEqual(["committer"]);
    expect(findLocalIdentities(["abc\tsomeone@example.local\tsomeone@example.local"]).length).toBe(2);
  });

  it("passes a correctly attributed commit", () => {
    const repo = repoWithCommit("A Contributor", "contributor@users.noreply.github.com");
    const r = runGuard(repo);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^OK/);
  });

  it("does not refuse a lookalike domain that merely contains local", () => {
    expect(findLocalIdentities(["abc\tone@localhost.example.com\tone@locally.dev"])).toEqual([]);
  });
});
