import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

type Tool = ToolDefinition<any, any, any>;
type Route = { provider: string; id: string } | undefined;
export function isDeepSeekHarnessRoute(model: Route): boolean {
  return model?.provider === "opencode-go" && model.id === "deepseek-v4.1-flash";
}

// Adapted from pi-dsh-minimal 0.4.2 / DeepSeek Harness minimal; see vendor notice.
export const HARNESS_GUIDANCE = `Use native structured read/edit/write tools for file operations. Existing constraints remain mandatory. Bash, when available, is nonpersistent.`;
export function appendHarnessPrompt(prompt: string, persistentBash = false): string {
  const guidance = persistentBash ? HARNESS_GUIDANCE.replace("Bash, when available, is nonpersistent.", "Bash retains cwd, exports and functions across calls; file-tool paths still resolve from the fixed run cwd. Timeout/abort/excessive output resets shell state. Timeout is seconds, capped at 120; output is capped at 20,000 characters.") : HARNESS_GUIDANCE;
  return `${prompt}\n\n${guidance}`;
}

/** Construction-time only: caller supplies the original guarded executors. */
export function adaptWorkerTools(_model: Route, tools: Tool[]): Tool[] {
  // Matched live trials found alias schemas added errors and tokens. Keep the
  // exact native schemas/executors; the admitted adaptation is the shell backend.
  return tools;
}

/** OpenAI-compatible request-only bootstrap. Never changes executable registry,
 * system messages, custom/approval tools, or arguments. Subsequent calls use the
 * host catalog. No restoration of a captured active-tool snapshot is needed. */
export function rewriteHarnessPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  const p = payload as { tools?: Array<{ type?: string; function?: { name?: string } }>; messages?: Array<{ role?: string }> };
  if (!Array.isArray(p.tools) || !Array.isArray(p.messages)) return payload;
  if (p.messages.some((m) => m.role === "assistant" || m.role === "tool")) return payload;
  // Keep all policy/coordination tools. Only redundant native search conveniences
  // are omitted on bootstrap; read/edit/write/bash retain native schemas and gates.
  const redundant = new Set(["grep", "find", "ls"]);
  return { ...p, tools: p.tools.filter((t) => !redundant.has(t.function?.name ?? "")) };
}
