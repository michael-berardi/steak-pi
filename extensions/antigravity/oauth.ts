// Sign-in through Pi's own /login flow: OAuth authorization code with PKCE, a loopback callback listener, and a
// paste-the-URL fallback for a browser on another machine. Pi stores the returned credential (0600 in its auth store);
// this module keeps no copy of it and opens no browser itself. The refresh token never leaves Pi's store: the `apiKey`
// handed to requests carries the access token and project only, and Pi's own `refresh` renews an expiring token.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { OAuthCredential, OAuthAuth, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { discoverProject, exchangeCode, needClient, refreshTokens } from "./client.ts";
import type { AntigravityConfig } from "./config.ts";
import { AntigravityError, stripControl } from "./errors.ts";

export const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const CALLBACK_PATH = "/oauth-callback";

const b64url = (buffer: Buffer) => buffer.toString("base64url");

interface Callback { code: string; state: string }

function listen(config: AntigravityConfig, expectedState: string): Promise<{ wait: Promise<Callback>; close(): void; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    let settle!: { ok(value: Callback): void; fail(error: Error): void };
    const wait = new Promise<Callback>((ok, fail) => { settle = { ok, fail }; });
    wait.catch(() => {});
    const page = (res: import("node:http").ServerResponse, status: number, text: string) => {
      res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(text);
    };
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "", "http://127.0.0.1");
      if (req.method !== "GET" || url.pathname !== CALLBACK_PATH) return page(res, 404, "Not found");
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      // A request with a missing or wrong state is not part of this sign-in: refuse it and keep waiting, so no web page or
      // local process can end the sign-in by sending one. Only a callback that carries the right state is final.
      if (state !== expectedState) return page(res, 400, "Sign-in failed: state missing or not matching this sign-in.");
      if (error) { page(res, 400, "Sign-in failed. You can close this window."); settle.fail(new AntigravityError("sign-in", `Google sign-in was refused: ${stripControl(error).slice(0, 100)}`)); return; }
      if (!code) { page(res, 400, "Sign-in failed: missing code."); settle.fail(new AntigravityError("sign-in", "The sign-in callback had no code")); return; }
      page(res, 200, "Antigravity sign-in complete. You can close this window and return to Pi.");
      settle.ok({ code, state });
    });
    server.once("error", (error: NodeJS.ErrnoException) => reject(error.code === "EADDRINUSE"
      ? new AntigravityError("sign-in", `Port ${config.redirectPort} is already in use; free it or set "redirectPort" (it must match the OAuth client's registered redirect)`)
      : error));
    server.listen(config.redirectPort, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : config.redirectPort;
      const timer = setTimeout(() => settle.fail(new AntigravityError("sign-in", "Timed out waiting for the browser sign-in (5 minutes)")), CALLBACK_TIMEOUT_MS);
      timer.unref?.();
      resolve({
        wait,
        redirectUri: `http://localhost:${port}${CALLBACK_PATH}`,
        close() { clearTimeout(timer); server.closeAllConnections?.(); server.close(); },
      });
    });
  });
}

/** A callback URL (or bare query string) pasted from a browser that could not reach this machine. */
export function parsePasted(raw: string, expectedState: string): Callback {
  const text = (raw ?? "").trim();
  if (!text) throw new AntigravityError("sign-in", "Nothing was pasted; paste the full callback URL from the browser's address bar");
  let url: URL;
  try { url = new URL(text); }
  catch { url = new URL(`http://localhost${CALLBACK_PATH}?${text.replace(/^\?/, "")}`); }
  const error = url.searchParams.get("error");
  if (error) throw new AntigravityError("sign-in", `Google sign-in was refused: ${stripControl(error).slice(0, 100)}`);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) throw new AntigravityError("sign-in", "The pasted text has no code or state; paste the full callback URL");
  if (state !== expectedState) throw new AntigravityError("sign-in", "The pasted callback belongs to a different sign-in; run /login antigravity again and paste the new URL");
  return { code, state };
}

export async function login(config: AntigravityConfig, interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
  const { clientId } = needClient(config);
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  // The state is independent of the verifier, so a leaked callback URL cannot disclose the verifier.
  const state = b64url(randomBytes(32));
  const listener = await listen(config, state);
  const settle = new AbortController();
  try {
    const params = new URLSearchParams({
      client_id: clientId, response_type: "code", redirect_uri: listener.redirectUri, scope: config.scopes.join(" "),
      code_challenge: challenge, code_challenge_method: "S256", state, access_type: "offline", prompt: "consent",
    });
    interaction.notify({
      type: "auth_url",
      url: `${config.authUrl}?${params.toString()}`,
      instructions: "Complete the Google sign-in. Pi captures the local callback by itself; on a remote machine, paste the callback URL when asked.",
    });
    const pasted = (async (): Promise<Callback> => {
      let message = "Browser on another machine? After signing in, paste the full callback URL from its address bar.";
      for (;;) {
        const text = await interaction.prompt({ type: "manual_code", message, signal: settle.signal });
        try { return parsePasted(text, state); }
        catch (error) { message = `${stripControl((error as Error).message)}. Paste the full callback URL:`; }
      }
    })();
    pasted.catch(() => {});
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = () => reject(new AntigravityError("sign-in", "Sign-in cancelled"));
      if (interaction.signal.aborted) onAbort(); else interaction.signal.addEventListener("abort", onAbort, { once: true });
    });
    aborted.catch(() => {});
    const { code } = await Promise.race([listener.wait, pasted, aborted]);
    const tokens = await exchangeCode(config, code, verifier, listener.redirectUri, interaction.signal);
    if (!tokens.refresh) throw new AntigravityError("sign-in", "Google returned no refresh token; run /login antigravity again and allow offline access");
    const projectId = await discoverProject(config, tokens.access, interaction.signal);
    return { type: "oauth", access: tokens.access, refresh: tokens.refresh, expires: tokens.expires, projectId };
  } finally {
    settle.abort();
    listener.close();
  }
}

export function createOAuth(config: AntigravityConfig): OAuthAuth {
  return {
    name: "Google Antigravity",
    isSubscription: true,
    loginLabel: "Sign in with Google (Antigravity)",
    login: (interaction) => login(config, interaction),
    async refresh(credential, signal) {
      const tokens = await refreshTokens(config, credential.refresh, signal);
      return { ...credential, access: tokens.access, refresh: tokens.refresh ?? credential.refresh, expires: tokens.expires };
    },
    async toAuth(credential) {
      const projectId = typeof credential.projectId === "string" ? credential.projectId : config.projectId;
      if (!projectId) throw new AntigravityError("auth-expired", "The saved Antigravity sign-in has no project; run /login antigravity again");
      return { apiKey: JSON.stringify({ token: credential.access, projectId }) };
    },
  };
}

/** Read what `toAuth` produced. The text may carry a token, so a failure never quotes it. */
export function parseKey(apiKey: string | undefined): { token: string; projectId: string } {
  if (!apiKey) throw new AntigravityError("auth-expired", "No Antigravity sign-in. Run /login antigravity");
  try {
    const parsed = JSON.parse(apiKey) as Record<string, unknown>;
    if (typeof parsed.token === "string" && parsed.token && typeof parsed.projectId === "string" && parsed.projectId) {
      return { token: parsed.token, projectId: parsed.projectId };
    }
  } catch { /* named error below, without the text */ }
  throw new AntigravityError("auth-expired", "The Antigravity credential is unreadable. Run /login antigravity");
}
