// The ACP prompt turn outlives individual Pi provider steps. A parked MCP call is handed to the active step as a
// normal Pi toolCall; the toolResult that Pi appends on the next step is what finally answers that MCP request.
import type { BridgeCallRequest, BridgeTool, BridgeToolResult, BridgeToolSource } from "./mcp-bridge.ts";

export interface TurnUpdate { sessionUpdate: string; [key: string]: unknown }

export interface ParkedCall extends BridgeCallRequest {
  step: number;
  emitted: boolean;
  answered: boolean;
  resolve(result: BridgeToolResult): void;
  reject(error: unknown): void;
}

export const toolError = (text: string): BridgeToolResult => ({ content: [{ type: "text", text }], isError: true });

export class AcpTurn {
  readonly updates: TurnUpdate[] = [];
  readonly calls = new Map<string, ParkedCall>();
  /** Number of updates already delivered to the Pi stream (survives step boundaries). */
  consumed = 0;
  step = 0;
  cancelled = false;
  settled = false;
  readonly onCall: (call: ParkedCall) => void = (call) => { this.pendingCalls.push(call); this.callHandler?.(call); };
  private readonly pendingCalls: ParkedCall[] = [];
  private callHandler?: (call: ParkedCall) => void;
  private readonly listeners = new Set<(update: TurnUpdate) => void>();
  private resolveEnd!: (result: { stopReason?: string; error?: unknown }) => void;
  private readonly end = new Promise<{ stopReason?: string; error?: unknown }>((resolve) => { this.resolveEnd = resolve; });

  subscribe(listener: (update: TurnUpdate) => void, from = this.consumed): () => void {
    for (let i = from; i < this.updates.length; i++) listener(this.updates[i]);
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  setCallHandler(handler: (call: ParkedCall) => void | undefined): void { this.callHandler = handler; }
  emit(update: TurnUpdate): void {
    this.updates.push(update);
    for (const listener of this.listeners) listener(update);
  }
  takePendingCalls(): ParkedCall[] { return this.pendingCalls.splice(0); }
  settle(result: { stopReason?: string; error?: unknown }): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveEnd(result);
  }
  waitForEnd(): Promise<{ stopReason?: string; error?: unknown }> { return this.end; }
  /** Answer every still-parked MCP request with a tool error, so agy's HTTP client is never left hanging. */
  failCalls(message: string): void {
    for (const call of this.calls.values()) if (!call.answered) call.resolve(toolError(message));
  }
  hasUnansweredCalls(): boolean { return [...this.calls.values()].some((call) => !call.answered); }
  answer(id: string, result: BridgeToolResult): boolean {
    const call = this.calls.get(id);
    if (!call || call.answered) return false;
    call.resolve(result);
    return true;
  }
}


export class AcpToolLoop {
  tools: BridgeTool[] = [];
  turn?: AcpTurn;
  private cancelTurn?: () => void;

  setCanceller(cancel: () => void): void { this.cancelTurn = cancel; }
  setTools(tools: BridgeTool[]): void { this.tools = tools; }
  source(): BridgeToolSource {
    return { list: () => this.tools, call: (request) => this.park(request) };
  }
  startTurn(): AcpTurn {
    const turn = new AcpTurn();
    this.turn = turn;
    return turn;
  }
  /** Abort/close: cancel ACP and give every parked call an error result. */
  cancel(message: string): void {
    const turn = this.turn;
    if (!turn || turn.cancelled) return;
    turn.cancelled = true;
    turn.failCalls(message);
    this.cancelTurn?.();
  }
  clear(): void { this.turn?.failCalls("ACP session ended"); this.turn = undefined; }

  private park(request: BridgeCallRequest): Promise<BridgeToolResult> {
    const turn = this.turn;
    if (!turn) return Promise.reject(new Error(`Pi tool ${request.name} is unavailable: no ACP turn is active`));
    return new Promise<BridgeToolResult>((resolve, reject) => {
      const call: ParkedCall = {
        ...request,
        step: turn.step,
        emitted: false,
        answered: false,
        resolve: (result) => { if (call.answered) return; call.answered = true; resolve(result); },
        reject: (error) => { if (call.answered) return; call.answered = true; reject(error); },
      };
      call.signal.addEventListener("abort", () => call.reject(call.signal.reason ?? new Error("MCP client closed the tool call")), { once: true });
      turn.calls.set(call.id, call);
      turn.onCall(call);
    });
  }
}
