import { describe, expect, it, vi } from "vitest";
import { capCacheBreakpoints, collectCacheBreakpoints } from "../../extensions/claude-code/cache-control.ts";
import { buildRequestTransform, capRequestCacheBreakpoints, rewriteInitialRequest } from "../../extensions/claude-code/claude-cli.ts";

// Fable 5.1 (2026-10-21): on a turn that uses a tool, the request the relay
// forwards carries five cache_control blocks (the last system block, the last
// tool definition, two blocks of the saved native environment and the relay's
// own marker on the tool result) and Anthropic accepts at most four, so the
// turn was rejected with
// "A maximum of 4 blocks with cache_control may be provided. Found 5.".
// The exact body the CLI sends was not captured, so the fixture models that
// shape rather than a recorded one.

const marker = { type: "ephemeral", ttl: "1h" };

function systemAndTools() {
  return {
    system: [
      { type: "text", text: "x-anthropic-billing-header" },
      { type: "text", text: "You are a Claude agent" },
      { type: "text", text: "You are an expert coding assistant", cache_control: marker },
    ],
    tools: [
      { name: "read", input_schema: { type: "object" } },
      { name: "mcp__pi__ultraterm_subagents", input_schema: { type: "object" }, cache_control: marker },
    ],
  };
}

/// The request that follows a tool call: the user asked, the agent called a
/// tool, the tool answered, and the CLI marked the native environment.
function fableToolCallRequest() {
  const { system, tools } = systemAndTools();
  return {
    model: "claude-fable-5-1",
    system,
    tools,
    messages: [
      { role: "user", content: [{ type: "text", text: "read the file" }] },
      { role: "system", content: [{ type: "text", text: "environment", cache_control: marker }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "read", input: { path: "scratch.txt" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "scratch-token" }] }],
      },
    ],
    max_tokens: 64_000,
  };
}

/// A request that already carries five markers, the shape the relay forwards
/// once the saved native environment has been spliced in.
function fiveMarkerRequest() {
  const { system, tools } = systemAndTools();
  return {
    model: "claude-fable-5-1",
    system,
    tools,
    messages: [
      { role: "user", content: [{ type: "text", text: "read the file" }] },
      {
        role: "system",
        content: [
          { type: "text", text: "reminder", cache_control: marker },
          { type: "text", text: "environment", cache_control: marker },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "read", input: { path: "scratch.txt" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "scratch-token" }], cache_control: marker }],
      },
    ],
    max_tokens: 64_000,
  };
}

/// What the agent saved of the CLI's native environment, markers included.
const savedNativeEnvironment = [
  { role: "system", content: [{ type: "text", text: "reminder", cache_control: marker }, { type: "text", text: "environment", cache_control: marker }] },
];

function countMarkers(payload: { system?: unknown; tools?: unknown; messages?: unknown }): number {
  return collectCacheBreakpoints(payload).length;
}

describe("capCacheBreakpoints", () => {
  it("reduces the five-marker Fable request to Anthropic's limit of four", () => {
    const payload = fiveMarkerRequest();
    expect(countMarkers(payload)).toBe(5);
    const { remaining, dropped } = capCacheBreakpoints(payload);
    expect(remaining).toBe(4);
    expect(dropped).toBe(1);
    expect(countMarkers(payload)).toBe(4);
  });

  it("keeps the system prompt, the tool definitions and the newest message cached", () => {
    const payload = fiveMarkerRequest();
    capCacheBreakpoints(payload);
    const system = payload.system as Array<Record<string, unknown>>;
    const tools = payload.tools as Array<Record<string, unknown>>;
    const messages = payload.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(system.at(-1)?.cache_control).toBeTruthy();
    expect(tools.at(-1)?.cache_control).toBeTruthy();
    // The oldest message marker is the one that goes.
    expect(messages[1].content[0].cache_control).toBeUndefined();
    expect(messages[1].content[1].cache_control).toBeTruthy();
    expect(messages[3].content[0].cache_control).toBeTruthy();
  });

  it("never counts a cache_control key that is data, not a marker", () => {
    const payload = {
      system: [{ type: "text", text: "prompt", cache_control: marker }],
      tools: [
        {
          name: "read",
          cache_control: marker,
          input_schema: { type: "object", properties: { cache_control: { type: "string" } } },
        },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: "hello", cache_control: marker }] },
        { role: "system", content: [{ type: "text", text: "environment", cache_control: marker }] },
      ],
    };
    const before = structuredClone(payload);
    expect(countMarkers(payload)).toBe(4);
    const { remaining, dropped } = capCacheBreakpoints(payload);
    expect(remaining).toBe(4);
    expect(dropped).toBe(0);
    expect(payload).toStrictEqual(before);
  });

  it("never touches a cache_control key inside a replayed tool input", () => {
    const payload = {
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_1",
              name: "read",
              input: { path: "scratch.txt", cache_control: { type: "ephemeral" } },
            },
          ],
        },
      ],
    };
    const before = structuredClone(payload);
    expect(countMarkers(payload)).toBe(0);
    const { dropped } = capCacheBreakpoints(payload);
    expect(dropped).toBe(0);
    expect(payload).toStrictEqual(before);
  });

  it("leaves a request that is already inside the limit untouched", () => {
    const payload = {
      system: [{ type: "text", text: "prompt", cache_control: marker }],
      tools: [{ name: "read", cache_control: marker }],
      messages: [
        { role: "user", content: [{ type: "text", text: "hello", cache_control: marker }] },
        { role: "assistant", content: [{ type: "text", text: "hi" }] },
        { role: "system", content: [{ type: "text", text: "environment", cache_control: marker }] },
      ],
    };
    const before = structuredClone(payload);
    const { remaining, dropped } = capCacheBreakpoints(payload);
    expect(remaining).toBe(4);
    expect(dropped).toBe(0);
    expect(payload).toStrictEqual(before);
  });

  it("counts a marker inside a tool result", () => {
    const payload = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "call_1",
              content: [{ type: "text", text: "file", cache_control: marker }],
            },
          ],
        },
      ],
    };
    expect(countMarkers(payload)).toBe(1);
  });
});

describe("rewriteInitialRequest", () => {
  it("caps the markers of the request that follows a tool call", () => {
    const body = Buffer.from(JSON.stringify(fableToolCallRequest()));
    const rewritten = rewriteInitialRequest(
      body,
      undefined,
      [{ type: "text", text: "read the file" }],
      savedNativeEnvironment,
    );
    const payload = JSON.parse(rewritten.toString("utf8"));
    const system = payload.system as Array<Record<string, unknown>>;
    const tools = payload.tools as Array<Record<string, unknown>>;
    const messages = payload.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    // Without the cap in the rewrite, the request would still carry five.
    expect(countMarkers(payload)).toBe(4);
    expect(messages[1].content[0].cache_control).toBeUndefined();
    expect(messages[1].content[1].cache_control).toBeTruthy();
    expect(messages[3].content[0].cache_control).toBeTruthy();
    expect(system.at(-1)?.cache_control).toBeTruthy();
    expect(tools.at(-1)?.cache_control).toBeTruthy();
  });

  it("leaves a request that is already inside the limit byte-identical", () => {
    const payload = {
      model: "claude-sonnet-5-5",
      system: [{ type: "text", text: "prompt", cache_control: marker }],
      tools: [{ name: "read", cache_control: marker }],
      messages: [
        { role: "user", content: [{ type: "text", text: "hello", cache_control: marker }] },
        { role: "assistant", content: [{ type: "text", text: "hi" }] },
        { role: "user", content: [{ type: "text", text: "more" }] },
      ],
    };
    // The rewrite always re-serializes the request, so the claim is about the
    // request, not about its bytes: it comes back with the same content.
    const body = Buffer.from(JSON.stringify(payload, null, 2));
    const rewritten = rewriteInitialRequest(body, undefined, [], undefined);
    expect(JSON.parse(rewritten.toString("utf8"))).toStrictEqual(payload);
  });
});

describe("buildRequestTransform", () => {
  it("caps a request the agent shaped", () => {
    const body = Buffer.from(JSON.stringify(fableToolCallRequest()));
    const transform = buildRequestTransform({
      initialSystemMessages: savedNativeEnvironment,
      canonicalInitialUser: [{ type: "text", text: "read the file" }],
    });
    const parsed = JSON.parse(transform(body).toString("utf8"));
    expect(countMarkers(parsed)).toBe(4);
  });

  it("caps a request the agent did not shape", () => {
    const body = Buffer.from(JSON.stringify(fiveMarkerRequest()));
    const transform = buildRequestTransform({ canonicalInitialUser: [] });
    const parsed = JSON.parse(transform(body).toString("utf8"));
    expect(countMarkers(parsed)).toBe(4);
  });

  it("leaves a request inside the limit byte-identical", () => {
    const payload = {
      system: [{ type: "text", text: "prompt", cache_control: marker }],
      tools: [{ name: "read", cache_control: marker }],
      messages: [{ role: "user", content: [{ type: "text", text: "hello", cache_control: marker }] }],
    };
    const body = Buffer.from(JSON.stringify(payload, null, 2));
    const transform = buildRequestTransform({ canonicalInitialUser: [] });
    expect(transform(body).equals(body)).toBe(true);
  });
});

describe("capRequestCacheBreakpoints", () => {
  it("caps a request the agent did not shape", () => {
    const payload = fiveMarkerRequest();
    const body = Buffer.from(JSON.stringify(payload));
    const capped = capRequestCacheBreakpoints(body);
    const parsed = JSON.parse(capped.toString("utf8"));
    expect(countMarkers(parsed)).toBe(4);
  });

  it("returns a body that is not a request unchanged", () => {
    const body = Buffer.from("null");
    expect(capRequestCacheBreakpoints(body).equals(body)).toBe(true);
  });

  it("returns a request inside the limit unchanged", () => {
    const payload = {
      system: [{ type: "text", text: "prompt", cache_control: marker }],
      tools: [{ name: "read", cache_control: marker }],
      messages: [{ role: "user", content: [{ type: "text", text: "hello", cache_control: marker }] }],
    };
    const body = Buffer.from(JSON.stringify(payload, null, 2));
    expect(capRequestCacheBreakpoints(body).equals(body)).toBe(true);
  });
});


it("drops tools before system markers when static prefixes alone exceed the cap", () => {
  const payload = {
    tools: [{ name: "read", cache_control: marker }],
    system: Array.from({ length: 4 }, (_, i) => ({ type: "text", text: `system-${i}`, cache_control: marker })),
  };
  capCacheBreakpoints(payload);
  expect(payload.tools[0].cache_control).toBeUndefined();
  expect(payload.system.every(block => block.cache_control)).toBe(true);
});

it("cache-cap diagnostics never write directly over the TUI", async () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    vi.resetModules();
    const cli = await import("../../extensions/claude-code/claude-cli.ts");
    cli.capRequestCacheBreakpoints(Buffer.from(JSON.stringify(fiveMarkerRequest())));
    expect(error).not.toHaveBeenCalled();
  } finally { error.mockRestore(); }
});


it("reports a dropped-marker count once through a TUI-safe notification sink", async () => {
  vi.resetModules();
  const cli = await import("../../extensions/claude-code/claude-cli.ts");
  const notify = vi.fn();
  cli.setClaudeCodeDiagnosticReporter(notify);
  try {
    const body = Buffer.from(JSON.stringify(fiveMarkerRequest()));
    cli.capRequestCacheBreakpoints(body);
    cli.capRequestCacheBreakpoints(body);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("[claude-code] 1 cache marker(s) dropped to stay inside Anthropic's limit of 4");
  } finally { cli.setClaudeCodeDiagnosticReporter(undefined); }
});
