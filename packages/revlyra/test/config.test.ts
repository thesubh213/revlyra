import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ConfigFile,
  configPaths,
  ensureConfigDir,
  loadConfig,
  type RevlyraConfig,
  redactConfig,
  writeConfigFile,
  writeEnvLocal,
} from '../src/config';

describe('configPaths', () => {
  it('derives .revlyra layout from the cwd', () => {
    const paths = configPaths('C:/tmp/demo');
    expect(paths.configDir).toMatch(/\.revlyra$/u);
    expect(paths.configFile).toMatch(/config\.json$/u);
    expect(paths.envFile).toMatch(/\.env\.local$/u);
    expect(paths.dataDir).toMatch(/data$/u);
  });
});

describe('ensureConfigDir + writers', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'revlyra-config-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the config directory idempotently', () => {
    ensureConfigDir(dir);
    expect(existsSync(join(dir, '.revlyra'))).toBe(true);
    ensureConfigDir(dir);
    expect(existsSync(join(dir, '.revlyra'))).toBe(true);
  });

  it('writeEnvLocal overwrites .env.local with key=value lines', () => {
    const path = writeEnvLocal(dir, { REVLYRA_PII_PEPPER: 'pepper-value', OTHER: '1' });
    const content = readFileSync(path, 'utf8');
    expect(content).toContain('REVLYRA_PII_PEPPER=pepper-value');
    expect(content).toContain('OTHER=1');
    expect(content).toContain('Never commit');
  });

  it('writeConfigFile writes pretty JSON with trailing newline', () => {
    const config: ConfigFile = { server: { port: 9900 } };
    const path = writeConfigFile(dir, config);
    expect(readFileSync(path, 'utf8')).toContain('"port": 9900');
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
  });

  it('round-trips a written config file through loadConfig', () => {
    writeConfigFile(dir, {
      server: { port: 9901 },
      privacy: {} as never,
      limits: { maxBatch: 42 },
    });
    const loaded = loadConfig({ cwd: dir, loadEnv: false, requirePepper: false });
    expect(loaded.server.port).toBe(9901);
    expect(loaded.limits.maxBatch).toBe(42);
  });
});

describe('loadConfig precedence and rules', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'revlyra-config-pred-'));
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('REVLYRA_')) delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('REVLYRA_')) delete process.env[key];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('uses documented defaults without any file or env', () => {
    const config = loadConfig({ cwd: dir, loadEnv: false, requirePepper: false });
    expect(config.server.host).toBe('127.0.0.1');
    expect(config.server.port).toBe(8787);
    expect(config.server.bodyLimit).toBe(1_048_576);
    expect(config.database.driver).toBe('sqlite');
    expect(config.database.path).toContain('revlyra.db');
    expect(config.jobs.mode).toBe('inline');
    expect(config.jobs.pollMs).toBe(500);
    expect(config.limits).toEqual({ reviewsPerMonth: 100_000, rps: 50, maxBatch: 1000 });
    expect(config.license.key).toBe('');
    expect(config.license.graceDays).toBe(7);
    expect(config.privacy.retentionDays).toBe(180);
    expect(config.privacy.redactEvidence).toBe(true);
    expect(config.detection.policy).toBe('balanced');
    expect(config.adminKey).toBe('');
    expect(config.webhooks).toEqual({});
  });

  it('throws when the pepper is short under requirePepper', () => {
    expect(() =>
      loadConfig({
        cwd: dir,
        loadEnv: false,
        requirePepper: true,
        overrides: { privacy: { pepper: 'short' } },
      }),
    ).toThrow(/REVLYRA_PII_PEPPER/u);
    const ok = loadConfig({
      cwd: dir,
      loadEnv: false,
      requirePepper: true,
      overrides: { privacy: { pepper: 'a-long-enough-pepper-value' } },
    });
    expect(ok.privacy.pepper).toBe('a-long-enough-pepper-value');
  });

  it('throws when postgres is selected without a database URL', () => {
    expect(() =>
      loadConfig({
        cwd: dir,
        loadEnv: false,
        requirePepper: false,
        overrides: { database: { driver: 'postgres' } },
      }),
    ).toThrow(/REVLYRA_DATABASE_URL/u);
  });

  it('resolves relative db paths against cwd and keeps absolute ones', () => {
    const relative = loadConfig({
      cwd: dir,
      loadEnv: false,
      requirePepper: false,
      overrides: { database: { path: './data/other.db' } },
    });
    expect(relative.database.path).toContain(join('data', 'other.db'));

    const absolute = loadConfig({
      cwd: dir,
      loadEnv: false,
      requirePepper: false,
      overrides: { database: { path: join(dir, 'abs.db') } },
    });
    expect(absolute.database.path).toBe(join(dir, 'abs.db'));
  });

  it('env wins over file which wins over defaults', () => {
    writeConfigFile(dir, { server: { port: 9900 } as never, privacy: {} as never });
    const fromFile = loadConfig({ cwd: dir, loadEnv: false, requirePepper: false });
    expect(fromFile.server.port).toBe(9900);

    process.env.REVLYRA_PORT = '9901';
    const fromEnv = loadConfig({ cwd: dir, loadEnv: false, requirePepper: false });
    expect(fromEnv.server.port).toBe(9901);
    delete process.env.REVLYRA_PORT;
  });

  it('envBool understands 1/true/yes and treats garbage as false', () => {
    const base = { cwd: dir, loadEnv: false, requirePepper: false };
    process.env.REVLYRA_MEDIA_ENABLED = 'yes';
    expect(loadConfig(base).detection.mediaEnabled).toBe(true);
    process.env.REVLYRA_MEDIA_ENABLED = 'TRUE';
    expect(loadConfig(base).detection.mediaEnabled).toBe(true);
    process.env.REVLYRA_MEDIA_ENABLED = '1';
    expect(loadConfig(base).detection.mediaEnabled).toBe(true);
    process.env.REVLYRA_MEDIA_ENABLED = 'garbage';
    expect(loadConfig(base).detection.mediaEnabled).toBe(false);
    delete process.env.REVLYRA_MEDIA_ENABLED;
  });

  it('envInt falls back when unparsable and parses base-10', () => {
    const base = { cwd: dir, loadEnv: false, requirePepper: false };
    process.env.REVLYRA_RETENTION_DAYS = 'abc';
    expect(loadConfig(base).privacy.retentionDays).toBe(180);
    process.env.REVLYRA_RETENTION_DAYS = '42';
    expect(loadConfig(base).privacy.retentionDays).toBe(42);
    delete process.env.REVLYRA_RETENTION_DAYS;
  });

  it('splits CORS origins on commas, trims, and drops empties', () => {
    const base = { cwd: dir, loadEnv: false, requirePepper: false };
    process.env.REVLYRA_CORS_ORIGINS = ' https://a.example , , https://b.example ,';
    expect(loadConfig(base).server.corsOrigins).toEqual(['https://a.example', 'https://b.example']);
    delete process.env.REVLYRA_CORS_ORIGINS;
  });

  it('unescapes \\n in the license public key', () => {
    const config = loadConfig({
      cwd: dir,
      loadEnv: false,
      requirePepper: false,
      overrides: { license: { publicKey: '-----BEGIN\\nPUBLIC KEY\\n-----' } },
    });
    expect(config.license.publicKey).toBe('-----BEGIN\nPUBLIC KEY\n-----');
  });

  it('rejects strict-file unknown keys and malformed JSON at file time', () => {
    configPaths;
    ensureConfigDir(dir);
    const bad = join(dir, '.revlyra', 'config.json');
    writeFileSync(bad, JSON.stringify({ nonsense: 1 }), 'utf8');
    expect(() => loadConfig({ cwd: dir, loadEnv: false, requirePepper: false })).toThrow(
      /Invalid config file/u,
    );

    writeFileSync(bad, '{not json', 'utf8');
    expect(() => loadConfig({ cwd: dir, loadEnv: false, requirePepper: false })).toThrow(
      /Invalid config file/u,
    );
  });

  it('redacts secrets in redactConfig and masks DB url userinfo', () => {
    const config = loadConfig({
      cwd: dir,
      loadEnv: false,
      requirePepper: false,
      overrides: {
        privacy: { pepper: 'a-very-long-pepper-value' },
        database: { driver: 'postgres', url: 'postgres://user:secret@db.example/x' },
        license: { key: 'rvlyra_dev_secret' },
      },
    });
    config.adminKey = 'admin-secret';
    config.bootstrapApiKey = 'live-secret';
    const redacted = redactConfig(config) as unknown as RevlyraConfig;
    expect(redacted.privacy.pepper).toBe('***');
    expect(redacted.license.key).toBe('***');
    expect(redacted.adminKey).toBe('***');
    expect(redacted.bootstrapApiKey).toBe('***');
    expect(redacted.database.url).toBe('postgres://***@db.example/x');

    const empty = redactConfig({
      ...loadConfig({ cwd: dir, loadEnv: false, requirePepper: false }),
      adminKey: '',
      bootstrapApiKey: '',
    });
    expect((empty as { license: { key: string } }).license.key).toBe('');
    expect((empty as { adminKey: string }).adminKey).toBe('');
  });

  it('keeps gov/telemetry/log-level fields from file or env', () => {
    const config = loadConfig({
      cwd: dir,
      loadEnv: false,
      requirePepper: false,
      overrides: {
        governance: { appealSlaDays: 14, sorTerritory: 'EU', outOfCourtDisputeBody: 'Board' },
        telemetry: true,
        logLevel: 'debug',
      },
    });
    expect(config.governance.appealSlaDays).toBe(14);
    expect(config.governance.sorTerritory).toBe('EU');
    expect(config.governance.outOfCourtDisputeBody).toBe('Board');
    expect(config.telemetry).toBe(true);
    expect(config.logLevel).toBe('debug');
  });

  it('honors model detection switches via env', () => {
    process.env.REVLYRA_TRANSFORMER = '1';
    process.env.REVLYRA_MODEL_DOWNLOAD = 'true';
    process.env.REVLYRA_MODEL_OFFLINE = 'yes';
    process.env.REVLYRA_MODEL_DIR = join(dir, 'models');
    process.env.REVLYRA_EMBEDDING_MODEL = 'EmbedA';
    process.env.REVLYRA_CLASSIFIER_MODEL = 'ClassA';
    const config = loadConfig({ cwd: dir, loadEnv: false, requirePepper: false });
    expect(config.detection.transformerEnabled).toBe(true);
    expect(config.detection.allowModelDownloads).toBe(true);
    expect(config.detection.modelOffline).toBe(true);
    expect(config.detection.modelDir).toBe(join(dir, 'models'));
    expect(config.detection.embeddingModel).toBe('EmbedA');
    expect(config.detection.classifierModel).toBe('ClassA');
    for (const key of [
      'REVLYRA_TRANSFORMER',
      'REVLYRA_MODEL_DOWNLOAD',
      'REVLYRA_MODEL_OFFLINE',
      'REVLYRA_MODEL_DIR',
      'REVLYRA_EMBEDDING_MODEL',
      'REVLYRA_CLASSIFIER_MODEL',
    ])
      delete process.env[key];
  });

  it('loads env-style webhooks and admin/api keys from env', () => {
    process.env.REVLYRA_WEBHOOK_URL = 'https://hooks.example/x';
    process.env.REVLYRA_WEBHOOK_SECRET = 'whsec';
    process.env.REVLYRA_ADMIN_KEY = 'rvlyra_admin_x';
    process.env.REVLYRA_API_KEY = 'rvlyra_live_y';
    const config = loadConfig({ cwd: dir, loadEnv: false, requirePepper: false });
    expect(config.webhooks).toEqual({ url: 'https://hooks.example/x', secret: 'whsec' });
    expect(config.adminKey).toBe('rvlyra_admin_x');
    expect(config.bootstrapApiKey).toBe('rvlyra_live_y');
    for (const key of [
      'REVLYRA_WEBHOOK_URL',
      'REVLYRA_WEBHOOK_SECRET',
      'REVLYRA_ADMIN_KEY',
      'REVLYRA_API_KEY',
    ]) {
      delete process.env[key];
    }
  });
});
