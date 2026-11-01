import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  finishGuardSettings,
  finishVerdict,
  textOf,
  todosOfPhases,
  type GuardTodo,
} from "../src/finish-guard.ts";

const CUSTOM_TYPE = "finish-guard";

/**
 * Finish guard. At Pi's final boundary (`agent_before_settle`) a turn that completed while the todo
 * plan still has open items, or whose final reply reports unfinished work, gets one more model request
 * with the open list instead of settling. Bounded: `maxPushes` per operator message (default 3), never
 * after an abort or error, never when the operator asked to stop or only for an answer.
 *
 * State is O(1) and event-driven: the last operator input, the last assistant text, the latest todo
 * state and the pushes so far. Nothing rescans the session at settle and nothing reads a file there;
 * settings are read at load and session start. Configure `finishGuard` in steak-pi.json
 * (`enabled`, `maxPushes`, `message`); STEAK_PI_FINISH_GUARD=0 turns it off. See src/finish-guard.ts.
 */
export default function finishGuardExtension(pi: ExtensionAPI): void {
  let settings = finishGuardSettings();
  let todos: GuardTodo[] = [];
  let lastUser = "";
  let finalText = "";
  let pushes = 0;

  const reset = () => { todos = []; lastUser = ""; finalText = ""; pushes = 0; };

  // One backward pass from the branch tip, stopping once the last operator message and the latest todo
  // state are both found. Runs when a session becomes active, never at settle.
  const seed = (entries: readonly unknown[] | undefined) => {
    reset();
    if (!entries) return;
    let needUser = true;
    let needTodo = true;
    for (let i = entries.length - 1; i >= 0 && (needUser || needTodo); i--) {
      const entry = entries[i] as { type?: string; customType?: string; message?: any } | undefined;
      if (!entry) continue;
      if (entry.type === "custom_message") {
        if (needUser && entry.customType === CUSTOM_TYPE) pushes += 1;
        continue;
      }
      if (entry.type !== "message" || !entry.message) continue;
      const message = entry.message;
      if (message.role === "user") {
        if (needUser) { lastUser = textOf(message.content); needUser = false; }
      } else if (message.role === "assistant") {
        if (needUser && !finalText) {
          const text = textOf(message.content);
          if (text.trim()) finalText = text;
        }
      } else if (message.role === "toolResult" && message.toolName === "todo" && needTodo) {
        const found = todosOfPhases(message.details?.state?.phases);
        if (found) { todos = found; needTodo = false; }
      }
    }
  };

  const reseed = (_event: unknown, ctx: { sessionManager?: { getBranch?: () => unknown[] } }) => {
    try { seed(ctx.sessionManager?.getBranch?.()); } catch { reset(); } // an unreadable session never traps the agent
  };

  pi.on("session_start", (event, ctx) => {
    if (event.reason !== "startup") settings = finishGuardSettings();
    reseed(event, ctx);
  });
  pi.on("session_tree", reseed);

  // The operator speaking starts a new request. Messages other extensions send are not the operator.
  pi.on("input", (event) => {
    if (event.source === "extension") return undefined;
    lastUser = event.text;
    finalText = "";
    pushes = 0;
    return undefined;
  });

  pi.on("message_end", (event) => {
    const message = event.message as { role?: string; content?: unknown };
    if (message.role !== "assistant") return undefined;
    const text = textOf(message.content);
    if (text.trim()) finalText = text;
    return undefined;
  });

  pi.on("tool_result", (event) => {
    if (event.toolName !== "todo" || event.isError) return undefined;
    const found = todosOfPhases((event.details as { state?: { phases?: unknown } } | undefined)?.state?.phases);
    if (found) todos = found;
    return undefined;
  });

  pi.on("agent_before_settle", (event) => {
    if (!settings.enabled || event.outcome !== "completed" || event.continue) return undefined;
    const verdict = finishVerdict({ todos, finalText, lastUserText: lastUser, continuations: pushes, maxPushes: settings.maxPushes, message: settings.message });
    if (!verdict.block) return undefined;
    pushes += 1;
    finalText = ""; // only the reply to this push counts next time
    return {
      entries: [...event.entries, { type: "custom_message", customType: CUSTOM_TYPE, content: verdict.reason, display: true }],
      continue: true,
    };
  });
}
