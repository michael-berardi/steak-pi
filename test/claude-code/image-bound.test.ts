import assert from "node:assert/strict";
import { test } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { prepareFrames } from "../../extensions/claude-code/transcript.ts";

const shot = (seed: number, kb = 400) => Buffer.alloc(kb * 1024, seed).toString("base64");
const at = (ordinal: number): Record<string, number> => ({ timestamp: ordinal });

function history(images: number, options: { path?: boolean } = {}): Message[] {
  const messages: Message[] = [{ role: "user", content: "start", ...at(0) } as never];
  for (let i = 0; i < images; i++) {
    messages.push({
      role: "assistant",
      content: [{ type: "toolCall", id: `call_${i}`, name: "read", arguments: options.path === false ? {} : { path: `/tmp/shot-${i}.png` } }],
      ...at(1),
    } as never);
    messages.push({
      role: "toolResult",
      toolCallId: `call_${i}`,
      toolName: "read",
      content: [{ type: "text", text: `Read image file [image/png]` }, { type: "image", data: shot(i + 1), mimeType: "image/png" }],
      isError: false,
      ...at(2),
    } as never);
  }
  return messages;
}

const wire = (messages: Message[]) => JSON.stringify(prepareFrames(messages));
const imageCount = (json: string) => (json.match(/"type":"image"/gu) ?? []).length;

test("old large images are replaced by a short text naming the file, recent ones are kept", () => {
  const json = wire(history(20));
  assert.ok(imageCount(json) <= 7 && imageCount(json) >= 4, `kept ${imageCount(json)}`);
  assert.match(json, /image omitted[^"]*\/tmp\/shot-0\.png/);
  assert.ok(json.includes(shot(20)), "the newest image is sent whole");
  assert.ok(!json.includes(shot(1)), "the oldest image bytes are not re-sent");
  assert.ok(Buffer.byteLength(json) < 4 * 1024 * 1024, `body ${Buffer.byteLength(json)} bytes`);
});

test("small images are never replaced", () => {
  const messages = history(20);
  for (const m of messages) if (m.role === "toolResult") (m.content[1] as { data: string }).data = shot(3, 8);
  assert.equal(imageCount(wire(messages)), 20);
});

test("a tool result without a path still gets a placeholder naming the tool", () => {
  const json = wire(history(20, { path: false }));
  assert.match(json, /image omitted[^"]*read/);
});

test("the same history builds byte-identical requests", () => {
  const base = history(12);
  assert.equal(wire(base), wire(structuredClone(base)));
  assert.equal(wire(base), wire(base));
});

test("appending an image leaves every earlier frame byte-identical on most turns (prompt cache prefix)", () => {
  let unchanged = 0;
  let previous = prepareFrames(history(8)).map((frame) => JSON.stringify(frame));
  for (let n = 9; n <= 24; n++) {
    const current = prepareFrames(history(n)).map((frame) => JSON.stringify(frame));
    if (previous.every((frame, index) => frame === current[index] || index === previous.length - 1)) unchanged += 1;
    previous = current;
  }
  assert.ok(unchanged >= 12, `prefix kept on ${unchanged} of 16 turns`);
});

test("user-message images are bounded the same way", () => {
  const messages: Message[] = [];
  for (let i = 0; i < 12; i++) {
    messages.push({ role: "user", content: [{ type: "text", text: `t${i}` }, { type: "image", data: shot(i + 1), mimeType: "image/png" }], ...at(i) } as never);
    messages.push({ role: "assistant", content: [{ type: "text", text: "ok" }], ...at(i) } as never);
  }
  messages.push({ role: "user", content: "last", ...at(99) } as never);
  const json = wire(messages);
  assert.ok(imageCount(json) < 12);
  assert.match(json, /image omitted/);
});
