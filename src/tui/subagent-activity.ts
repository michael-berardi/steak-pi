// The coordinator remains the source of truth; this bridge only exposes its live count.
let read = () => 0;
const listeners = new Set<() => void>();
export function getSubagentCount(): number { return read(); }
export function setSubagentCountReader(reader: () => number): void { read = reader; }
export function subagentActivityChanged(): void { for (const listener of listeners) { try { listener(); } catch { /* observation is non-owning */ } } }
export function onSubagentActivityChanged(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
