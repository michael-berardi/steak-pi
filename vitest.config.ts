import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests never read the operator's real ~/.config/ultraterm (routing.json, harness
// manifests), ~/.pi (paid-routes.json) or ~/.claude: a private empty HOME per run
// keeps the gate identical on every machine. Before this, a live routing.json
// naming a Go profile made 49 tests fail on the operator's own computer.
const home = mkdtempSync(join(tmpdir(), "steak-pi-vitest-home-"));
process.on("exit", () => { try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ } });
// Steak Pi ships no routing choice of its own. The suite runs against one synthetic
// operator fixture (the former built-in chains, profiles and reviewed paid routes) so
// behavioral tests keep exercising real chains; neutral-defaults.test.ts and
// neutrality.test.ts cover the empty configuration and the shipped files.
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "test", "fixtures");

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Transport fixtures start native processes with short idle deadlines.
    // Bound file fan-out so host CPU count cannot turn startup contention into
    // false protocol timeouts (individual fixtures still exercise concurrency).
    maxWorkers: 2,
    env: {
      // Keep unit tests hermetic: no cross-process slot files, default caps.
      STEAK_PI_USAP_MACHINE: "off",
      HOME: home,
      STEAK_PI_ROUTING_CONFIG: join(fixtures, "routing.json"),
      STEAK_PI_PAID_ROUTES: join(fixtures, "paid-routes.json"),
      // The task-class router's evidence store is a state file: tests write theirs under the private HOME.
      STEAK_PI_ROUTE_EVIDENCE: join(home, "route-evidence.jsonl"),
    },
  },
});
