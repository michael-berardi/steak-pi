import { createProvider, type AuthContext, type ProviderEnv } from "@earendil-works/pi-ai";
import { keepsStoredRow, rowVersion, steakPiVersion, storedRowIsOlderAndShorter, VERSION_MARKER, type CatalogRow } from "./catalog-guard.ts";
import { discoverClaudeModels, getClaudeStatus, LOGIN_HINT, reportClaudeCodeDiagnostic } from "./claude-cli.ts";
import { API_ID, CLAUDE_CODE_MODELS, modelFromDiscovery, PROVIDER_ID } from "./model-catalog.ts";
import { streamClaudeCode } from "./stream.ts";

const PROVIDER_ENV_NAMES = ["PI_CLAUDE_CODE_COMMAND", "PI_CLAUDE_CODE_CONFIG_DIR", "CLAUDE_CONFIG_DIR"] as const;

async function providerEnvironment(ctx: AuthContext): Promise<ProviderEnv | undefined> {
  const env: ProviderEnv = {};
  await Promise.all(
    PROVIDER_ENV_NAMES.map(async (name) => {
      const value = await ctx.env(name);
      if (value !== undefined) env[name] = value;
    }),
  );
  return Object.keys(env).length ? env : undefined;
}

// Pi resolves provider-scoped settings (such as PI_CLAUDE_CODE_COMMAND) only
// through auth hooks. Remember the latest values so model discovery and the
// status command look at the same Claude Code installation as requests do.
let lastProviderEnv: ProviderEnv | undefined;

/** The environment used to locate and configure Claude Code. */
export function claudeCodeEnv(): Record<string, string | undefined> {
  return { ...process.env, ...lastProviderEnv };
}

export interface ClaudeCodeProviderOptions {
  /** The Steak Pi version stamped on the stored catalog row. Defaults to this package's version. */
  version?: string;
  /** Receives the one line written when a stored catalog row is kept. Defaults to the session's notifier, or stderr when headless. */
  log?: (line: string) => void;
}

export function createClaudeCodeProvider(options: ClaudeCodeProviderOptions = {}) {
  let discoveredIds: Set<string> | undefined;
  const version = options.version ?? steakPiVersion();
  const log = options.log ?? reportClaudeCodeDiagnostic;
  // The catalog this session last stored from its own discovery.
  let ownRow: CatalogRow | undefined;
  const externalOAuthMarker = () => ({
    type: "oauth" as const,
    access: "claude-code-external",
    refresh: "claude-code-external",
    expires: Date.now() + 365 * 24 * 60 * 60 * 1_000,
  });
  const provider = createProvider({
    id: PROVIDER_ID,
    name: "Claude Code Subscription (Experimental)",
    baseUrl: "process://claude-code",
    auth: {
      apiKey: {
        name: "Claude Code login",
        // Report the external Claude Code subscription as OAuth-shaped auth so
        // Pi can label list-price accounting as "(sub)". Requests still resolve
        // through this ambient method; credentials remain owned by Claude Code.
        async check({ ctx, signal }) {
          const providerEnv = await providerEnvironment(ctx);
          lastProviderEnv = providerEnv;
          const status = await getClaudeStatus(claudeCodeEnv(), signal);
          // Only report the provider as configured when Claude Code is
          // installed and logged in, so Pi hides its models otherwise.
          if (!status.available || !status.loggedIn) return undefined;
          return {
            type: status.subscription ? "oauth" : "api_key",
            source: status.subscription ? `Claude Code ${status.plan ?? "subscription"}` : "Claude Code CLI",
          };
        },
        async resolve({ ctx, signal }) {
          signal.throwIfAborted();
          const providerEnv = await providerEnvironment(ctx);
          lastProviderEnv = providerEnv;
          return {
            auth: { apiKey: "external-process" },
            env: providerEnv,
            source: "Claude Code CLI",
          };
        },
      },
      // Metadata marker for Pi's subscription-aware UI. This is deliberately
      // not the request auth path and never imports Claude Code credentials.
      // Login and logout are handled by the Claude Code CLI itself.
      oauth: {
        name: "Claude Code subscription (managed by Claude Code)",
        isSubscription: true,
        async login() {
          throw new Error(
            "Claude Code manages its own login. Run `claude auth login` in a terminal instead; " +
              "this provider uses it automatically.",
          );
        },
        async refresh(_credential, signal) {
          const status = await getClaudeStatus(claudeCodeEnv(), signal);
          if (!status.subscription) throw new Error(status.detail ?? LOGIN_HINT);
          return externalOAuthMarker();
        },
        async toAuth() {
          return { apiKey: "external-process" };
        },
      },
    },
    models: CLAUDE_CODE_MODELS,
    async fetchModels({ signal }) {
      const models = (await discoverClaudeModels(claudeCodeEnv(), signal)).map(modelFromDiscovery);
      discoveredIds = new Set(models.map((model) => model.id));
      return models;
    },
    filterModels(models) {
      const ids = discoveredIds;
      return ids ? models.filter((model) => ids.has(model.id)) : models;
    },
    api: {
      stream: streamClaudeCode,
      streamSimple: streamClaudeCode,
    },
  });
  const refreshModels = provider.refreshModels;
  if (!refreshModels) return provider;
  return {
    ...provider,
    // Pi stores what fetchModels returns as the provider's row in models-store.json, which every running Pi shares.
    // The row is stamped with this Steak Pi version, and an older Steak Pi never replaces a newer one's row with a
    // shorter catalog (rule in catalog-guard.ts).
    refreshModels: async (context) => {
      const stored = context.stored;
      // A row an older Steak Pi wrote over this session's own discovery does not replace it in memory either.
      const restore = stored && ownRow && storedRowIsOlderAndShorter(stored, ownRow, version) ? ownRow : stored;
      await refreshModels({
        ...context,
        stored: restore as typeof stored,
        publish: (publication) => {
          const fetched = publication.persist;
          if (!fetched) return context.publish(publication);
          if (stored && keepsStoredRow(stored, fetched.models.length, version)) {
            log(
              `[claude-code] kept the stored model catalog (${stored.models.length} models, written by Steak Pi ${rowVersion(stored)}): ` +
                `this Steak Pi ${version} discovered ${fetched.models.length}. Reload this session to run the newer release.`,
            );
            // Only the check time moves; the models and the writer's version stay as stored.
            return context.publish({
              persist: { ...stored, checkedAt: fetched.checkedAt },
              update: () => {
                discoveredIds = new Set(stored.models.map((model) => model.id));
                ownRow = undefined;
              },
            });
          }
          const row = version ? { ...fetched, [VERSION_MARKER]: version } : fetched;
          return context.publish({
            persist: row,
            update: () => {
              publication.update?.();
              ownRow = row;
            },
          });
        },
      });
    },
  } satisfies typeof provider;
}

export { API_ID, PROVIDER_ID };
