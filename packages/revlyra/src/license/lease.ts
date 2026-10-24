import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { parseLicenseToken, statusFromPayload, verifySignedToken } from './token';
import type { LicenseStatus } from './types';

const leaseFileSchema = z.object({
  token: z.string(),
  obtainedAt: z.string(),
  expiresAt: z.string(),
});

export type LeaseFile = z.infer<typeof leaseFileSchema>;

export function leasePath(configDir: string): string {
  return join(configDir, 'lease.json');
}

export function readLease(configDir: string): LeaseFile | null {
  const file = leasePath(configDir);
  if (!existsSync(file)) return null;
  try {
    return leaseFileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return null;
  }
}

export function writeLease(configDir: string, lease: LeaseFile): void {
  writeFileSync(leasePath(configDir), `${JSON.stringify(lease, null, 2)}\n`, { mode: 0o600 });
}

export interface LeaseOptions {
  server: string;
  licenseKey: string;
  /** Raw install ID. The server hashes it; never send the hash here. */
  installId: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export async function requestLease(options: LeaseOptions): Promise<{
  token: string;
  expiresAt: string;
}> {
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
  try {
    const response = await fetcher(`${options.server.replace(/\/$/u, '')}/v1/leases`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        license: options.licenseKey,
        installId: options.installId,
        product: 'revlyra',
        version: '0.1.0',
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`LEASE_REQUEST_FAILED_${response.status}`);
    }
    const data = (await response.json()) as { token?: string; expiresAt?: string };
    if (!data.token) throw new Error('LEASE_TOKEN_MISSING');
    const parsed = parseLicenseToken(data.token, 'rvlyra_lease_v1_');
    return {
      token: data.token,
      expiresAt: data.expiresAt ?? new Date(parsed.payload.exp * 1000).toISOString(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function verifyLease(
  token: string,
  publicKeyPem: string,
  options: { installIdHash?: string; now?: Date } = {},
): LicenseStatus {
  const payload = verifySignedToken(token, publicKeyPem, {
    prefix: 'rvlyra_lease_v1_',
    now: options.now,
  });
  if (
    options.installIdHash &&
    payload.installIdHash &&
    payload.installIdHash !== options.installIdHash
  ) {
    return {
      valid: false,
      kind: 'lease',
      tier: payload.tier,
      subject: payload.sub,
      features: [],
      limits: payload.limits,
      grace: false,
      reason: 'LEASE_INSTALL_MISMATCH',
    };
  }
  return statusFromPayload(payload, 'lease');
}

export function cachedLeaseStatus(
  configDir: string,
  publicKeyPem: string,
  installIdHash: string,
  now = new Date(),
): LicenseStatus | null {
  const lease = readLease(configDir);
  if (!lease) return null;
  try {
    const status = verifyLease(lease.token, publicKeyPem, { installIdHash, now });
    return status.valid ? status : null;
  } catch {
    return null;
  }
}
