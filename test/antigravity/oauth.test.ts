import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOAuth, login, parseKey, parsePasted } from "../../extensions/antigravity/oauth.ts";
import { AntigravityError } from "../../extensions/antigravity/errors.ts";
import { json, startFake, testConfig, type Fake } from "./fixture.ts";

let fake: Fake;
beforeEach(async () => { fake = await startFake(); });
afterEach(() => fake.close());

const freePort = async () => { const { createServer } = await import("node:net"); const s = createServer(); await new Promise<void>((r) => s.listen(0, "127.0.0.1", r)); const port = (s.address() as { port: number }).port; await new Promise((r) => s.close(r)); return port; };

/** An interaction that plays the browser: it follows the auth URL's redirect_uri with a code and the state. */
function browser(opts: { state?: (s: string) => string; capture?: { url?: URL } } = {}) {
  const abort = new AbortController();
  return {
    signal: abort.signal,
    notify(event: { type: string; url?: string }) {
      if (event.type !== "auth_url") return;
      const url = new URL(event.url!);
      if (opts.capture) opts.capture.url = url;
      const redirect = new URL(url.searchParams.get("redirect_uri")!);
      redirect.searchParams.set("code", "code-1");
      redirect.searchParams.set("state", opts.state ? opts.state(url.searchParams.get("state")!) : url.searchParams.get("state")!);
      setTimeout(() => void fetch(redirect).catch(() => {}), 20);
    },
    // Nobody pastes: the prompt stays open until the sign-in finishes and aborts it.
    prompt: (p: { signal?: AbortSignal }) => new Promise<string>((_, reject) => p.signal?.addEventListener("abort", () => reject(new Error("prompt aborted")))),
  } as never;
}

function backend(tokenBody: Record<string, unknown> = { access_token: "acc-1", refresh_token: "ref-1", expires_in: 3600 }) {
  fake.on("/token", (req, res) => json(res, 200, tokenBody));
  fake.on("/v1internal:loadCodeAssist", (req, res) => json(res, 200, { cloudaicompanionProject: "proj-9" }));
}

describe("antigravity sign-in", () => {
  it("runs the PKCE code flow, exchanges the code, and returns a credential with the discovered project", async () => {
    backend();
    const config = testConfig(fake, { redirectPort: await freePort() });
    const capture: { url?: URL } = {};
    const credential = await login(config, browser({ capture }));
    expect(credential).toMatchObject({ type: "oauth", access: "acc-1", refresh: "ref-1", projectId: "proj-9" });
    expect(credential.expires).toBeGreaterThan(Date.now());
    const url = capture.url!;
    expect(url.origin).toBe(fake.url);
    expect(url.searchParams.get("client_id")).toBe("test-client");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    const form = new URLSearchParams(fake.seen.find((s) => s.url === "/token")!.body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("code-1");
    expect(createHash("sha256").update(form.get("code_verifier")!).digest("base64url")).toBe(url.searchParams.get("code_challenge"));
    expect(url.searchParams.get("state")).not.toBe(form.get("code_verifier"));
    // The project lookup carried the new token and the configured user agent, and nothing went anywhere else.
    const lookup = fake.seen.find((s) => s.url.startsWith("/v1internal:loadCodeAssist"))!;
    expect(lookup.headers.authorization).toBe("Bearer acc-1");
    expect(lookup.headers["user-agent"]).toMatch(/^steak-pi-antigravity\//);
  });

  it("refuses a callback whose state does not match, naming the cause", async () => {
    backend();
    const config = testConfig(fake, { redirectPort: await freePort() });
    await expect(login(config, browser({ state: () => "forged" }))).rejects.toThrow(/state did not match/);
    expect(fake.seen.some((s) => s.url === "/token")).toBe(false);
  });

  it("names the missing OAuth client instead of using a built-in one", async () => {
    const config = testConfig(fake, { clientId: undefined, clientSecret: undefined });
    await expect(login(config, browser())).rejects.toThrow(/set "clientId" and "clientSecret".*none is shipped/);
  });

  it("fails when Google returns no refresh token", async () => {
    backend({ access_token: "acc-1", expires_in: 3600 });
    const config = testConfig(fake, { redirectPort: await freePort() });
    await expect(login(config, browser())).rejects.toThrow(/no refresh token/);
  });

  it("accepts a pasted callback URL and rejects one from another sign-in", () => {
    expect(parsePasted("http://localhost:1/oauth-callback?code=c&state=s", "s")).toEqual({ code: "c", state: "s" });
    expect(parsePasted("?code=c&state=s", "s")).toEqual({ code: "c", state: "s" });
    expect(() => parsePasted("http://localhost:1/oauth-callback?code=c&state=other", "s")).toThrow(/different sign-in/);
    expect(() => parsePasted("", "s")).toThrow(/Nothing was pasted/);
  });

  it("refreshes: new access token, kept refresh token and project", async () => {
    fake.on("/token", (req, res) => json(res, 200, { access_token: "acc-2", expires_in: 3600 }));
    const oauth = createOAuth(testConfig(fake));
    const next = await oauth.refresh({ type: "oauth", access: "old", refresh: "ref-1", expires: 0, projectId: "proj-9" }, new AbortController().signal);
    expect(next).toMatchObject({ access: "acc-2", refresh: "ref-1", projectId: "proj-9" });
    expect(new URLSearchParams(fake.seen[0].body).get("refresh_token")).toBe("ref-1");
    const auth = await oauth.toAuth(next);
    expect(parseKey(auth.apiKey)).toMatchObject({ token: "acc-2", projectId: "proj-9" });
  });

  it("a refused refresh token is a named expiry that says to sign in again, and never prints a token", async () => {
    fake.on("/token", (req, res) => json(res, 400, { error: "invalid_grant", error_description: "Token has been expired or revoked. refresh_token=1//abcdefghijklmnopqrstuvwxyz" }));
    const oauth = createOAuth(testConfig(fake));
    const error = await oauth.refresh({ type: "oauth", access: "a", refresh: "1//abcdefghijklmnopqrstuvwxyz", expires: 0, projectId: "p" }, new AbortController().signal).catch((e) => e);
    expect(error).toBeInstanceOf(AntigravityError);
    expect(error.code).toBe("auth-expired");
    expect(error.message).toMatch(/invalid_grant.*\/login antigravity/);
    expect(error.message).not.toMatch(/1\/\/abc/);
  });

  it("an unreadable credential is named and never quoted", () => {
    expect(() => parseKey("not json tok-secret")).toThrow(/unreadable/);
    try { parseKey("not json tok-secret"); } catch (e) { expect((e as Error).message).not.toMatch(/tok-secret/); }
    expect(() => parseKey(undefined)).toThrow(/\/login antigravity/);
  });
});
