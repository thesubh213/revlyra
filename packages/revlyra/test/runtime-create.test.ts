import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createRevlyra, type RevlyraRuntime } from '../src';
import type { ConfigFile } from '../src/config';

const dirs: string[] = [];

function tempCwd(): string {
  const dir = mkdtempSync(join(tmpdir(), 'revlyra-runtime-'));
  dirs.push(dir);
  return dir;
}

function runtimeOverrides(dir: string): Partial<ConfigFile> {
  return {
    database: { driver: 'sqlite', path: join(dir, 'runtime.db') },
    privacy: { pepper: 'runtime-config-pepper-aaaa' },
    license: { key: '' },
  };
}

afterAll(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // windows handle quirks
    }
  }
});

describe('createRevlyra', () => {
  it('assembles a full runtime with default inline behavior and license checks skipped', async () => {
    const dir = tempCwd();
    const runtime: RevlyraRuntime = await createRevlyra({
      cwd: dir,
      config: runtimeOverrides(dir),
      requireLicense: false,
      allowOnlineLicense: false,
    });
    expect(runtime.config.privacy.pepper).toBe('runtime-config-pepper-aaaa');
    expect(runtime.store).toBeTruthy();
    expect(runtime.policy.id).toBe('balanced');
    expect(runtime.model.version).toBe('2026.10.1');
    expect(typeof runtime.close).toBe('function');
    await runtime.close();
  });

  it('surfaces license errors when no license key exists (pepper managed by overrides)', async () => {
    const dir = tempCwd();
    let error: unknown = null;
    try {
      await createRevlyra({
        cwd: dir,
        allowOnlineLicense: false,
        config: {
          database: { driver: 'sqlite', path: join(dir, 'licenseless.db') },
          privacy: { pepper: 'runtime-config-pepper-aaaa' },
        },
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/LICENSE/i);
  });

  it('boots stores it can use for store-level work even without licensing (requireLicense off)', async () => {
    const dir = tempCwd();
    const runtime = await createRevlyra({
      cwd: dir,
      requireLicense: false,
      allowOnlineLicense: false,
      config: {
        database: { driver: 'sqlite', path: join(dir, 'runtime.db') },
        privacy: { pepper: 'runtime-config-pepper-aaaa' },
        license: { key: '' },
      },
    });
    await runtime.store.ensureTenant('default');
    const tenants = await runtime.store.listTenants();
    expect(tenants.map((t) => t.id)).toContain('default');
    await runtime.close();
  });
});
