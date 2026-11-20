// One ACP session per Pi session: a long-lived `agy acp` child, session/new with the loopback MCP bridge,
// session/prompt per turn, session/cancel on abort, and real model/effort/context values from session options.
import type { ChildProcess } from "node:child_process";
import { AgyError, cleanAgyText, missingMessage } from "../errors.ts";
import { spawnAgyChild, stopChild } from "../process.ts";
import { AcpRpcError, createJsonRpcPeer, type AcpPeer } from "./jsonrpc.ts";
import { startMcpBridge, type BridgeToolResult, type BridgeToolSource, type McpBridge } from "./mcp-bridge.ts";
import { contextWindowFromOptions, effortForAcp, normalizeAcpUsage, thinkingLevelMapFromOptions, type AcpConfigOption } from "./options.ts";

export interface AcpPermissionRequest {
  title: string;
  name?: string;
  options: { optionId: string; name?: string; kind?: string }[];
}
export type AcpPermissionHandler = (request: AcpPermissionRequest, signal?: AbortSignal) => Promise<string | undefined>;

let toolSource: BridgeToolSource = { list: () => [], call: async (name) => { throw new Error(`Pi tool ${name} is unavailable in this context`); } };
let permissionHandler: AcpPermissionHandler | undefined;
export const setAcpToolSource = (source: BridgeToolSource) => { toolSource = source; };
export const getAcpToolSource = () => toolSource;
export const setAcpPermissionHandler = (handler: AcpPermissionHandler | undefined) => { permissionHandler = handler; };

/** Turn text of ACP's authentication error into the same named cause as the headless route. */
export function acpError(error: unknown, phase: "initialize" | "prompt"): AgyError {
  if (error instanceof AgyError) return error;
  const cause = (error as NodeJS.ErrnoException)?.cause ?? error;
  if ((cause as NodeJS.ErrnoException)?.code === "ENOENT" || (cause as NodeJS.ErrnoException)?.code === "EACCES") {
    return new AgyError("missing", missingMessage("agy"), { cause: error });
  }
  if (error instanceof AcpRpcError && error.rpc.code === -32000 && /auth|sign|credential/i.test(error.rpc.message)) {
    return new AgyError("signed-out", `agy is not signed in (ACP said: ${cleanAgyText(error.rpc.message)}); run agy once to sign in.`, { cause: error });
  }
  const message = cleanAgyText(error instanceof Error ? error.message : String(error));
  if (/timed out|no ACP response/i.test(message)) return new AgyError("timeout", `ACP ${phase} timed out: ${message}`, { cause: error });
  return new AgyError("protocol", `ACP ${phase} failed: ${message}`, { cause: error });
}

export interface TurnUpdate { sessionUpdate: string; [key: string]: unknown }

export interface AcpSessionOptions {
  bin: string;
  cwd: string;
  env: Record<string, string | undefined>;
  toolSource?: BridgeToolSource;
  onPermission?: AcpPermissionHandler;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export class AcpSession {
  readonly sessionId: string;
  readonly child: ChildProcess;
  readonly bridge: McpBridge;
  private readonly peer: AcpPeer;
  private readonly source: BridgeToolSource;
  private onPermission?: AcpPermissionHandler;
  private options: AcpConfigOption[];
  private cancelled = false;
  private updateSink?: (update: TurnUpdate) => void;
  turns = 0;
  closed = false;
  contextWindow?: number;
  lastUsage?: ReturnType<typeof normalizeAcpUsage>;

  private constructor(init: { sessionId: string; child: ChildProcess; bridge: McpBridge; peer: AcpPeer; options: AcpConfigOption[]; source: BridgeToolSource; onPermission?: AcpPermissionHandler }) {
    this.sessionId = init.sessionId;
    this.child = init.child;
    this.bridge = init.bridge;
    this.peer = init.peer;
    this.options = init.options;
    this.source = init.source;
    this.onPermission = init.onPermission;
  }

  static async create(options: AcpSessionOptions): Promise<AcpSession> {
    const source = options.toolSource ?? getAcpToolSource();
    const bridge = await startMcpBridge(source);
    let child: ChildProcess | undefined;
    let peer: AcpPeer | undefined;
    let self: AcpSession | undefined;
    let stderr = "";
    let spawnError: NodeJS.ErrnoException | undefined;
    try {
      // Google documents --process-per-session as REQUIRED for HTTP MCP servers the client configures, and --disable-telemetry.
      // No --gemini-dir / isolated home: agy uses its own cached sign-in. No --dangerously-skip-permissions: agy's
      // permission requests are answered by Pi's own approval path (session/request_permission below).
      child = spawnAgyChild(["acp", "--process-per-session", "--disable-telemetry"], options.cwd, options.env);
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-4_000); });
      peer = createJsonRpcPeer({
        input: child.stdout!,
        // A child that cannot start must fail the initialize request, not hang it.
        onClose: () => {},
        output: child.stdin!,
        onRequest: async (method, params) => method === "session/request_permission" ? await answerPermission(params, self?.onPermission ?? options.onPermission ?? permissionHandler, self?.cancelled ?? false) : null,
        onNotification: (method, params: any) => { if (method === "session/update") self?.receiveUpdate(params?.update ?? {}); },
      });
      child.once("error", (error: NodeJS.ErrnoException) => { spawnError = error; peer?.close(error); });
      const init = await peer.request<{ protocolVersion?: number; agentCapabilities?: { mcpCapabilities?: { http?: boolean } } }>(
        "initialize",
        {
          protocolVersion: 1,
          // Deliberately no fs/terminal client capabilities: agy may only act through Pi tools and Pi's approvals.
          clientCapabilities: {},
          clientInfo: { name: "steak-pi", title: "Steak Pi", version: "0.38.2" },
        },
        { signal: options.signal, timeoutMs: options.timeoutMs ?? 20_000 },
      );
      if (typeof init?.protocolVersion === "number" && init.protocolVersion > 1) {
        throw new AgyError("protocol", `ACP protocol version ${init.protocolVersion} is newer than the version Steak Pi implements (1)`);
      }
      if (!init?.agentCapabilities?.mcpCapabilities?.http) {
        throw new AgyError("protocol", "agy acp did not advertise HTTP MCP support; Steak Pi needs it for the loopback Pi-tool bridge (use --process-per-session)");
      }
      const created = await peer.request<{ sessionId?: string; configOptions?: AcpConfigOption[] }>("session/new", {
        cwd: options.cwd,
        mcpServers: [{
          type: "http",
          name: "pi-tools",
          url: bridge.url,
          headers: [{ name: "Authorization", value: `Bearer ${bridge.token}` }, { name: "Content-Type", value: "application/json" }],
        }],
      }, { signal: options.signal, timeoutMs: options.timeoutMs ?? 20_000 });
      if (!created?.sessionId) throw new AgyError("protocol", "ACP session/new returned no sessionId");
      const session = new AcpSession({ sessionId: created.sessionId, child, bridge, peer, options: created.configOptions ?? [], source, onPermission: options.onPermission });
      self = session;
      session.contextWindow = contextWindowFromOptions(session.options);
      return session;
    } catch (error) {
      peer?.close();
      if (child) await stopChild(child);
      await bridge.close();
      const named = spawnError?.code === "ENOENT" || spawnError?.code === "EACCES"
        ? new AgyError("missing", missingMessage(options.bin), { cause: spawnError })
        : acpError(error, "initialize");
      const detail = cleanAgyText(stderr, 300);
      if (detail && !named.message.includes(detail)) named.message += ` (agy said: ${detail})`;
      throw named;
    }
  }

  get configOptions(): readonly AcpConfigOption[] { return this.options; }
  get isFresh(): boolean { return this.turns === 0; }

  private receiveUpdate(update: TurnUpdate): void {
    this.updateSink?.(update);
    if (update.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions)) this.options = update.configOptions as AcpConfigOption[];
    if (update.sessionUpdate === "usage_update") {
      this.lastUsage = normalizeAcpUsage(update as never);
      if (typeof update.size === "number" && update.size > 0) this.contextWindow = update.size;
    }
  }

  private async configure(modelId: string | undefined, reasoning: string | undefined): Promise<void> {
    const sets: [string, string][] = [];
    const modelOption = this.options.find((o) => o.id === "model" || o.category === "model");
    if (modelId && modelOption?.currentValue !== modelId && modelOption?.options?.some((o) => o.value === modelId)) sets.push([modelOption.id, modelId]);
    const levelOption = this.options.find((o) => o.category === "thought_level" || /thought|reason|effort/i.test(o.id));
    const effort = effortForAcp(reasoning ?? "medium", this.options);
    if (levelOption && effort && levelOption.currentValue !== effort) sets.push([levelOption.id, effort]);
    for (const [configId, value] of sets) {
      const result = await this.peer.request<{ configOptions?: AcpConfigOption[] }>("session/set_config_option", { sessionId: this.sessionId, configId, value }, { timeoutMs: 15_000 });
      if (result?.configOptions) this.options = result.configOptions;
    }
  }

  async prompt(text: string, options: {
    modelId?: string;
    reasoning?: string;
    signal?: AbortSignal;
    onUpdate?: (update: TurnUpdate) => void;
    timeoutMs?: number;
    onPermission?: AcpPermissionHandler;
  } = {}): Promise<{ stopReason: string; usage?: ReturnType<typeof normalizeAcpUsage> }> {
    this.cancelled = false;
    this.updateSink = options.onUpdate;
    await this.configure(options.modelId, options.reasoning);
    const onAbort = () => {
      this.cancelled = true;
      this.peer.notify("session/cancel", { sessionId: this.sessionId });
    };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      this.onPermission = options.onPermission ?? this.onPermission;
      this.turns++;
      const result = await this.peer.request<{ stopReason?: string }>("session/prompt", {
        sessionId: this.sessionId,
        prompt: [{ type: "text", text }],
      }, { signal: options.signal, timeoutMs: options.timeoutMs ?? 1_800_000 });
      return { stopReason: String(result?.stopReason ?? "end_turn"), usage: this.lastUsage };
    } catch (error) {
      throw acpError(error, "prompt");
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      this.updateSink = undefined;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.peer.close();
    await stopChild(this.child);
    await this.bridge.close();
  }
}

/** Answer agy's own permission requests through Pi's approval handler; never auto-allow them here. */
async function answerPermission(params: any, handler: AcpPermissionHandler | undefined, cancelled: boolean): Promise<{ outcome: { outcome: string; optionId?: string } }> {
  const options: AcpPermissionRequest["options"] = Array.isArray(params?.options) ? params.options : [];
  if (cancelled) return { outcome: { outcome: "cancelled" } };
  const chosen = await handler?.({
    title: String(params?.toolCall?.title ?? params?.toolCall?.name ?? "agy tool permission"),
    name: params?.toolCall?.name ? String(params.toolCall.name) : undefined,
    options: options.map((o) => ({ optionId: String(o.optionId), name: o.name ? String(o.name) : undefined, kind: o.kind ? String(o.kind) : undefined })),
  });
  const selected = options.find((o) => String(o.optionId) === chosen && String(o.kind ?? "").startsWith("allow"));
  if (selected) return { outcome: { outcome: "selected", optionId: String(selected.optionId) } };
  const rejected = options.find((o) => String(o.kind ?? "").startsWith("reject"));
  return rejected ? { outcome: { outcome: "selected", optionId: String(rejected.optionId) } } : { outcome: { outcome: "cancelled" } };
}

let active: AcpSession | undefined;
let creating: Promise<AcpSession> | undefined;

/** Create lazily on first ACP inference and reuse for the whole Pi session. */
export async function getAcpSession(options: AcpSessionOptions): Promise<AcpSession> {
  if (active && !active.closed) return active;
  if (creating) return creating;
  creating = AcpSession.create(options).then((session) => { active = session; return session; }).finally(() => { creating = undefined; });
  return creating;
}

/** Branch, compaction and new session make the live ACP conversation unsafe to reuse. */
export async function resetAcpSessions(): Promise<void> {
  const closing = [active];
  active = undefined;
  if (creating) { try { closing.push(await creating); } catch { /* creation already reports its own cause */ } }
  await Promise.all(closing.filter(Boolean).map((session) => session!.close()));
}

export type { BridgeToolResult, BridgeToolSource };
