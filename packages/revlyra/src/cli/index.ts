#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type AnalysisResult,
  analyzeReview,
  type CanonicalReview,
  getPolicyPreset,
  type IntegrityResult,
} from '@revlyra/core';
import { Command } from 'commander';
import pc from 'picocolors';
import {
  ensureConfigDir,
  loadConfig,
  loadEnvFiles,
  redactConfig,
  writeConfigFile,
  writeEnvLocal,
} from '../config';
import { buildTransparencyReport, renderTransparencyHtml } from '../engine/compliance';
import { buildStatementOfReasons, renderStatementOfReasonsMarkdown } from '../engine/sor';
import { createRevlyra, VERSION } from '../index';
import { defaultHandlers, JobWorker } from '../jobs';
import { generateApiKey as generateTenantKey, hashApiKey, SCOPES } from '../keys';
import {
  generateDevLicenseKey,
  inspectLicenseKey,
  isDevLicenseKey,
  registerDevLicense,
  resolveLicense,
} from '../license';
import { scopedHmac } from '../privacy';
import { startServer } from '../server';
import { createSource, type SourceConfig } from '../sources';
import type { Store } from '../store';

const program = new Command();
program
  .name('revlyra')
  .description('Review integrity engine: analyze, explain, select, and audit reviews.')
  .version(VERSION)
  .option('--cwd <path>', 'working directory', process.cwd())
  .option('--json', 'output machine-readable JSON', false);

program.hook('preAction', () => {
  const cwd = program.opts().cwd as string | undefined;
  if (cwd) process.chdir(resolve(cwd));
});

function jsonMode(): boolean {
  return Boolean(program.opts().json);
}

function emit(data: unknown, human: string): void {
  if (jsonMode()) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(human);
  }
}

function fail(error: unknown): void {
  const message = String((error as Error)?.message ?? error);
  if (jsonMode()) {
    console.error(JSON.stringify({ ok: false, error: message }, null, 2));
  } else {
    console.error(pc.red(`Error: ${message}`));
  }
  process.exitCode = 1;
}

function handle<Args extends unknown[]>(
  fn: (...args: Args) => Promise<void>,
): (...args: Args) => Promise<void> {
  return async (...args: Args) => {
    try {
      await fn(...args);
    } catch (error) {
      fail(error);
    }
  };
}

function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    values[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  }
  return values;
}

function ensureGitignore(cwd: string): void {
  const file = resolve(cwd, '.gitignore');
  const required = [
    'node_modules/',
    'dist/',
    '.env',
    '.env.*',
    '!.env.example',
    '.revlyra/',
    'data/',
  ];
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = new Set(existing.split(/\r?\n/u).map((line) => line.trim()));
  const missing = required.filter((line) => !lines.has(line));
  if (missing.length === 0) return;
  writeFileSync(
    file,
    `${existing}${existing.endsWith('\n') || existing.length === 0 ? '' : '\n'}${missing.join('\n')}\n`,
  );
}

function humanResult(result: AnalysisResult): string {
  const lines = [
    `${pc.bold('Decision:')} ${result.decision.toUpperCase()}  ${pc.dim(`(${result.band})`)}`,
    `${pc.bold('Score:')} ${(result.score * 100).toFixed(1)}%  ${pc.bold('Confidence:')} ${(result.confidence * 100).toFixed(1)}%`,
    `${pc.bold('Model:')} ${result.modelVersion}  ${pc.bold('Policy:')} ${result.policyVersion}`,
  ];
  if (result.provisional)
    lines.push(pc.yellow('Media analysis is pending; this score is provisional.'));
  lines.push('', pc.bold('Top reasons:'));
  for (const reason of result.reasons.slice(0, 6)) {
    lines.push(
      `  ${pc.cyan(reason.code)}  ${pc.dim(`+${reason.contribution.toFixed(3)}`)}  ${reason.message}`,
    );
  }
  if (result.reasons.length === 0) lines.push(pc.dim('  No risk signals fired.'));
  return lines.join('\n');
}

async function runtimeOrExit(options: Parameters<typeof createRevlyra>[0] = {}) {
  return createRevlyra(options);
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

program
  .command('init')
  .description('Create local configuration, a dev license, keys, and the database.')
  .option('--force', 'regenerate all secrets and configuration', false)
  .option('--port <port>', 'server port', '8787')
  .option('--host <host>', 'server host', '127.0.0.1')
  .action(
    handle(async (options: { force?: boolean; port?: string; host?: string }) => {
      const cwd = process.cwd();
      const paths = ensureConfigDir(cwd);
      ensureGitignore(cwd);
      const envFile = paths.envFile;
      const existing = readEnvFile(envFile);
      const force = options.force === true;

      const licenseKey = (!force && existing.REVLYRA_LICENSE_KEY) || generateDevLicenseKey();
      const pepper =
        (!force && existing.REVLYRA_PII_PEPPER) || randomBytes(32).toString('base64url');
      const adminKey = (!force && existing.REVLYRA_ADMIN_KEY) || generateTenantKey('admin').key;
      const apiKey = (!force && existing.REVLYRA_API_KEY) || generateTenantKey('live').key;

      if (isDevLicenseKey(licenseKey)) {
        registerDevLicense(paths.configDir, licenseKey);
      }

      const envValues: Record<string, string> = {
        ...existing,
        REVLYRA_LICENSE_KEY: licenseKey,
        REVLYRA_PII_PEPPER: pepper,
        REVLYRA_ADMIN_KEY: adminKey,
        REVLYRA_API_KEY: apiKey,
        REVLYRA_DB_DRIVER: existing.REVLYRA_DB_DRIVER ?? 'sqlite',
        REVLYRA_DB_PATH: existing.REVLYRA_DB_PATH ?? './.revlyra/revlyra.db',
        REVLYRA_HOST: existing.REVLYRA_HOST ?? options.host ?? '127.0.0.1',
        REVLYRA_PORT: existing.REVLYRA_PORT ?? options.port ?? '8787',
        REVLYRA_POLICY: existing.REVLYRA_POLICY ?? 'balanced',
        REVLYRA_WORKER: existing.REVLYRA_WORKER ?? 'inline',
      };
      writeEnvLocal(cwd, envValues);

      if (!existsSync(paths.configFile) || force) {
        writeConfigFile(cwd, {
          database: { driver: 'sqlite', path: './.revlyra/revlyra.db' },
          server: { host: options.host ?? '127.0.0.1', port: Number(options.port ?? 8787) },
          detection: { policy: 'balanced' },
          jobs: { mode: 'inline' },
        });
      }

      loadEnvFiles(cwd);
      const config = loadConfig({ cwd, requirePepper: true });
      const runtime = await createRevlyra({ cwd, requireLicense: false });
      const store = runtime.store;
      await store.ensureTenant('default');
      const existingKey = await store.findApiKeyByHash(hashApiKey(apiKey));
      if (!existingKey) {
        const prefix = apiKey.startsWith('rvlyra_live_')
          ? (apiKey.slice('rvlyra_live_'.length).split('_')[0] ?? 'local')
          : 'local';
        await store.createApiKey({
          tenantId: 'default',
          prefix,
          keyHash: hashApiKey(apiKey),
          scopes: ['analyze:write', 'feedback:write', 'scan:write'],
        });
      }
      await runtime.close();

      const summary = {
        ok: true,
        envFile,
        configFile: paths.configFile,
        database: config.database.path,
        license: inspectLicenseKey(licenseKey),
        apiKey,
        adminKey,
        next: ['revlyra serve', 'revlyra analyze --text "..." --rating 5'],
      };
      emit(
        summary,
        [
          pc.green('Revlyra is initialized.'),
          '',
          `  env:      ${envFile}`,
          `  config:   ${paths.configFile}`,
          `  database: ${config.database.path}`,
          `  license:  ${pc.dim('dev (30 days, local)')}`,
          '',
          pc.bold('API key (shown once):'),
          `  ${apiKey}`,
          '',
          pc.bold('Admin key (shown once):'),
          `  ${adminKey}`,
          '',
          'Next:',
          '  revlyra serve',
          '  revlyra analyze --text "Great battery life" --rating 5',
        ].join('\n'),
      );
    }),
  );

// ---------------------------------------------------------------------------
// keys
// ---------------------------------------------------------------------------

program
  .command('keygen')
  .description('Generate and register a new local dev license key.')
  .option('--write-env', 'write the key to .env.local', false)
  .action(
    handle(async (options: { writeEnv?: boolean }) => {
      const cwd = process.cwd();
      const paths = ensureConfigDir(cwd);
      const key = generateDevLicenseKey();
      const record = registerDevLicense(paths.configDir, key);
      if (options.writeEnv) {
        const env = readEnvFile(paths.envFile);
        writeEnvLocal(cwd, { ...env, REVLYRA_LICENSE_KEY: key });
      }
      emit(
        { ok: true, licenseKey: key, expiresAt: record.expiresAt },
        `${pc.green('Dev license generated.')}\n  ${key}\n  expires: ${record.expiresAt}`,
      );
    }),
  );

const keyCommand = program.command('key').description('Manage tenant API keys.');

keyCommand
  .command('create')
  .description('Create a tenant API key (shown once).')
  .option('--tenant <id>', 'tenant id', 'default')
  .option('--scopes <list>', 'comma-separated scopes', 'analyze:write,feedback:write,scan:write')
  .option('--expires <iso>', 'expiry date')
  .action(
    handle(async (options: { tenant?: string; scopes?: string; expires?: string }) => {
      const runtime = await runtimeOrExit();
      try {
        await runtime.store.ensureTenant(options.tenant ?? 'default');
        const scopes = (options.scopes ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);
        const allowed = new Set<string>(SCOPES);
        const invalid = scopes.filter((scope) => !allowed.has(scope));
        if (invalid.length > 0) {
          throw new Error(`Invalid scopes: ${invalid.join(', ')}`);
        }
        if (options.expires && Number.isNaN(Date.parse(options.expires))) {
          throw new Error('Invalid --expires date.');
        }
        const material = generateTenantKey('live');
        const record = await runtime.store.createApiKey({
          tenantId: options.tenant ?? 'default',
          prefix: material.prefix,
          keyHash: material.hash,
          scopes,
          expiresAt: options.expires ?? null,
        });
        await runtime.store.appendAudit({
          tenantId: record.tenantId,
          actor: 'cli',
          action: 'api_key.created',
          targetType: 'api_key',
          targetId: record.id,
          payload: { scopes: record.scopes },
        });
        emit(
          { ok: true, id: record.id, key: material.key, scopes: record.scopes },
          `${pc.green('API key created (shown once):')}\n  ${material.key}\n  id: ${record.id}`,
        );
      } finally {
        await runtime.close();
      }
    }),
  );

keyCommand
  .command('list')
  .description('List tenant API keys.')
  .option('--tenant <id>', 'tenant id', 'default')
  .action(
    handle(async (options: { tenant?: string }) => {
      const runtime = await runtimeOrExit();
      try {
        const keys = await runtime.store.listApiKeys(options.tenant ?? 'default');
        const rows = keys.map((key) => ({
          id: key.id,
          prefix: key.prefix,
          scopes: key.scopes,
          createdAt: key.createdAt,
          expiresAt: key.expiresAt,
          revokedAt: key.revokedAt,
        }));
        emit(
          { ok: true, keys: rows },
          rows.length === 0
            ? 'No API keys.'
            : rows
                .map(
                  (key) =>
                    `${key.id}  ${pc.dim(key.prefix)}  ${key.scopes.join(',')}${key.revokedAt ? pc.red(' revoked') : ''}`,
                )
                .join('\n'),
        );
      } finally {
        await runtime.close();
      }
    }),
  );

keyCommand
  .command('revoke <id>')
  .description('Revoke a tenant API key.')
  .option('--tenant <id>', 'tenant id', 'default')
  .action(
    handle(async (id: string, options: { tenant?: string }) => {
      const runtime = await runtimeOrExit();
      try {
        const revoked = await runtime.store.revokeApiKey(options.tenant ?? 'default', id);
        if (!revoked) throw new Error('API key not found.');
        await runtime.store.appendAudit({
          tenantId: options.tenant ?? 'default',
          actor: 'cli',
          action: 'api_key.revoked',
          targetType: 'api_key',
          targetId: id,
          payload: {},
        });
        emit({ ok: true, id, revoked: true }, pc.green(`Revoked ${id}`));
      } finally {
        await runtime.close();
      }
    }),
  );

// ---------------------------------------------------------------------------
// license
// ---------------------------------------------------------------------------

const licenseCommand = program.command('license').description('Inspect and activate licenses.');

licenseCommand
  .command('status')
  .description('Show offline license status and entitlements.')
  .action(
    handle(async () => {
      const config = loadConfig({ cwd: process.cwd(), requirePepper: false });
      const { status, entitlements } = await resolveLicense({
        configDir: config.configDir,
        licenseKey: config.license.key,
        ...(config.license.publicKey ? { publicKey: config.license.publicKey } : {}),
        ...(config.license.server ? { licenseServer: config.license.server } : {}),
      });
      emit(
        { ok: true, status, entitlements: entitlements.toJSON() },
        [
          `Valid:     ${status.valid ? pc.green('yes') : pc.red('no')}`,
          `Kind:      ${status.kind}`,
          `Tier:      ${status.tier}`,
          `Subject:   ${status.subject || pc.dim('-')}`,
          `Expires:   ${status.expiresAt ?? pc.dim('never')}`,
          `Grace:     ${status.grace ? 'yes' : 'no'}`,
          `Features:  ${status.features.join(', ') || pc.dim('none')}`,
          `Reason:    ${status.reason ?? pc.dim('-')}`,
        ].join('\n'),
      );
    }),
  );

licenseCommand
  .command('activate')
  .description('Request an online lease from the configured license server.')
  .action(
    handle(async () => {
      const config = loadConfig({ cwd: process.cwd(), requirePepper: false });
      const { status } = await resolveLicense({
        configDir: config.configDir,
        licenseKey: config.license.key,
        ...(config.license.publicKey ? { publicKey: config.license.publicKey } : {}),
        ...(config.license.server ? { licenseServer: config.license.server } : {}),
        allowOnline: true,
      });
      emit({ ok: status.valid, status }, JSON.stringify(status, null, 2));
    }),
  );

// ---------------------------------------------------------------------------
// sources
// ---------------------------------------------------------------------------

const sourceCommand = program.command('source').description('Manage review data sources.');

sourceCommand
  .command('add')
  .description('Register a source. Use --config JSON or --file for file sources.')
  .requiredOption('--kind <kind>', 'files|sqlite|postgres|mysql|mongodb|rest')
  .option('--name <name>', 'display name')
  .option('--config <json>', 'source config JSON')
  .option('--config-file <path>', 'source config JSON file')
  .option('--mapping <json>', 'field mapping JSON')
  .option('--mapping-file <path>', 'field mapping JSON file')
  .option('--file <path>', 'shorthand: file path for a files source')
  .option('--format <format>', 'shorthand: json|ndjson|csv', 'json')
  .option('--tenant <id>', 'tenant id', 'default')
  .action(
    handle(
      async (options: {
        kind: string;
        name?: string;
        config?: string;
        configFile?: string;
        mapping?: string;
        mappingFile?: string;
        file?: string;
        format?: string;
        tenant?: string;
      }) => {
        const runtime = await runtimeOrExit();
        try {
          let config: Record<string, unknown>;
          if (options.file) {
            config = { path: resolve(options.file), format: options.format ?? 'json' };
          } else if (options.configFile) {
            config = JSON.parse(readFileSync(resolve(options.configFile), 'utf8'));
          } else if (options.config) {
            config = JSON.parse(options.config);
          } else {
            throw new Error('Provide --config, --config-file, or --file.');
          }
          const mapping = options.mappingFile
            ? JSON.parse(readFileSync(resolve(options.mappingFile), 'utf8'))
            : options.mapping
              ? JSON.parse(options.mapping)
              : {};
          const source = await runtime.store.createSource({
            tenantId: options.tenant ?? 'default',
            kind: options.kind,
            name: options.name ?? options.kind,
            config,
            mapping,
          });
          await runtime.store.appendAudit({
            tenantId: source.tenantId,
            actor: 'cli',
            action: 'source.created',
            targetType: 'source',
            targetId: source.id,
            payload: { kind: source.kind, name: source.name },
          });
          emit(
            { ok: true, source },
            `${pc.green('Source created.')}\n  id:   ${source.id}\n  kind: ${source.kind}\n  name: ${source.name}`,
          );
        } finally {
          await runtime.close();
        }
      },
    ),
  );

sourceCommand
  .command('list')
  .description('List registered sources.')
  .option('--tenant <id>', 'tenant id', 'default')
  .action(
    handle(async (options: { tenant?: string }) => {
      const runtime = await runtimeOrExit();
      try {
        const sources = await runtime.store.listSources(options.tenant ?? 'default');
        emit(
          { ok: true, sources },
          sources.length === 0
            ? 'No sources.'
            : sources
                .map(
                  (source) =>
                    `${source.id}  ${source.kind.padEnd(9)} ${source.name}${source.enabled ? '' : pc.dim(' (disabled)')}`,
                )
                .join('\n'),
        );
      } finally {
        await runtime.close();
      }
    }),
  );

sourceCommand
  .command('test <id>')
  .description('Test a source and show a mapped sample.')
  .option('--tenant <id>', 'tenant id', 'default')
  .action(
    handle(async (id: string, options: { tenant?: string }) => {
      const runtime = await runtimeOrExit();
      try {
        const source = await runtime.store.getSource(options.tenant ?? 'default', id);
        if (!source) throw new Error('Source not found.');
        const client = createSource(source.id, {
          ...(source.config as Record<string, unknown>),
          kind: source.kind,
          mapping: source.mapping,
        } as SourceConfig);
        try {
          const result = await client.test();
          emit(result, JSON.stringify(result, null, 2));
        } finally {
          await client.close?.();
        }
      } finally {
        await runtime.close();
      }
    }),
  );

sourceCommand
  .command('remove <id>')
  .description('Remove a source.')
  .option('--tenant <id>', 'tenant id', 'default')
  .action(
    handle(async (id: string, options: { tenant?: string }) => {
      const runtime = await runtimeOrExit();
      try {
        const deleted = await runtime.store.deleteSource(options.tenant ?? 'default', id);
        if (!deleted) throw new Error('Source not found.');
        emit({ ok: true, id, deleted: true }, pc.green(`Removed ${id}`));
      } finally {
        await runtime.close();
      }
    }),
  );

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

program
  .command('scan')
  .description('Pull and analyze reviews from a configured source.')
  .requiredOption('--source <id>', 'source id')
  .option('--limit <number>', 'maximum reviews to import')
  .option('--batch-size <number>', 'reader batch size', '500')
  .option('--tenant <id>', 'tenant id', 'default')
  .action(
    handle(
      async (options: { source: string; limit?: string; batchSize?: string; tenant?: string }) => {
        const runtime = await runtimeOrExit();
        try {
          const tenantId = options.tenant ?? 'default';
          const source = await runtime.store.getSource(tenantId, options.source);
          if (!source) throw new Error('Source not found.');
          const job = await runtime.store.createJob({
            tenantId,
            kind: 'scan',
            payload: {
              sourceId: source.id,
              ...(options.limit ? { limit: Number(options.limit) } : {}),
              ...(options.batchSize ? { batchSize: Number(options.batchSize) } : {}),
            },
          });
          const scanHandler = defaultHandlers.scan;
          if (!scanHandler) throw new Error('Scan handler missing.');
          try {
            const result = await scanHandler(job, {
              store: runtime.store,
              service: runtime.service,
              config: runtime.config,
            });
            await runtime.store.completeJob(job.id, result);
            emit({ ok: true, jobId: job.id, result }, JSON.stringify(result, null, 2));
          } catch (error) {
            await runtime.store.failJob(job.id, String((error as Error).message ?? error));
            throw error;
          }
        } finally {
          await runtime.close();
        }
      },
    ),
  );

// ---------------------------------------------------------------------------
// campaigns
// ---------------------------------------------------------------------------

const campaignsCommand = program
  .command('campaigns')
  .description('Detect and inspect coordinated review clusters.');

campaignsCommand
  .command('detect')
  .description('Build the co-review graph and detect dense campaign blocks.')
  .option('--tenant <id>', 'tenant id', 'default')
  .option('--queue', 'queue the job instead of running it now', false)
  .action(
    handle(async (options: { tenant?: string; queue?: boolean }) => {
      const runtime = await runtimeOrExit();
      try {
        const tenantId = options.tenant ?? 'default';
        const job = await runtime.store.createJob({
          tenantId,
          kind: 'campaigns',
          payload: {},
        });
        if (options.queue) {
          emit({ ok: true, jobId: job.id, status: 'pending' }, `Campaign job queued: ${job.id}`);
          return;
        }
        const handler = defaultHandlers.campaigns;
        if (!handler) throw new Error('Campaign handler missing.');
        try {
          const result = await handler(job, {
            store: runtime.store,
            service: runtime.service,
            config: runtime.config,
          });
          await runtime.store.completeJob(job.id, result);
          emit({ ok: true, jobId: job.id, result }, JSON.stringify(result, null, 2));
        } catch (error) {
          await runtime.store.failJob(job.id, String((error as Error).message ?? error));
          throw error;
        }
      } finally {
        await runtime.close();
      }
    }),
  );

campaignsCommand
  .command('list')
  .description('List detected campaigns.')
  .option('--tenant <id>', 'tenant id', 'default')
  .option('--limit <number>', 'maximum campaigns', '50')
  .action(
    handle(async (options: { tenant?: string; limit?: string }) => {
      const runtime = await runtimeOrExit();
      try {
        const campaigns = await runtime.store.listCampaigns(
          options.tenant ?? 'default',
          Number(options.limit ?? 50),
        );
        emit(
          { ok: true, campaigns },
          campaigns.length === 0
            ? 'No campaigns detected.'
            : campaigns
                .map(
                  (campaign) =>
                    `${campaign.id}  score ${campaign.score.toFixed(2)}  ${campaign.memberCount} reviewers  ${campaign.status}`,
                )
                .join('\n'),
        );
      } finally {
        await runtime.close();
      }
    }),
  );

// ---------------------------------------------------------------------------
// analyze / explain / select / report
// ---------------------------------------------------------------------------

program
  .command('analyze')
  .description('Analyze one review from flags or a JSON file.')
  .option('--file <path>', 'JSON file containing a review or { review, reviewer, item }')
  .option('--text <text>', 'review text')
  .option('--rating <rating>', 'star rating', '5')
  .option('--item <id>', 'item id', 'item')
  .option('--reviewer <id>', 'reviewer id', 'reviewer')
  .option('--tenant <id>', 'tenant id', 'default')
  .action(
    handle(
      async (options: {
        file?: string;
        text?: string;
        rating?: string;
        item?: string;
        reviewer?: string;
        tenant?: string;
      }) => {
        let payload: Record<string, unknown>;
        if (options.file) {
          payload = JSON.parse(readFileSync(resolve(options.file), 'utf8')) as Record<
            string,
            unknown
          >;
          if (!('review' in payload)) payload = { review: payload };
        } else if (options.text) {
          payload = {
            review: {
              itemId: options.item ?? 'item',
              reviewerId: options.reviewer ?? 'reviewer',
              rating: Number(options.rating ?? 5),
              text: options.text,
              submittedAt: new Date().toISOString(),
            },
          };
        } else {
          throw new Error('Provide --text or --file.');
        }
        const runtime = await runtimeOrExit();
        try {
          const review = payload.review as CanonicalReview;
          const reviewer = payload.reviewer as Record<string, unknown> | undefined;
          const item = payload.item as Record<string, unknown> | undefined;
          const accountCreatedAt =
            reviewer && typeof reviewer.accountCreatedAt === 'string'
              ? reviewer.accountCreatedAt
              : undefined;
          const reviewerStats = reviewer
            ? Object.fromEntries(
                Object.entries(reviewer).filter(([key]) => key !== 'accountCreatedAt'),
              )
            : undefined;
          const result = await runtime.service.ingest(
            options.tenant ?? 'default',
            {
              review,
              ...(reviewerStats
                ? {
                    reviewer: {
                      ...(accountCreatedAt ? { accountCreatedAt } : {}),
                      stats: reviewerStats,
                    },
                  }
                : {}),
              ...(item ? { item: item as never } : {}),
            },
            'cli',
          );
          emit(
            { ok: true, reviewId: result.review.id, result: result.result },
            `Review ${result.review.id}\n\n${humanResult(result.result)}`,
          );
        } finally {
          await runtime.close();
        }
      },
    ),
  );

program
  .command('explain <reviewId>')
  .description('Explain a stored decision.')
  .option('--tenant <id>', 'tenant id', 'default')
  .action(
    handle(async (reviewId: string, options: { tenant?: string }) => {
      const runtime = await runtimeOrExit();
      try {
        const result = await runtime.service.getResult(options.tenant ?? 'default', reviewId);
        if (!result) throw new Error('Review not found.');
        const human = [
          `Review ${reviewId}`,
          `${pc.bold('Decision:')} ${result.result.decision}  ${pc.bold('Score:')} ${(result.result.score * 100).toFixed(1)}%  ${pc.bold('Confidence:')} ${(result.result.confidence * 100).toFixed(1)}%`,
          '',
          ...result.result.reasons.map(
            (reason) =>
              `  ${pc.cyan(reason.code)}  ${pc.dim(`+${reason.contribution.toFixed(3)}`)}  ${reason.message}`,
          ),
        ].join('\n');
        emit({ ok: true, ...result.result }, human);
      } finally {
        await runtime.close();
      }
    }),
  );

program
  .command('select')
  .description('Select trustworthy, diverse reviews for an item.')
  .requiredOption('--item <id>', 'item id or external id')
  .option('--limit <number>', 'number of reviews', '10')
  .option('--min-trust <number>', 'minimum trust score', '0')
  .option('--include-flagged', 'include held/removed reviews', false)
  .option('--tenant <id>', 'tenant id', 'default')
  .action(
    handle(
      async (options: {
        item: string;
        limit?: string;
        minTrust?: string;
        includeFlagged?: boolean;
        tenant?: string;
      }) => {
        const runtime = await runtimeOrExit();
        try {
          const result = await runtime.service.selectReviews(
            options.tenant ?? 'default',
            options.item,
            {
              limit: Number(options.limit ?? 10),
              minTrust: Number(options.minTrust ?? 0),
              includeFlagged: options.includeFlagged === true,
            },
          );
          if (!result) throw new Error('Item not found.');
          const human = [
            `Selected ${result.selection.reviews.length} of ${result.selection.clusters} clusters`,
            `Aspects: ${result.selection.aspectsCovered.join(', ') || 'none'}`,
            '',
            ...result.selection.reviews.map(
              (review) =>
                `${review.id}  ${'★'.repeat(Math.round(review.rating))}${'☆'.repeat(5 - Math.round(review.rating))}  trust ${(review.trustScore * 100).toFixed(0)}%  ${review.selectionReason}\n  ${review.text.slice(0, 180)}${review.text.length > 180 ? '…' : ''}`,
            ),
          ].join('\n');
          emit({ ok: true, ...result.selection }, human);
        } finally {
          await runtime.close();
        }
      },
    ),
  );

program
  .command('report')
  .description('Trust-weighted integrity report for an item.')
  .requiredOption('--item <id>', 'item id or external id')
  .option('--html', 'render an HTML report', false)
  .option('--out <path>', 'write HTML to a file')
  .option('--tenant <id>', 'tenant id', 'default')
  .action(
    handle(async (options: { item: string; html?: boolean; out?: string; tenant?: string }) => {
      const runtime = await runtimeOrExit();
      try {
        const result = await runtime.service.computeIntegrity(
          options.tenant ?? 'default',
          options.item,
        );
        if (!result) throw new Error('Item not found.');
        if (options.html) {
          const html = renderIntegrityHtml(result.itemId, result.integrity);
          if (options.out) {
            writeFileSync(resolve(options.out), html);
            emit({ ok: true, out: options.out }, pc.green(`Wrote ${options.out}`));
          } else {
            console.log(html);
          }
          return;
        }
        const human = [
          `Item ${result.itemId}`,
          `Raw rating:      ${result.integrity.rawRating.toFixed(2)}`,
          `Adjusted rating: ${result.integrity.adjustedRating.toFixed(2)}  ${pc.dim(`(${result.integrity.delta >= 0 ? '+' : ''}${result.integrity.delta.toFixed(2)})`)}`,
          `95% interval:    ${result.integrity.confidenceLow.toFixed(2)} – ${result.integrity.confidenceHigh.toFixed(2)}`,
          `Reviews:         ${result.integrity.reviewCount} (${result.integrity.includedCount} included, ${result.integrity.effectiveSampleSize.toFixed(1)} effective)`,
          `Suspicion rate:  ${(result.integrity.suspicionRate * 100).toFixed(1)}%`,
          `Excess 5★:       ${(result.integrity.excessFiveStar * 100).toFixed(1)}%`,
          `Bimodality:      ${result.integrity.bimodality.toFixed(2)}`,
          `Distribution:    mode ${result.integrity.distributionSignals.modeStars}★ · std dev ${result.integrity.distributionSignals.stdDev.toFixed(2)} · polarization ${result.integrity.distributionSignals.polarizationIndex.toFixed(2)}`,
          `Verified share:  ${result.integrity.distributionSignals.verifiedShare === 0 ? 'unknown' : `${(result.integrity.distributionSignals.verifiedShare * 100).toFixed(0)}%`} · recent-90d weight ${((result.integrity.distributionSignals.recencyWeightedShare90d || 0) * 100).toFixed(0)}%${result.integrity.distributionSignals.allPositiveSuspicion ? ' · 100%-positive profile (consumers distrust these; not proof of fraud)' : ''}`,
          `Top concerns:    ${result.integrity.topConcerns.join(', ') || 'none'}`,
        ].join('\n');
        emit({ ok: true, ...result }, human);
      } finally {
        await runtime.close();
      }
    }),
  );

program
  .command('statement-of-reasons <reviewId>')
  .description('DSA-style statement of reasons for a stored decision (JSON or markdown).')
  .option('--md', 'render markdown', false)
  .option('--tenant <id>', 'tenant id', 'default')
  .action(
    handle(async (reviewId: string, options: { md?: boolean; tenant?: string }) => {
      const runtime = await runtimeOrExit();
      try {
        const result = await runtime.service.getResult(options.tenant ?? 'default', reviewId);
        if (!result) throw new Error('Review not found.');
        const sor = buildStatementOfReasons({
          review: result.review,
          result: result.result,
          config: runtime.config,
        });
        if (options.md) {
          emit(
            { ok: true, markdown: renderStatementOfReasonsMarkdown(sor) },
            renderStatementOfReasonsMarkdown(sor),
          );
          return;
        }
        emit(
          { ok: true, statementOfReasons: sor },
          `Statement of reasons ${sor.id}\nDecision: ${sor.decision.decision} — ${sor.decision.visibility}\nGrounds: ${sor.grounds.flatMap((ground) => ground.codes).join(', ') || 'none'}`,
        );
      } finally {
        await runtime.close();
      }
    }),
  );

const appealsCommand = program.command('appeals').description('Appeal workflows (DSA Art. 20).');

appealsCommand
  .command('list')
  .description('List appeals by status.')
  .option('--status <status>', 'open | upheld | overturned')
  .option('--tenant <id>', 'tenant id', 'default')
  .action(
    handle(async (options: { status?: string; tenant?: string }) => {
      const runtime = await runtimeOrExit();
      try {
        const status =
          options.status === 'open' ||
          options.status === 'upheld' ||
          options.status === 'overturned'
            ? options.status
            : undefined;
        const appeals = await runtime.store.listAppeals(options.tenant ?? 'default', status);
        emit(
          { ok: true, appeals },
          appeals
            .map(
              (appeal) =>
                `${appeal.id}  ${appeal.status.padEnd(10)}  review ${appeal.reviewId}  opened ${appeal.createdAt.slice(0, 10)}  due ${appeal.slaDueAt ? appeal.slaDueAt.slice(0, 10) : '—'}`,
            )
            .join('\n') || 'No appeals.',
        );
      } finally {
        await runtime.close();
      }
    }),
  );

appealsCommand
  .command('resolve <id>')
  .description('Record a human adjudication — handler identity is required (not purely automated).')
  .requiredOption('--outcome <outcome>', 'upheld | overturned')
  .requiredOption('--handler <hmac>', 'human handler identity (raw value; stored as tenant HMAC)')
  .option('--reason <text>', 'outcome note')
  .option('--tenant <id>', 'tenant id', 'default')
  .action(
    handle(
      async (
        id: string,
        options: { outcome: string; handler: string; reason?: string; tenant?: string },
      ) => {
        if (options.outcome !== 'upheld' && options.outcome !== 'overturned') {
          throw new Error('--outcome must be upheld or overturned.');
        }
        const runtime = await runtimeOrExit();
        try {
          const appeal = await runtime.store.resolveAppeal(
            options.tenant ?? 'default',
            id,
            options.outcome,
            scopedHmac(
              runtime.config.privacy.pepper,
              options.tenant ?? 'default',
              'actor',
              options.handler,
            ),
            options.reason ?? null,
          );
          if (!appeal) throw new Error('Appeal not found.');
          emit(
            { ok: true, appeal },
            `Appeal ${appeal.id}: ${appeal.status}${appeal.outcomeNote ? ` — ${appeal.outcomeNote}` : ''}`,
          );
        } finally {
          await runtime.close();
        }
      },
    ),
  );

const noticesCommand = program
  .command('notices')
  .description('Notice-and-action records (DSA Art. 16).');

noticesCommand
  .command('add')
  .description('Record a notice (complaint, legal, or authority) against a review.')
  .requiredOption('--review <id>', 'review id')
  .requiredOption('--type <type>', 'complaint | legal | authority')
  .requiredOption('--claim <text>', 'the claim made in the notice')
  .option('--substantiated', 'mark the notice substantiated on receipt', false)
  .option('--tenant <id>', 'tenant id', 'default')
  .action(
    handle(
      async (options: {
        review: string;
        type: string;
        claim: string;
        substantiated?: boolean;
        tenant?: string;
      }) => {
        if (!['complaint', 'legal', 'authority'].includes(options.type)) {
          throw new Error('--type must be complaint, legal, or authority.');
        }
        const runtime = await runtimeOrExit();
        try {
          const notice = await runtime.store.insertNotice({
            tenantId: options.tenant ?? 'default',
            reviewId: options.review,
            type: options.type as 'complaint' | 'legal' | 'authority',
            claim: options.claim,
            substantiated: options.substantiated ?? false,
          });
          await runtime.store.appendAudit({
            tenantId: options.tenant ?? 'default',
            actor: 'cli',
            action: 'notice.received',
            targetType: 'notice',
            targetId: notice.id,
            payload: { reviewId: notice.reviewId, type: notice.type },
          });
          emit(
            { ok: true, notice },
            `Notice ${notice.id} recorded against review ${notice.reviewId} (type ${notice.type}).`,
          );
        } finally {
          await runtime.close();
        }
      },
    ),
  );

noticesCommand
  .command('list')
  .description('List notices.')
  .option('--review <id>', 'filter by review id')
  .option('--tenant <id>', 'tenant id', 'default')
  .action(
    handle(async (options: { review?: string; tenant?: string }) => {
      const runtime = await runtimeOrExit();
      try {
        const notices = await runtime.store.listNotices(options.tenant ?? 'default', {
          ...(options.review ? { reviewId: options.review } : {}),
          limit: 200,
        });
        emit(
          { ok: true, notices },
          notices
            .map(
              (notice) =>
                `${notice.id}  ${notice.type.padEnd(10)} ${notice.status.padEnd(12)} review ${notice.reviewId}  ${notice.createdAt.slice(0, 10)}`,
            )
            .join('\n') || 'No notices.',
        );
      } finally {
        await runtime.close();
      }
    }),
  );

noticesCommand
  .command('status <id>')
  .description('Update a notice status (received, under_review, actioned, rejected, expired).')
  .requiredOption('--value <status>', 'new status')
  .option('--note <text>', 'status note')
  .option('--tenant <id>', 'tenant id', 'default')
  .action(
    handle(async (id: string, options: { value: string; note?: string; tenant?: string }) => {
      const runtime = await runtimeOrExit();
      try {
        const notice = await runtime.store.updateNoticeStatus(options.tenant ?? 'default', id, {
          status: options.value as never,
          ...(options.note ? { note: options.note } : {}),
        });
        if (!notice) throw new Error('Notice not found.');
        emit({ ok: true, notice }, `Notice ${notice.id} → ${notice.status}`);
      } finally {
        await runtime.close();
      }
    }),
  );

program
  .command('transparency')
  .description('Aggregate transparency and fairness report (DSA Art. 15/24; DMCCA evidence).')
  .option('--days <number>', 'report window in days', '90')
  .option('--html', 'render as HTML', false)
  .option('--out <path>', 'write HTML to a file')
  .option('--tenant <id>', 'tenant id', 'default')
  .action(
    handle(async (options: { days?: string; html?: boolean; out?: string; tenant?: string }) => {
      const runtime = await runtimeOrExit();
      try {
        const report = await buildTransparencyReport(runtime.store, options.tenant ?? 'default', {
          sinceDays: Number(options.days ?? 90),
        });
        if (options.html) {
          const html = renderTransparencyHtml(report);
          if (options.out) {
            writeFileSync(resolve(options.out), html);
            emit({ ok: true, out: options.out }, pc.green(`Wrote ${options.out}`));
          } else {
            console.log(html);
          }
          return;
        }
        const appeals = report.humanOversight.appeals;
        const human = [
          `Transparency report (${report.period.from.slice(0, 10)} → ${report.period.to.slice(0, 10)})`,
          `Reviews analyzed: ${report.reviews.analyzed}`,
          ...Object.entries(report.reviews.byDecision).map(
            ([decision, count]) => `  ${decision}: ${count}`,
          ),
          `Safety-routed: ${report.reviews.safetyRouted}`,
          `Appeals: open ${appeals.open}, upheld ${appeals.upheld}, overturned ${appeals.overturned}, SLA breaches ${appeals.slaBreaches}`,
          `Automation share: ${report.humanOversight.automationShare}`,
          `Notices: ${JSON.stringify(report.notices)}`,
        ].join('\n');
        emit({ ok: true, report }, human);
      } finally {
        await runtime.close();
      }
    }),
  );

function renderIntegrityHtml(itemId: string, integrity: IntegrityResult): string {
  const counts = integrity.distribution;
  const max = Math.max(1, ...Object.values(counts));
  const bars = (['1', '2', '3', '4', '5'] as const)
    .map((star) => {
      const value = counts[star];
      const width = Math.round((value / max) * 180);
      return `<div class="bar"><span>${star}★</span><div class="track"><div class="fill" style="width:${width}px"></div></div><strong>${value}</strong></div>`;
    })
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Revlyra integrity report</title>
<style>
:root{color-scheme:dark}
body{margin:0;background:#0b0d10;color:#e8edf2;font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:48px 24px}
h1{font-size:26px;letter-spacing:-.02em;margin:0 0 4px}
.muted{color:#8b98a6}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:28px 0}
.card{background:#131820;border:1px solid #222c38;border-radius:12px;padding:16px}
.card .value{font-size:24px;font-weight:650;letter-spacing:-.02em}
.bar{display:grid;grid-template-columns:32px 1fr 40px;align-items:center;gap:10px;margin:8px 0}
.track{height:8px;background:#1b2430;border-radius:999px;overflow:hidden}
.fill{height:100%;background:linear-gradient(90deg,#3b82f6,#22c55e);border-radius:999px}
.pill{display:inline-block;padding:3px 9px;border:1px solid #2b3949;border-radius:999px;font-size:12px;color:#9fb0c2;margin:0 6px 6px 0}
table{width:100%;border-collapse:collapse;margin-top:10px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #1d2631}
</style></head>
<body><main>
<h1>Review integrity report</h1>
<p class="muted">Item ${escapeHtml(itemId)} · generated ${new Date().toISOString()}</p>
<div class="grid">
  <div class="card"><div class="muted">Raw rating</div><div class="value">${integrity.rawRating.toFixed(2)}</div></div>
  <div class="card"><div class="muted">Adjusted rating</div><div class="value">${integrity.adjustedRating.toFixed(2)}</div><div class="muted">${integrity.delta >= 0 ? '+' : ''}${integrity.delta.toFixed(2)}</div></div>
  <div class="card"><div class="muted">Suspicion rate</div><div class="value">${(integrity.suspicionRate * 100).toFixed(1)}%</div></div>
  <div class="card"><div class="muted">Reviews</div><div class="value">${integrity.reviewCount}</div><div class="muted">${integrity.includedCount} included</div></div>
</div>
<h2>Rating distribution</h2>${bars}
<h2>Distributional signals</h2>
<p>
<span class="pill">mode ${integrity.distributionSignals.modeStars}★</span>
<span class="pill">std dev ${integrity.distributionSignals.stdDev.toFixed(2)}</span>
<span class="pill">critical ${(integrity.distributionSignals.criticalShare * 100).toFixed(0)}%</span>
<span class="pill">positive ${(integrity.distributionSignals.positiveRatio * 100).toFixed(0)}%</span>
<span class="pill">polarization ${integrity.distributionSignals.polarizationIndex.toFixed(2)}</span>
<span class="pill">verified share ${integrity.distributionSignals.verifiedShare === 0 ? 'unknown' : `${(integrity.distributionSignals.verifiedShare * 100).toFixed(0)}%`}</span>
<span class="pill">recency-90d weight ${((integrity.distributionSignals.recencyWeightedShare90d || 0) * 100).toFixed(0)}%</span>
${integrity.distributionSignals.allPositiveSuspicion ? '<span class="pill" style="color:#f59e0b">100%-positive profile: most consumers distrust these (context, not proof of fraud)</span>' : ''}
</p>
<h2>Signals</h2>
<p>${integrity.topConcerns.map((concern) => `<span class="pill">${escapeHtml(concern)}</span>`).join('') || '<span class="muted">No strong concerns.</span>'}</p>
<p class="muted">This report is a risk assessment, not proof of fraud. Adverse actions require human review and an appeal path.</p>
</main></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;');
}

// ---------------------------------------------------------------------------
// serve / worker / db / audit / doctor / bench
// ---------------------------------------------------------------------------

program
  .command('serve')
  .description('Start the HTTP API.')
  .option('--port <port>', 'port override')
  .option('--host <host>', 'host override')
  .option('--no-worker', 'do not start the background worker')
  .action(
    handle(async (options: { port?: string; host?: string; worker?: boolean }) => {
      const runtime = await runtimeOrExit();
      if (options.port) runtime.config.server.port = Number(options.port);
      if (options.host) runtime.config.server.host = options.host;
      const app = await startServer({
        config: runtime.config,
        store: runtime.store,
        service: runtime.service,
        startWorker: options.worker !== false,
      });
      const address = app.server.address();
      const port =
        typeof address === 'object' && address ? address.port : runtime.config.server.port;
      emit(
        { ok: true, host: runtime.config.server.host, port, version: VERSION },
        `${pc.green('Revlyra API listening')} on http://${runtime.config.server.host}:${port}\n${pc.dim('Press Ctrl+C to stop.')}`,
      );
      const shutdown = async () => {
        await app.close();
        await runtime.close();
        process.exit(0);
      };
      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());
    }),
  );

program
  .command('worker')
  .description('Run the background job worker.')
  .option('--once', 'process one batch of jobs and exit', false)
  .action(
    handle(async (options: { once?: boolean }) => {
      const runtime = await runtimeOrExit();
      const worker = new JobWorker({
        store: runtime.store,
        service: runtime.service,
        config: runtime.config,
      });
      if (options.once) {
        const processed = await worker.runOnce();
        await runtime.close();
        emit({ ok: true, processed }, `Processed ${processed} job(s).`);
        return;
      }
      worker.start();
      emit({ ok: true, status: 'running' }, pc.green('Worker started. Press Ctrl+C to stop.'));
      const shutdown = async () => {
        await worker.stop();
        await runtime.close();
        process.exit(0);
      };
      process.on('SIGINT', () => void shutdown());
      process.on('SIGTERM', () => void shutdown());
    }),
  );

program
  .command('db')
  .description('Database maintenance.')
  .addCommand(
    new Command('migrate').description('Apply schema migrations.').action(
      handle(async () => {
        const runtime = await runtimeOrExit({ requireLicense: false });
        await runtime.store.migrate();
        await runtime.close();
        emit({ ok: true, migrated: true }, pc.green('Migrations applied.'));
      }),
    ),
  )
  .addCommand(
    new Command('backup')
      .description('Back up the SQLite database.')
      .requiredOption('--out <path>', 'backup path')
      .action(
        handle(async (options: { out: string }) => {
          const config = loadConfig({ cwd: process.cwd(), requirePepper: false });
          if (config.database.driver !== 'sqlite') {
            throw new Error('Use pg_dump for Postgres backups.');
          }
          const sqlite = (await import('../sqlite')).sqliteModule();
          const out = resolve(options.out);
          if (existsSync(out)) throw new Error(`Backup path already exists: ${out}`);
          const db = new sqlite.DatabaseSync(config.database.path);
          try {
            const backupFn = (
              sqlite as { backup?: (source: unknown, path: string) => Promise<number> }
            ).backup;
            if (typeof backupFn === 'function') {
              const pages = await backupFn(db, out);
              emit({ ok: true, out, pages }, pc.green(`Backed up to ${out}`));
            } else {
              db.exec(`VACUUM INTO '${out.replace(/'/gu, "''")}'`);
              emit({ ok: true, out }, pc.green(`Backed up to ${out}`));
            }
          } finally {
            db.close();
          }
        }),
      ),
  );

program
  .command('audit')
  .description('Audit log operations.')
  .addCommand(
    new Command('verify')
      .description('Verify the tamper-evident audit chain.')
      .option('--tenant <id>', 'tenant id', 'default')
      .action(
        handle(async (options: { tenant?: string }) => {
          const runtime = await runtimeOrExit();
          try {
            const result = await runtime.store.verifyAudit(options.tenant ?? 'default');
            emit(
              result,
              result.valid
                ? pc.green(`Audit chain valid (${result.count} entries).`)
                : pc.red(`Audit chain broken at seq ${result.firstBrokenSeq}.`),
            );
            if (!result.valid) process.exitCode = 1;
          } finally {
            await runtime.close();
          }
        }),
      ),
  )
  .addCommand(
    new Command('export')
      .description('Export the audit log as JSONL.')
      .option('--tenant <id>', 'tenant id', 'default')
      .option('--out <path>', 'write to a file')
      .action(
        handle(async (options: { tenant?: string; out?: string }) => {
          const runtime = await runtimeOrExit();
          try {
            const rows = await runtime.store.listAudit(options.tenant ?? 'default', 10_000);
            const jsonl = rows.map((row) => JSON.stringify(row)).join('\n');
            if (options.out) {
              writeFileSync(resolve(options.out), `${jsonl}\n`);
              emit(
                { ok: true, out: options.out, count: rows.length },
                pc.green(`Exported ${rows.length} entries.`),
              );
            } else {
              console.log(jsonl);
            }
          } finally {
            await runtime.close();
          }
        }),
      ),
  );

program
  .command('doctor')
  .description('Diagnose configuration, license, store, and optional modules.')
  .action(
    handle(async () => {
      const config = loadConfig({ cwd: process.cwd(), requirePepper: false });
      const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
      checks.push({ name: 'node', ok: true, detail: process.version });
      checks.push({ name: 'platform', ok: true, detail: `${process.platform} ${process.arch}` });

      try {
        const resolved = await resolveLicense({
          configDir: config.configDir,
          licenseKey: config.license.key,
          ...(config.license.publicKey ? { publicKey: config.license.publicKey } : {}),
          ...(config.license.server ? { licenseServer: config.license.server } : {}),
          allowOnline: false,
        });
        checks.push({
          name: 'license',
          ok: resolved.status.valid,
          detail: `${resolved.status.kind} / ${resolved.status.tier}${resolved.status.reason ? ` (${resolved.status.reason})` : ''}`,
        });
      } catch (error) {
        checks.push({ name: 'license', ok: false, detail: String(error) });
      }

      checks.push({
        name: 'pepper',
        ok: config.privacy.pepper.length >= 16,
        detail: config.privacy.pepper ? 'set' : 'missing',
      });

      let store: Store | null = null;
      try {
        const runtime = await runtimeOrExit({ requireLicense: false, allowOnlineLicense: false });
        store = runtime.store;
        const corpus = await runtime.store.getCorpusStats('default');
        checks.push({
          name: 'store',
          ok: true,
          detail: `${config.database.driver}; ${corpus.totalReviews} reviews`,
        });
        await runtime.close();
      } catch (error) {
        checks.push({ name: 'store', ok: false, detail: String(error) });
        if (store) await store.close().catch(() => undefined);
      }

      for (const [name, spec] of [
        ['sharp', 'sharp'],
        ['pg', 'pg'],
        ['mysql2', 'mysql2/promise'],
        ['mongodb', 'mongodb'],
        ['@huggingface/transformers', '@huggingface/transformers'],
      ] as const) {
        try {
          await import(spec);
          checks.push({ name, ok: true, detail: 'available' });
        } catch {
          checks.push({ name, ok: true, detail: 'not installed (optional)' });
        }
      }

      const human = checks
        .map(
          (check) =>
            `${check.ok ? pc.green('✓') : pc.red('✗')} ${check.name.padEnd(26)} ${check.detail}`,
        )
        .join('\n');
      emit({ ok: checks.every((check) => check.ok), checks, config: redactConfig(config) }, human);
      if (checks.some((check) => !check.ok)) process.exitCode = 1;
    }),
  );

program
  .command('bench')
  .description('Benchmark the core analysis pipeline.')
  .option('--count <number>', 'reviews to analyze', '1000')
  .action(
    handle(async (options: { count?: string }) => {
      const config = loadConfig({ cwd: process.cwd(), requirePepper: false });
      const policy = getPolicyPreset(config.detection.policy);
      const count = Math.max(10, Math.min(100_000, Number(options.count ?? 1000)));
      const times: number[] = [];
      const start = performance.now();
      for (let i = 0; i < count; i += 1) {
        const review: CanonicalReview = {
          id: `bench-${i}`,
          itemId: `item-${i % 100}`,
          reviewerId: `reviewer-${i % 500}`,
          rating: (i % 5) + 1,
          text: `I bought this ${i % 2 === 0 ? 'drill' : 'lamp'} three weeks ago. The build quality is ${i % 3 === 0 ? 'solid' : 'mixed'}, battery lasted about ${4 + (i % 4)} hours, and shipping took ${2 + (i % 5)} days.`,
          submittedAt: new Date(Date.now() - i * 60_000).toISOString(),
          verifiedPurchase: i % 4 !== 0,
        };
        const result = analyzeReview(review, {}, { policy });
        times.push(result.timings.total ?? 0);
      }
      const elapsed = performance.now() - start;
      times.sort((a, b) => a - b);
      const percentile = (p: number) =>
        times[Math.min(times.length - 1, Math.floor(times.length * p))] ?? 0;
      const summary = {
        count,
        elapsedMs: Number(elapsed.toFixed(1)),
        throughputPerSecond: Number(((count / elapsed) * 1000).toFixed(0)),
        p50Ms: Number((percentile(0.5) ?? 0).toFixed(2)),
        p95Ms: Number((percentile(0.95) ?? 0).toFixed(2)),
        p99Ms: Number((percentile(0.99) ?? 0).toFixed(2)),
      };
      emit(summary, JSON.stringify(summary, null, 2));
    }),
  );

program.parseAsync(process.argv).catch(fail);
