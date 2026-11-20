import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { applyModelGuidance, modelGuidanceSettings, modelGuidanceText, type ModelGuidanceRule } from "../src/model-guidance.ts";

/**
 * Per-model guidance from the operator's `modelGuidance` rules (src/model-guidance.ts). Read at load and at session
 * start; applied before every agent start to the model that run uses, so a mid-session model switch gets the new
 * model's lines and loses the old ones (the system prompt is rebuilt per run).
 */
export default function modelGuidance(pi: ExtensionAPI): void {
  let rules: ModelGuidanceRule[] = [];
  let reported = "";
  const load = (ctx?: { ui?: { notify?: (message: string, level?: string) => void } }) => {
    const settings = modelGuidanceSettings();
    rules = settings.rules;
    const errors = settings.errors.join("; ");
    if (errors && errors !== reported) {
      reported = errors;
      const message = `steak-pi model guidance: ${errors}`;
      if (ctx?.ui?.notify) ctx.ui.notify(message, "warning");
      else process.stderr.write(`${message}\n`);
    }
  };
  load();
  pi.on("session_start", (_event, ctx) => load(ctx as never));
  pi.on("before_agent_start", (event, ctx) => applyModelGuidance(event as never, modelGuidanceText(ctx?.model, rules)));
}
