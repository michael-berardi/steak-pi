import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  codexReplyLimitError,
  MAX_SMALLER_STEP_FOLLOW_UPS,
  SMALLER_STEP_INSTRUCTION,
} from "../src/codex-reply-limit.ts";

/**
 * Codex ends a reply after about 15 minutes. Pi would send the identical request again and fail
 * the same way; this names the failure instead (so Pi does not retry it) and, once per failure
 * chain, asks for the same work in smaller steps on the same model and reasoning level.
 * See src/codex-reply-limit.ts.
 */
export default function codexReplyLimitExtension(pi: ExtensionAPI): void {
  let turnStartedAt = Date.now();
  let followUps = 0;
  let followUpDue = false;

  pi.on("turn_start", () => {
    turnStartedAt = Date.now();
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message as { role?: string; stopReason?: string; errorMessage?: string; provider?: string; api?: string; model?: string };
    if (message.role !== "assistant") return undefined;
    const explicit = codexReplyLimitError(message, Date.now() - turnStartedAt, ctx.thinkingLevel);
    if (!explicit) {
      if (message.stopReason !== "error") followUps = 0; // progress: a later cut gets its own follow-up
      return undefined;
    }
    followUpDue = followUps < MAX_SMALLER_STEP_FOLLOW_UPS;
    return { message: { ...event.message, errorMessage: explicit } as typeof event.message };
  });

  pi.on("agent_settled", () => {
    if (!followUpDue) return;
    followUpDue = false;
    followUps += 1;
    pi.sendUserMessage(SMALLER_STEP_INSTRUCTION, { deliverAs: "followUp" });
  });
}
