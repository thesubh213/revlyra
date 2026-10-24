import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  timingSafeEqual,
} from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Fastify from 'fastify';
import { verifySignedToken } from 'revlyra';
import { z } from 'zod';

type SqliteModule = typeof import('node:sqlite');

function sqliteModule(): SqliteModule {
  const getBuiltin = (process as NodeJS.Process & { getBuiltinModule?: (id: string) => unknown })
    .getBuiltinModule;
  if (!getBuiltin) throw new Error('node:sqlite requires Node 22.13+.');
  return getBuiltin.call(process, 'node:sqlite') as SqliteModule;
}

const PRIVATE_KEY = process.env.LICENSE_PRIVATE_KEY?.replace(/\\n/gu, '\n');
const ADMIN_KEY = process.env.LICENSE_ADMIN_KEY ?? '';
const HOST = process.env.LICENSE_HOST ?? '127.0.0.1';
const PORT = Number(process.env.LICENSE_PORT ?? 8790);
const DB_PATH = resolve(process.env.LICENSE_DB_PATH ?? './data/licenses.db');

if (!PRIVATE_KEY) {
  console.error('LICENSE_PRIVATE_KEY is required. Run node scripts/keygen.mjs to create one.');
  process.exit(1);
}
if (!ADMIN_KEY || ADMIN_KEY.length < 24) {
  console.error('LICENSE_ADMIN_KEY must be set to at least 24 characters.');
  process.exit(1);
}

const privateKey = createPrivateKey(PRIVATE_KEY);
const publicKey = createPublicKey(privateKey);
const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const limitsSchema = z.object({
  reviewsPerMonth: z.number().int().nonnegative(),
  sources: z.number().int().nonnegative(),
  rps: z.number().int().positive(),
  seats: z.number().int().positive(),
});

const licensePayloadSchema = z.object({
  sub: z.string().min(1),
  tier: z.enum(['dev', 'pro', 'enterprise']),
  features: z.array(z.string()),
  limits: limitsSchema,
  iat: z.number().int().nonnegative(),
  nbf: z.number().int().nonnegative().optional(),
  exp: z.number().int().positive(),
  jti: z.string().min(1),
  kid: z.string().optional(),
  licenseJti: z.string().optional(),
  installIdHash: z.string().optional(),
});

type LicensePayload = z.infer<typeof licensePayloadSchema>;

function signToken(payload: unknown, prefix: string): string {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const body = bytes.toString('base64url');
  const signature = sign(null, bytes, privateKey).toString('base64url');
  return `${prefix}${body}.${signature}`;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function installHash(installId: string): string {
  return createHash('sha256').update(installId, 'utf8').digest('hex');
}

function loadDb(): import('node:sqlite').DatabaseSync {
  if (DB_PATH !== ':memory:') mkdirSync(dirname(DB_PATH), { recursive: true });
  const sqlite = sqliteModule();
  const db = new sqlite.DatabaseSync(DB_PATH, { timeout: 5000 });
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS licenses (
      jti TEXT PRIMARY KEY,
      sub TEXT NOT NULL,
      tier TEXT NOT NULL,
      features TEXT NOT NULL,
      limits TEXT NOT NULL,
      install_id_hash TEXT,
      iat INTEGER NOT NULL,
      exp INTEGER NOT NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activations (
      license_jti TEXT NOT NULL,
      install_id_hash TEXT NOT NULL,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      PRIMARY KEY (license_jti, install_id_hash)
    );
    CREATE TABLE IF NOT EXISTS leases (
      jti TEXT PRIMARY KEY,
      license_jti TEXT NOT NULL,
      install_id_hash TEXT NOT NULL,
      exp INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return db;
}

const db = loadDb();

function getLicense(jti: string): Record<string, any> | undefined {
  return db.prepare('SELECT * FROM licenses WHERE jti = ?').get(jti) as
    | Record<string, any>
    | undefined;
}

function rowToPayload(row: Record<string, any>): LicensePayload {
  return {
    sub: String(row.sub),
    tier: String(row.tier) as LicensePayload['tier'],
    features: JSON.parse(String(row.features)) as string[],
    limits: JSON.parse(String(row.limits)) as LicensePayload['limits'],
    iat: Number(row.iat),
    exp: Number(row.exp),
    jti: String(row.jti),
    ...(row.install_id_hash ? { installIdHash: String(row.install_id_hash) } : {}),
  };
}

const app = Fastify({
  logger: {
    level: process.env.LICENSE_LOG_LEVEL ?? 'info',
    redact: ['req.headers.authorization'],
  },
  trustProxy: false,
  bodyLimit: 64 * 1024,
});

app.setErrorHandler((error, request, reply) => {
  if (error instanceof z.ZodError) {
    return reply.code(400).send({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed.',
        request_id: request.id,
        details: error.issues,
      },
    });
  }
  const status = (error as { statusCode?: number }).statusCode ?? 500;
  if (status >= 500) request.log.error({ err: error }, 'license server error');
  return reply.code(status).send({
    error: {
      code: (error as { code?: string }).code ?? 'INTERNAL',
      message: status >= 500 ? 'Internal error.' : (error as Error).message,
      request_id: request.id,
    },
  });
});

app.addHook('onRequest', async (request, reply) => {
  const path = (request.raw.url ?? request.url).split('?')[0];
  if (
    path === '/health' ||
    path === '/v1/public-key' ||
    path === '/v1/leases' ||
    request.method === 'OPTIONS'
  ) {
    return;
  }
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ') || !constantTimeEqual(header.slice(7), ADMIN_KEY)) {
    return reply.code(401).send({
      error: { code: 'AUTH_INVALID', message: 'Admin key required.', request_id: request.id },
    });
  }
});

app.get('/health', async () => ({ status: 'ok', service: 'revlyra-license-server' }));

app.get('/v1/public-key', async () => ({ publicKey: publicPem }));

const issueBody = z.object({
  sub: z.string().min(1),
  tier: z.enum(['pro', 'enterprise']),
  features: z.array(z.string()),
  limits: limitsSchema,
  expiresInDays: z.number().int().positive().max(3650).optional(),
  installIdHash: z.string().length(64).optional(),
});

app.post('/v1/licenses', async (request, reply) => {
  const body = issueBody.parse(request.body);
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (body.expiresInDays ?? 365) * 86_400;
  const payload: LicensePayload = {
    sub: body.sub,
    tier: body.tier,
    features: body.features,
    limits: body.limits,
    iat: now,
    exp,
    jti: randomUUID(),
    ...(body.installIdHash ? { installIdHash: body.installIdHash } : {}),
  };
  db.prepare(
    `INSERT INTO licenses (jti, sub, tier, features, limits, install_id_hash, iat, exp, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    payload.jti,
    payload.sub,
    payload.tier,
    JSON.stringify(payload.features),
    JSON.stringify(payload.limits),
    payload.installIdHash ?? null,
    payload.iat,
    payload.exp,
    new Date().toISOString(),
  );
  const license = signToken(payload, 'rvlyra_lic_v1_');
  return reply.code(201).send({
    license,
    jti: payload.jti,
    expiresAt: new Date(exp * 1000).toISOString(),
    installIdHash: payload.installIdHash ?? null,
  });
});

app.get('/v1/licenses', async () => {
  const rows = db
    .prepare('SELECT * FROM licenses ORDER BY created_at DESC LIMIT 500')
    .all() as Array<Record<string, any>>;
  return {
    licenses: rows.map((row) => ({
      jti: row.jti,
      sub: row.sub,
      tier: row.tier,
      features: JSON.parse(String(row.features)),
      limits: JSON.parse(String(row.limits)),
      installIdHash: row.install_id_hash,
      iat: row.iat,
      exp: row.exp,
      revokedAt: row.revoked_at,
      createdAt: row.created_at,
    })),
  };
});

app.get<{ Params: { jti: string } }>('/v1/licenses/:jti', async (request, reply) => {
  const row = getLicense(request.params.jti);
  if (!row)
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'License not found.' } });
  const activations = db
    .prepare('SELECT * FROM activations WHERE license_jti = ? ORDER BY last_seen DESC')
    .all(request.params.jti);
  return { license: rowToPayload(row), activations };
});

app.post<{ Params: { jti: string } }>('/v1/licenses/:jti/revoke', async (request, reply) => {
  const result = db
    .prepare('UPDATE licenses SET revoked_at = ? WHERE jti = ? AND revoked_at IS NULL')
    .run(new Date().toISOString(), request.params.jti);
  if (result.changes === 0) {
    const exists = getLicense(request.params.jti);
    if (!exists)
      return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'License not found.' } });
  }
  return { jti: request.params.jti, revoked: true };
});

const leaseBody = z.object({
  license: z.string().min(1),
  installId: z.string().min(1),
  product: z.string().optional(),
  version: z.string().optional(),
});

app.post('/v1/leases', async (request, reply) => {
  const body = leaseBody.parse(request.body);
  let payload: LicensePayload;
  try {
    payload = licensePayloadSchema.parse(verifySignedToken(body.license, publicPem));
  } catch (error) {
    return reply.code(403).send({
      error: {
        code: 'LICENSE_INVALID',
        message: String((error as Error).message ?? error),
      },
    });
  }

  const row = getLicense(payload.jti);
  if (!row || row.revoked_at) {
    return reply.code(403).send({
      error: { code: 'LICENSE_REVOKED_OR_UNKNOWN', message: 'License is not active.' },
    });
  }

  const installIdHash = installHash(body.installId);
  if (row.install_id_hash && row.install_id_hash !== installIdHash) {
    return reply.code(403).send({
      error: {
        code: 'LICENSE_BOUND_TO_OTHER_INSTALL',
        message: 'License is bound to another install.',
      },
    });
  }

  const activation = db
    .prepare('SELECT 1 FROM activations WHERE license_jti = ? AND install_id_hash = ?')
    .get(payload.jti, installIdHash);
  if (!activation) {
    const count = db
      .prepare('SELECT COUNT(*) AS total FROM activations WHERE license_jti = ?')
      .get(payload.jti) as { total: number };
    if (Number(count.total) >= payload.limits.seats) {
      return reply.code(403).send({
        error: { code: 'SEAT_LIMIT_REACHED', message: 'License activation limit reached.' },
      });
    }
    db.prepare(
      'INSERT INTO activations (license_jti, install_id_hash, first_seen, last_seen) VALUES (?, ?, ?, ?)',
    ).run(payload.jti, installIdHash, new Date().toISOString(), new Date().toISOString());
  } else {
    db.prepare(
      'UPDATE activations SET last_seen = ? WHERE license_jti = ? AND install_id_hash = ?',
    ).run(new Date().toISOString(), payload.jti, installIdHash);
  }

  const now = Math.floor(Date.now() / 1000);
  const leasePayload: LicensePayload = {
    sub: payload.sub,
    tier: payload.tier,
    features: payload.features,
    limits: payload.limits,
    iat: now,
    exp: now + 86_400,
    jti: randomUUID(),
    licenseJti: payload.jti,
    installIdHash,
  };
  const token = signToken(leasePayload, 'rvlyra_lease_v1_');
  db.prepare(
    'INSERT INTO leases (jti, license_jti, install_id_hash, exp, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(leasePayload.jti, payload.jti, installIdHash, leasePayload.exp, new Date().toISOString());

  return {
    token,
    expiresAt: new Date(leasePayload.exp * 1000).toISOString(),
    tier: payload.tier,
    features: payload.features,
    limits: payload.limits,
  };
});

const graceful = async () => {
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', () => void graceful());
process.on('SIGTERM', () => void graceful());

await app.listen({ host: HOST, port: PORT });
app.log.info(
  { host: HOST, port: PORT, db: existsSync(DB_PATH) ? DB_PATH : ':memory:' },
  'Revlyra license server listening',
);
