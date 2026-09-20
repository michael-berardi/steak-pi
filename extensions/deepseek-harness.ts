import { createBashToolDefinition, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { appendHarnessPrompt, isDeepSeekHarnessRoute, rewriteHarnessPayload } from "../src/deepseek-harness/index.ts";
import { createPrimaryShell, MANAGED_FLAG, preflightPrimary } from "../src/deepseek-primary.ts";

export default function deepseekHarness(pi: ExtensionAPI): void {
  pi.registerFlag(MANAGED_FLAG, { type: "boolean", description: "Admitted steak-pi-dsh primary configuration only" });
  let managed = false;
  let admissionError: string | undefined;
  let shell: ReturnType<typeof createPrimaryShell> | undefined;
  const cleanup = async () => { await shell?.dispose(); };
  const failClosed = (error: unknown, ctx: ExtensionContext) => {
    managed = false;
    admissionError = error instanceof Error ? error.message : String(error);
    ctx.shutdown();
  };
  const reset = async (_event: unknown, ctx: ExtensionContext) => {
    try { await cleanup(); } catch (error) { failClosed(error, ctx); throw error; }
  };
  pi.on("tool_call", () => admissionError ? { block: true, reason: admissionError } : undefined);
  pi.on("session_start", async (_event, ctx) => {
    managed = false;
    admissionError = undefined;
    try {
    await cleanup();
    shell = undefined;
    if (!pi.getFlag(MANAGED_FLAG)) return;
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    if (process.env.STEAK_DSH_MANAGED_ROOT !== root) throw new Error("Use bin/steak-pi-dsh; unmanaged native-name override refused");
    preflightPrimary(root, ctx.cwd, process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent"), []);
    managed = true;
    shell = createPrimaryShell(ctx.cwd);
    const native = createBashToolDefinition(ctx.cwd);
    const persistent = createBashToolDefinition(ctx.cwd, { operations: shell.operations });
    pi.registerTool({ ...native, async execute(id, params, signal, update, toolCtx) {
      if (managed && isDeepSeekHarnessRoute(toolCtx.model)) return persistent.execute(id, params, signal, update, toolCtx);
      await cleanup();
      return native.execute(id, params, signal, update, toolCtx);
    } });
    } catch (error) { failClosed(error, ctx); throw error; }
  });
  pi.on("model_select", reset);
  pi.on("session_before_switch", reset);
  pi.on("session_before_fork", reset);
  pi.on("session_before_tree", reset);
  pi.on("session_shutdown", cleanup);
  pi.on("before_agent_start", (event, ctx) => {
    if (!isDeepSeekHarnessRoute(ctx.model)) return;
    const prompt = appendHarnessPrompt(event.systemPrompt, managed).replace("worker-local persistent shell", "primary-session-local persistent shell");
    return { systemPrompt: prompt };
  });
  pi.on("before_provider_request", (event, ctx) => {
    if (!isDeepSeekHarnessRoute(ctx.model)) return;
    const catalog = pi.getAllTools();
    if (["grep", "find", "ls"].some(name => catalog.some(t => t.name === name && t.sourceInfo?.source !== "builtin"))) return;
    return rewriteHarnessPayload(event.payload);
  });
}
