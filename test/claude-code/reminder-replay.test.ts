import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildRequestTransform, rewriteInitialRequest } from "../../extensions/claude-code/claude-cli.ts";

const memory = "<system-reminder>\nCodebase and user instructions are shown below.\n# MEMORY\n- index entry\n</system-reminder>\n";
const email = "<system-reminder>\n# userEmail\nThe user's email address is a@b.test.\n</system-reminder>\n";
const prefix = [
  { type: "text", text: memory },
  { type: "text", text: email },
];
const canonical = [{ type: "text", text: "run echo twice" }];
const environment = [{ role: "system", content: [{ type: "text", text: "# Environment\ncwd" }] }];

type Block = Record<string, unknown>;
type Message = { role: string; content: unknown };

function request(finalContent: unknown, middleContent: unknown = "out-1"): Buffer {
  const messages: Message[] = [
    { role: "user", content: [...structuredClone(prefix), ...structuredClone(canonical)] },
    { role: "system", content: [{ type: "text", text: "# Environment\ncwd" }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: middleContent }] },
    { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "bash", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: finalContent }] },
  ];
  return Buffer.from(JSON.stringify({ messages }));
}

function rewrite(body: Buffer, withSystem: boolean): Message[] {
  const out = rewriteInitialRequest(body, prefix, canonical, withSystem ? environment : undefined);
  return (JSON.parse(out.toString("utf8")) as { messages: Message[] }).messages;
}

function toolResults(messages: Message[]): Block[] {
  return messages
    .filter((message) => message.role === "user" && Array.isArray(message.content))
    .flatMap((message) => (message.content as Block[]).filter((block) => block.type === "tool_result"));
}

const tails = [
  ["a blank line before one joined context", `\n\n${memory}${email}`],
  ["a blank line before blank-line-joined blocks", `\n\n${memory.trim()}\n\n${email.trim()}`],
  ["a newline before newline-joined blocks", `\n${memory.trim()}\n${email.trim()}`],
] as const;

describe.each([true, false])("replayed context with saved system messages: %s", (withSystem) => {
  for (const [label, tail] of tails) {
    test(`string tool result with ${label} comes back byte-identical`, () => {
      const results = toolResults(rewrite(request(`out-2${tail}`), withSystem));
      assert.equal(results.at(-1)?.content, "out-2");
      assert.equal(results[0]?.content, "out-1");
    });

    test(`array tool result with ${label} comes back byte-identical`, () => {
      const final = [{ type: "text", text: `out-2${tail}` }];
      const results = toolResults(rewrite(request(final), withSystem));
      assert.deepEqual(results.at(-1)?.content, [{ type: "text", text: "out-2" }]);
    });
  }

  test("separate trailing text blocks for the memory index and the account email are removed", () => {
    const final = [
      { type: "text", text: "out-2" },
      { type: "text", text: memory },
      { type: "text", text: email },
    ];
    const results = toolResults(rewrite(request(final), withSystem));
    assert.deepEqual(results.at(-1)?.content, [{ type: "text", text: "out-2" }]);
  });

  test("a tool's own output that mentions a reminder is never stripped", () => {
    const own = "found:\n<system-reminder>\nunrelated\n</system-reminder>\n";
    const partial = `out\n\n${memory}`;
    for (const content of [own, partial, [{ type: "text", text: own }], [{ type: "text", text: partial }]]) {
      const results = toolResults(rewrite(request(content), withSystem));
      assert.deepEqual(results.at(-1)?.content, content);
    }
  });

  test("the first user message keeps its context exactly once", () => {
    const messages = rewrite(request(`out-2\n\n${memory}${email}`), withSystem);
    assert.deepEqual(messages[0]?.content, [...prefix, ...canonical]);
    const text = JSON.stringify(messages);
    assert.equal(text.split("# MEMORY").length - 1, 1);
    assert.equal(text.split("# userEmail").length - 1, 1);
  });
});

describe("request transform without saved metadata", () => {
  test("reads the context from the request itself when no prefix was saved", () => {
    const transform = buildRequestTransform({ canonicalInitialUser: canonical });
    const out = JSON.parse(transform(request(`out-2\n\n${memory}${email}`)).toString("utf8")) as { messages: Message[] };
    assert.equal(toolResults(out.messages).at(-1)?.content, "out-2");
    assert.deepEqual(out.messages[0]?.content, [...prefix, ...canonical]);
  });

  test("a request without any context passes through untouched", () => {
    const body = request("out-2\n\nplain");
    const transform = buildRequestTransform({ canonicalInitialUser: [{ type: "text", text: "nothing" }] });
    assert.equal(transform(body).toString("utf8"), body.toString("utf8"));
  });
});
