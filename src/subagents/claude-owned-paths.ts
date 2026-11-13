import { realpathSync } from "node:fs";

/** Characters that cannot be made literal in an Edit(...) rule. Measured against the Claude Code CLI's own
 * matcher (2.1.322, mock model, real permission checks): `\?` does not match a literal `?`, and `\\` collapses so
 * `f\\x` also allows `fx`. Newlines cannot appear in a rule. These stay refused, naming the full path. */
const PERMISSION_RULE_UNSAFE = /[?\\\n\r]/;

/** Pattern characters the CLI matcher honours a backslash escape for (measured: `\[ \] \* \{ \} \( \) \!` each
 * match only the literal character, so `[id]` no longer acts as a character class matching `i` or `d`). */
const PERMISSION_RULE_ESCAPED = /[*[\]{}()!]/g;

function literalRulePath(form: string): string {
  return form.replace(PERMISSION_RULE_ESCAPED, "\\$&");
}

function realpathOrUndefined(value: string): string | undefined {
  try { return realpathSync(value); } catch { return undefined; }
}

/** Shared by dispatch admission and launch-time CLI argument construction.
 * Dispatch supplies its physical projection, including nonexistent children
 * beneath symlinks; launch rechecks paths against the current filesystem. */
export function claudeOwnedPathRules(
  ownedPaths: readonly string[],
  resolve: (value: string) => string | undefined = realpathOrUndefined,
): string[] {
  const rules: string[] = [];
  for (const owned of ownedPaths) {
    if (!owned.startsWith("/")) throw new Error(`claude-code owned path must be absolute: ${JSON.stringify(owned)}`);
    const forms = new Set([owned.replace(/\/+$/, "") || "/"]);
    const physical = resolve(owned);
    if (physical) forms.add(physical.replace(/\/+$/, "") || "/");
    for (const form of forms) {
      const unsafe = PERMISSION_RULE_UNSAFE.exec(form)?.[0];
      if (unsafe !== undefined) {
        throw new Error(`claude-code owned path contains a permission-rule metacharacter ${JSON.stringify(unsafe)} and cannot be enforced exactly: ${JSON.stringify(form.slice(0, 2000))}`);
      }
      // `//` marks an absolute filesystem path in Claude Code permission rules.
      const literal = literalRulePath(form);
      rules.push(`Edit(/${literal})`, `Edit(/${literal === "/" ? "" : literal}/**)`);
    }
  }
  return rules;
}
