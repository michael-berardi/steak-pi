import { chmodSync, renameSync, writeFileSync } from "node:fs";

/** A stand-in Claude Code CLI that answers the model-catalog probe with `ids`, or exits 1 when `ids` is "fail". */
export function writeFakeClaude(path: string, ids: readonly string[] | "fail"): void {
  const models = ids === "fail" ? [] : ids.map((id) => ({ value: id, displayName: id, description: `${id} test model` }));
  const body = ids === "fail"
    ? `process.stderr.write("catalog probe refused\\n"); process.exit(1);`
    : `import { createInterface } from "node:readline";
for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const frame = JSON.parse(line);
  if (frame.type === "control_request" && frame.request?.subtype === "initialize") {
    console.log(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: frame.request_id, response: { models: ${JSON.stringify(models)} } } }));
  } else if (frame.shouldQuery === false) {
    console.log(JSON.stringify({ type: "result", num_turns: 0 }));
  }
}`;
  // Written whole, then renamed: a discovery already running never executes half a script.
  writeFileSync(`${path}.tmp`, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(`${path}.tmp`, 0o755);
  renameSync(`${path}.tmp`, path);
}
