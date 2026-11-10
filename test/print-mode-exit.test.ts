import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// P-1553 regression: a print-mode `pi -p` run must return its answer and exit on
// its own within a bounded time. A hermetic OpenAI-compatible stub stands in for
// the model, so the check needs no live route, no network and no operator config.

const EXIT_DEADLINE_MS = 60_000;
const ANSWER = "PRINT_EXIT_OK";
const piBin = process.env.STEAK_PI_TEST_PI_BIN ?? "pi";

let server: Server;
let baseUrl = "";
let home = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "GET" && req.url?.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "stub-model", object: "model" }] }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: object, finish: string | null = null) =>
        `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "stub-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.write(chunk({ role: "assistant", content: ANSWER }));
      res.write(chunk({}, "stop"));
      res.write("data: [DONE]\n\n");
      res.end();
    });
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
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (home) rmSync(home, { recursive: true, force: true });
});

describe("print-mode exit (P-1553)", () => {
  it("returns the answer and exits on its own within a bounded time", async () => {
    const started = Date.now();
    const result = await new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string; timedOut: boolean }>((resolve) => {
      const child = spawn(piBin, ["-p", "--no-extensions", "--no-tools", "--model", "stub/stub-model", "Reply with the marker."], {
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
    const elapsed = Date.now() - started;

    expect(result.timedOut, `pi -p did not exit within ${EXIT_DEADLINE_MS} ms (stderr: ${result.stderr.slice(0, 300)})`).toBe(false);
    expect(result.code, `pi -p exited with ${result.code ?? result.signal}: ${result.stderr.slice(0, 300)}`).toBe(0);
    expect(result.stdout).toContain(ANSWER);
    expect(elapsed).toBeLessThan(EXIT_DEADLINE_MS);
  }, EXIT_DEADLINE_MS + 15_000);
});
