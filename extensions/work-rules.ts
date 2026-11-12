import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Working rules: one short system-prompt section, the same six lines Steak DSH ships. On the ParetoBench short set
 * (20 tasks, 3 repeats, paired) the lean run with these rules cost 0.84 times the lean run without them (95% interval
 * 0.75 to 0.93) at the same correct count, mostly by cutting output and repeat reads. `STEAK_PI_WORK_RULES=off`
 * leaves them out; `STEAK_PI_WORK_RULES_TEXT` replaces the text.
 */
export const WORK_RULES = [
  "Work rules:",
  "- Be economical with steps. Send independent tool calls together in one step (several reads, or several checks, at once) instead of one per step.",
  "- Gather context once. Do not re-read a file you just read or wrote, and do not list a directory twice.",
  "- For large files and logs, search or compute with a command instead of reading the whole file.",
  "- After a change, check it once: run the project's tests or check script when one exists, otherwise run the changed code. If it fails, fix it and run again. Report failures as failures.",
  "- A request with several parts is done only when every part is done. Change only what was asked.",
  "- Final reply: a few short lines saying what changed and how you checked it.",
].join("\n");

export function workRulesText(env: NodeJS.ProcessEnv = process.env): string {
  if (/^(0|false|off|no)$/i.test(env.STEAK_PI_WORK_RULES?.trim() ?? "")) return "";
  const custom = env.STEAK_PI_WORK_RULES_TEXT;
  return typeof custom === "string" && custom.trim() ? custom.trim() : WORK_RULES;
}

export default function workRules(pi: ExtensionAPI): void {
  pi.on("before_agent_start", event => {
    const text = workRulesText();
    if (!text || event.systemPrompt.includes(text)) return undefined;
    return { systemPrompt: `${event.systemPrompt}\n\n${text}` };
  });
}
