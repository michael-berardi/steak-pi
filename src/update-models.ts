// `steak-pi update --models`: refresh Pi's cached model catalogs, including the providers extensions register.
// Runs the installed Pi headless (RPC mode, no prompt, no session file) with the operator's own packages loaded
// plus src/model-refresh-extension.ts, which forces the refresh once every provider is registered.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatModelRefreshReport, RESULT_ENV, type ModelRefreshReport } from "./model-refresh-extension.ts";

const EXTENSION = join(dirname(fileURLToPath(import.meta.url)), "model-refresh-extension.ts");

export interface UpdateModelsOptions {
  /** The Pi executable; `pi` on PATH by default. */
  pi?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  write?: (line: string) => void;
  writeError?: (line: string) => void;
}

/** Returns the process exit code: 0 when every provider that was fetched refreshed, 1 otherwise. */
export async function updateModels(options: UpdateModelsOptions = {}): Promise<number> {
  const write = options.write ?? ((line: string) => console.log(line));
  const writeError = options.writeError ?? ((line: string) => console.error(line));
  const directory = mkdtempSync(join(tmpdir(), "steak-pi-models-"));
  const resultPath = join(directory, "result.json");
  const child = spawn(options.pi ?? "pi", ["--mode", "rpc", "--no-session", "--no-approve", "-e", EXTENSION], {
    env: { ...(options.env ?? process.env), [RESULT_ENV]: resultPath },
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => (stderr = (stderr + chunk).slice(-2_000)));
  child.stdin.on("error", () => {});
  let exited: string | undefined;
  child.on("error", (error) => (exited = `could not start pi: ${error.message}`));
  child.on("exit", (code, signal) => (exited ??= `pi exited (${signal ?? code}) before the refresh finished`));
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
    const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const wait = (ms: number) => Promise.race([gone.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms).unref())]);
    child.stdin.end(); // RPC mode shuts down cleanly when its input ends.
    if (await wait(5_000)) return;
    child.kill("SIGTERM");
    if (await wait(3_000)) return;
    child.kill("SIGKILL");
  };
  try {
    const deadline = Date.now() + (options.timeoutMs ?? 120_000);
    while (!existsSync(resultPath)) {
      if (exited) {
        // The result may have landed between the check and the exit.
        if (existsSync(resultPath)) break;
        writeError(`steak-pi: model catalogs were not refreshed: ${exited}.`);
        if (stderr.trim()) writeError(stderr.trim());
        return 1;
      }
      if (Date.now() > deadline) {
        writeError("steak-pi: model catalogs were not refreshed: pi did not finish the refresh in time.");
        return 1;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const report = JSON.parse(readFileSync(resultPath, "utf8")) as ModelRefreshReport;
    for (const line of formatModelRefreshReport(report)) write(line);
    if (!report.ok) {
      writeError("steak-pi: some model catalogs were not refreshed (see FAILED above).");
      return 1;
    }
    write("Model catalogs refreshed. Running Pi sessions pick them up on /reload or restart.");
    return 0;
  } finally {
    await stop();
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await updateModels();
}
