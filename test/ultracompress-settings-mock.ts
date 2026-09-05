import { vi } from "vitest";

// Extension registration normally reads/scaffolds home settings and probes bins.
// Keep both the existing module tests and request tests entirely in memory.
vi.mock("../extensions/ultracompress/src/settings.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../extensions/ultracompress/src/settings.ts")>();
  return {
    ...actual,
    loadSettings: vi.fn(() => structuredClone(actual.DEFAULT_SETTINGS)),
    resolveUltraCompressBin: vi.fn(() => "mock-ultracompress"),
  };
});
