// `steak-pi routing check [file]`: validate a routing.json with the exact parser every Pi turn uses, so a writer can
// refuse a bad file before it lands. 2026-11-08: a retune appended evidence to taskClasses notes (727 > 400 characters)
// and every pane failed on its next turn.
import { readFileSync } from "node:fs";
import { parseRoutingConfig, routingConfigPath } from "./routing-config.ts";

const path = process.argv[2] ?? routingConfigPath();
try {
  parseRoutingConfig(JSON.parse(readFileSync(path, "utf8")));
  console.log(`ok ${path}`);
} catch (error) {
  console.error(`steak-pi routing check: ${path}: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
