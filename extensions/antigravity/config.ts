// Operator configuration for the Antigravity module. This file imports only node built-ins so that reading it at
// startup costs nothing when the module is not configured: nothing else of the module loads until `enabled` is true.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AntigravityError } from "./errors.ts";

export const CONFIG_ENV = "STEAK_PI_ANTIGRAVITY_CONFIG";
export const CONFIG_LABEL = "~/.config/ultraterm/antigravity.json";
export const PROVIDER_ID = "antigravity";
export const API_ID = "antigravity-cloud-code";

export interface AntigravityConfig {
  enabled: true;
  /** OAuth client. Required to sign in; never shipped with the tool. */
  clientId?: string;
  clientSecret?: string;
  /** Provider endpoints, tried in order on transport failures. */
  baseUrls: string[];
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** Loopback port that the OAuth client has registered as its redirect. */
  redirectPort: number;
  userAgent: string;
  /** Sent as `requestType` in the request envelope. */
  requestType: string;
  /** Sent as `metadata.ideType` in the project lookup. */
  ideType: string;
  /** Cloud project to bill the quota to. Discovered at sign-in when absent. */
  projectId?: string;
  /** Longest single wait for a rate limit before the request fails with a named error. */
  maxRateLimitWaitMs: number;
  /** Times a rate-limited request is sent again after waiting. */
  maxRateLimitRetries: number;
}

export const DEFAULT_BASE_URLS = ["https://cloudcode-pa.googleapis.com"];
const DEFAULT_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/aicode",
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
];

export function configPath(env: Record<string, string | undefined> = process.env): string {
  return env[CONFIG_ENV] || join(homedir(), ".config", "ultraterm", "antigravity.json");
}

const isLoopback = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";

/** An endpoint must be https, or plain http only to this machine (a local test server). No credentials in the URL. */
export function checkUrl(name: string, value: unknown): string {
  if (typeof value !== "string" || !value) throw new AntigravityError("not-configured", `${CONFIG_LABEL}: "${name}" must be a URL string`);
  let url: URL;
  try { url = new URL(value); }
  catch { throw new AntigravityError("not-configured", `${CONFIG_LABEL}: "${name}" is not a valid URL`); }
  if (url.username || url.password) throw new AntigravityError("not-configured", `${CONFIG_LABEL}: "${name}" must not contain credentials`);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw new AntigravityError("not-configured", `${CONFIG_LABEL}: "${name}" must be https (http is allowed only for localhost)`);
  }
  return value.replace(/\/+$/, "");
}

function positiveInt(name: string, value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    throw new AntigravityError("not-configured", `${CONFIG_LABEL}: "${name}" must be a whole number from 0 to ${max}`);
  }
  return value;
}

function optionalString(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new AntigravityError("not-configured", `${CONFIG_LABEL}: "${name}" must be a non-empty string`);
  return value.trim();
}

/** Validate a parsed config object. Returns undefined when the module is not turned on. */
export function parseConfig(raw: unknown, version: () => string | undefined = () => undefined): AntigravityConfig | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new AntigravityError("not-configured", `${CONFIG_LABEL} must be a JSON object`);
  const o = raw as Record<string, unknown>;
  if (o.enabled !== true) return undefined;
  const urls = o.baseUrls === undefined ? DEFAULT_BASE_URLS : o.baseUrls;
  if (!Array.isArray(urls) || urls.length === 0) throw new AntigravityError("not-configured", `${CONFIG_LABEL}: "baseUrls" must be a non-empty array of URLs`);
  const scopes = o.scopes === undefined ? DEFAULT_SCOPES : o.scopes;
  if (!Array.isArray(scopes) || !scopes.every((s) => typeof s === "string" && s)) throw new AntigravityError("not-configured", `${CONFIG_LABEL}: "scopes" must be an array of strings`);
  const port = positiveInt("redirectPort", o.redirectPort, 51121, 65535);
  if (port < 1024) throw new AntigravityError("not-configured", `${CONFIG_LABEL}: "redirectPort" must be from 1024 to 65535`);
  return {
    enabled: true,
    clientId: optionalString("clientId", o.clientId),
    clientSecret: optionalString("clientSecret", o.clientSecret),
    baseUrls: urls.map((u, i) => checkUrl(`baseUrls[${i}]`, u)),
    authUrl: checkUrl("authUrl", o.authUrl ?? DEFAULT_AUTH_URL),
    tokenUrl: checkUrl("tokenUrl", o.tokenUrl ?? DEFAULT_TOKEN_URL),
    scopes: scopes as string[],
    redirectPort: port,
    userAgent: optionalString("userAgent", o.userAgent) ?? `steak-pi-antigravity/${version() ?? "dev"}`,
    requestType: optionalString("requestType", o.requestType) ?? "agent",
    ideType: optionalString("ideType", o.ideType) ?? "ANTIGRAVITY",
    projectId: optionalString("projectId", o.projectId),
    maxRateLimitWaitMs: positiveInt("maxRateLimitWaitMs", o.maxRateLimitWaitMs, 30_000, 300_000),
    maxRateLimitRetries: positiveInt("maxRateLimitRetries", o.maxRateLimitRetries, 2, 3),
  };
}

/**
 * Read the operator's config. Returns undefined when there is no file or it does not say `"enabled": true`: the module
 * then registers nothing. A file that exists but is unreadable, not JSON, or invalid throws a named error, because a
 * typo must not silently leave the provider off. A file that other users can write, or that another user owns, is refused; so is one holding a client secret that they can read.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env, version?: () => string | undefined): AntigravityConfig | undefined {
  const path = configPath(env);
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new AntigravityError("not-configured", `Cannot read ${path}: ${(error as Error).message}`, { cause: error });
  }
  let raw: unknown;
  try { raw = JSON.parse(text); }
  catch { throw new AntigravityError("not-configured", `${path} is not valid JSON`); }
  const config = parseConfig(raw, version);
  if (config && process.platform !== "win32") {
    // The endpoints in this file decide where the token is sent, so whoever can write it can take the token.
    const info = statSync(path);
    const mode = info.mode & 0o777;
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      throw new AntigravityError("not-configured", `${path} is not owned by the current user (owner uid ${info.uid}); run: chown "$(id -un)" ${path} && chmod 600 ${path}`);
    }
    if (mode & 0o022) throw new AntigravityError("not-configured", `${path} is writable by other users (mode ${mode.toString(8)}), and its endpoints decide where the token is sent; run: chmod 600 ${path}`);
    if (config.clientSecret && mode & 0o077) throw new AntigravityError("not-configured", `${path} holds a client secret but is readable by other users (mode ${mode.toString(8)}); run: chmod 600 ${path}`);
  }
  return config;
}
