import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ preflight: vi.fn(), dispose: vi.fn(), native: vi.fn(), persistent: vi.fn() }));
vi.mock("../src/deepseek-primary.ts", () => ({ MANAGED_FLAG: "steak-dsh-managed", preflightPrimary: mocks.preflight,
  createPrimaryShell: () => ({ operations: {}, dispose: mocks.dispose }) }));
vi.mock("@earendil-works/pi-coding-agent", () => ({ createBashToolDefinition: (_cwd: string, options?: unknown) => ({
  name: "bash", description: "native bash", parameters: {}, execute: options ? mocks.persistent : mocks.native,
}) }));
import extension from "../extensions/deepseek-harness.ts";
const target = { provider: "opencode-go", id: "deepseek-v4.1-flash" };
function setup(managed = true) {
  const handlers = new Map<string, Function>();
  let tool: any;
  const ctx = { cwd: process.cwd(), model: target, shutdown: vi.fn() };
  const pi = { registerFlag: vi.fn(), getFlag: () => managed, getAllTools: () => [],
    on: (name: string, fn: Function) => handlers.set(name, fn), registerTool: (value: any) => { tool = value; } };
  extension(pi as any);
  return { handlers, ctx, getTool: () => tool };
}
beforeEach(() => {
  vi.stubEnv("STEAK_DSH_MANAGED_ROOT", process.cwd());
  mocks.preflight.mockReset().mockReturnValue([]);
  mocks.dispose.mockReset().mockResolvedValue(undefined);
  mocks.native.mockReset().mockResolvedValue({ content: [] });
  mocks.persistent.mockReset().mockResolvedValue({ content: [] });
});
afterEach(() => vi.unstubAllEnvs());
describe("managed primary extension lifecycle", () => {
  it("leaves unmanaged tool registration unchanged", async () => {
    const s = setup(false); await s.handlers.get("session_start")!({}, s.ctx);
    expect(s.getTool()).toBeUndefined(); expect(mocks.preflight).not.toHaveBeenCalled();
  });
  it("uses persistent operations only on the exact route and native fallback otherwise", async () => {
    const s = setup(); await s.handlers.get("session_start")!({}, s.ctx);
    await s.getTool().execute("target", {}, undefined, undefined, s.ctx);
    expect(mocks.persistent).toHaveBeenCalledTimes(1);
    await s.getTool().execute("other", {}, undefined, undefined, { ...s.ctx, model: { ...target, provider: "other" } });
    expect(mocks.native).toHaveBeenCalledTimes(1); expect(mocks.dispose).toHaveBeenCalledTimes(1);
  });
  it("cleans on model/session transitions and shutdown", async () => {
    const s = setup(); await s.handlers.get("session_start")!({}, s.ctx);
    for (const event of ["model_select", "session_before_switch", "session_before_fork", "session_before_tree", "session_shutdown"]) await s.handlers.get(event)!({}, s.ctx);
    expect(mocks.dispose).toHaveBeenCalledTimes(5);
  });
  it("blocks all future tools and requests shutdown when a later admission fails", async () => {
    const s = setup(); await s.handlers.get("session_start")!({}, s.ctx);
    mocks.preflight.mockImplementation(() => { throw new Error("foreign guard detected"); });
    await expect(s.handlers.get("session_start")!({}, s.ctx)).rejects.toThrow("foreign guard");
    expect(s.ctx.shutdown).toHaveBeenCalledTimes(1);
    expect(s.handlers.get("tool_call")!({}, s.ctx)).toEqual({ block: true, reason: "foreign guard detected" });
  });
  it("fails closed when shell cleanup cannot be confirmed", async () => {
    const s = setup(); await s.handlers.get("session_start")!({}, s.ctx);
    mocks.dispose.mockRejectedValue(new Error("exit unconfirmed"));
    await expect(s.handlers.get("model_select")!({}, s.ctx)).rejects.toThrow("exit unconfirmed");
    expect(s.ctx.shutdown).toHaveBeenCalledTimes(1);
    expect(s.handlers.get("tool_call")!({}, s.ctx).block).toBe(true);
  });
});
