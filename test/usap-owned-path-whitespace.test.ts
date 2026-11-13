import { describe, expect, it } from "vitest";
import { claudeOwnedPathRules } from "../src/subagents/claude-owned-paths.ts";

const rules = (path: string) => claudeOwnedPathRules([path], () => undefined);

describe("claude-code owned paths: whitespace at a segment edge (the CLI drops it, which would widen the fence)", () => {
  it("refuses a segment that begins or ends with whitespace, naming the full path and the reason", () => {
    for (const owned of ["/repo/src ", "/repo/src /a.ts", "/repo/ src/a.ts", "/repo/a.ts ", "/repo/a /b", "/repo/ a/b", "/repo/a\t/b"]) {
      expect(() => rules(owned), owned).toThrow(/begins or ends with whitespace/);
      expect(() => rules(owned), owned).toThrow(/cannot match it exactly/);
      expect(() => rules(owned), owned).toThrow(JSON.stringify(owned));
    }
  });

  it("accepts inner spaces", () => {
    expect(rules("/repo/my dir/a.ts")).toEqual(["Edit(//repo/my dir/a.ts)", "Edit(//repo/my dir/a.ts/**)"]);
  });

  it("checks the physical form too", () => {
    expect(() => claudeOwnedPathRules(["/repo/link"], () => "/real/dir /x")).toThrow(/begins or ends with whitespace/);
  });
});

describe("claude-code owned paths: parentheses next to whitespace or a comma", () => {
  it("refuses a path with parentheses and whitespace or a comma anywhere", () => {
    for (const owned of ["/repo/a) b/c", "/repo/a),b/c", "/repo/(a) b/c", "/repo/a b(1)/c", "/repo/x,(y)/c", "/repo/(a/b c"]) {
      expect(() => rules(owned), owned).toThrow(/parenthes/);
      expect(() => rules(owned), owned).toThrow(JSON.stringify(owned));
    }
  });

  it("keeps balanced or unpaired parentheses without whitespace or comma", () => {
    expect(rules("/repo/a(1)/b")[0]).toBe("Edit(//repo/a\\(1\\)/b)");
    expect(rules("/repo/a)b")[0]).toBe("Edit(//repo/a\\)b)");
    expect(rules("/repo/(a")[0]).toBe("Edit(//repo/\\(a)");
  });

  it("keeps whitespace or a comma when there are no parentheses", () => {
    expect(rules("/repo/a b,c/d")[0]).toBe("Edit(//repo/a b,c/d)");
  });
});

describe("owned-path error text", () => {
  it("strips C1 controls, DEL and bidi overrides from the printed path", () => {
    const owned = "/repo/a\u0085b\u007fc‮d⁦e/x?y";
    let message = "";
    try { rules(owned); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("/repo/abcde/x?y");
    expect(message).not.toMatch(/[\u007f-\u009f‪-‮⁦-⁩]/u);
  });
});
