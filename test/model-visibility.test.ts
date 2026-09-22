import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { catalogModels, createConfigRefresher, readProfiles } from '../extensions/ultraterm-ui.ts';
import { curatedPickerModels, isRemovedOpenRouterFlash, sharedPickerModels } from '../src/model-visibility.ts';
import { guardModelRuntime, isModelRouteAllowed, selectChainedWorkerModel, type WorkerRouteStep } from '../src/model-route-policy.ts';
import { curatedPickerScope, type HarnessProfile } from '../src/harness-profiles.ts';

const route = (provider: string, id: string) => ({ provider, id, name: id });

describe('shared picker visibility removes the OpenRouter DeepSeek Flash routes', () => {
  it('drops the canonical V4/V4.1 Flash routes and every released/latest/batch alias', () => {
    const removed = [
      'deepseek/deepseek-v4-flash',
      'deepseek/deepseek-v4-flash-0731',
      'deepseek/deepseek-v4-flash-0731:batch',
      '~deepseek/deepseek-v4-flash-latest',
      'deepseek/deepseek-v4.1-flash',
      'deepseek/deepseek-v4.1-flash-latest',
      '~deepseek/deepseek-flash-latest',
    ];
    const kept = [
      'deepseek/deepseek-v4-flash-vision-exp',
      'deepseek/deepseek-v4-flash-vision-exp:batch',
      'deepseek/deepseek-v4-pro',
      'deepseek/deepseek-v4-pro-0813',
      'deepseek/deepseek-v4-pro-0813:batch',
      '~deepseek/deepseek-pro-latest',
      'deepseek/deepseek-chat-v3.1',
      'z-ai/glm-5.3-flash',
    ];
    const models = [...removed, ...kept].map(id => route('openrouter', id));
    expect(sharedPickerModels(models).map(model => model.id)).toEqual(kept);
    for (const id of removed) expect(isRemovedOpenRouterFlash(route('openrouter', id))).toBe(true);
    for (const id of kept) expect(isRemovedOpenRouterFlash(route('openrouter', id))).toBe(false);
  });

  it('is provider-scoped: Go Flash, INCO Fast and every other provider keep their routes', () => {
    const models = [
      route('opencode-go', 'deepseek-v4.1-flash'),
      route('inco', 'deepseek-v4.1-flash:fast'),
      route('vercel-ai-gateway', 'deepseek/deepseek-v4-flash-0731'),
      route('xiaomi', 'mimo-v2.6-pro'),
      route('zai', 'glm-5.3-flash'),
      route('openai-codex', 'gpt-6-astra'),
      route('openrouter', 'deepseek/deepseek-v4-flash'),
      route('openrouter', 'deepseek/deepseek-v4.1-flash'),
    ];
    expect(sharedPickerModels(models).map(model => `${model.provider}/${model.id}`)).toEqual([
      'opencode-go/deepseek-v4.1-flash',
      'inco/deepseek-v4.1-flash:fast',
      'vercel-ai-gateway/deepseek/deepseek-v4-flash-0731',
      'xiaomi/mimo-v2.6-pro',
      'zai/glm-5.3-flash',
      'openai-codex/gpt-6-astra',
    ]);
    // Never a blanket provider hide: the same-named route on another provider
    // is not the removed route and is never matched by substring.
    for (const provider of ['opencode-go', 'inco', 'vercel-ai-gateway', 'xiaomi', 'zai', 'openai-codex'])
      expect(models.filter(model => model.provider === provider).every(model => !isRemovedOpenRouterFlash(model))).toBe(true);
  });

  it('preserves caller order and the input list', () => {
    const models = [route('zai', 'glm-5.3-flash'), route('openrouter', 'deepseek/deepseek-v4-flash'), route('inco', 'deepseek-v4.1-flash:fast')];
    expect(sharedPickerModels(models).map(model => `${model.provider}/${model.id}`))
      .toEqual(['zai/glm-5.3-flash', 'inco/deepseek-v4.1-flash:fast']);
    expect(models).toHaveLength(3);
  });
});

/** The curated harness manifest is the picker scope for the real Pi 0.87 runtime. */
const HARNESS = 'steak-pi';
const OFF = 'http://127.0.0.1:1/v1';

function fixture() {
  const harnessDir = mkdtempSync(join(tmpdir(), 'mv-harness-'));
  const configDir = mkdtempSync(join(tmpdir(), 'mv-native-'));
  let tick = 0;
  // mtime/size is the revision: distinct stamps make every rewrite observable
  // even when two manifests happen to serialize to the same length.
  const write = (path: string, body: string) => {
    writeFileSync(path, body);
    tick += 1;
    const stamp = new Date(Date.now() + tick * 1000);
    utimesSync(path, stamp, stamp);
  };
  return {
    harnessDir, configDir,
    manifest: (profiles: unknown[], harness = HARNESS) => write(join(harnessDir, `${harness}.json`), JSON.stringify({ schemaVersion: 1, id: harness, profiles })),
    nativeProviders: (providers: Record<string, string[]>) => write(join(configDir, 'models.json'), JSON.stringify({ providers: Object.fromEntries(
      Object.entries(providers).map(([id, models]) => [id, { baseUrl: OFF, api: 'openai-completions', models: models.map(model => ({ id: model, name: model })) }])) })),
    credentials: (providers: string[]) => write(join(configDir, 'auth.json'), JSON.stringify(Object.fromEntries(
      providers.map(id => [id, { type: 'api_key', key: 'offline-fixture-key' }])))),
    cleanup: () => { rmSync(harnessDir, { recursive: true, force: true }); rmSync(configDir, { recursive: true, force: true }); },
  };
}

const configured = (id: string, name: string, route: string, thinking = 'high') => ({ id, name, args: ['--model', route, '--thinking', thinking] });

async function nativeRuntime(configDir: string) {
  const runtime = await ModelRuntime.create({ authPath: join(configDir, 'auth.json'), modelsPath: join(configDir, 'models.json'),
    modelsStorePath: join(configDir, 'models-store.json'), allowModelNetwork: false, refreshOnCreate: false });
  guardModelRuntime(runtime);
  const registry = new ModelRegistry(runtime);
  await registry.refresh({ allowNetwork: false, signal: AbortSignal.timeout(5000) });
  return { runtime, registry };
}

const pickerIds = (ctx: any) => catalogModels(ctx).map((profile: HarnessProfile) => `${profile.provider}/${profile.id}`);
const scope = (harnessDir: string) => { vi.stubEnv('ULTRATERM_HARNESS_DIR', harnessDir); vi.stubEnv('ULTRATERM_HARNESS_RESOURCES', join(harnessDir, 'none')); vi.stubEnv('ULTRATERM_HARNESS_ID', HARNESS); };
/**
 * A real-runtime fixture must not inherit the operator's ambient Pi state: `HOME`
 * and `PI_CODING_AGENT_DIR` hold live `auth.json`/harness manifests, and provider
 * `*_API_KEY` variables authenticate providers. Any of them would add routes to
 * the exact picker snapshot asserted here (the fail-open case reads the whole
 * native catalog), so each real-runtime test pins its own isolated environment.
 */
const isolateAmbient = (home: string) => {
  vi.stubEnv('HOME', home);
  vi.stubEnv('PI_CODING_AGENT_DIR', join(home, 'pi-agent'));
  for (const name of Object.keys(process.env)) if (/(_API_KEY|_KEY|_TOKEN)$/.test(name)) vi.stubEnv(name, '');
};

describe('curated harness profiles are the only picker scope, for native /model and the composer', () => {
  it('publishes exactly the configured, authenticated and policy-valid profile routes from the real runtime', async () => {
    const f = fixture();
    const fetch = vi.fn(() => { throw new Error('Network forbidden'); });
    vi.stubGlobal('fetch', fetch);
    scope(f.harnessDir);
    isolateAmbient(join(f.harnessDir, 'home'));
    try {
      // Two curated routes plus routes that must never become choices: an
      // unconfigured provider, a curated OpenRouter Flash duplicate and a curated
      // paid GPT route the native policy refuses.
      f.manifest([
        configured('first', 'First', 'alpha/first-model', 'high'),
        configured('second', 'Second', 'beta/second-model', 'low'),
        configured('flash', 'Flash', 'openrouter/deepseek/deepseek-v4-flash', 'high'),
        configured('gpt', 'GPT', 'openrouter/gpt-6-astra', 'high'),
      ]);
      f.nativeProviders({ alpha: ['first-model'], beta: ['second-model'], gamma: ['extra-model'],
        openrouter: ['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4-pro', 'gpt-6-astra'] });
      f.credentials(['alpha', 'beta', 'gamma', 'openrouter']);
      const { runtime, registry } = await nativeRuntime(f.configDir);
      // The sidebar manifest is read as metadata: labels, effort and the exact route.
      const profiles = readProfiles();
      expect(profiles.map(profile => `${profile.profileId}:${profile.provider}/${profile.id}:${profile.thinking}`))
        .toEqual(['steak-pi/first:alpha/first-model:high', 'steak-pi/second:beta/second-model:low',
          'steak-pi/flash:openrouter/deepseek/deepseek-v4-flash:high', 'steak-pi/gpt:openrouter/gpt-6-astra:high']);
      const ctx: any = { modelRegistry: registry, scopedModels: [], model: undefined };
      // The manifest scope is the sidebar authority; the curated Flash duplicate is
      // removed by the shared rule and the curated GPT route is refused by policy.
      expect([...curatedPickerScope()!].sort())
        .toEqual(['alpha/first-model', 'beta/second-model', 'openrouter/deepseek/deepseek-v4-flash', 'openrouter/gpt-6-astra']);
      expect(isRemovedOpenRouterFlash({ provider: 'openrouter', id: 'deepseek/deepseek-v4-flash' })).toBe(true);
      expect(isModelRouteAllowed({ provider: 'openrouter', id: 'gpt-6-astra' })).toBe(false);
      // Native /model renders the curated snapshot; the composer renders the same.
      // An authenticated route the manifest does not configure (openrouter
      // deepseek-v4-pro) is dispatch-only and never becomes a choice.
      expect(runtime.getAvailableSnapshot().map((model: any) => `${model.provider}/${model.id}`))
        .toEqual(['alpha/first-model', 'beta/second-model']);
      expect(pickerIds(ctx)).toEqual(['alpha/first-model', 'beta/second-model']);
      expect(catalogModels(ctx)).toEqual([
        expect.objectContaining({ profileId: 'steak-pi/first', label: 'First', provider: 'alpha', id: 'first-model', thinking: 'high' }),
        expect.objectContaining({ profileId: 'steak-pi/second', label: 'Second', provider: 'beta', id: 'second-model', thinking: 'low' }),
      ]);
      // Dispatch and fallback keep the whole native library: the Go GLM-style
      // fallback stays reachable even when it is not a separate picker choice.
      const dispatch = runtime.getModels().map((model: any) => `${model.provider}/${model.id}`);
      expect(dispatch).toContain('gamma/extra-model');
      expect(dispatch).toContain('openrouter/deepseek/deepseek-v4-pro');
      expect(dispatch).toContain('openrouter/deepseek/deepseek-v4-flash');
      expect(dispatch).toContain('openrouter/gpt-6-astra');
      const chain: WorkerRouteStep[] = [{ provider: 'gamma', id: 'extra-model' }];
      expect(selectChainedWorkerModel(registry, chain)?.id).toBe('extra-model');
      expect(fetch).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); f.cleanup(); }
  });

  it('keeps native availability when no harness manifest exists, and an empty curated list when one does', async () => {
    const f = fixture();
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden'); }));
    try {
      f.nativeProviders({ alpha: ['first-model'], beta: ['second-model'] });
      f.credentials(['alpha', 'beta']);
      // No manifest anywhere: unknown metadata keeps the native catalog rather than
      // hiding every model in a broken install, and both pickers still agree.
      scope(mkdtempSync(join(tmpdir(), 'mv-empty-')));
      isolateAmbient(join(f.harnessDir, 'home'));
      const absent = await nativeRuntime(f.configDir);
      const ctx: any = { modelRegistry: absent.registry, scopedModels: [], model: undefined };
      expect(absent.runtime.getAvailableSnapshot().map((model: any) => `${model.provider}/${model.id}`))
        .toEqual(['alpha/first-model', 'beta/second-model']);
      expect(pickerIds(ctx)).toEqual(['alpha/first-model', 'beta/second-model']);
      // A manifest that resolves no native route is authority: the sidebar shows an
      // empty list, so the pickers show an empty list too.
      f.manifest([{ id: 'cli-only', name: 'CLI only', args: ['--extension', '/untrusted.ts'] }]);
      scope(f.harnessDir);
      const empty = await nativeRuntime(f.configDir);
      expect(empty.runtime.getAvailableSnapshot()).toEqual([]);
      expect(pickerIds({ modelRegistry: empty.registry, scopedModels: [], model: undefined })).toEqual([]);
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); f.cleanup(); }
  });

  it('follows profile add, rename and removal, plus credential loss, without switching the running model', async () => {
    const f = fixture();
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden'); }));
    scope(f.harnessDir);
    isolateAmbient(join(f.harnessDir, 'home'));
    try {
      f.manifest([configured('first', 'First', 'alpha/first-model')]);
      f.nativeProviders({ alpha: ['first-model', 'renamed-model'], beta: ['second-model'] });
      f.credentials(['alpha', 'beta']);
      const { runtime, registry } = await nativeRuntime(f.configDir);
      const refresher = createConfigRefresher({ directory: f.configDir });
      const running = runtime.getModel('alpha', 'first-model')!;
      const ctx: any = { modelRegistry: registry, scopedModels: [], model: running };
      const snapshot = () => runtime.getAvailableSnapshot().map((model: any) => `${model.provider}/${model.id}`);
      const expectParity = () => { expect(pickerIds(ctx)).toEqual(snapshot()); };
      expect(refresher.changed()).toBe(false);
      expect(snapshot()).toEqual(['alpha/first-model']);
      expectParity();
      // Add: the manifest revision alone drives the reload that reaches both pickers.
      f.manifest([configured('first', 'First', 'alpha/first-model'), configured('second', 'Second', 'beta/second-model', 'low')]);
      expect(refresher.changed()).toBe(true);
      await refresher.sync(registry);
      expect(snapshot()).toEqual(['alpha/first-model', 'beta/second-model']);
      expect(catalogModels(ctx)).toContainEqual(expect.objectContaining({ profileId: 'steak-pi/second', label: 'Second', thinking: 'low' }));
      expectParity();
      // Rename the label: metadata changes, the route does not.
      f.manifest([configured('first', 'First Renamed', 'alpha/first-model'), configured('second', 'Second', 'beta/second-model', 'low')]);
      await refresher.sync(registry);
      expect(catalogModels(ctx)).toContainEqual(expect.objectContaining({ id: 'first-model', label: 'First Renamed' }));
      expect(snapshot()).toEqual(['alpha/first-model', 'beta/second-model']);
      // Rename the route: the old choice leaves, the new one arrives, same reload.
      f.manifest([configured('first', 'First Renamed', 'alpha/renamed-model'), configured('second', 'Second', 'beta/second-model', 'low')]);
      await refresher.sync(registry);
      expect(snapshot()).toEqual(['alpha/renamed-model', 'beta/second-model']);
      expect(pickerIds(ctx)).not.toContain('alpha/first-model');
      expectParity();
      // A stale launch scope naming a removed route never resurrects it as a choice;
      // for a route that is still configured, the scope supplies only effort.
      ctx.scopedModels = [{ model: running, thinkingLevel: 'max' }, { model: runtime.getModel('beta', 'second-model'), thinkingLevel: 'high' }];
      expect(pickerIds(ctx)).not.toContain('alpha/first-model');
      expect(catalogModels(ctx)).toContainEqual(expect.objectContaining({ id: 'second-model', thinking: 'high' }));
      // Remove: the choice disappears while the running model keeps running and
      // stays in the unfiltered dispatch catalog.
      f.manifest([configured('second', 'Second', 'beta/second-model', 'low')]);
      await refresher.sync(registry);
      expect(snapshot()).toEqual(['beta/second-model']);
      expect(pickerIds(ctx)).toEqual(['beta/second-model']);
      expect(ctx.model).toBe(running);
      expect(runtime.getModels('alpha').map((model: any) => model.id)).toContain('first-model');
      // Credential loss removes the last curated choice from both pickers, never
      // from dispatch, and an unchanged manifest does not reload again.
      f.credentials(['alpha']);
      await refresher.sync(registry);
      expect(snapshot()).toEqual([]);
      expect(pickerIds(ctx)).toEqual([]);
      expect(runtime.getModels('beta').map((model: any) => model.id)).toContain('second-model');
      expect(refresher.changed()).toBe(false);
    } finally { vi.unstubAllGlobals(); vi.unstubAllEnvs(); f.cleanup(); }
  });

  it('narrows a shared catalog without re-adding removed routes through a stale scope', () => {
    const scopeSet = new Set(['alpha/first-model']);
    const models = [route('alpha', 'first-model'), route('alpha', 'removed-model'), route('beta', 'second-model')];
    expect(curatedPickerModels(models, scopeSet).map(model => `${model.provider}/${model.id}`)).toEqual(['alpha/first-model']);
    expect(curatedPickerModels(models, new Set()).length).toBe(0);
    expect(curatedPickerModels(models, undefined).map(model => model.id)).toEqual(['first-model', 'removed-model', 'second-model']);
    expect(models).toHaveLength(3);
  });
});
