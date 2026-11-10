// Per-turn content belongs at the end of a request: a local server reuses its prompt cache only for an identical
// prefix, so a block that changes between turns must not sit in front of the conversation.
import { describe, expect, it } from "vitest";
import { movePerTurnTail, PER_TURN_MARKERS, splitPerTurnTail } from "../src/prompt-order.ts";

const AVAILABILITY = "USAP route availability: route-a: up; route-b: COOLING until Mon 03:42. Next usable route: route-a. Omit model, profile and harness on ultraterm_subagents and let the router choose.";
const TODO = "## Active todo plan\n\nThis session has an unfinished plan tracked by the `todo` tool; its `view` op is the only checklist.\n- Before starting an item, record it with `op:\"start\"`.";

const system = (content: string) => ({ role: "system", content });
const user = (content: string) => ({ role: "user", content });
const conversation = [user("do the thing"), { role: "assistant", content: "working" }, { role: "toolResult", content: "ok" }];

const payloadFor = (head: string) => ({ model: "any", messages: [system(head), ...conversation], max_tokens: 512 });

describe("a per-turn block is moved behind the conversation", () => {
  it("splits a trailing availability block off the fixed prompt", () => {
    const split = splitPerTurnTail(`stable sections\n\n${AVAILABILITY}`);
    expect(split.stable).toBe("stable sections");
    expect(split.tail).toBe(AVAILABILITY);
  });

  it("splits both blocks, in the order they were appended", () => {
    const split = splitPerTurnTail(`stable sections\n\n${AVAILABILITY}\n\n${TODO}`);
    expect(split.stable).toBe("stable sections");
    expect(split.tail).toBe(`${AVAILABILITY}\n\n${TODO}`);
  });

  it("returns a prompt with no marker untouched, by identity", () => {
    const head = "only stable sections here";
    expect(splitPerTurnTail(head)).toEqual({ stable: head });
    const payload = payloadFor(head);
    const result = movePerTurnTail(payload);
    expect(result.payload).toBe(payload);
    expect(result.moved).toEqual([]);
  });

  it("moves the block into the last user message and keeps every character", () => {
    const head = `preamble\n<rules>\n- be concise\n</rules>\n\n${AVAILABILITY}`;
    const payload = payloadFor(head);
    const result = movePerTurnTail(payload);
    expect(result.payload).not.toBe(payload);
    const messages = result.payload.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(1 + conversation.length);
    expect(messages[0]).toEqual({ role: "system", content: "preamble\n<rules>\n- be concise\n</rules>" });
    expect(messages.slice(1)).toEqual([user(`do the thing\n\n${AVAILABILITY}`), conversation[1], conversation[2]]);
    // Nothing was added, dropped or reworded: the blank line before the block moves with it.
    const chars = (items: Array<{ content: string }>) => items.reduce((total, item) => total + item.content.length, 0);
    expect(chars(messages)).toBe(chars([system(head), ...conversation]));
    expect(result.moved).toEqual([AVAILABILITY]);
    // The input payload is not mutated.
    expect((payload.messages[0] as { content: string }).content).toBe(head);
    expect((payload.messages[1] as { content: string }).content).toBe("do the thing");
  });

  it("never leaves a system message anywhere but the start (the local chat template rejects one)", () => {
    const payload = payloadFor(`stable\n\n${AVAILABILITY}\n\n${TODO}`);
    const messages = movePerTurnTail(payload).payload.messages as Array<{ role: string }>;
    expect(messages.slice(1).some((message) => message.role === "system")).toBe(false);
  });

  it("uses the most recent user message when there are several turns", () => {
    const turns = [user("first"), { role: "assistant", content: "ok" }, user("second"), { role: "assistant", content: "done" }, { role: "toolResult", content: "t" }];
    const payload = { model: "any", messages: [system(`stable\n\n${AVAILABILITY}`), ...turns] };
    const messages = movePerTurnTail(payload).payload.messages as Array<{ role: string; content: string }>;
    expect(messages[1]).toEqual(turns[0]);
    expect(messages[3]).toEqual({ role: "user", content: `second\n\n${AVAILABILITY}` });
    expect(messages.slice(4)).toEqual(turns.slice(3));
  });

  it("leaves the block in place when the request has no string user message to receive it", () => {
    const head = `stable\n\n${AVAILABILITY}`;
    for (const messages of [
      [system(head), { role: "assistant", content: "only" }],
      [system(head), { role: "user", content: [{ type: "text", text: "array content" }] }],
    ]) {
      const payload = { model: "any", messages };
      const result = movePerTurnTail(payload);
      expect(result.payload).toBe(payload);
      expect(result.moved).toEqual([]);
    }
  });

  it("moves the todo guidance as well, when both are present", () => {
    const payload = payloadFor(`stable\n\n${AVAILABILITY}\n\n${TODO}`);
    const messages = movePerTurnTail(payload).payload.messages as Array<{ role: string; content: string }>;
    expect(messages[0]!.content).toBe("stable");
    expect(messages[1]!.content).toBe(`do the thing\n\n${AVAILABILITY}\n\n${TODO}`);
  });

  it("never guesses: a marker inside the text, twice, or not as a trailing block is left alone", () => {
    // Twice: ambiguous, so nothing moves.
    expect(splitPerTurnTail(`${AVAILABILITY}\n\nmiddle\n\n${AVAILABILITY}`).tail).toBeUndefined();
    // A marker with text after it is not a trailing block.
    expect(splitPerTurnTail(`${AVAILABILITY}\n\nmore stable text after it`).tail).toBeUndefined();
    // The marker as a substring of a longer word is not the marker.
    expect(splitPerTurnTail("USAP route availability table of contents\n\nbody").tail).toBeUndefined();
    expect(PER_TURN_MARKERS).toContain("## Active todo plan");
  });

  it("leaves a payload it cannot read untouched", () => {
    for (const payload of [undefined, null, 42, "text", {}, { messages: [] }, { messages: [{ role: "user", content: "hi" }] },
      { messages: [{ role: "system", content: [{ type: "text", text: "blocks" }] }] }]) {
      const result = movePerTurnTail(payload);
      expect(result.payload).toBe(payload);
      expect(result.moved).toEqual([]);
    }
  });
});
