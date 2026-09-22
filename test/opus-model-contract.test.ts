import { readFileSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';

const sdk = dirname(findPackageJSON('@earendil-works/pi-coding-agent', import.meta.url)!);
const ai = join(sdk, 'node_modules/@earendil-works/pi-ai/dist');
const load = (path: string) => import(pathToFileURL(path).href);
const { ModelRuntime } = await load(join(sdk, 'dist/core/model-runtime.js'));
const { InMemoryCredentialStore } = await load(join(ai, 'auth/credential-store.js'));
const { InMemoryModelsStore } = await load(join(ai, 'models-store.js'));
const { streamSimple } = await load(join(ai, 'api/anthropic-messages.js'));
const fragmentPath = new URL('../docs/opus-5-5.models.json', import.meta.url);
const fragment = JSON.parse(readFileSync(fragmentPath, 'utf8'));
const definition = fragment.providers.anthropic.models[0];
const model = { ...definition, provider: 'anthropic' };

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it('adds the first-party model without replacing built-ins, auth methods or credentials', async () => {
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('ANTHROPIC_OAUTH_TOKEN', '');
  vi.stubEnv('PI_OFFLINE', '1');
  const network = vi.fn(() => { throw new Error('Network forbidden'); });
  vi.stubGlobal('fetch', network);
  const credentials = new InMemoryCredentialStore();
  const options = { credentials, modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false };
  const baseline = await ModelRuntime.create({ ...options, modelsPath: null });
  const runtime = await ModelRuntime.create({ ...options, modelsPath: fragmentPath.pathname });
  expect(runtime.getError()).toBeUndefined();
  for (const previous of baseline.getModels()) {
    expect(runtime.getModel(previous.provider, previous.id)).toEqual(previous);
  }
  expect(runtime.getModel('anthropic', model.id)).toMatchObject(model);
  expect(Object.keys(runtime.getProvider('anthropic').auth)).toEqual(Object.keys(baseline.getProvider('anthropic').auth));
  expect(await credentials.list()).toEqual([]);
  expect(runtime.hasConfiguredAuth('anthropic')).toBe(false);
  expect(await runtime.getAvailable('anthropic', { env: {} })).toEqual([]);
  expect(Object.keys(fragment.providers.anthropic)).toEqual(['models']);
  expect(network).not.toHaveBeenCalled();
});

async function payloadFor(candidate: typeof model, reasoning?: string) {
  let payload: any;
  const fetch = vi.fn(() => { throw new Error('Transport forbidden'); });
  vi.stubGlobal('fetch', fetch);
  const result = await streamSimple(candidate, {
    messages: [{ role: 'user', content: 'Payload fixture only', timestamp: 0 }],
  }, {
    // Synthetic in-memory test marker only. Never stored or sent anywhere.
    apiKey: 'mock-not-a-credential', reasoning, fetch,
    onPayload: (value: unknown) => { payload = value; throw new Error('MOCK_PAYLOAD_CAPTURED'); },
  }).result();
  expect(result.errorMessage).toContain('MOCK_PAYLOAD_CAPTURED');
  expect(fetch).not.toHaveBeenCalled();
  return payload;
}

it('sends adaptive thinking with explicit high effort for the exact new ID', async () => {
  const payload = await payloadFor(model, 'high');
  expect(payload.model).toBe('claude-opus-5-5');
  expect(payload.thinking).toMatchObject({ type: 'adaptive' });
  expect(payload.thinking).not.toHaveProperty('budget_tokens');
  expect(payload.output_config).toEqual({ effort: 'high' });
  expect(payload.max_tokens).toBeLessThanOrEqual(128000);
  expect(definition).toMatchObject({ baseUrl: 'https://api.anthropic.com', input: ['text', 'image'], contextWindow: 1000000, maxTokens: 128000, cost: { input: 4, output: 20 } });
  expect(definition.thinkingLevelMap.off).toBeNull();
});

it('demonstrates that the new ID alone would incorrectly use fixed thinking budgets', async () => {
  const payload = await payloadFor({ ...model, compat: {} }, 'high');
  expect(payload.thinking.type).toBe('enabled');
  expect(payload.thinking.budget_tokens).toBeGreaterThan(0);
  expect(payload.output_config).toBeUndefined();
});

it('never explicitly disables always-on thinking even if a caller omits reasoning', async () => {
  const payload = await payloadFor(model);
  expect(payload.thinking).toBeUndefined(); // Server's always-on default, not disabled.
});
