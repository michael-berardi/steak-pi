import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_TASKS = 8;
const MAX_CONCURRENCY = 4;
const OUTPUT_LIMIT = 20_000;

type Task = { label: string; task: string };
type Result = {
  label: string;
  ok: boolean;
  output: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
};

function invocation(args: string[]): { command: string; args: string[] } {
  const script = process.argv[1];
  if (script && !script.startsWith("/$bunfs/root/") && fs.existsSync(script)) {
    return { command: process.execPath, args: [script, ...args] };
  }
  const executable = path.basename(process.execPath).toLowerCase();
  return /^(node|bun)(\.exe)?$/.test(executable)
    ? { command: "pi", args }
    : { command: process.execPath, args };
}

function text(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: string; text: string } =>
      typeof item === "object" &&
      item !== null &&
      "type" in item &&
      item.type === "text" &&
      "text" in item &&
      typeof item.text === "string",
    )
    .map((item) => item.text)
    .join("");
}

async function runTask(
  task: Task,
  cwd: string,
  model: string | undefined,
  thinking: string | undefined,
  signal: AbortSignal | undefined,
): Promise<Result> {
  const args = [
    "--mode", "json", "--print", "--no-session", "--no-extensions",
    "--tools", "read,bash,edit,write,grep,find,ls",
  ];
  if (model) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);
  args.push(
    "--append-system-prompt",
    "You are one bounded parallel worker. Work only on your assigned slice and files. Keep changes minimal, do not modify tests, and report changed paths plus focused verification.",
    `Task: ${task.task}`,
  );
  const launch = invocation(args);
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let output = "";
  let failed = false;
  let stderr = "";

  await new Promise<void>((resolve) => {
    const child = spawn(launch.command, launch.args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffer = "";
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
          output = text(event.message.content) || output;
          const current = event.message.usage;
          if (current) {
            usage.input += current.input || 0;
            usage.output += current.output || 0;
            usage.cacheRead += current.cacheRead || 0;
            usage.cacheWrite += current.cacheWrite || 0;
            usage.cost += current.cost?.total || 0;
          }
          failed ||= event.message.stopReason === "error" || event.message.stopReason === "aborted";
        } catch {
          // Pi JSONL may contain a partial final line until the next chunk.
        }
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => { failed = true; stderr += error.message; resolve(); });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      failed ||= code !== 0;
      resolve();
    });
  });

  const fallback = stderr.trim().split("\n").at(-1) || "Worker returned no final output.";
  return {
    label: task.label,
    ok: !failed,
    output: (output || fallback).slice(-OUTPUT_LIMIT),
    usage,
  };
}

export default function parallelExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "parallel",
    label: "Parallel",
    description: "Run 2-8 genuinely independent coding tasks concurrently (maximum four at once). Assign disjoint file ownership; the parent integrates and verifies.",
    parameters: Type.Object({
      tasks: Type.Array(
        Type.Object({
          label: Type.String({ minLength: 1, maxLength: 48 }),
          task: Type.String({ minLength: 1, maxLength: 8_000 }),
        }),
        { minItems: 2, maxItems: MAX_TASKS },
      ),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const tasks = params.tasks as Task[];
      const results: Result[] = new Array(tasks.length);
      let cursor = 0;
      let complete = 0;
      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const runNext = async (): Promise<void> => {
        while (cursor < tasks.length) {
          const index = cursor++;
          results[index] = await runTask(tasks[index]!, ctx.cwd, model, ctx.thinkingLevel, signal);
          complete += 1;
          onUpdate?.({
            content: [{ type: "text", text: `${complete}/${tasks.length} parallel tasks complete` }],
            details: { results: results.filter(Boolean) },
          });
        }
      };
      await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, tasks.length) }, runNext));
      const rendered = results
        .map((result) => `[${result.label}] ${result.ok ? "completed" : "failed"}\n${result.output}`)
        .join("\n\n");
      return {
        content: [{ type: "text", text: rendered }],
        details: { mode: "parallel", results },
        isError: results.some((result) => !result.ok),
      };
    },
  });
}
