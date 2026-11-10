import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  budgetApplies, describePromptBudget, planFixedPrompt, readPromptBudgetConfig, type PromptBudgetProblem,
} from "../../src/prompt-budget.ts";

/**
 * Hold a small-context route's fixed prompt to a share of its window.
 *
 * The decision is the route's declared context size, never a model name or a provider: any route whose window is below
 * the threshold gets the budget, and a route at or above it is left exactly as Pi assembled it (this hook returns
 * nothing, so the prompt is the one the earlier handlers produced, byte for byte).
 *
 * The budget is applied through the documented chained `systemPrompt` contract (the same one the skill catalog uses),
 * so a later handler still sees and can extend the result. The overage of project instructions — which are never
 * truncated — and any refused configuration value are reported once, with the numbers, in the status line and the log.
 */
export default function promptBudget(pi: ExtensionAPI): void {
  const { config, problems } = readPromptBudgetConfig(process.env);
  if (!config.enabled) return;
  let saidProblems = false;
  let saidOverage = false;

  const say = (ctx: ExtensionContext, key: string, text: string, kind: "info" | "warning") => {
    try { ctx.ui.setStatus(key, text); } catch { /* a detached UI is not a reason to skip the log line. */ }
    try { ctx.ui.notify(text, kind); } catch { /* notifications are best-effort. */ }
    if (ctx.hasUI === false) process.stderr.write(`${text}\n`);
  };
  const problemText = (problem: PromptBudgetProblem) =>
    `steak-pi prompt budget: REFUSED (bad-prompt-budget) ${problem.key} ${problem.reason} (got ${JSON.stringify(problem.value)}); using ${problem.used}`;

  pi.on("before_agent_start", (event, ctx) => {
    if (!saidProblems && problems.length > 0) {
      saidProblems = true;
      for (const problem of problems) say(ctx, "prompt-budget-config", problemText(problem), "warning");
    }
    const window = ctx.model?.contextWindow;
    if (!budgetApplies(window, config)) return undefined; // large-context routes: nothing changes, not one byte
    const plan = planFixedPrompt({ text: event.systemPrompt, contextWindow: window as number, config });
    if (!plan.changed) return undefined;
    say(ctx, "prompt-budget", describePromptBudget(plan), "info");
    if (plan.keptWhole !== undefined && !saidOverage) {
      saidOverage = true;
      say(ctx, "prompt-budget-overage",
        `steak-pi prompt budget: project instructions kept whole (${plan.keptWhole.tokens} tokens, ${plan.keptWhole.overBy} over the ${plan.budgetTokens}-token budget for a ${plan.contextWindow}-token window): they carry the operator's rules and are never truncated`,
        "warning");
    }
    return { systemPrompt: plan.text };
  });
}
