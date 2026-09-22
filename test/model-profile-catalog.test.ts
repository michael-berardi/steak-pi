import { expect, it, vi } from 'vitest';
import { mkdtempSync, utimesSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { catalogModels, readProfiles } from '../extensions/ultraterm-ui.ts';
import { curatedPickerScope } from '../src/harness-profiles.ts';
import { isModelRouteAllowed } from '../src/model-route-policy.ts';
import { curatedPickerModels, sharedPickerModels } from '../src/model-visibility.ts';

it('includes active paid/subscription profile metadata without transferring launch overrides', () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-profile-catalog-'));
  const make = (id: string, model: string, extra: string[] = []) => ({ id, name: id, args: ['--model', model, '--thinking', 'medium', ...extra], workerDefault: { profile: 'steak-pi/opencode-go' }, reviewerDefault: { profile: 'steak-pi/opencode-go' } });
  try {
    writeFileSync(join(root, 'steak-pi.json'), JSON.stringify({ schemaVersion: 1, profiles: [
      make('go', 'opencode-go/deepseek-v4.1-flash'),
      make('pro', 'xiaomi/mimo-v2.6-pro', ['--steak-pi-paid-route=xiaomi/mimo-v2.6-pro']),
      make('flash', 'xiaomi/mimo-v2.6-flash', ['--steak-pi-paid-route', 'xiaomi/mimo-v2.6-flash']),
      make('mismatch', 'inco/test', ['--steak-pi-paid-route=xiaomi/mimo-v2.6-pro']),
      make('override', 'inco/test', ['--extension', '/untrusted.ts']),
      make('duplicate', 'inco/test', ['--steak-pi-paid-route=inco/test', '--steak-pi-paid-route=inco/test']),
    ] }));
    const profiles = readProfiles(root);
    expect(profiles.map(p => p.profileId)).toEqual(['steak-pi/go', 'steak-pi/pro', 'steak-pi/flash']);
    expect(profiles.every(p => Object.keys(p).sort().join(',') === 'id,label,profileId,provider,thinking')).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

/** The selected harness manifest is the one scope the sidebar, native /model and the composer share. */
const HARNESS = 'steak-pi';
const route = (provider: string, id: string) => ({ provider, id, name: id });

function curatedFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pi-profile-catalog-live-'));
  const path = join(dir, `${HARNESS}.json`);
  let tick = 0;
  // mtime/size is the manifest revision: distinct stamps keep every rewrite observable.
  const manifest = (profiles: unknown[]) => {
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, id: HARNESS, profiles }));
    tick += 1;
    const stamp = new Date(Date.now() + tick * 1000);
    utimesSync(path, stamp, stamp);
  };
  vi.stubEnv('ULTRATERM_HARNESS_ID', HARNESS);
  vi.stubEnv('ULTRATERM_HARNESS_DIR', dir);
  vi.stubEnv('ULTRATERM_HARNESS_RESOURCES', join(dir, 'none'));
  return { dir, manifest, cleanup: () => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); } };
}

const profile = (id: string, name: string, model: string, thinking = 'high') => ({ id, name, args: ['--model', model, '--thinking', thinking] });
const routes = (profiles: { provider: string; id: string }[]) => profiles.map(p => `${p.provider}/${p.id}`);

it('follows profile additions, removals and renames in the sidebar list and the shared picker scope', () => {
  const f = curatedFixture();
  try {
    f.manifest([profile('first', 'First', 'alpha/first-model')]);
    expect(readProfiles().map(p => `${p.profileId}:${p.label}`)).toEqual(['steak-pi/first:First']);
    expect([...curatedPickerScope()!]).toEqual(['alpha/first-model']);
    // Addition: a new configured route joins both the sidebar list and the scope.
    f.manifest([profile('first', 'First', 'alpha/first-model'), profile('second', 'Second', 'beta/second-model', 'low')]);
    expect(readProfiles().map(p => p.profileId)).toEqual(['steak-pi/first', 'steak-pi/second']);
    expect([...curatedPickerScope()!].sort()).toEqual(['alpha/first-model', 'beta/second-model']);
    // Rename: the label and the route both follow the manifest, never a hard-coded list.
    f.manifest([profile('first', 'First Renamed', 'alpha/renamed-model'), profile('second', 'Second', 'beta/second-model', 'low')]);
    expect(readProfiles().map(p => `${p.profileId}:${p.label}:${p.provider}/${p.id}`))
      .toEqual(['steak-pi/first:First Renamed:alpha/renamed-model', 'steak-pi/second:Second:beta/second-model']);
    expect([...curatedPickerScope()!].sort()).toEqual(['alpha/renamed-model', 'beta/second-model']);
    // Removal: the route leaves the scope, and an emptied manifest is still authority.
    f.manifest([profile('second', 'Second', 'beta/second-model', 'low')]);
    expect(readProfiles().map(p => p.profileId)).toEqual(['steak-pi/second']);
    expect([...curatedPickerScope()!]).toEqual(['beta/second-model']);
    f.manifest([]);
    expect(readProfiles()).toEqual([]);
    expect([...curatedPickerScope()!]).toEqual([]);
  } finally { f.cleanup(); }
});

/** Native-shaped catalog fixture: the app-bundled resources directory plus the
 * live operator directory, the two sources the launcher exports to a session. */
function mergedFixture() {
  const bundledDir = mkdtempSync(join(tmpdir(), 'pi-profile-catalog-res-'));
  const liveDir = mkdtempSync(join(tmpdir(), 'pi-profile-catalog-ext-'));
  let tick = 0;
  const write = (dir: string, profiles: unknown[], overrides: Record<string, unknown> = {}) => {
    const path = join(dir, `${HARNESS}.json`);
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1, id: HARNESS, name: 'Steak Pi', description: 'app catalog',
      executable: 'steak-pi', launcher: 'generic', profileSource: 'static', profiles, ...overrides,
    }));
    tick += 1;
    const stamp = new Date(Date.now() + tick * 1000);
    utimesSync(path, stamp, stamp);
  };
  const nativeProfile = (id: string, name: string, model: string, thinking = 'high') =>
    ({ id, name, description: `${name} native route`, args: ['--model', model, '--thinking', thinking] });
  vi.stubEnv('ULTRATERM_HARNESS_ID', HARNESS);
  vi.stubEnv('ULTRATERM_HARNESS_DIR', liveDir);
  vi.stubEnv('ULTRATERM_HARNESS_RESOURCES', bundledDir);
  return {
    bundledDir, liveDir, write, nativeProfile,
    cleanup: () => { vi.unstubAllEnvs(); rmSync(bundledDir, { recursive: true, force: true }); rmSync(liveDir, { recursive: true, force: true }); },
  };
}

it('merges operator additions onto the bundled catalog instead of replacing it', () => {
  const f = mergedFixture();
  const bundled = [f.nativeProfile('go', 'Go', 'opencode-go/deepseek-v4.1-flash'), f.nativeProfile('mimo', 'MiMo', 'xiaomi/mimo-v2.6-pro')];
  try {
    // Until an operator manifest exists, the bundled catalog is the whole list.
    f.write(f.bundledDir, bundled);
    expect(routes(readProfiles())).toEqual(['opencode-go/deepseek-v4.1-flash', 'xiaomi/mimo-v2.6-pro']);
    expect([...curatedPickerScope()!].sort()).toEqual(['opencode-go/deepseek-v4.1-flash', 'xiaomi/mimo-v2.6-pro']);
    // A partial external manifest appends its new custom profile; a profile id
    // that collides with a bundled one never shadows the bundled route or label.
    f.write(f.liveDir, [f.nativeProfile('go', 'Renamed Hijack', 'zai/glm-5.3-flash'), f.nativeProfile('team-review', 'Team review', 'beta/review-model', 'low')]);
    expect(readProfiles().map(p => `${p.profileId}:${p.label}`)).toEqual([
      'steak-pi/go:Go', 'steak-pi/mimo:MiMo', 'steak-pi/team-review:Team review',
    ]);
    expect([...curatedPickerScope()!].sort()).toEqual(['beta/review-model', 'opencode-go/deepseek-v4.1-flash', 'xiaomi/mimo-v2.6-pro']);
    // Rename semantics: a profile the operator owns follows its rename...
    f.write(f.liveDir, [f.nativeProfile('team-review', 'Team review renamed', 'beta/review-model', 'low')]);
    expect(readProfiles().map(p => `${p.profileId}:${p.label}`)).toEqual([
      'steak-pi/go:Go', 'steak-pi/mimo:MiMo', 'steak-pi/team-review:Team review renamed',
    ]);
    // ...and removing the external manifest restores the bundled catalog intact.
    rmSync(join(f.liveDir, `${HARNESS}.json`));
    expect(routes(readProfiles())).toEqual(['opencode-go/deepseek-v4.1-flash', 'xiaomi/mimo-v2.6-pro']);
    expect([...curatedPickerScope()!].sort()).toEqual(['opencode-go/deepseek-v4.1-flash', 'xiaomi/mimo-v2.6-pro']);
  } finally { f.cleanup(); }
});

it('refuses invalid or incompatible external manifests exactly like the native catalog and keeps the bundled profiles', () => {
  const f = mergedFixture();
  const bundledRoutes = ['opencode-go/deepseek-v4.1-flash', 'xiaomi/mimo-v2.6-pro'];
  try {
    f.write(f.bundledDir, [f.nativeProfile('go', 'Go', 'opencode-go/deepseek-v4.1-flash'), f.nativeProfile('mimo', 'MiMo', 'xiaomi/mimo-v2.6-pro')]);
    const incompatible: [string, Record<string, unknown>][] = [
      ['schemaVersion must be 1', { schemaVersion: 2 }],
      ['omp launcher never merges into an external manifest', { launcher: 'omp' }],
      ['omp profileSource never merges into an external manifest', { profileSource: 'omp' }],
      ['an executable mismatch skips the whole merge', { executable: 'pi' }],
      ['a different manifest id is a different harness', { id: 'not-steak-pi' }],
    ];
    for (const [why, overrides] of incompatible) {
      f.write(f.liveDir, [f.nativeProfile('custom', 'Custom', 'zai/glm-5.3-flash')], overrides);
      expect(routes(readProfiles()), why).toEqual(bundledRoutes);
      expect([...curatedPickerScope()!].sort(), why).toEqual(bundledRoutes);
    }
    // The native per-profile rules refuse the entire external manifest too, and
    // the retired first-party DSH id is normalized away, never resurrected.
    const refused: [string, unknown[]][] = [
      ['profile ids must be lowercase kebab-case', [f.nativeProfile('Team Review', 'Team', 'zai/glm-5.3-flash')]],
      ['profiles require a description', [{ id: 'custom', name: 'Custom', args: ['--model', 'zai/glm-5.3-flash', '--thinking', 'high'] }]],
      ['duplicate profile ids refuse the manifest', [f.nativeProfile('custom', 'Custom', 'zai/glm-5.3-flash'), f.nativeProfile('custom', 'Custom Two', 'beta/other-model')]],
      ['static external manifests require at least one profile', []],
      ['the retired DSH profile merges onto the bundled canonical route', [f.nativeProfile('opencode-go-dsh', 'OpenCode Go DSH', 'zai/glm-5.3-flash')]],
    ];
    for (const [why, profiles] of refused) {
      f.write(f.liveDir, profiles);
      expect(routes(readProfiles()), why).toEqual(bundledRoutes);
      expect([...curatedPickerScope()!].sort(), why).toEqual(bundledRoutes);
    }
  } finally { f.cleanup(); }
});

it('watches both catalog sources so a bundle edit or an operator edit is detected', () => {
  const f = mergedFixture();
  try {
    f.write(f.bundledDir, [f.nativeProfile('go', 'Go', 'opencode-go/deepseek-v4.1-flash')]);
    expect([...curatedPickerScope()!]).toEqual(['opencode-go/deepseek-v4.1-flash']);
    // Bundle-side change: a new app-shipped profile must reach the pickers.
    f.write(f.bundledDir, [f.nativeProfile('go', 'Go', 'opencode-go/deepseek-v4.1-flash'), f.nativeProfile('mimo', 'MiMo', 'xiaomi/mimo-v2.6-pro')]);
    expect([...curatedPickerScope()!].sort()).toEqual(['opencode-go/deepseek-v4.1-flash', 'xiaomi/mimo-v2.6-pro']);
    // Operator-side change without touching the bundle.
    f.write(f.liveDir, [f.nativeProfile('team-review', 'Team review', 'beta/review-model', 'low')]);
    expect([...curatedPickerScope()!].sort()).toEqual(['beta/review-model', 'opencode-go/deepseek-v4.1-flash', 'xiaomi/mimo-v2.6-pro']);
  } finally { f.cleanup(); }
});

it('keeps the native snapshot, the composer catalog and the sidebar list on that one curated scope', () => {
  const f = curatedFixture();
  try {
    f.manifest([profile('first', 'First', 'alpha/first-model'), profile('second', 'Second', 'beta/second-model', 'low')]);
    // The library the native runtime publishes: curated routes plus dispatch-only ones.
    const library = [route('alpha', 'first-model'), route('beta', 'second-model'), route('gamma', 'extra-model'), route('openrouter', 'deepseek/deepseek-v4-flash'), route('openrouter', 'deepseek/deepseek-v4-pro')];
    const sidebar = routes(readProfiles());
    // Exactly what guardModelRuntime's provider.filterModels publishes to native /model.
    const native = routes(curatedPickerModels(sharedPickerModels(library.filter(isModelRouteAllowed)), curatedPickerScope()));
    const ctx: any = { modelRegistry: { getAvailable: () => library, hasConfiguredAuth: () => true }, scopedModels: [], model: undefined };
    const composer = routes(catalogModels(ctx, readProfiles));
    expect(sidebar).toEqual(['alpha/first-model', 'beta/second-model']);
    expect(native).toEqual(sidebar);
    expect(composer).toEqual(sidebar);
    // A profile without scoped effort keeps the manifest label and thinking; a
    // scoped effort for the same route wins over the profile metadata.
    expect(catalogModels(ctx, readProfiles)).toEqual([
      expect.objectContaining({ profileId: 'steak-pi/first', label: 'First', provider: 'alpha', id: 'first-model', thinking: 'high' }),
      expect.objectContaining({ profileId: 'steak-pi/second', label: 'Second', provider: 'beta', id: 'second-model', thinking: 'low' }),
    ]);
    ctx.scopedModels = [{ model: library[1], thinkingLevel: 'max' }];
    expect(catalogModels(ctx, readProfiles)).toContainEqual(expect.objectContaining({ id: 'second-model', thinking: 'max' }));
    // A manifest may name a route the pickers must still refuse (removed Flash,
    // policy-refused GPT); the sidebar list is manifest metadata, while native and
    // composer stay equal as the policy-valid intersection. Dispatch keeps everything.
    f.manifest([profile('first', 'First', 'alpha/first-model'), profile('flash', 'Flash', 'openrouter/deepseek/deepseek-v4-flash'), profile('gpt', 'GPT', 'openrouter/gpt-6-astra')]);
    expect(routes(readProfiles())).toEqual(['alpha/first-model', 'openrouter/deepseek/deepseek-v4-flash', 'openrouter/gpt-6-astra']);
    const narrowed = routes(curatedPickerModels(sharedPickerModels(library.filter(isModelRouteAllowed)), curatedPickerScope()));
    expect(narrowed).toEqual(['alpha/first-model']);
    expect(routes(catalogModels(ctx, readProfiles))).toEqual(narrowed);
    expect(routes(library)).toContain('openrouter/deepseek/deepseek-v4-flash');
    expect(routes(library)).toContain('openrouter/deepseek/deepseek-v4-pro');
  } finally { f.cleanup(); }
});
