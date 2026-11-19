// Google Antigravity CLI (agy) route. Steak Pi never talks to Google's service itself: it runs the official `agy` binary.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { INSTALL_COMMAND } from "./errors.ts";
import { LEGACY_NOTICE, legacyEnabledConfig } from "./legacy.ts";
import { agyStatus, createAgyProvider } from "./provider.ts";

export default function agyExtension(pi: ExtensionAPI): void {
  pi.registerProvider(createAgyProvider());
  pi.on("session_start", (_event, ctx) => {
    if (legacyEnabledConfig()) ctx.ui.notify(LEGACY_NOTICE, "warning");
  });
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
