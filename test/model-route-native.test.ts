import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { guardModelRuntime } from "../src/model-route-policy.js";

// Pi 0.85's root export references optional pi-server; use the same native
// ModelRuntime module as the worker, without adding that unrelated dependency.
const sdkPackage = findPackageJSON("@earendil-works/pi-coding-agent", import.meta.url)!;
const { ModelRuntime } = await import(
  pathToFileURL(join(dirname(sdkPackage), "dist/core/model-runtime.js")).href
) as Pick<typeof import("@earendil-works/pi-coding-agent"), "ModelRuntime">;

const PNG = "iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAIAAAAC64paAAAAKklEQVR4nGP8z0A+YKJAL8OoZhIBE6kakMGoZhIBE6kakMGoZhIBRQEGACKcAScj7Xy0AAAAAElFTkSuQmCC";
type Source = "extension" | "models" | "model-api";

async function probe(source: Source, provider = "policy-test", allowed = false, alias = false) {
  const root = resolve(import.meta.dirname, "..");
  const temp = await mkdtemp(join(tmpdir(), "steak-route-denial-"));
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    if (!allowed) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "synthetic loopback denial fixture" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "qa", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "qa", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing probe listener");
    const id = alias ? "opaque-alias" : allowed ? "glm-5.3-flash" : provider === "openrouter" ? "openai/gpt-4o" : "gpt-6-astra";
    const expectedApi = source === "model-api" ? "openai-responses" : "openai-completions";
    const config = {
      baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "not-a-real-credential",
      api: "openai-completions", models: [{ id, api: expectedApi, name: allowed ? "GLM-5.3 Flash" : "GPT-6 Astra",
        reasoning: false, input: ["text", "image"], contextWindow: 32000, maxTokens: 100,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],

    };
    const extensions: string[] = [];
    if (source === "extension") {
      const fixture = join(temp, "fixture.ts");
      await writeFile(fixture, `export default function(pi) { pi.registerProvider(${JSON.stringify(provider)}, ${JSON.stringify(config)}); }`);
      extensions.push("--extension", fixture);
    } else {
      await writeFile(join(temp, "models.json"), JSON.stringify({ providers: { [provider]: config } }));
    }
    const observedApi = join(temp, "observed-api.txt");
    const inspection = join(temp, "inspect-api.ts");
    await writeFile(inspection, `import {writeFileSync} from 'node:fs'; export default function(pi) { pi.on('before_agent_start', (_, ctx) => writeFileSync(${JSON.stringify(observedApi)}, ctx.modelRegistry.find(${JSON.stringify(provider)}, ${JSON.stringify(id)})?.api ?? 'missing')); }`);
    extensions.push("--extension", inspection);
    await writeFile(join(temp, "settings.json"), JSON.stringify({
      enableInstallTelemetry: false, defaultProjectTrust: "never", retry: { enabled: false },
    }));
    const attachment: string[] = [];
    if (allowed) {
      const image = join(temp, "pixel.png");
      await writeFile(image, Buffer.from(PNG, "base64"));
      attachment.push(`@${image}`);
    }
    const pending = promisify(execFile)(join(root, "node_modules/.bin/pi"), [
      "--offline", "--no-session", "--mode", "json", "--no-extensions", ...extensions,
      "--extension", join(root, "extensions/model-route-policy.ts"),
      "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-tools",
      "--model", `${provider}/${id}`, "--print", ...attachment, "Reply OK",
    ], {
      cwd: temp, timeout: 45000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: temp, PI_CODING_AGENT_DIR: temp, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    });
    pending.child.stdin?.end();
    const { stdout } = await pending;
    const terminal = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line))
      .filter((event) => event.type === "message_end" && event.message?.role === "assistant");
    expect(terminal).toHaveLength(1);
    expect(await readFile(observedApi, "utf8")).toBe(expectedApi);
    return { message: terminal[0].message, requests };
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await rm(temp, { recursive: true, force: true });
  }
}

it.each([
  ["extension", "policy-test", false],
  ["models", "policy-test", false],
  ["model-api", "policy-test", false],
  ["models", "openai-codex", false],
  ["model-api", "openai-codex", false],
  ["model-api", "openrouter", false],
  ["models", "policy-test", true],
] as const)("native Pi denies GPT before network through %s / %s (alias %s)", async (source, provider, alias) => {
  const { message, requests } = await probe(source, provider, false, alias);
  expect(message.stopReason).toBe("error");
  expect(message.errorMessage).toContain("paid openai-codex");
  expect(requests).toHaveLength(0);
}, 60000);

it("re-guards the native worker runtime after a real model API refresh", async () => {
  const temp = await mkdtemp(join(tmpdir(), "steak-runtime-refresh-"));
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.writeHead(400); res.end("fixture"); });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing listener");
    const modelsPath = join(temp, "models.json");
    const configure = (api: string) => writeFile(modelsPath, JSON.stringify({ providers: { openrouter: {
      apiKey: "not-a-real-credential", baseUrl: `http://127.0.0.1:${address.port}`,
      models: [{ id: "openai/gpt-4o", api }],
    } } }));
    await configure("openai-completions");
    const runtime = await ModelRuntime.create({ modelsPath, authPath: join(temp, "auth.json"),
      modelsStorePath: join(temp, "models-store.json"), allowModelNetwork: false });
    for (const api of ["openai-completions", "openai-responses"]) {
      await configure(api);
      await runtime.refresh({ allowNetwork: false });
      guardModelRuntime(runtime); // Same boundary used after creation and each worker turn.
      const model = runtime.getModel("openrouter", "openai/gpt-4o")!;
      expect(model.api).toBe(api);
      const result = await runtime.completeSimple(model, { messages: [{ role: "user", content: "OK", timestamp: Date.now() }] });
      expect(result.errorMessage).toContain("paid openai-codex");
      expect(requests).toBe(0);
    }
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
    await rm(temp, { recursive: true, force: true });
  }
}, 60000);

it("preserves allowed GLM-style model dispatch and image_url serialization through models.json", async () => {
  const { message, requests } = await probe("models", "policy-test", true);
  expect(message.stopReason).toBe("stop");
  expect(message.content.some((part: any) => part.type === "text" && part.text === "OK")).toBe(true);
  expect(requests).toHaveLength(1);
  const images = requests[0].messages.flatMap((m: any) => Array.isArray(m.content) ? m.content : [])
    .filter((part: any) => part.type === "image_url");
  expect(images).toHaveLength(1);
  expect(images[0].image_url.url).toMatch(/^data:image\/png;base64,/);
}, 60000);
