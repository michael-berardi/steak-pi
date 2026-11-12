#!/usr/bin/env node
// Refuses commits whose author or committer email is machine-local (@localhost, @local, *.local).
// Such identities expose the host and job names and are rejected by the public release audit.
// Usage: node scripts/check-commit-identity.mjs [revision-range] [--repo <dir>]
//   default range: origin/main..HEAD when origin/main exists, else HEAD (the pre-push check).
// Exit 0 = every commit in range is attributed; exit 1 = names each refused commit (no secrets printed).
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const LOCAL_EMAIL = /@(?:[^@]*\.)?local$|@localhost$/i;

/** Returns the refused identities: [{ commit, role, email }]. Input is `git log --format=%H%x09%ae%x09%ce` lines. */
export function findLocalIdentities(logLines) {
  const refused = [];
  for (const line of logLines) {
    const [commit, author, committer] = line.split("\t");
    if (!commit) continue;
    if (LOCAL_EMAIL.test(author ?? "")) refused.push({ commit, role: "author", email: author });
    if (LOCAL_EMAIL.test(committer ?? "")) refused.push({ commit, role: "committer", email: committer });
  }
  return refused;
}

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

export function checkRange(repo, range) {
  const lines = git(repo, ["log", "--format=%H%x09%ae%x09%ce", range]).split("\n").filter(Boolean);
  return findLocalIdentities(lines);
}

function defaultRange(repo) {
  try {
    git(repo, ["rev-parse", "--verify", "--quiet", "origin/main"]);
    return "origin/main..HEAD";
  } catch {
    return "HEAD";
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const repoIdx = args.indexOf("--repo");
  const repo = repoIdx >= 0 ? args[repoIdx + 1] : process.cwd();
  const range = args.find((a, i) => a !== "--repo" && (repoIdx < 0 || i !== repoIdx + 1)) ?? defaultRange(repo);
  const refused = checkRange(repo, range);
  if (refused.length) {
    for (const r of refused) {
      console.error(`refused: ${r.commit.slice(0, 8)} ${r.role} uses a machine-local identity (${r.email.replace(/^[^@]*/, "<name>")}); commit as the operator's public identity`);
    }
    process.exit(1);
  }
  console.log(`OK commit identities in ${range}`);
}
