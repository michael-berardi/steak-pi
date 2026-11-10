import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// P-1553 regression: a print-mode `pi -p` run must return its answer and then
// exit on its own, even when the transport that carried the answer stays open.
// The report that opened P-1553 was "returned its answer but stayed alive until
// timeout", with and without extensions, so the bound has to sit far below any
// keep-alive or idle TTL a transport could hold (the longest one in the shipped
// Pi SDK is a 5-minute WebSocket session-cache idle timer).
//
// Hermetic: an OpenAI-compatible stub stands in for the model, so the check
// needs no live route, no network and no operator config. Three teardown paths
// are covered: plain text, a transport that never closes its response after the
// answer, and JSON mode (which also tears down the stdout backpressure
// subscription).
//
// Sensitivity: the same spawn with an extension that arms a 5-minute timer after
// the answer fails this deadline, so a leaked handle cannot pass it.

const EXIT_DEADLINE_MS = 25_000;
const ANSWER = "PRINT_EXIT_OK";
// Hermetic by default: the repo's own pinned Pi CLI from devDependencies, never
// the operator's managed wrapper or installed package. STEAK_PI_TEST_PI_BIN is
// the test-only switch for running the check against another Pi build by hand.
const localPi = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", ".bin", "pi");
const piBin = process.env.STEAK_PI_TEST_PI_BIN ?? (existsSync(localPi) ? localPi : "pi");

type StubMode = "clean" | "held-open";

let server: Server;
let baseUrl = "";
let home = "";
let stubMode: StubMode = "clean";
const openSockets = new Set<Socket>();

function sseBody(answer: string): string {
  const chunk = (delta: object, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "stub-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  return `${chunk({ role: "assistant", content: answer })}${chunk({}, "stop")}data: [DONE]\n\n`;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      if (req.method === "GET" && req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "stub-model", object: "model" }] }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(sseBody(ANSWER));
      if (stubMode === "clean") {
        res.end();
      }
      // "held-open": the answer and [DONE] are sent, the response never ends. A
      // run that waits for the connection instead of its own event loop exits
      // only at the deadline, which is exactly the P-1553 symptom.
    });
  });
  server.on("connection", (socket) => {
    openSockets.add(socket);
    socket.on("close", () => openSockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("stub server did not bind");
  baseUrl = `http://127.0.0.1:${addr.port}/v1`;

  home = mkdtempSync(join(tmpdir(), "steak-pi-print-exit-"));
  const agent = join(home, ".pi", "agent");
  mkdirSync(agent, { recursive: true });
  writeFileSync(
    join(agent, "models.json"),
    JSON.stringify({
      providers: {
        stub: { baseUrl, api: "openai-completions", apiKey: "stub-key", models: [{ id: "stub-model" }] },
      },
    }),
  );
});

afterAll(async () => {
  for (const socket of openSockets) socket.destroy();
  openSockets.clear();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (home) rmSync(home, { recursive: true, force: true });
});

interface RunResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  elapsedMs: number;
}

async function runPrintMode(args: string[]): Promise<RunResult> {
  const started = Date.now();
  const result = await new Promise<Omit<RunResult, "elapsedMs">>((resolve) => {
    const child = spawn(piBin, args, {
      env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ code: null, signal: "SIGKILL", stdout, stderr, timedOut: true });
    }, EXIT_DEADLINE_MS);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut: false });
    });
  });
  return { ...result, elapsedMs: Date.now() - started };
}

function expectCleanExit(result: RunResult): void {
  expect(result.timedOut, `pi -p did not exit within ${EXIT_DEADLINE_MS} ms (stderr: ${result.stderr.slice(0, 300)})`).toBe(false);
  expect(result.code, `pi -p exited with ${result.code ?? result.signal}: ${result.stderr.slice(0, 300)}`).toBe(0);
  expect(result.stdout).toContain(ANSWER);
  expect(result.elapsedMs).toBeLessThan(EXIT_DEADLINE_MS);
}

describe("print-mode exit (P-1553)", () => {
  it("returns the answer and exits on its own within a bounded time", async () => {
    stubMode = "clean";
    expectCleanExit(await runPrintMode(["-p", "--no-extensions", "--no-tools", "--model", "stub/stub-model", "Reply with the marker."]));
  }, EXIT_DEADLINE_MS + 15_000);

  it("exits when the transport holds its response open after the answer", async () => {
    stubMode = "held-open";
    try {
      expectCleanExit(await runPrintMode(["-p", "--no-extensions", "--no-tools", "--model", "stub/stub-model", "Reply with the marker."]));
    } finally {
      stubMode = "clean";
    }
  }, EXIT_DEADLINE_MS + 15_000);

  it("exits after a JSON-mode run", async () => {
    stubMode = "clean";
    expectCleanExit(await runPrintMode(["-p", "--mode", "json", "--no-extensions", "--no-tools", "--model", "stub/stub-model", "Reply with the marker."]));
  }, EXIT_DEADLINE_MS + 15_000);
});
