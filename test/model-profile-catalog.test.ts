import { expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProfiles } from '../extensions/ultraterm-ui.ts';

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
