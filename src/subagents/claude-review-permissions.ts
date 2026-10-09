/**
 * Shell policy for read-only Claude Code reviewer leaves (P-0525).
 *
 * A reviewer leaf (role "reviewer", mayEdit false) is an audit step. An
 * unscoped `Bash` grant is not read-only: aliases, pipelines, interpreters and
 * `kill` all run inside it, and the CLI has no way to scope them after the
 * fact. So the contract is deny, not sandbox: a read-only reviewer never gets
 * the Bash tool or any Bash allow rule, even when allowBash was requested. The
 * parent stages git evidence (diff, status, log, file contents) in the task
 * text or under the run cwd, and the reviewer reads it with Read/Grep/Glob.
 *
 * Editable workers (mayEdit true) and every other role keep exactly the shell
 * the task asked for; this module changes nothing for them.
 *
 * Integration (claude-worker.ts):
 *   const shell = claudeShellPolicy(task);                  // { role, mayEdit, allowBash }
 *   claudeWorkerArgs: use `shell.allowBash` where `permissions.allowBash` gates
 *     the `Bash` tool and the unscoped `Bash` allow rule, then
 *     `assertClaudeReviewArgsShellFree(task, args)` on the final argv;
 *   buildClaudeWorkerPrompt: `shell.permissionLine ?? permissionLine(task)` and
 *     `May use bash: ${shell.bashStatus}.`; surface `shell.diagnostic` (when
 *     set) in the run journal/output so the suppression is never silent.
 */

/** Named diagnostic: allowBash was requested for a read-only reviewer and withheld. */
export const CLAUDE_REVIEW_SHELL_SUPPRESSED = "claude-review-shell-suppressed";
/** Named failure: final CLI arguments for a read-only reviewer carry a shell or wider tool. */
export const CLAUDE_REVIEW_SHELL_ARGS_REJECTED = "claude-review-shell-args-rejected";

/** The only tools a read-only reviewer may hold (mirrors CLAUDE_CODE_ALLOWED_TOOLS). */
export const CLAUDE_REVIEW_TOOLS: readonly string[] = ["Read", "Grep", "Glob"];

export interface ClaudeShellPolicyInput {
  role?: string;
  mayEdit?: boolean;
  allowBash?: boolean;
}

export interface ClaudeShellPolicy {
  /** Effective shell grant: gates the `Bash` tool and the unscoped `Bash` allow rule. */
  allowBash: boolean;
  /** True when allowBash was requested but withheld from a read-only reviewer. */
  suppressed: boolean;
  /** Present iff `suppressed`: the named, human-readable reason. */
  diagnostic?: string;
  /** Present iff `suppressed`: replaces the prompt's permission line. */
  permissionLine?: string;
  /** Text for the prompt's `May use bash:` field. */
  bashStatus: string;
}

const SUPPRESSION_REASON = "unscoped Bash can run aliases, pipelines and interpreters and can signal arbitrary processes, so read-only reviewers get no shell";

/** Read-only review: role reviewer and mayEdit not explicitly true (fail closed
 * on a missing or malformed mayEdit; role matching ignores case and spacing). */
export function isClaudeReadOnlyReview(input: ClaudeShellPolicyInput): boolean {
  const role = typeof input.role === "string" ? input.role.trim().toLowerCase() : "";
  return role === "reviewer" && input.mayEdit !== true;
}

export function claudeShellPolicy(input: ClaudeShellPolicyInput): ClaudeShellPolicy {
  const requested = Boolean(input.allowBash);
  if (!isClaudeReadOnlyReview(input)) {
    return { allowBash: requested, suppressed: false, bashStatus: requested ? "yes (unsandboxed, operator trust domain)" : "no" };
  }
  if (!requested) return { allowBash: false, suppressed: false, bashStatus: "no" };
  return {
    allowBash: false,
    suppressed: true,
    diagnostic: `${CLAUDE_REVIEW_SHELL_SUPPRESSED}: allowBash was requested for a read-only reviewer leaf (role reviewer, mayEdit false) and was not granted; ${SUPPRESSION_REASON}. The parent must stage git evidence (diff, status, log, file contents) in the task text or under the run cwd; the reviewer uses Read, Grep, Glob only.`,
    permissionLine: `This is a read-only reviewer leaf: your tool allowlist is Read, Grep, Glob only. Shell access is not available to read-only reviewers even though allowBash was requested (${CLAUDE_REVIEW_SHELL_SUPPRESSED}). Review the git evidence the parent staged in the task text or under the run cwd; if needed evidence is missing, say so in your final report instead of attempting shell commands.`,
    bashStatus: `no (${CLAUDE_REVIEW_SHELL_SUPPRESSED}: read-only reviewer)`,
  };
}

/** Fail-closed argv check for read-only reviewers; a no-op for any other leaf.
 * Requires exactly one `--tools` listing only Read/Grep/Glob (a missing
 * `--tools` would leave the CLI default tool set), `--allowedTools` rules that
 * name only those tools, `--permission-mode dontAsk`, and no permission-skip
 * flag. It validates the arguments; it is not a shell sandbox. */
export function assertClaudeReviewArgsShellFree(input: ClaudeShellPolicyInput, args: readonly string[]): void {
  if (!isClaudeReadOnlyReview(input)) return;
  const reject = (reason: string): never => { throw new Error(`${CLAUDE_REVIEW_SHELL_ARGS_REJECTED}: ${reason}`); };
  const permitted = new Set(CLAUDE_REVIEW_TOOLS);
  let tools: string | undefined;
  let mode: string | undefined;
  const rules: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (/^--(?:tools|allowedTools|allowed-tools|permission-mode)=/.test(arg)) reject(`unsupported inline form ${JSON.stringify(arg.slice(0, arg.indexOf("=")))}`);
    if (arg === "--dangerously-skip-permissions" || arg === "--allow-dangerously-skip-permissions") reject("permission-skip flags are forbidden");
    if (arg === "--tools") {
      if (tools !== undefined) reject("--tools given more than once");
      tools = args[++index] ?? reject("--tools has no value");
    } else if (arg === "--permission-mode") {
      if (mode !== undefined) reject("--permission-mode given more than once");
      mode = args[++index] ?? reject("--permission-mode has no value");
    } else if (arg === "--allowedTools" || arg === "--allowed-tools") {
      while (index + 1 < args.length && !args[index + 1].startsWith("--")) rules.push(args[++index]);
    }
  }
  if (tools === undefined) reject("--tools is missing, which would leave the CLI default tool set");
  for (const tool of (tools as string).split(/[\s,]+/).filter(Boolean)) {
    if (!permitted.has(tool)) reject(`tool ${JSON.stringify(tool)} is not one of ${CLAUDE_REVIEW_TOOLS.join(", ")}`);
  }
  for (const rule of rules) {
    const name = rule.trim().replace(/\([\s\S]*$/, "");
    if (!permitted.has(name)) reject(`allow rule ${JSON.stringify(rule.slice(0, 64))} does not name Read, Grep or Glob`);
  }
  if (mode !== "dontAsk") reject("--permission-mode must be dontAsk");
}
