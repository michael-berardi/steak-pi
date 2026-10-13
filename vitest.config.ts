import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Tests never read the operator's real ~/.config/ultraterm (routing.json, harness
// manifests), ~/.pi (paid-routes.json) or ~/.claude: a private empty HOME per run
// keeps the gate identical on every machine. Before this, a live routing.json
// naming a Go profile made 49 tests fail on the operator's own computer.
const home = mkdtempSync(join(tmpdir(), "steak-pi-vitest-home-"));
process.on("exit", () => { try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ } });

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    env: {
      // Keep unit tests hermetic: no cross-process slot files, default caps.
      STEAK_PI_USAP_MACHINE: "off",
      HOME: home,
    },
  },
});
