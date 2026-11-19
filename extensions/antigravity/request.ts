// Pi transcript -> Cloud Code Assist request. Pure: no I/O, so every mapping rule is testable on its own.
import { randomUUID } from "node:crypto";
import { collapseSystemMessages, getCurrentSystemPrompt, getCurrentTools, type Model, type SimpleStreamOptions, type ThinkingLevel, type TranscriptContext } from "@earendil-works/pi-ai";
import { AntigravityError } from "./errors.ts";

type Part = Record<string, unknown>;
interface Content { role: "user" | "model"; parts: Part[] }

/** Thinking budget in tokens for each Pi level. A caller's `thinkingBudgets` replaces any of them. */
const LEVEL_BUDGET: Record<ThinkingLevel, number> = { minimal: 1024, low: 2048, medium: 8192, high: 16384, xhigh: 32768, max: 32768 };

function push(contents: Content[], role: Content["role"], parts: Part[]): void {
  if (parts.length === 0) return;
  const last = contents[contents.length - 1];
  // The API wants alternating turns, and all the answers to one round of tool calls in one user turn.
  if (last && last.role === role) last.parts.push(...parts);
  else contents.push({ role, parts });
}

function imagePart(model: Model<any>, block: { data: string; mimeType: string }): Part {
  if (!model.input.includes("image")) {
    throw new AntigravityError("unsupported", `Model ${model.id} does not accept images (the provider lists it as text-only). Remove the image or pick a model that accepts images`);
  }
  if (!block.data || !block.mimeType) throw new AntigravityError("unsupported", "An image in the conversation has no data or no MIME type, so it cannot be sent");
  return { inlineData: { mimeType: block.mimeType, data: block.data } };
}

export function buildContents(model: Model<any>, context: TranscriptContext): Content[] {
  const contents: Content[] = [];
  for (const message of context.messages) {
    if (message.role === "user") {
      const blocks = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
      push(contents, "user", blocks.flatMap((block): Part[] => block.type === "text" ? (block.text ? [{ text: block.text }] : []) : [imagePart(model, block)]));
    } else if (message.role === "assistant") {
      // A turn that failed or was cut short is not history the provider ever completed.
      if (message.stopReason === "error" || message.stopReason === "aborted") continue;
      const parts: Part[] = [];
      for (const block of message.content) {
        if (block.type === "text") { if (block.text) parts.push({ text: block.text, ...(block.textSignature ? { thoughtSignature: block.textSignature } : {}) }); }
        // Thinking is replayed only when this provider signed it; another provider's reasoning is not ours to vouch for.
        else if (block.type === "thinking") { if (block.thinkingSignature && block.thinking) parts.push({ text: block.thinking, thought: true, thoughtSignature: block.thinkingSignature }); }
        else parts.push({ functionCall: { id: block.id, name: block.name, args: block.arguments }, ...(block.thoughtSignature ? { thoughtSignature: block.thoughtSignature } : {}) });
      }
      push(contents, "model", parts);
    } else if (message.role === "toolResult") {
      const text = message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
      const images = message.content.flatMap((block) => block.type === "image" ? [imagePart(model, block)] : []);
      push(contents, "user", [{ functionResponse: { id: message.toolCallId, name: message.toolName, response: message.isError ? { error: text } : { output: text } } }, ...images]);
    }
  }
  return contents;
}

export interface BuiltRequest { envelope: Record<string, unknown>; imageCount: number }

export function buildRequest(model: Model<any>, context: TranscriptContext, projectId: string, options: SimpleStreamOptions | undefined, identity: { userAgent: string; requestType: string }): BuiltRequest {
  const collapsed = collapseSystemMessages(context);
  const contents = buildContents(model, collapsed);
  if (contents.length === 0) throw new AntigravityError("unsupported", "There is nothing to send: the conversation has no user message");
  const system = getCurrentSystemPrompt(collapsed.messages);
  const tools = getCurrentTools(collapsed.messages);
  const generationConfig: Record<string, unknown> = {};
  if (options?.temperature !== undefined) generationConfig.temperature = options.temperature;
  generationConfig.maxOutputTokens = Math.min(options?.maxTokens ?? model.maxTokens, model.maxTokens);
  if (options?.reasoning) {
    if (!model.reasoning) throw new AntigravityError("unsupported", `Model ${model.id} does not support thinking (the provider lists it without thinking), so reasoning "${options.reasoning}" cannot be applied. Turn thinking off for this model`);
    const budget = options.thinkingBudgets?.[options.reasoning as keyof NonNullable<SimpleStreamOptions["thinkingBudgets"]>] ?? LEVEL_BUDGET[options.reasoning];
    generationConfig.thinkingConfig = { includeThoughts: true, thinkingBudget: budget };
  }
  const request: Record<string, unknown> = { contents, generationConfig };
  if (system) request.systemInstruction = { role: "user", parts: [{ text: system }] };
  if (tools.length) request.tools = [{ functionDeclarations: tools.map((tool) => ({ name: tool.name, description: tool.description, parametersJsonSchema: JSON.parse(JSON.stringify(tool.parameters)) })) }];
  if (options?.toolChoice === "none") request.toolConfig = { functionCallingConfig: { mode: "NONE" } };
  if (options?.sessionId) request.sessionId = options.sessionId;
  const imageCount = contents.reduce((n, c) => n + c.parts.filter((p) => "inlineData" in p).length, 0);
  return { envelope: { project: projectId, model: model.id, request, requestType: identity.requestType, userAgent: identity.userAgent, requestId: `steak-pi-${randomUUID()}` }, imageCount };
}
