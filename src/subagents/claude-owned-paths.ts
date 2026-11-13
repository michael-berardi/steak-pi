import { realpathSync } from "node:fs";

/** Characters that cannot be made literal in an Edit(...) rule. Measured against the Claude Code CLI's own
 * matcher (2.1.322, mock model, real permission checks): `\?` does not match a literal `?`, and `\\` collapses so
 * `f\\x` also allows `fx`. Newlines cannot appear in a rule. These stay refused, naming the full path. */
const PERMISSION_RULE_UNSAFE = /[?\\\n\r]/;

/** Pattern characters the CLI matcher honours a backslash escape for (measured: `\[ \] \* \{ \} \( \) \!` each
 * match only the literal character, so `[id]` no longer acts as a character class matching `i` or `d`). */
const PERMISSION_RULE_ESCAPED = /[*[\]{}()!]/g;

/** C1 controls, DEL and bidi overrides never reach an operator-facing error: they can hide or reorder text. */
const UNPRINTABLE = /[\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
export const printablePath = (value: string): string => value.replace(UNPRINTABLE, "");

/** Any whitespace other than the plain space (tab, vertical tab, form feed, no-break space, other Unicode spaces,
 * line separators). Not measured on the CLI's matcher, so not allowed anywhere in a path. */
const NON_PLAIN_WHITESPACE = /[^\S ]/u;

/** A path segment that starts or ends with whitespace. Measured on the real CLI: the rule `Edit(//W/p5/src /**)`
 * allowed a write to `W/p5/src/x.ts` (the CLI drops the trailing space) and denied `W/p5/src /x.ts`, so the fence
 * would widen to a sibling. Refused for every segment, any Unicode whitespace. */
function whitespaceEdgeSegment(form: string): boolean {
  return form.split("/").some((segment) => segment !== "" && (/^\s/u.test(segment) || /\s$/u.test(segment)));
}

/** True when this form's rule differs from its unescaped form, i.e. the rule depends on the CLI honouring a backslash escape. */
export function claudeOwnedPathNeedsEscape(form: string): boolean {
  return literalRulePath(form) !== form;
}

/** Owned paths (lexical and physical forms) whose rules need a backslash escape; the first such full path, if any. */
export function claudeEscapedOwnedPath(
  ownedPaths: readonly string[],
  resolve: (value: string) => string | undefined = realpathOrUndefined,
): string | undefined {
  for (const owned of ownedPaths) {
    for (const form of ownedPathForms(owned, resolve)) if (claudeOwnedPathNeedsEscape(form)) return form;
  }
  return undefined;
}

function ownedPathForms(owned: string, resolve: (value: string) => string | undefined): Set<string> {
  const forms = new Set([owned.replace(/\/+$/, "") || "/"]);
  const physical = resolve(owned);
  if (physical) forms.add(physical.replace(/\/+$/, "") || "/");
  return forms;
}

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
    for (const form of ownedPathForms(owned, resolve)) {
      const shown = JSON.stringify(printablePath(form).slice(0, 2000));
      if (whitespaceEdgeSegment(form)) {
        throw new Error(`claude-code owned path has a segment that begins or ends with whitespace, and the Claude Code permission rule cannot match it exactly: ${shown}`);
      }
      if (/[()]/.test(form) && /[\s,]/u.test(form)) {
        throw new Error(`claude-code owned path contains parentheses together with whitespace or a comma, and the Claude Code permission rule splitter cannot be trusted to match it exactly: ${shown}`);
      }
      const unsafe = PERMISSION_RULE_UNSAFE.exec(form)?.[0];
      if (unsafe !== undefined) {
        throw new Error(`claude-code owned path contains a permission-rule metacharacter ${JSON.stringify(printablePath(unsafe))} and cannot be enforced exactly: ${shown}`);
      }
      if (NON_PLAIN_WHITESPACE.test(form)) {
        throw new Error(`claude-code owned path contains whitespace other than a plain space (tab, no-break space or another Unicode space), which is not measured against the Claude Code permission rule matcher and so cannot be enforced exactly: ${shown}`);
      }
      // `//` marks an absolute filesystem path in Claude Code permission rules.
      const literal = literalRulePath(form);
      rules.push(`Edit(/${literal})`, `Edit(/${literal === "/" ? "" : literal}/**)`);
    }
  }
  return rules;
}
