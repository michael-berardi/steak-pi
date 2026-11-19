import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getClaudeStatus, setClaudeCodeDiagnosticReporter, setClaudeCodeStatusReporter } from "./claude-cli.ts";
import { claudeCodeEnv, createClaudeCodeProvider } from "./provider.ts";

export default function claudeCodeExtension(pi: ExtensionAPI): void {
  pi.registerProvider(createClaudeCodeProvider());
  pi.on("session_start", (_event, ctx) => {
    setClaudeCodeDiagnosticReporter((message) => ctx.ui.notify(message, "info"));
    setClaudeCodeStatusReporter((text) => ctx.ui.setStatus("claude-code-wait", text));
  });
  pi.on("session_shutdown", (_event, ctx) => {
    setClaudeCodeDiagnosticReporter(undefined);
    setClaudeCodeStatusReporter(undefined);
    try { ctx.ui.setStatus("claude-code-wait", undefined); } catch { /* the UI may already be gone */ }
  });

  pi.registerCommand("claude-code-status", {
    description: "Check the Claude Code executable and subscription login",
    handler: async (_args, ctx) => {
      const status = await getClaudeStatus(claudeCodeEnv(), ctx.signal);
      if (!status.available || !status.loggedIn) {
        ctx.ui.notify(status.detail ?? "Claude Code is not ready", "error");
        return;
      }
      const plan = status.plan ? ` (${status.plan})` : "";
      ctx.ui.notify(`Claude Code is installed and logged in${plan}`, "info");
    },
  });
}

export { createClaudeCodeProvider } from "./provider.ts";
export { streamClaudeCode } from "./stream.ts";
