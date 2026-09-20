import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type PanelFactory = Extract<Parameters<ExtensionContext["ui"]["setWidget"]>[1], (...args: any[]) => any>;
export type PanelId = "subagents" | "todo";
const ORDER: readonly PanelId[] = ["subagents", "todo"];
const KEY = Symbol.for("steak-pi.pinned-panels.v2");
type Entry = { factory: PanelFactory; signature?: string };
type State = { panels: Map<PanelId, Entry>; requestRender?: () => void; disposeChild?: (id: PanelId) => void; dispose?: () => void };
type Registry = WeakMap<object, State>;
const shared = globalThis as typeof globalThis & { [KEY]?: Registry };
const registry = shared[KEY] ??= new WeakMap();

/** Stable native widget: progress updates invalidate it, never remove/reinsert it.
 * Signatures describe visible data, suppressing token-only/no-op repaint churn. */
export function setPinnedPanel(ctx: ExtensionContext, id: PanelId, factory: PanelFactory | undefined, signature?: string): void {
  const ui = ctx.ui;
  if (typeof ui.setWidget !== "function") return;
  let state = registry.get(ui);
  const previous = state?.panels.get(id);
  if (!factory && !previous) return;
  if (factory && previous && (signature !== undefined ? signature === previous.signature : factory === previous.factory)) return;
  const fresh = !state;
  if (!state) { state = { panels: new Map() }; registry.set(ui, state); }
  state.disposeChild?.(id);
  if (factory) state.panels.set(id, { factory, signature }); else state.panels.delete(id);
  if (!state.panels.size) {
    state.dispose?.();
    ui.setWidget("steak-pinned-panels", undefined);
    registry.delete(ui);
    return;
  }
  if (!fresh) { state.requestRender?.(); return; }
  // One-time migration from the legacy independent widget, not every update.
  ui.setWidget("usap-progress", undefined);
  const current = state;
  ui.setWidget("steak-pinned-panels", (tui, theme) => {
    current.dispose?.();
    const children = new Map<PanelId, { factory: PanelFactory; component: ReturnType<PanelFactory> }>();
    let disposed = false;
    const disposeChild = (id: PanelId) => { children.get(id)?.component.dispose?.(); children.delete(id); };
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      for (const id of children.keys()) disposeChild(id);
      // A late native disposer must never detach a newer mount's callbacks.
      if (current.dispose === dispose) {
        current.dispose = undefined; current.disposeChild = undefined; current.requestRender = undefined;
      }
    };
    current.dispose = dispose;
    current.disposeChild = disposeChild;
    current.requestRender = () => tui.requestRender?.();
    return {
      render(width: number): string[] {
        if (disposed) return [];
        const rows: string[] = [];
        for (const id of ORDER) {
          const entry = current.panels.get(id);
          let child = children.get(id);
          if (child && child.factory !== entry?.factory) { child.component.dispose?.(); children.delete(id); child = undefined; }
          if (!entry) continue;
          if (!child) { child = { factory: entry.factory, component: entry.factory(tui, theme) }; children.set(id, child); }
          rows.push(...child.component.render(width));
        }
        return rows;
      },
      invalidate() { for (const child of children.values()) child.component.invalidate(); },
      dispose,
    };
  }, { placement: "aboveEditor" });
}
