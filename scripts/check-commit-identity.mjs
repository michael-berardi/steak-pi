#!/usr/bin/env node
// Refuses commits whose author or committer email is machine-local (@localhost, @local, *.local, *.localhost, *.localdomain).
// Such identities expose the host and job names and are rejected by the public release audit.
// Usage: node scripts/check-commit-identity.mjs [revision-range] [--repo <dir>]
//   default range: origin/main..HEAD when that range has commits, else HEAD^..HEAD on a release cut,
//                 or HEAD when there is no origin/main ref (the pre-push check).
// Exit 0 = every commit in range is attributed; exit 1 = names each refused commit (no secrets printed).
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const LOCAL_EMAIL = /@(?:[^@.\s]+\.)*(?:local|localhost|localdomain)\.?$/i;

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
  const lines = git(repo, ["log", "--format=%H%x09%ae%x09%ce", "--end-of-options", range]).split("\n").filter(Boolean);
  return findLocalIdentities(lines);
}

function tipRange(repo) {
  try {
    git(repo, ["rev-parse", "--verify", "--quiet", "HEAD^"]);
    return "HEAD^..HEAD";
  } catch {
    return "HEAD";
  }
}

function defaultRange(repo) {
  try {
    git(repo, ["rev-parse", "--verify", "--quiet", "origin/main"]);
    try {
      if (Number(git(repo, ["rev-list", "--count", "origin/main..HEAD"]).trim()) > 0) return "origin/main..HEAD";
    } catch {
      // Fall through to the tip commit if the range cannot be counted.
    }
    return tipRange(repo); // release cut from main: verify the release commit, not a vacuous empty range
  } catch {
    return "HEAD"; // no origin/main: the original pre-push check covers all local history
  }
}

function parseArgs(args) {
  let repo = process.cwd();
  let range;
  const usage = "usage: check-commit-identity.mjs [revision-range] [--repo <dir>]";
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--repo") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) throw new Error("--repo requires a directory");
      repo = value;
      i += 1;
    } else if (arg === "--") {
      const rest = args.slice(i + 1);
      if (rest.length > 1) throw new Error(usage);
      if (rest.length === 1) range = rest[0];
      break;
    } else if (arg.startsWith("-")) {
      throw new Error(`unexpected option '${arg}'; use -- before a revision that starts with '-'`);
    } else if (range === undefined) {
      range = arg;
    } else {
      throw new Error(usage);
    }
  }
  return { repo, range: range ?? defaultRange(repo) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { repo, range } = parseArgs(process.argv.slice(2));
    const refused = checkRange(repo, range);
    if (refused.length) {
      for (const r of refused) {
        console.error(`refused: ${r.commit.slice(0, 8)} ${r.role} uses a machine-local identity (${r.email.replace(/^[^@]*/, "<name>")}); commit as the operator's public identity`);
      }
      process.exit(1);
    }
    console.log(`OK commit identities in ${range}`);
  } catch (error) {
    console.error(`check-commit-identity: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
