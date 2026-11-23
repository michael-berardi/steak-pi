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

function addCommit(repo: string, filename: string, name: string, email: string): void {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", HOME: repo };
  writeFileSync(join(repo, filename), name);
  execFileSync("git", ["-C", repo, "add", filename], { env, encoding: "utf8" });
  execFileSync("git", ["-C", repo, "-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-q", "-m", name], {
    env: { ...env, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email },
  });
}

function runGuard(repo: string, ...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, "--repo", repo, ...args], { encoding: "utf8" });
}

/** Makes the only commit also the remote tip, reproducing a release cut from main. */
function pointOriginMainAtHead(repo: string): void {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", HOME: repo };
  const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { env, encoding: "utf8" }).trim();
  execFileSync("git", ["-C", repo, "update-ref", "refs/remotes/origin/main", head], { env, encoding: "utf8" });
}

describe("commit identity guard", () => {
  it("refuses a commit authored as worker@localhost", () => {
    const repo = repoWithCommit("Steak Pi worker", "worker@localhost");
    const r = runGuard(repo);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/author uses a machine-local identity/);
    expect(r.stderr).not.toContain("worker@localhost");
  });

  it("refuses @local, *.local, *.localhost and *.localdomain addresses, including trailing dots", () => {
    expect(findLocalIdentities(["abc\tdev@host.local\tok@example.com"]).map((x: { role: string }) => x.role)).toEqual(["author"]);
    expect(findLocalIdentities(["abc\tok@example.com\tbuild@local"]).map((x: { role: string }) => x.role)).toEqual(["committer"]);
    expect(findLocalIdentities(["abc\tsomeone@example.local\tsomeone@example.local"]).length).toBe(2);
    for (const email of ["dev@host.local.", "dev@localhost.", "dev@box.localdomain", "dev@box.localhost", "dev@a.b.localhost"]) {
      expect(findLocalIdentities([`abc\t${email}\tok@example.com`]).map((x: { role: string }) => x.role), email).toEqual(["author"]);
    }
  });

  it("passes a correctly attributed commit", () => {
    const repo = repoWithCommit("A Contributor", "contributor@users.noreply.github.com");
    const r = runGuard(repo);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^OK/);
  });

  it("does not refuse a lookalike domain that merely contains local", () => {
    expect(findLocalIdentities(["abc\tone@localhost.example.com\tone@locally.dev\tone@localdomain.example.com"])).toEqual([]);
  });

  it("checks the tip commit when the default release range is empty", () => {
    const repo = repoWithCommit("Steak Pi worker", "worker@localhost");
    pointOriginMainAtHead(repo);
    const r = runGuard(repo);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/author uses a machine-local identity/);
  });

  it("checks only the tip when a release cut has an empty range and older local commits", () => {
    const repo = repoWithCommit("Steak Pi worker", "worker@localhost");
    addCommit(repo, "public.txt", "Release", "release@users.noreply.github.com");
    pointOriginMainAtHead(repo);
    const r = runGuard(repo);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/HEAD\^\.\.HEAD/);
  });

  it("reports malformed arguments without a stack trace", () => {
    const missingRepo = spawnSync(process.execPath, [SCRIPT, "--repo"], { encoding: "utf8" });
    expect(missingRepo.status).toBe(2);
    expect(missingRepo.stderr).toMatch(/--repo requires a directory/);
    expect(missingRepo.stderr).not.toContain("\n    at ");

    const repo = repoWithCommit("A Contributor", "contributor@users.noreply.github.com");
    const optionRange = spawnSync(process.execPath, [SCRIPT, "--repo", repo, "-3"], { encoding: "utf8" });
    expect(optionRange.status).toBe(2);
    expect(optionRange.stderr).toMatch(/unexpected option/);
    expect(optionRange.stderr).not.toContain("\n    at ");
  });
});
