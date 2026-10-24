import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

const configFileSchema = z
  .object({
    server: z
      .object({
        host: z.string().optional(),
        port: z.number().int().positive().optional(),
        trustProxy: z.boolean().optional(),
        corsOrigins: z.array(z.string()).optional(),
        bodyLimit: z.number().int().positive().optional(),
      })
      .optional(),
    database: z
      .object({
        driver: z.enum(['sqlite', 'postgres']).optional(),
        path: z.string().optional(),
        url: z.string().optional(),
        poolSize: z.number().int().positive().optional(),
      })
      .optional(),
    license: z
      .object({
        key: z.string().optional(),
        server: z.string().url().optional(),
        publicKey: z.string().optional(),
        graceDays: z.number().int().nonnegative().optional(),
      })
      .optional(),
    privacy: z
      .object({
        pepper: z.string().optional(),
        storeRawText: z.boolean().optional(),
        retentionDays: z.number().int().positive().optional(),
        contextDays: z.number().int().positive().optional(),
        auditDays: z.number().int().positive().optional(),
        redactEvidence: z.boolean().optional(),
        identityMinimization: z.boolean().optional(),
      })
      .optional(),
    governance: z
      .object({
        appealSlaDays: z.number().int().positive().optional(),
        sorTerritory: z.enum(['EU', 'UK', 'US', 'global']).optional(),
        outOfCourtDisputeBody: z.string().optional(),
      })
      .optional(),
    detection: z
      .object({
        policy: z.string().optional(),
        modelPath: z.string().optional(),
        mediaEnabled: z.boolean().optional(),
        transformerEnabled: z.boolean().optional(),
        minReviewLength: z.number().int().nonnegative().optional(),
        modelDir: z.string().optional(),
        modelOffline: z.boolean().optional(),
        embeddingModel: z.string().optional(),
        classifierModel: z.string().optional(),
        allowModelDownloads: z.boolean().optional(),
      })
      .optional(),
    jobs: z
      .object({
        mode: z.enum(['inline', 'off', 'worker']).optional(),
        concurrency: z.number().int().positive().optional(),
        pollMs: z.number().int().positive().optional(),
      })
      .optional(),
    limits: z
      .object({
        reviewsPerMonth: z.number().int().nonnegative().optional(),
        rps: z.number().int().positive().optional(),
        maxBatch: z.number().int().positive().optional(),
      })
      .optional(),
    telemetry: z.boolean().optional(),
    logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).optional(),
  })
  .strict();

export type ConfigFile = z.infer<typeof configFileSchema>;

export interface RevlyraConfig {
  cwd: string;
  configDir: string;
  server: {
    host: string;
    port: number;
    trustProxy: boolean;
    corsOrigins: string[];
    bodyLimit: number;
  };
  database: {
    driver: 'sqlite' | 'postgres';
    path: string;
    url?: string;
    poolSize: number;
  };
  license: {
    key: string;
    server?: string;
    publicKey?: string;
    graceDays: number;
  };
  privacy: {
    pepper: string;
    storeRawText: boolean;
    retentionDays: number;
    contextDays: number;
    auditDays: number;
    redactEvidence: boolean;
    identityMinimization: boolean;
  };
  governance: {
    appealSlaDays: number;
    sorTerritory: 'EU' | 'UK' | 'US' | 'global';
    outOfCourtDisputeBody?: string;
  };
  detection: {
    policy: string;
    modelPath?: string;
    mediaEnabled: boolean;
    transformerEnabled: boolean;
    minReviewLength: number;
    modelDir?: string;
    modelOffline: boolean;
    embeddingModel?: string;
    classifierModel?: string;
    allowModelDownloads: boolean;
  };
  jobs: {
    mode: 'inline' | 'off' | 'worker';
    concurrency: number;
    pollMs: number;
  };
  limits: {
    reviewsPerMonth: number;
    rps: number;
    maxBatch: number;
  };
  adminKey: string;
  bootstrapApiKey: string;
  webhooks: {
    url?: string;
    secret?: string;
  };
  telemetry: boolean;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
}

export interface ConfigPaths {
  configDir: string;
  configFile: string;
  envFile: string;
  dataDir: string;
}

export function configPaths(cwd = process.cwd()): ConfigPaths {
  const configDir = join(cwd, '.revlyra');
  return {
    configDir,
    configFile: join(configDir, 'config.json'),
    envFile: join(cwd, '.env.local'),
    dataDir: join(cwd, 'data'),
  };
}

export function loadEnvFiles(cwd = process.cwd()): void {
  const load = (process as NodeJS.Process & { loadEnvFile?: (path: string) => void }).loadEnvFile;
  if (typeof load !== 'function') return;
  for (const name of ['.env', '.env.local']) {
    const file = join(cwd, name);
    if (!existsSync(file)) continue;
    try {
      load.call(process, file);
    } catch {
      // Malformed env files are reported by config validation later.
    }
  }
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

function envBool(name: string, fallback: boolean): boolean {
  const value = env(name);
  if (value === undefined) return fallback;
  return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes';
}

function envInt(name: string, fallback: number): number {
  const value = env(name);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readConfigFile(cwd: string): ConfigFile {
  const { configFile } = configPaths(cwd);
  if (!existsSync(configFile)) return {};
  try {
    return configFileSchema.parse(JSON.parse(readFileSync(configFile, 'utf8')));
  } catch (error) {
    throw new Error(`Invalid config file at ${configFile}: ${String(error)}`);
  }
}

function absolutePath(cwd: string, value: string): string {
  return isAbsolute(value) ? value : resolve(cwd, value);
}

export interface LoadConfigOptions {
  cwd?: string;
  overrides?: Partial<ConfigFile>;
  requirePepper?: boolean;
  loadEnv?: boolean;
}

export function loadConfig(options: LoadConfigOptions = {}): RevlyraConfig {
  const cwd = resolve(options.cwd ?? process.cwd());
  if (options.loadEnv !== false) loadEnvFiles(cwd);
  const file = readConfigFile(cwd);
  const merged: ConfigFile = {
    ...file,
    ...options.overrides,
    server: { ...file.server, ...options.overrides?.server },
    database: { ...file.database, ...options.overrides?.database },
    license: { ...file.license, ...options.overrides?.license },
    privacy: { ...file.privacy, ...options.overrides?.privacy },
    governance: { ...file.governance, ...options.overrides?.governance },
    detection: { ...file.detection, ...options.overrides?.detection },
    jobs: { ...file.jobs, ...options.overrides?.jobs },
    limits: { ...file.limits, ...options.overrides?.limits },
  };

  const driver =
    (env('REVLYRA_DB_DRIVER') as 'sqlite' | 'postgres' | undefined) ??
    merged.database?.driver ??
    'sqlite';
  const dbPath = absolutePath(
    cwd,
    env('REVLYRA_DB_PATH') ?? merged.database?.path ?? join('.revlyra', 'revlyra.db'),
  );
  const url = env('REVLYRA_DATABASE_URL') ?? merged.database?.url;
  if (driver === 'postgres' && !url) {
    throw new Error('REVLYRA_DATABASE_URL is required when REVLYRA_DB_DRIVER=postgres.');
  }

  const pepper = env('REVLYRA_PII_PEPPER') ?? merged.privacy?.pepper ?? '';
  if (options.requirePepper && pepper.length < 16) {
    throw new Error(
      'REVLYRA_PII_PEPPER must be set to at least 16 characters. Run `revlyra init` to generate it.',
    );
  }

  const corsOrigins = env('REVLYRA_CORS_ORIGINS')
    ? env('REVLYRA_CORS_ORIGINS')!
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
    : (merged.server?.corsOrigins ?? []);

  const publicKeyRaw = env('REVLYRA_LICENSE_PUBLIC_KEY') ?? merged.license?.publicKey;

  return {
    cwd,
    configDir: configPaths(cwd).configDir,
    server: {
      host: env('REVLYRA_HOST') ?? merged.server?.host ?? '127.0.0.1',
      port: envInt('REVLYRA_PORT', merged.server?.port ?? 8787),
      trustProxy: envBool('REVLYRA_TRUST_PROXY', merged.server?.trustProxy ?? false),
      corsOrigins,
      bodyLimit: envInt('REVLYRA_BODY_LIMIT', merged.server?.bodyLimit ?? 1_048_576),
    },
    database: {
      driver,
      path: dbPath,
      ...(url ? { url } : {}),
      poolSize: envInt('REVLYRA_DB_POOL', merged.database?.poolSize ?? 10),
    },
    license: {
      key: env('REVLYRA_LICENSE_KEY') ?? merged.license?.key ?? '',
      ...((env('REVLYRA_LICENSE_SERVER') ?? merged.license?.server)
        ? { server: env('REVLYRA_LICENSE_SERVER') ?? merged.license?.server }
        : {}),
      ...(publicKeyRaw ? { publicKey: publicKeyRaw.replace(/\\n/gu, '\n') } : {}),
      graceDays: envInt('REVLYRA_LICENSE_GRACE_DAYS', merged.license?.graceDays ?? 7),
    },
    privacy: {
      pepper,
      storeRawText: envBool('REVLYRA_STORE_RAW_TEXT', merged.privacy?.storeRawText ?? false),
      retentionDays: envInt('REVLYRA_RETENTION_DAYS', merged.privacy?.retentionDays ?? 180),
      contextDays: envInt('REVLYRA_CONTEXT_DAYS', merged.privacy?.contextDays ?? 30),
      auditDays: envInt('REVLYRA_AUDIT_DAYS', merged.privacy?.auditDays ?? 730),
      redactEvidence: envBool('REVLYRA_REDACT_EVIDENCE', merged.privacy?.redactEvidence ?? true),
      identityMinimization: envBool(
        'REVLYRA_IDENTITY_MINIMIZATION',
        merged.privacy?.identityMinimization ?? true,
      ),
    },
    governance: {
      appealSlaDays: envInt('REVLYRA_APPEAL_SLA_DAYS', merged.governance?.appealSlaDays ?? 30),
      sorTerritory:
        (env('REVLYRA_SOR_TERRITORY') as RevlyraConfig['governance']['sorTerritory'] | undefined) ??
        merged.governance?.sorTerritory ??
        'global',
      ...((env('REVLYRA_OOCD_BODY') ?? merged.governance?.outOfCourtDisputeBody)
        ? {
            outOfCourtDisputeBody:
              env('REVLYRA_OOCD_BODY') ?? merged.governance?.outOfCourtDisputeBody,
          }
        : {}),
    },
    detection: {
      policy: env('REVLYRA_POLICY') ?? merged.detection?.policy ?? 'balanced',
      ...((env('REVLYRA_MODEL_PATH') ?? merged.detection?.modelPath)
        ? { modelPath: env('REVLYRA_MODEL_PATH') ?? merged.detection?.modelPath }
        : {}),
      mediaEnabled: envBool('REVLYRA_MEDIA_ENABLED', merged.detection?.mediaEnabled ?? false),
      transformerEnabled: envBool(
        'REVLYRA_TRANSFORMER',
        merged.detection?.transformerEnabled ?? false,
      ),
      minReviewLength: envInt('REVLYRA_MIN_REVIEW_LENGTH', merged.detection?.minReviewLength ?? 0),
      ...((env('REVLYRA_MODEL_DIR') ?? merged.detection?.modelDir)
        ? { modelDir: env('REVLYRA_MODEL_DIR') ?? merged.detection?.modelDir }
        : {}),
      modelOffline: envBool('REVLYRA_MODEL_OFFLINE', merged.detection?.modelOffline ?? false),
      ...((env('REVLYRA_EMBEDDING_MODEL') ?? merged.detection?.embeddingModel)
        ? {
            embeddingModel: env('REVLYRA_EMBEDDING_MODEL') ?? merged.detection?.embeddingModel,
          }
        : {}),
      ...((env('REVLYRA_CLASSIFIER_MODEL') ?? merged.detection?.classifierModel)
        ? {
            classifierModel: env('REVLYRA_CLASSIFIER_MODEL') ?? merged.detection?.classifierModel,
          }
        : {}),
      allowModelDownloads: envBool(
        'REVLYRA_MODEL_DOWNLOAD',
        merged.detection?.allowModelDownloads ?? false,
      ),
    },
    jobs: {
      mode:
        (env('REVLYRA_WORKER') as 'inline' | 'off' | 'worker' | undefined) ??
        merged.jobs?.mode ??
        'inline',
      concurrency: envInt('REVLYRA_JOB_CONCURRENCY', merged.jobs?.concurrency ?? 2),
      pollMs: envInt('REVLYRA_JOB_POLL_MS', merged.jobs?.pollMs ?? 500),
    },
    limits: {
      reviewsPerMonth: envInt(
        'REVLYRA_LIMIT_REVIEWS_PER_MONTH',
        merged.limits?.reviewsPerMonth ?? 100_000,
      ),
      rps: envInt('REVLYRA_LIMIT_RPS', merged.limits?.rps ?? 50),
      maxBatch: envInt('REVLYRA_LIMIT_MAX_BATCH', merged.limits?.maxBatch ?? 1000),
    },
    adminKey: env('REVLYRA_ADMIN_KEY') ?? '',
    bootstrapApiKey: env('REVLYRA_API_KEY') ?? '',
    webhooks: {
      ...(env('REVLYRA_WEBHOOK_URL') ? { url: env('REVLYRA_WEBHOOK_URL') } : {}),
      ...(env('REVLYRA_WEBHOOK_SECRET') ? { secret: env('REVLYRA_WEBHOOK_SECRET') } : {}),
    },
    telemetry: envBool('REVLYRA_TELEMETRY', merged.telemetry ?? false),
    logLevel:
      (env('REVLYRA_LOG_LEVEL') as RevlyraConfig['logLevel'] | undefined) ??
      merged.logLevel ??
      'info',
  };
}

export function ensureConfigDir(cwd = process.cwd()): ConfigPaths {
  const paths = configPaths(cwd);
  mkdirSync(paths.configDir, { recursive: true });
  mkdirSync(dirname(paths.envFile), { recursive: true });
  return paths;
}

export function writeEnvLocal(cwd: string, values: Record<string, string>): string {
  const paths = ensureConfigDir(cwd);
  const lines = [
    '# Generated by `revlyra init`. Never commit this file.',
    '',
    ...Object.entries(values).map(([key, value]) => `${key}=${value}`),
    '',
  ];
  writeFileSync(paths.envFile, lines.join('\n'), { mode: 0o600 });
  return paths.envFile;
}

export function writeConfigFile(cwd: string, config: ConfigFile): string {
  const paths = ensureConfigDir(cwd);
  writeFileSync(paths.configFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return paths.configFile;
}

export function redactConfig(config: RevlyraConfig): Record<string, unknown> {
  return {
    ...config,
    license: { ...config.license, key: config.license.key ? '***' : '' },
    privacy: { ...config.privacy, pepper: config.privacy.pepper ? '***' : '' },
    adminKey: config.adminKey ? '***' : '',
    bootstrapApiKey: config.bootstrapApiKey ? '***' : '',
    database: {
      ...config.database,
      ...(config.database.url
        ? { url: config.database.url.replace(/:\/\/[^@]+@/u, '://***@') }
        : {}),
    },
  };
}
