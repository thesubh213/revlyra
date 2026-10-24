import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { safeEqualHex } from '../privacy';
import { DEV_FEATURES, DEV_LIMITS, type LicenseStatus } from './types';

const DEV_KEY_PREFIX = 'rvlyra_dev_';
const DEV_FILE = 'dev-license.json';
const DEV_TTL_DAYS = 30;

const devFileSchema = z.object({
  keyHash: z.string().length(64),
  createdAt: z.string(),
  expiresAt: z.string(),
  tier: z.literal('dev'),
  features: z.array(z.string()),
  limits: z.object({
    reviewsPerMonth: z.number().int().nonnegative(),
    sources: z.number().int().nonnegative(),
    rps: z.number().int().positive(),
    seats: z.number().int().positive(),
  }),
});

export type DevLicenseFile = z.infer<typeof devFileSchema>;

export function devLicensePath(configDir: string): string {
  return join(configDir, DEV_FILE);
}

export function generateDevLicenseKey(): string {
  return `${DEV_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
}

export function hashDevLicenseKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function isDevLicenseKey(key: string): boolean {
  return key.startsWith(DEV_KEY_PREFIX) && key.length >= DEV_KEY_PREFIX.length + 32;
}

export function registerDevLicense(configDir: string, key: string): DevLicenseFile {
  if (!isDevLicenseKey(key)) {
    throw new Error('Invalid dev license key format.');
  }
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + DEV_TTL_DAYS * 86_400_000);
  const record: DevLicenseFile = {
    keyHash: hashDevLicenseKey(key),
    createdAt: createdAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    tier: 'dev',
    features: DEV_FEATURES,
    limits: DEV_LIMITS,
  };
  writeFileSync(devLicensePath(configDir), `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o600,
  });
  return record;
}

export function readDevLicense(configDir: string): DevLicenseFile | null {
  const file = devLicensePath(configDir);
  if (!existsSync(file)) return null;
  try {
    return devFileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

export function verifyDevLicense(configDir: string, key: string, now = new Date()): LicenseStatus {
  const record = readDevLicense(configDir);
  if (!record) {
    return {
      valid: false,
      kind: 'dev',
      tier: 'dev',
      subject: 'dev',
      features: [],
      limits: DEV_LIMITS,
      grace: false,
      reason: 'DEV_LICENSE_NOT_REGISTERED',
    };
  }
  if (!safeEqualHex(record.keyHash, hashDevLicenseKey(key))) {
    return {
      valid: false,
      kind: 'dev',
      tier: 'dev',
      subject: 'dev',
      features: [],
      limits: DEV_LIMITS,
      grace: false,
      reason: 'DEV_LICENSE_MISMATCH',
    };
  }
  if (new Date(record.expiresAt).getTime() <= now.getTime()) {
    return {
      valid: false,
      kind: 'dev',
      tier: 'dev',
      subject: 'dev',
      features: record.features,
      limits: record.limits,
      expiresAt: record.expiresAt,
      issuedAt: record.createdAt,
      grace: false,
      reason: 'DEV_LICENSE_EXPIRED',
    };
  }
  return {
    valid: true,
    kind: 'dev',
    tier: 'dev',
    subject: 'dev',
    features: record.features,
    limits: record.limits,
    expiresAt: record.expiresAt,
    issuedAt: record.createdAt,
    grace: false,
  };
}
