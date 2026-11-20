// Google Antigravity CLI (agy) route. Steak Pi never talks to Google's service itself: it runs the official `agy` binary.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { INSTALL_COMMAND } from "./errors.ts";
import { LEGACY_NOTICE, legacyEnabledConfig } from "./legacy.ts";
import { agyStatus, createAgyProvider } from "./provider.ts";
import { resetAcpSessions, setAcpPermissionHandler, setAcpToolSource } from "./acp/session.ts";
import { setAcpLog } from "./acp/transport.ts";

/** Pi's current context owns the tools and approvals; the ACP bridge borrows it for the active turn. */
function attachContext(ctx: ExtensionContext): void {
  setAcpToolSource({
    list: () => ((ctx as any).getCallableTools?.() ?? []) .map((tool: any) => ({
      name: String(tool.name),
      description: String(tool.description ?? ""),
      parameters: tool.parameters as Record<string, unknown>,
    })),
    call: async (name, args) => {
      const outcome = await (ctx as any).executeTool?.("steak-pi-agy-acp", name, args, { signal: ctx.signal });
      if (!outcome) throw new Error(`Pi tool ${name} is not callable in this context`);
      return {
        content: (outcome.result?.content ?? []).map((part: any) => part?.type === "image"
          ? { type: "image" as const, data: String(part.data ?? ""), mimeType: String(part.mimeType ?? "application/octet-stream") }
          : { type: "text" as const, text: String(part?.text ?? "") }),
        ...(outcome.isError || outcome.result?.isError ? { isError: true } : {}),
      };
    },
  });
  setAcpPermissionHandler(async (request) => {
    const allowed = request.options.find((option) => String(option.kind ?? "").startsWith("allow"));
    if (!ctx.hasUI) return undefined; // no dialog: never auto-approve an agy tool
    try {
      const approved = await ctx.ui.confirm(`Allow agy to ${request.title}?`, `The Antigravity CLI asked for permission. Steak Pi sends this to your normal approval path; agy's own permissions are not bypassed.`);
      return approved ? allowed?.optionId : undefined;
    } catch { return undefined; }
  });
  setAcpLog((message) => { try { ctx.ui.notify(message, "warning"); } catch { /* logging never breaks the turn */ } });
}

export default function agyExtension(pi: ExtensionAPI): void {
  pi.registerProvider(createAgyProvider());
  // Capture the live context before any provider request; a new session/tree/compact replaces the ACP session.
  for (const event of ["session_start", "agent_start", "before_provider_request", "context"] as const) {
    pi.on(event as never, ((_event: unknown, ctx: ExtensionContext) => {
      attachContext(ctx);
      if (event === "session_start") {
        if (legacyEnabledConfig()) ctx.ui.notify(LEGACY_NOTICE, "warning");
        return void resetAcpSessions();
      }
    }) as never);
  }
  pi.on("session_tree", () => resetAcpSessions());
  pi.on("session_compact", () => resetAcpSessions());
  pi.on("session_shutdown", () => resetAcpSessions());
  pi.registerCommand("agy-status", {
    description: "Check the Antigravity CLI (agy) install and sign-in",
    handler: async (_args, ctx) => {
      const status = await agyStatus(ctx.signal);
      if (!status.ok) { ctx.ui.notify(status.error.message, "error"); return; }
      ctx.ui.notify(`agy is installed and signed in (${status.models} models on this plan). Install command if needed: ${INSTALL_COMMAND}`, "info");
    },
  });
}

export { createAgyProvider } from "./provider.ts";
export { streamAgy } from "./stream.ts";
export { streamAgyAcp } from "./acp/stream.ts";
