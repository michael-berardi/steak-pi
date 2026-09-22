import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { catalogModels, createConfigRefresher } from '../extensions/ultraterm-ui.ts';
import { isRemovedOpenRouterFlash, sharedPickerModels } from '../src/model-visibility.ts';
import { guardModelRuntime, isModelRouteAllowed } from '../src/model-route-policy.ts';

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

/** Picker authority: the exact snapshot native `/model` renders, then the published catalog. */
function pickerSnapshot(runtime: any): string[] {
  return [...runtime.getAvailableSnapshot().map((model: any) => `${model.provider}/${model.id}`)].sort();
}
function catalog(ctx: any): any[] { return catalogModels(ctx, () => []); }
const pickerIds = (models: any[]) => models.map(model => `${model.provider}/${model.id}`);

describe('native picker source and shared catalog stay one authority', () => {
  it('does not re-add the running removed route, or a stale scope entry naming it, into the choices', () => {
    const active = route('openrouter', 'deepseek/deepseek-v4-flash');
    const goFlash = { provider: 'opencode-go', id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' };
    const glm = { provider: 'zai', id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' };
    const registry: any = { getAvailable: () => [active, goFlash], hasConfiguredAuth: () => true };
    // The running route stays published as currentModel; it must not come back
    // as a selectable choice.
    expect(pickerIds(catalog({ modelRegistry: registry, scopedModels: [], model: active }))).toEqual(['opencode-go/deepseek-v4.1-flash']);
    // A stale scope entry naming a removed route never unions it back in, and
    // its effort preference cannot resurrect it either.
    const stale = { provider: 'openrouter', id: '~deepseek/deepseek-v4-flash-latest', name: 'DeepSeek V4 Flash Latest' };
    const scopedRegistry: any = { getAvailable: () => [glm], hasConfiguredAuth: () => true };
    expect(pickerIds(catalog({ modelRegistry: scopedRegistry, scopedModels: [{ model: stale, thinkingLevel: 'high' }], model: stale })))
      .toEqual(['zai/glm-5.3-flash']);
  });

  it('removes only the OpenRouter DeepSeek Flash routes from the real Pi 0.87 native choice source', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mv-native-'));
    const modelsPath = join(directory, 'models.json'), authPath = join(directory, 'auth.json');
    const fetch = vi.fn(() => { throw new Error('Network forbidden'); });
    vi.stubGlobal('fetch', fetch);
    try {
      writeFileSync(modelsPath, '{}');
      writeFileSync(authPath, JSON.stringify({ openrouter: { type: 'api_key', key: 'offline-fixture-key' } }));
      const runtime = await ModelRuntime.create({ authPath, modelsPath, allowModelNetwork: false, refreshOnCreate: false });
      guardModelRuntime(runtime);
      const registry = new ModelRegistry(runtime);
      await registry.refresh({ allowNetwork: false });
      const available = runtime.getAvailableSnapshot().filter((model: any) => model.provider === 'openrouter').map((model: any) => model.id);
      const published = runtime.getModels('openrouter').map((model: any) => model.id);
      // The real 0.87 catalog serves the whole Flash line; the picker shows none of it.
      const removed = published.filter((id: string) => isRemovedOpenRouterFlash({ provider: 'openrouter', id }));
      expect(removed).toEqual(expect.arrayContaining([
        'deepseek/deepseek-v4-flash',
        'deepseek/deepseek-v4-flash-0731',
        'deepseek/deepseek-v4-flash-0731:batch',
        'deepseek/deepseek-v4.1-flash',
        '~deepseek/deepseek-v4-flash-latest',
      ]));
      for (const id of removed) {
        expect(published).toContain(id);      // dispatch coverage is untouched
        expect(available).not.toContain(id);  // gone from native `/model`
      }
      // Distinct variants and unrelated OpenRouter models stay visible.
      for (const id of ['deepseek/deepseek-v4-flash-vision-exp', 'deepseek/deepseek-v4-flash-vision-exp:batch',
        'deepseek/deepseek-v4-pro', 'deepseek/deepseek-v4-pro-0813', 'deepseek/deepseek-v4-pro-0813:batch',
        '~deepseek/deepseek-pro-latest', 'deepseek/deepseek-chat-v3.1'])
        expect(available).toContain(id);
      // Exactly the GPT policy plus the removed Flash routes: never a provider hide.
      const expected = sharedPickerModels(runtime.getModels('openrouter').filter((model: any) => isModelRouteAllowed(model))).map((model: any) => model.id).sort();
      expect([...available].sort()).toEqual(expected);
      // Other providers keep their own `latest` aliases.
      expect(available).toContain('~z-ai/glm-flash-latest');
      // The published catalog is the same source, not a parallel list.
      const ctx: any = { modelRegistry: registry, scopedModels: [], model: undefined };
      expect(pickerIds(catalog(ctx)).sort()).toEqual(pickerSnapshot(runtime));
      expect(pickerIds(catalog(ctx))).not.toContain('openrouter/deepseek/deepseek-v4-flash');
      expect(pickerIds(catalog(ctx))).not.toContain('openrouter/~deepseek/deepseek-v4-flash-latest');
      expect(fetch).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('propagates added, renamed, removed and unauthenticated configured models to both pickers without switching the running model', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mv-config-'));
    const modelsPath = join(directory, 'models.json'), authPath = join(directory, 'auth.json');
    const provider = (id: string, modelId: string, name = modelId) => ({ [id]: { baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', models: [{ id: modelId, name }] } });
    const credential = (ids: string[]) => JSON.stringify(Object.fromEntries(ids.map(id => [id, { type: 'api_key', key: 'offline-fixture-key' }])));
    const fetch = vi.fn(() => { throw new Error('Network forbidden'); });
    vi.stubGlobal('fetch', fetch);
    try {
      // The refresher exists before any config does, so the first write is a real observed revision.
      const refresher = createConfigRefresher({ directory, backoffMs: 30_000 });
      const runtime = await ModelRuntime.create({ authPath, modelsPath, allowModelNetwork: false, refreshOnCreate: false });
      guardModelRuntime(runtime);
      const registry = new ModelRegistry(runtime);
      let selected: any;
      const scoped: any[] = [];
      const ctx: any = { modelRegistry: registry, scopedModels: scoped, get model() { return selected; } };
      writeFileSync(modelsPath, JSON.stringify({ providers: provider('freshroute', 'fresh-model', 'Fresh Model') }));
      writeFileSync(authPath, credential(['freshroute']));
      expect(refresher.changed()).toBe(true);
      await refresher.sync(registry);
      selected = registry.find('freshroute', 'fresh-model');
      expect(selected).toBeDefined();
      // An old launch scope must not resurrect this route after removal.
      scoped.push({ model: selected, thinkingLevel: 'medium' });
      const assertParity = () => {
        // The native picker's own choice source and the published catalog are the same list.
        expect(pickerIds(catalog(ctx)).sort()).toEqual(pickerSnapshot(runtime));
      };
      expect(runtime.getAvailableSnapshot().map((model: any) => `${model.provider}/${model.id}`)).toContain('freshroute/fresh-model');
      expect(catalog(ctx)).toContainEqual(expect.objectContaining({ provider: 'freshroute', id: 'fresh-model', label: 'Fresh Model' }));
      assertParity();
      // Add: a second configured provider appears in both without a restart.
      writeFileSync(modelsPath, JSON.stringify({ providers: { ...provider('freshroute', 'fresh-model', 'Fresh Model'), ...provider('secondroute', 'second-model', 'Second Model') } }));
      writeFileSync(authPath, credential(['freshroute', 'secondroute']));
      expect(refresher.changed()).toBe(true);
      await refresher.sync(registry);
      expect(runtime.getAvailableSnapshot().map((model: any) => `${model.provider}/${model.id}`)).toContain('secondroute/second-model');
      expect(catalog(ctx)).toContainEqual(expect.objectContaining({ provider: 'secondroute', id: 'second-model', label: 'Second Model' }));
      assertParity();
      expect(ctx.model).toBe(selected);
      // Keep a deliberately stale launch-scope object through label/id changes.
      scoped.push({ model: registry.find('secondroute', 'second-model'), thinkingLevel: 'medium' });
      // Rename a label: both pickers show the new one, the route is unchanged.
      writeFileSync(modelsPath, JSON.stringify({ providers: { ...provider('freshroute', 'fresh-model', 'Fresh Model'), ...provider('secondroute', 'second-model', 'Second Model Renamed') } }));
      await refresher.sync(registry);
      expect(runtime.getAvailableSnapshot().find((model: any) => model.id === 'second-model')?.name).toBe('Second Model Renamed');
      expect(catalog(ctx)).toContainEqual(expect.objectContaining({ provider: 'secondroute', id: 'second-model', label: 'Second Model Renamed' }));
      assertParity();
      // Rename an id: the old route disappears from both at once.
      writeFileSync(modelsPath, JSON.stringify({ providers: { ...provider('freshroute', 'fresh-model', 'Fresh Model'), ...provider('secondroute', 'second-model-v2', 'Second Model Renamed') } }));
      await refresher.sync(registry);
      const afterRename = pickerSnapshot(runtime);
      expect(afterRename).toContain('secondroute/second-model-v2');
      expect(afterRename).not.toContain('secondroute/second-model');
      expect(catalog(ctx)).toContainEqual(expect.objectContaining({ provider: 'secondroute', id: 'second-model-v2' }));
      assertParity();
      // Remove: the route leaves both while the running model is untouched (no silent switch).
      writeFileSync(modelsPath, JSON.stringify({ providers: provider('secondroute', 'second-model-v2', 'Second Model Renamed') }));
      await refresher.sync(registry);
      expect(pickerSnapshot(runtime)).not.toContain('freshroute/fresh-model');
      expect(pickerIds(catalog(ctx))).not.toContain('freshroute/fresh-model');
      assertParity();
      expect(ctx.model).toBe(selected);
      // The removed model is only gone from availability, never from the catalog/dispatch source.
      expect(runtime.getModels('freshroute').map((model: any) => model.id)).toEqual([]);
      // Auth update: dropping a credential hides the route from both pickers at
      // once, while the catalog/dispatch source and the running model are untouched.
      writeFileSync(authPath, JSON.stringify({}));
      expect(refresher.changed()).toBe(true);
      await refresher.sync(registry);
      expect(pickerSnapshot(runtime)).not.toContain('secondroute/second-model-v2');
      expect(pickerIds(catalog(ctx))).not.toContain('secondroute/second-model-v2');
      assertParity();
      expect(ctx.model).toBe(selected);
      expect(runtime.getModels('secondroute').map((model: any) => model.id)).toEqual(['second-model-v2']);
      expect(fetch).not.toHaveBeenCalled();
      expect(registry.getError()).toBeUndefined();
    } finally { vi.unstubAllGlobals(); rmSync(directory, { recursive: true, force: true }); }
  }, 30_000);
});
