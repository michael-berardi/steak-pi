import { createExplicitPaidApproval } from "../src/explicit-paid-route.ts";
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { ModelRegistry, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { decodeRequest, installUi, builtinCommands, readProfiles, publishCatalog, catalogModels, createConfigRefresher, configRevision, nativeConfigDir, CONFIG_POLL_MS } from '../extensions/ultraterm-ui.ts';
import type { ConfigRefresh, NativeReloadOptions } from '../extensions/ultraterm-ui.ts';
import type { getPrimaryHostIdentity } from '../src/primary-host.ts';

const profile = { profileId: 'steak-pi/glm-5-3-flash', label: 'Flash', provider: 'zai', id: 'glm-5.3-flash', thinking: 'high' as const };
const request = (extra = {}) => ({ version: 1, sessionId: 's1', generation: 'g1', requestId: 'r1', action: 'message', text: 'Exact\r\nmessage  ', model: { provider: profile.provider, id: profile.id }, thinking: 'high', ...extra });
const encode = (data: unknown) => Buffer.from(JSON.stringify(data)).toString('base64url');
/** Directory that never contains native config, so unrelated tests never refresh. */
const absentConfigDir = join(tmpdir(), 'ut20-no-native-config');
function harness(options: { configDir?: string; refresh?: () => ConfigRefresh } = {}) {
  const handlers = new Map<string, Function>();
  const entries: any[] = [], messages: string[] = [];
  const prior = { provider: 'openai-codex', id: 'gpt-6-astra', api: 'openai-codex-responses' };
  const target = { provider: profile.provider, id: profile.id, api: 'openai-completions' };
  let model: any = prior, thinking: any = 'medium';
  let available: any[] = [target];
  let host: any = { pid: process.pid, sessionId: 's1', sessionFile: '/session.jsonl', generation: 'g1' };
  const manager = { getSessionId: () => 's1', getSessionFile: () => '/session.jsonl', getSessionDir: () => '/sessions' };
  const refresh = vi.fn(async (_options: NativeReloadOptions) => ({ aborted: false, errors: new Map() }));
  const modelRegistry: any = { getAvailable: () => available, find: vi.fn(() => target), hasConfiguredAuth: () => true, isUsingOAuth: () => true, getApiKeyAndHeaders: async () => ({ ok: true }), refresh };
  const context: any = { sessionManager: manager, scopedModels: [], isIdle: () => true, waitForIdle: vi.fn(async () => {}), get model() { return model; }, ui: { notify: vi.fn() }, switchSession: vi.fn(async () => ({ cancelled: true })), modelRegistry };
  const pi: any = { exec: vi.fn(async () => ({ code: 0, stdout: '' })), events: { on: () => () => {}, emit: vi.fn() }, on: (name: string, fn: Function) => handlers.set(name, fn), registerCommand: (_name: string, command: any) => handlers.set('command', command.handler), appendEntry: (type: string, data: unknown) => entries.push({ type, data }), getCommands: () => [], getThinkingLevel: () => thinking, setThinkingLevel: (level: string) => { thinking = level; }, setModel: vi.fn(async (value: any) => { model = value; return true; }), sendUserMessage: (text: string) => messages.push(text) };
  const configDir = options.configDir ?? absentConfigDir;
  const factory = options.refresh ?? (() => createConfigRefresher({ directory: configDir }));
  installUi(pi as ExtensionAPI, () => [profile], path => path, (() => host) as typeof getPrimaryHostIdentity, async () => [], factory);
  return { context, pi, entries, messages, prior, target, modelRegistry, refresh, event: (name: string) => handlers.get(name)!({}, context), start: () => handlers.get('session_start')!({}, context), shutdown: () => handlers.get('session_shutdown')!(), run: (data: unknown = request()) => handlers.get('command')!(encode(data), context as ExtensionCommandContext), replaceHost: () => { host = { ...host, generation: 'g2' }; }, setAvailable: (models: any[]) => { available = models; }, model: () => model, thinking: () => thinking };
}

describe('Pi UI machine control', () => {
  it('publishes initial choices through the pinned tmux before any user message, retrying a failed write', async () => {
    vi.useFakeTimers(); vi.stubEnv('TMUX_BIN', '/pinned/tmux'); vi.stubEnv('TMUX_PANE', '%42');
    const h = harness();
    h.pi.exec.mockResolvedValueOnce({ code: 1, stdout: '' });
    try {
      h.start(); await vi.advanceTimersByTimeAsync(1);
      expect(h.pi.exec).toHaveBeenCalledWith('/pinned/tmux', expect.arrayContaining(['@pi-ui-catalog']), { timeout: 1000 });
      await vi.advanceTimersByTimeAsync(101);
      expect(h.pi.exec).toHaveBeenCalledTimes(2);
      expect(h.entries.at(-1).data.models).toEqual([profile]);
      expect(h.messages).toEqual([]); expect(h.pi.setModel).not.toHaveBeenCalled();
    } finally { h.shutdown(); vi.useRealTimers(); vi.unstubAllEnvs(); }
  });
  it('shares all active native routes while retaining scoped effort preferences', () => {
    const h = harness();
    const models = [h.target, h.prior, { provider: 'opencode-go', id: 'deepseek-v4.1-flash' }, { provider: 'inco', id: 'glm-5.3-flash:fast' }];
    h.context.modelRegistry.getAvailable = () => models;
    expect(catalogModels(h.context, () => []).map(p => `${p.provider}/${p.id}`)).toEqual([
      'zai/glm-5.3-flash', 'openai-codex/gpt-6-astra', 'opencode-go/deepseek-v4.1-flash', 'inco/glm-5.3-flash:fast',
    ]);
    h.context.scopedModels = [{ model: models[3], thinkingLevel: 'high' }];
    const catalog = catalogModels(h.context, () => [profile]);
    expect(catalog).toHaveLength(4);
    expect(catalog).toContainEqual(expect.objectContaining({ provider: 'inco', thinking: 'high' }));
    h.context.modelRegistry.hasConfiguredAuth = () => false;
    expect(catalogModels(h.context, () => [])).toEqual([]);
  });
  it('uses medium rather than unsupported off when a reasoning model has no profile metadata', () => {
    const h = harness();
    h.context.modelRegistry.getAvailable = () => [{ ...h.prior, reasoning: true }, { ...h.target, reasoning: false }];
    expect(catalogModels(h.context, () => []).map(model => model.thinking)).toEqual(['medium', 'off']);
  });
  it('switches without inference and republishes current native selection and thinking', async () => {
    vi.useFakeTimers(); const h = harness();
    try {
      const { text, ...control } = request({ action: 'model' });
      await h.run(control as any); await vi.advanceTimersByTimeAsync(1);
      expect(h.messages).toEqual([]); expect(h.context.switchSession).not.toHaveBeenCalled();
      expect(h.entries.at(-1).data).toMatchObject({ version: 1, actions: ['resume', 'message', 'model'], currentModel: { provider: 'zai', id: 'glm-5.3-flash', thinking: 'high' } });
      await h.pi.setModel(h.prior); h.event('model_select'); await vi.advanceTimersByTimeAsync(1);
      expect(h.entries.at(-1).data.currentModel.id).toBe('gpt-6-astra');
      h.pi.setThinkingLevel('low'); h.event('thinking_level_select'); await vi.advanceTimersByTimeAsync(1);
      expect(h.entries.at(-1).data.currentModel.thinking).toBe('low');
      expect(() => decodeRequest(encode(request({ action: 'model' })))).toThrow();
    } finally { h.shutdown(); vi.useRealTimers(); }
  });
  it.each(['busy', 'stale', 'auth', 'unavailable', 'clamped', 'codex'])('model-only fails safely for %s', async reason => {
    const h = harness(); const { text, ...control } = request({ action: 'model' });
    if (reason === 'busy') h.context.isIdle = () => false;
    if (reason === 'stale') control.generation = 'old';
    if (reason === 'auth') h.context.modelRegistry.hasConfiguredAuth = () => false;
    if (reason === 'unavailable') h.context.modelRegistry.getAvailable = () => [];
    if (reason === 'clamped') h.pi.setThinkingLevel = () => {};
    if (reason === 'codex') { h.context.modelRegistry.getAvailable = () => [h.prior]; control.model = { provider: h.prior.provider, id: h.prior.id }; h.context.modelRegistry.isUsingOAuth = () => false; }
    await h.run(control as any);
    expect(h.messages).toEqual([]); expect(h.model()).toBe(h.prior);
    expect(h.entries.at(-1).data.ok).toBe(false);
  });
  it('keeps optional broken profile metadata from hiding authenticated native choices', () => {
    const h = harness();
    expect(catalogModels(h.context, () => { throw new Error('bad metadata'); })).toEqual([expect.objectContaining({ provider: 'zai' })]);
  });
  it('rechecks native scope after asynchronous auth resolution', async () => {
    const h = harness(); const { text, ...control } = request({ action: 'model' });
    h.context.modelRegistry.getApiKeyAndHeaders = async () => { h.context.scopedModels = [{ model: h.prior }]; return { ok: true }; };
    await h.run(control as any);
    expect(h.pi.setModel).not.toHaveBeenCalled(); expect(h.messages).toEqual([]);
  });
  it('does not restore through a revoked identity after a model switch', async () => {
    const h = harness(); const { text, ...control } = request({ action: 'model' });
    const select = h.pi.setModel.getMockImplementation();
    h.pi.setModel.mockImplementation(async (model: any) => { await select(model); h.replaceHost(); return true; });
    await h.run(control as any);
    expect(h.pi.setModel).toHaveBeenCalledTimes(1); expect(h.messages).toEqual([]); expect(h.entries).toEqual([]);
  });
  it('does not leak unresolved model-only authentication errors', async () => {
    const h = harness(); const { text, ...control } = request({ action: 'model' });
    h.context.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: false, error: 'PRIVATE' });
    await h.run(control as any);
    expect(h.pi.setModel).not.toHaveBeenCalled(); expect(JSON.stringify(h.entries)).not.toContain('PRIVATE');
  });
  it('publishes a large full catalog through a private temporary source and cleans up on failure', async () => {
    let source = '';
    const exec = vi.fn(async (_binary: string, args: string[]) => {
      expect(args[0]).toBe('source-file'); source = args[1];
      expect(statSync(source).mode & 0o777).toBe(0o600);
      const text = readFileSync(source, 'utf8');
      expect(text).toContain('if-shell -F -t %42');
      expect(text).toContain('@pi-primary-host');
      expect(text).toContain('x'.repeat(35000));
      throw new Error('synthetic failure');
    });
    await expect(publishCatalog({ exec } as unknown as ExtensionAPI, '%42', { sessionId: 's1' }, JSON.stringify({ description: 'x'.repeat(35000) }))).rejects.toThrow('synthetic failure');
    expect(exec).toHaveBeenCalledOnce(); expect(existsSync(source)).toBe(false);
  });

  it('rejects malformed, injected and unsupported payloads', () => {
    for (const value of ['', 'abc\n/model', encode({ ...request(), action: 'exec' }), encode({ ...request(), extra: true }), encode({ version: 1, action: 'resume', path: '/safe/../bad.jsonl' })]) expect(() => decodeRequest(value)).toThrow();
    expect(decodeRequest(encode(request())).action).toBe('message');
  });
  it('waits before changing model and sends exact text in the same manager', async () => {
    const h = harness(); let release!: () => void;
    h.context.waitForIdle = () => new Promise<void>(resolve => { release = resolve; });
    const pending = h.run(); await Promise.resolve();
    expect(h.pi.setModel).not.toHaveBeenCalled(); expect(h.messages).toEqual([]);
    release(); await pending;
    expect(h.model()).toBe(h.target); expect(h.thinking()).toBe('high');
    expect(h.messages).toEqual(['Exact\r\nmessage  ']);
    expect(h.context.switchSession).not.toHaveBeenCalled();
  });
  it('rejects replacement identity while queued', async () => {
    const h = harness(); h.context.waitForIdle = async () => h.replaceHost();
    await h.run(); expect(h.pi.setModel).not.toHaveBeenCalled(); expect(h.messages).toEqual([]);
  });
  it('accepts native effort changes independent of profile defaults', async () => {
    const h = harness(); await h.run(request({ thinking: 'low' }));
    expect(h.thinking()).toBe('low'); expect(h.messages).toHaveLength(1);
  });
  it('rolls back a capability-clamped effort without sending', async () => {
    const h = harness(); h.pi.setThinkingLevel = (_level: string) => {};
    await h.run(); expect(h.messages).toEqual([]); expect(h.model()).toBe(h.prior);
    expect(h.entries.at(-1).data.ok).toBe(false);
  });
  it('does not send through an unavailable credential route', async () => {
    const h = harness(); h.context.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: false, error: 'PRIVATE CREDENTIAL' });
    await h.run(); expect(h.pi.setModel).not.toHaveBeenCalled(); expect(JSON.stringify(h.entries)).not.toContain('PRIVATE');
  });
  it('does not report a cancelled resume as success', async () => {
    const h = harness(); await h.run({ version: 1, sessionId: 's1', generation: 'g1', requestId: 'resume1', action: 'resume', path: '/sessions/selected.jsonl' } as any);
    expect(h.context.switchSession).toHaveBeenCalled(); expect(h.entries.at(-1).data.ok).toBe(false);
    expect(h.messages).toEqual([]);
  });
  it('uses plain session replacement without a revoked API callback or hidden message', async () => {
    const h = harness(); h.context.switchSession = vi.fn(async () => { h.replaceHost(); return { cancelled: false }; });
    await h.run({ version: 1, sessionId: 's1', generation: 'g1', requestId: 'resume2', action: 'resume', path: '/sessions/selected.jsonl' } as any);
    expect(h.context.switchSession).toHaveBeenCalledWith('/sessions/selected.jsonl');
    expect(h.entries).toEqual([]); expect(h.messages).toEqual([]);
  });
  it('rejects a request for an old primary identity before applying effects', async () => {
    const h = harness(); await h.run(request({ generation: 'old-generation' }));
    expect(h.pi.setModel).not.toHaveBeenCalled(); expect(h.context.waitForIdle).not.toHaveBeenCalled();
    expect(h.messages).toEqual([]);
  });
  it('loads the actual pinned Pi builtin inventory', async () => {
    const commands = await builtinCommands(); expect(commands.some(command => command.name === 'resume')).toBe(true);
    expect(commands.every(command => command.source === 'builtin')).toBe(true);
  });
  it('reads arbitrary safe profile labels without making profiles catalog authority', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ut20-profile-test-'));
    let profiles: ReturnType<typeof readProfiles>;
    try {
      writeFileSync(join(directory, 'steak-pi.json'), JSON.stringify({ schemaVersion: 1, id: 'steak-pi', profiles: [{ id: 'arbitrary-new-profile-id', name: 'DeepSeek V4.1 Flash', args: ['--model', 'openrouter/deepseek/deepseek-v4.1-flash', '--thinking', 'high'] }] }));
      profiles = readProfiles(directory);
    } finally { rmSync(directory, { recursive: true, force: true }); }
    expect(profiles).toHaveLength(1);
    expect(profiles.some(p => p.provider === 'openrouter' && p.id === 'deepseek/deepseek-v4.1-flash' && p.thinking === 'high')).toBe(true);
  });

  it('resolves the native config directory from PI_CODING_AGENT_DIR without touching HOME defaults', () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', '/tmp/ut20-agent');
    try { expect(nativeConfigDir()).toBe('/tmp/ut20-agent'); } finally { vi.unstubAllEnvs(); }
    expect(nativeConfigDir({})).toBe(join(homedir(), '.pi/agent'));
    expect(nativeConfigDir({ PI_CODING_AGENT_DIR: '~/custom-agent' })).toBe(join(homedir(), 'custom-agent'));
  });

  it('hot-publishes a newly configured native model after one bounded offline reload', async () => {
    vi.useFakeTimers(); vi.stubEnv('TMUX_BIN', '/pinned/tmux'); vi.stubEnv('TMUX_PANE', '%42');
    const directory = mkdtempSync(join(tmpdir(), 'ut20-native-config-'));
    const config = join(directory, 'models.json');
    writeFileSync(config, '{"providers":{}}');
    const h = harness({ configDir: directory });
    const added = { provider: 'newroute', id: 'fresh-model', name: 'Fresh', api: 'openai-completions', reasoning: true };
    try {
      h.start(); await vi.advanceTimersByTimeAsync(1);
      expect(h.refresh).not.toHaveBeenCalled();
      expect(h.entries.at(-1).data.models).toEqual([profile]);
      // The native registry only knows the model once its reload actually ran.
      h.refresh.mockImplementation(async () => { h.setAvailable([h.target, added]); return { aborted: false, errors: new Map() }; });
      writeFileSync(config, '{"providers":{"newroute":{"baseUrl":"http://127.0.0.1"}}}');
      await vi.advanceTimersByTimeAsync(CONFIG_POLL_MS);
      expect(h.refresh).toHaveBeenCalledTimes(1);
      expect(h.refresh.mock.calls[0][0]).toMatchObject({ allowNetwork: false });
      expect(h.refresh.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
      const catalog = h.entries.at(-1).data;
      expect(catalog.version).toBe(1);
      expect(catalog.models.map((m: any) => `${m.provider}/${m.id}`)).toEqual(['zai/glm-5.3-flash', 'newroute/fresh-model']);
      expect(catalog.models[1]).toMatchObject({ label: 'Fresh', thinking: 'medium' });
      // The reload must preserve the session's current model identity and effort.
      expect(h.model()).toBe(h.prior);
      expect(catalog.currentModel).toEqual({ provider: h.prior.provider, id: h.prior.id, thinking: 'medium' });
      expect(h.pi.setModel).not.toHaveBeenCalled(); expect(h.messages).toEqual([]);
      // Unchanged files must never trigger another reload or publication.
      const published = h.entries.length;
      await vi.advanceTimersByTimeAsync(CONFIG_POLL_MS * 20);
      expect(h.refresh).toHaveBeenCalledTimes(1);
      expect(h.entries).toHaveLength(published);
    } finally { h.shutdown(); rmSync(directory, { recursive: true, force: true }); vi.useRealTimers(); vi.unstubAllEnvs(); }
  });

  it('removes a deleted native route from the running catalog on the next bounded reload', async () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(tmpdir(), 'ut20-native-remove-'));
    const config = join(directory, 'models.json');
    writeFileSync(config, '{"providers":{"newroute":{}}}');
    const h = harness({ configDir: directory });
    const added = { provider: 'newroute', id: 'fresh-model', api: 'openai-completions' };
    h.setAvailable([h.target, added]);
    try {
      h.start(); await vi.advanceTimersByTimeAsync(1);
      expect(h.entries.at(-1).data.models).toHaveLength(2);
      h.refresh.mockImplementation(async () => { h.setAvailable([h.target]); return { aborted: false, errors: new Map() }; });
      writeFileSync(config, '{"providers":{}}');
      await vi.advanceTimersByTimeAsync(CONFIG_POLL_MS);
      expect(h.refresh).toHaveBeenCalledTimes(1);
      expect(h.entries.at(-1).data.models.map((m: any) => m.id)).toEqual(['glm-5.3-flash']);
      expect(h.pi.setModel).not.toHaveBeenCalled(); expect(h.messages).toEqual([]);
    } finally { h.shutdown(); rmSync(directory, { recursive: true, force: true }); vi.useRealTimers(); }
  });

  it.each(['rejection', 'error-result', 'abort-result'])('keeps the last good catalog and backs off on %s', async (failure) => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(tmpdir(), 'ut20-native-broken-'));
    const config = join(directory, 'models.json');
    writeFileSync(config, '{"providers":{"broken":{}}}');
    const h = harness({ configDir: directory });
    h.refresh.mockImplementation(async () => {
      h.setAvailable([]); // Native failures may already have mutated the snapshot.
      if (failure === 'rejection') throw new Error('malformed models.json');
      return { aborted: failure === 'abort-result', errors: new Map(failure === 'error-result' ? [['fixture', new Error('refresh failed')]] : []) };
    });
    try {
      h.start(); await vi.advanceTimersByTimeAsync(1);
      const good = h.entries.at(-1).data.models;
      writeFileSync(config, '{"providers":{"broken":{"baseUrl":1}}}');
      await vi.advanceTimersByTimeAsync(CONFIG_POLL_MS);
      expect(h.refresh).toHaveBeenCalledTimes(1);
      // A failed reload never empties the catalog and never touches the session.
      expect(h.entries.at(-1).data.models).toEqual(good);
      h.event('agent_end'); await vi.advanceTimersByTimeAsync(1);
      expect(h.entries.at(-1).data.models).toEqual(good);
      expect(h.pi.setModel).not.toHaveBeenCalled(); expect(h.messages).toEqual([]);
      // Backoff: an unchanged failed revision is not retried on every poll.
      await vi.advanceTimersByTimeAsync(CONFIG_POLL_MS * 2);
      expect(h.refresh).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(CONFIG_POLL_MS);
      expect(h.refresh).toHaveBeenCalledTimes(2);
      // Recovery still lands immediately once the config loads again.
      h.refresh.mockImplementation(async () => ({ aborted: false, errors: new Map() }));
      await vi.advanceTimersByTimeAsync(CONFIG_POLL_MS * 3);
      expect(h.refresh).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(h.refresh).toHaveBeenCalledTimes(3);
    } finally { h.shutdown(); rmSync(directory, { recursive: true, force: true }); vi.useRealTimers(); }
  });

  it('clears the config watch and bounds an in-flight reload on session shutdown', async () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(tmpdir(), 'ut20-native-stop-'));
    const config = join(directory, 'models.json');
    writeFileSync(config, '{"providers":{"slow":{}}}');
    const h = harness({ configDir: directory });
    let signal: AbortSignal | undefined;
    h.refresh.mockImplementation(async (options: NativeReloadOptions) => { signal = options.signal; return await new Promise<never>(() => {}); });
    try {
      h.start(); await vi.advanceTimersByTimeAsync(1);
      writeFileSync(config, '{"providers":{"slow":{"baseUrl":"http://127.0.0.1"}}}');
      await vi.advanceTimersByTimeAsync(CONFIG_POLL_MS);
      expect(h.refresh).toHaveBeenCalledTimes(1);
      expect(signal?.aborted).toBe(false);
      h.shutdown();
      expect(signal?.aborted).toBe(true);
      const published = h.entries.length, exec: number = h.pi.exec.mock.calls.length;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(h.refresh).toHaveBeenCalledTimes(1);
      expect(h.entries).toHaveLength(published);
      expect(h.pi.exec.mock.calls).toHaveLength(exec);
    } finally { h.shutdown(); rmSync(directory, { recursive: true, force: true }); vi.useRealTimers(); }
  });

  it('native registry reload makes a newly configured model and credential available in-process without network', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ut20-native-runtime-'));
    const modelsPath = join(directory, 'models.json');
    const authPath = join(directory, 'auth.json');
    // Unroutable fixture endpoint: any network attempt would hang, not pass.
    const provider = (id: string, modelId: string) => ({ [id]: { baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', models: [{ id: modelId, name: modelId }] } });
    writeFileSync(modelsPath, JSON.stringify({ providers: provider('freshroute', 'fresh-model') }));
    writeFileSync(authPath, '{}');
    const runtime = await ModelRuntime.create({ authPath, modelsPath, allowModelNetwork: false, refreshOnCreate: false });
    const registry = new ModelRegistry(runtime);
    const mine = () => registry.getAvailable().map(model => `${model.provider}/${model.id}`).filter(id => id.startsWith('freshroute/') || id.startsWith('secondroute/'));
    const reload = () => registry.refresh({ allowNetwork: false, signal: AbortSignal.timeout(5000) });
    try {
      await reload();
      // Declared but unauthenticated: exactly the gap this change closes.
      expect(registry.find('freshroute', 'fresh-model')).toBeDefined();
      expect(runtime.hasConfiguredAuth('freshroute')).toBe(false);
      expect(mine()).toEqual([]);
      // A new credential is invisible to the in-memory snapshot until the reload runs.
      writeFileSync(authPath, JSON.stringify({ freshroute: { type: 'api_key', key: 'offline-fixture-key' } }));
      expect(runtime.hasConfiguredAuth('freshroute')).toBe(false);
      expect(mine()).toEqual([]);
      await reload();
      expect(runtime.hasConfiguredAuth('freshroute')).toBe(true);
      expect(mine()).toEqual(['freshroute/fresh-model']);
      // A newly declared provider appears through the same bounded reload.
      writeFileSync(modelsPath, JSON.stringify({ providers: { ...provider('freshroute', 'fresh-model'), ...provider('secondroute', 'second-model') } }));
      expect(mine()).toEqual(['freshroute/fresh-model']);
      writeFileSync(authPath, JSON.stringify({ freshroute: { type: 'api_key', key: 'offline-fixture-key' }, secondroute: { type: 'api_key', key: 'offline-fixture-key' } }));
      await reload();
      expect(mine()).toEqual(['freshroute/fresh-model', 'secondroute/second-model']);
      // Removal updates the same snapshot.
      writeFileSync(modelsPath, JSON.stringify({ providers: provider('freshroute', 'fresh-model') }));
      await reload();
      expect(mine()).toEqual(['freshroute/fresh-model']);
      // Native refresh resolves even though the config snapshot is erroneous.
      writeFileSync(modelsPath, '{ not json');
      const broken = await reload();
      expect(broken.aborted).toBe(false);
      expect(registry.getError()).toContain('models.json');
      writeFileSync(modelsPath, JSON.stringify({ providers: provider('freshroute', 'fresh-model') }));
      await reload();
      expect(mine()).toEqual(['freshroute/fresh-model']);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it.each(['models.json', 'auth.json'])('preserves publication through actual native malformed %s, then recovers offline', async (file) => {
    const directory = mkdtempSync(join(tmpdir(), 'ut20-native-error-'));
    const modelsPath = join(directory, 'models.json'), authPath = join(directory, 'auth.json');
    const config = JSON.stringify({ providers: { fixtureroute: { baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-completions', models: [{ id: 'fixture-model', name: 'Fixture' }] } } });
    const auth = JSON.stringify({ fixtureroute: { type: 'api_key', key: 'synthetic-only' } });
    const fetch = vi.fn(() => { throw new Error('Network forbidden'); });
    vi.stubGlobal('fetch', fetch);
    let h: ReturnType<typeof harness> | undefined;
    try {
      writeFileSync(modelsPath, config); writeFileSync(authPath, auth);
      const runtime = await ModelRuntime.create({ authPath, modelsPath, allowModelNetwork: false, refreshOnCreate: false });
      const registry = new ModelRegistry(runtime);
      await registry.refresh({ allowNetwork: false });
      const refresher = createConfigRefresher({ directory, backoffMs: 30_000 });
      h = harness({ configDir: directory, refresh: () => refresher });
      h.context.modelRegistry = registry;
      vi.useFakeTimers();
      h.start(); await vi.advanceTimersByTimeAsync(1);
      const good = h.entries.at(-1).data.models;
      expect(good.some((m: any) => m.provider === 'fixtureroute')).toBe(true);
      const count = h.entries.length;
      const nativeRefresh = vi.spyOn(registry, 'refresh');
      writeFileSync(join(directory, file), '{ malformed fixture');
      await expect(refresher.sync(registry)).rejects.toThrow('configuration unavailable');
      const nativeResult = await nativeRefresh.mock.results[0].value;
      expect(nativeResult.aborted).toBe(false);
      expect(nativeResult.errors.size > 0 || !!registry.getError()).toBe(true);
      expect(nativeRefresh.mock.calls[0][0]).toMatchObject({ allowNetwork: false });
      h.event('agent_end'); await vi.advanceTimersByTimeAsync(1);
      expect(h.entries).toHaveLength(count);
      expect(h.entries.at(-1).data.models).toEqual(good);
      await h.run(request({ model: { provider: 'fixtureroute', id: 'fixture-model' } }));
      expect(h.entries.at(-1).data.ok).toBe(false);
      expect(h.pi.setModel).not.toHaveBeenCalled(); expect(h.messages).toEqual([]);
      writeFileSync(modelsPath, config); writeFileSync(authPath, auth);
      await refresher.sync(registry);
      h.event('agent_end'); await vi.advanceTimersByTimeAsync(1);
      expect(h.entries.at(-1).type).toBe('ultraterm.ui.catalog');
      expect(h.entries.at(-1).data.models).toEqual(good);
      // Credential removal is authoritative, not restored from the UI cache.
      rmSync(authPath);
      await refresher.sync(registry);
      expect(registry.hasConfiguredAuth(registry.find('fixtureroute', 'fixture-model')!)).toBe(false);
      await h.run(request({ model: { provider: 'fixtureroute', id: 'fixture-model' } }));
      expect(h.entries.at(-1).data.ok).toBe(false);
      expect(h.pi.setModel).not.toHaveBeenCalled(); expect(h.messages).toEqual([]);
      expect(fetch).not.toHaveBeenCalled();
    } finally { h?.shutdown(); vi.useRealTimers(); vi.unstubAllGlobals(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('reads a config revision from the three native config files only', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ut20-revision-'));
    try {
      const absent = configRevision(directory);
      expect(absent).toContain('models.json:absent');
      writeFileSync(join(directory, 'models.json'), '{}');
      expect(configRevision(directory)).not.toBe(absent);
      writeFileSync(join(directory, 'unrelated.json'), '{}');
      expect(configRevision(directory)).toBe(configRevision(directory));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});


it('model-only selection does not create paid authorization or send an inference prompt', async () => {
  const h = harness();
  const paid = { provider: 'inco', id: 'glm-5.3-flash:fast', baseUrl: 'https://api.inco.ai/v1' };
  Object.assign(h.target, paid);
  const approval = createExplicitPaidApproval(undefined, paid);
  const { text, ...data } = request({ action: 'model', model: { provider: paid.provider, id: paid.id } });
  await h.run(data);
  expect(h.entries.at(-1).data.ok).toBe(true);
  expect(h.messages).toEqual([]);
  expect(approval(paid)).toBe(false);
});
