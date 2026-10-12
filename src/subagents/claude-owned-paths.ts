import { realpathSync } from "node:fs";

/** Characters that change the meaning of an Edit(...) gitignore-style rule.
 * Refuse them rather than escaping or widening the caller's ownership. */
const PERMISSION_RULE_UNSAFE = /[*?[\]{}()!\\\n\r]/;

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
        throw new Error(`claude-code owned path contains a permission-rule metacharacter ${JSON.stringify(unsafe)} and cannot be enforced exactly: ${JSON.stringify(form)}`);
      }
      // `//` marks an absolute filesystem path in Claude Code permission rules.
      rules.push(`Edit(/${form})`, `Edit(/${form === "/" ? "" : form}/**)`);
    }
  }
  return rules;
}
