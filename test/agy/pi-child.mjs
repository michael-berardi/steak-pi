// Stands in for Pi in the signal test: starts one agy turn (the fake) and waits. It installs no signal handler of its own.
import { runAgy } from "../../extensions/agy/process.ts";
void runAgy({ args: ["--input-format", "stream-json", "--output-format", "stream-json"], input: '{"event":"user","message":{"content":"go"}}\n', cwd: process.cwd(), timeoutMs: 60_000 });
setInterval(() => {}, 1000);
