import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIG_ENV, loadConfig, parseConfig } from "../../extensions/antigravity/config.ts";
import { AntigravityError } from "../../extensions/antigravity/errors.ts";

const dir = mkdtempSync(join(tmpdir(), "ag-config-"));
const write = (name: string, body: string, mode = 0o600) => { const p = join(dir, name); writeFileSync(p, body); chmodSync(p, mode); return p; };

describe("antigravity config", () => {
  it("is off without a file, and with a file that does not say enabled", () => {
    expect(loadConfig({ [CONFIG_ENV]: join(dir, "missing.json") })).toBeUndefined();
    expect(loadConfig({ [CONFIG_ENV]: write("off.json", "{}") })).toBeUndefined();
    expect(loadConfig({ [CONFIG_ENV]: write("off2.json", '{"enabled": false}') })).toBeUndefined();
  });

  it("turns on with enabled: true and ships no OAuth client, project or model", () => {
    const config = loadConfig({ [CONFIG_ENV]: write("on.json", '{"enabled": true}') }, () => "9.9.9")!;
    expect(config.clientId).toBeUndefined();
    expect(config.clientSecret).toBeUndefined();
    expect(config.projectId).toBeUndefined();
    expect(config.userAgent).toBe("steak-pi-antigravity/9.9.9");
    expect(config.baseUrls).toEqual(["https://cloudcode-pa.googleapis.com"]);
  });

  it("names the file and the key when the config is wrong, instead of leaving the provider silently off", () => {
    expect(() => loadConfig({ [CONFIG_ENV]: write("bad.json", "{nope") })).toThrow(/is not valid JSON/);
    expect(() => parseConfig({ enabled: true, baseUrls: ["http://example.com"] })).toThrow(/baseUrls\[0\].*https/);
    expect(() => parseConfig({ enabled: true, baseUrls: ["https://user:pw@example.com"] })).toThrow(/credentials/);
    expect(() => parseConfig({ enabled: true, maxRateLimitRetries: 9 })).toThrow(/maxRateLimitRetries/);
    expect(() => parseConfig({ enabled: true, redirectPort: 80 })).toThrow(/redirectPort/);
    expect(() => parseConfig([])).toThrow(AntigravityError);
  });

  it("allows plain http only to this machine", () => {
    expect(parseConfig({ enabled: true, baseUrls: ["http://127.0.0.1:9"] })?.baseUrls).toEqual(["http://127.0.0.1:9"]);
    expect(() => parseConfig({ enabled: true, tokenUrl: "http://10.0.0.5/token" })).toThrow(/tokenUrl/);
  });

  it.skipIf(process.platform === "win32")("refuses a config that holds a client secret but is readable by others", () => {
    const path = write("secret.json", '{"enabled": true, "clientId": "a", "clientSecret": "b"}', 0o644);
    expect(() => loadConfig({ [CONFIG_ENV]: path })).toThrow(/chmod 600/);
    chmodSync(path, 0o600);
    expect(loadConfig({ [CONFIG_ENV]: path })?.clientSecret).toBe("b");
  });

  it.skipIf(process.platform === "win32")("refuses an enabled config that others can write, with or without a secret, naming the chmod", () => {
    for (const [name, body] of [["w1.json", '{"enabled": true}'], ["w2.json", '{"enabled": true, "clientId": "a", "clientSecret": "b"}']] as const) {
      const path = write(name, body, 0o666);
      expect(() => loadConfig({ [CONFIG_ENV]: path }), name).toThrow(/writable by other users.*chmod 600/);
      chmodSync(path, 0o620);
      expect(() => loadConfig({ [CONFIG_ENV]: path }), name).toThrow(/writable by other users/);
      chmodSync(path, 0o600);
      expect(loadConfig({ [CONFIG_ENV]: path })?.enabled).toBe(true);
    }
    // A config that is not enabled is not inspected: the module is off.
    expect(loadConfig({ [CONFIG_ENV]: write("off3.json", "{}", 0o666) })).toBeUndefined();
    // Group/other-readable without a secret is fine.
    expect(loadConfig({ [CONFIG_ENV]: write("r.json", '{"enabled": true}', 0o644) })?.enabled).toBe(true);
  });

  it.skipIf(process.platform === "win32" || typeof process.getuid !== "function")("refuses a config owned by another user", async () => {
    const path = write("own.json", '{"enabled": true}');
    const real = process.getuid!;
    (process as { getuid: () => number }).getuid = () => real.call(process) + 1;
    try { expect(() => loadConfig({ [CONFIG_ENV]: path })).toThrow(/not owned by the current user.*chown.*chmod 600/); }
    finally { (process as { getuid: () => number }).getuid = real; }
  });

  it("identity keys default to the documented values and can be set", () => {
    const d = parseConfig({ enabled: true })!;
    expect([d.requestType, d.ideType]).toEqual(["agent", "ANTIGRAVITY"]);
    const c = parseConfig({ enabled: true, requestType: "chat", ideType: "X" })!;
    expect([c.requestType, c.ideType]).toEqual(["chat", "X"]);
  });
});
