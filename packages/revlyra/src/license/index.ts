import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDevLicenseKey, verifyDevLicense } from './dev';
import { Entitlements } from './entitlements';
import { cachedLeaseStatus, readLease, requestLease, verifyLease, writeLease } from './lease';
import {
  invalidStatus,
  LICENSE_PREFIX,
  parseLicenseToken,
  statusFromPayload,
  verifySignedToken,
} from './token';
import type { LicenseStatus } from './types';

export * from './dev';
export * from './entitlements';
export * from './lease';
export * from './token';
export * from './types';

export interface ResolveLicenseOptions {
  configDir: string;
  licenseKey: string;
  publicKey?: string;
  licenseServer?: string;
  installId?: string;
  graceDays?: number;
  now?: Date;
  fetcher?: typeof fetch;
  allowOnline?: boolean;
}

export function installIdHash(installId: string): string {
  return createHash('sha256').update(installId, 'utf8').digest('hex');
}

export function readOrCreateInstallId(configDir: string): string {
  mkdirSync(configDir, { recursive: true });
  const file = join(configDir, 'install-id');
  if (existsSync(file)) {
    const value = readFileSync(file, 'utf8').trim();
    if (value.length > 0) return value;
  }
  const value = `install_${randomBytes(24).toString('hex')}`;
  writeFileSync(file, `${value}\n`, { mode: 0o600 });
  return value;
}

function offlineStatus(options: ResolveLicenseOptions): LicenseStatus {
  const key = options.licenseKey.trim();
  if (!key) return invalidStatus('LICENSE_KEY_MISSING', 'none');
  if (isDevLicenseKey(key)) {
    return verifyDevLicense(options.configDir, key, options.now);
  }
  if (key.startsWith(LICENSE_PREFIX)) {
    if (!options.publicKey) {
      return invalidStatus('LICENSE_PUBLIC_KEY_MISSING');
    }
    try {
      const payload = verifySignedToken(key, options.publicKey, { now: options.now });
      return statusFromPayload(payload, 'license');
    } catch (error) {
      return invalidStatus(String((error as Error).message || error));
    }
  }
  return invalidStatus('LICENSE_KEY_FORMAT_UNKNOWN');
}

export async function resolveLicense(options: ResolveLicenseOptions): Promise<{
  status: LicenseStatus;
  entitlements: Entitlements;
}> {
  const offline = offlineStatus(options);
  const installId = options.installId ?? readOrCreateInstallId(options.configDir);
  const installHash = installIdHash(installId);

  let status = offline;

  if (options.allowOnline !== false && options.licenseServer && options.publicKey) {
    try {
      const lease = await requestLease({
        server: options.licenseServer,
        licenseKey: options.licenseKey,
        installId,
        ...(options.fetcher ? { fetcher: options.fetcher } : {}),
      });
      const leaseStatus = verifyLease(lease.token, options.publicKey, {
        installIdHash: installHash,
        ...(options.now ? { now: options.now } : {}),
      });
      if (!leaseStatus.valid) {
        status = leaseStatus;
      } else {
        writeLease(options.configDir, {
          token: lease.token,
          obtainedAt: new Date().toISOString(),
          expiresAt: lease.expiresAt,
        });
        status = { ...leaseStatus, grace: false };
      }
    } catch (error) {
      const message = String((error as Error).message || error);
      if (/LEASE_REQUEST_FAILED_4\d\d/u.test(message)) {
        status = {
          ...offline,
          valid: false,
          grace: false,
          reason: 'LEASE_REJECTED_OR_REVOKED',
        };
      } else {
        const cached = cachedLeaseStatus(
          options.configDir,
          options.publicKey,
          installHash,
          options.now,
        );
        if (cached) {
          status = { ...cached, grace: true };
        } else {
          const lease = readLease(options.configDir);
          const nowMs = (options.now ?? new Date()).getTime();
          const graceMs = (options.graceDays ?? 7) * 86_400_000;
          if (lease) {
            const expires = new Date(lease.expiresAt).getTime();
            if (offline.valid && Number.isFinite(expires) && nowMs <= expires + graceMs) {
              status = { ...offline, grace: true, reason: 'LEASE_OFFLINE_GRACE' };
            } else {
              status = {
                ...offline,
                valid: false,
                grace: false,
                reason: 'LEASE_GRACE_EXPIRED',
              };
            }
          } else {
            status = {
              ...offline,
              valid: false,
              grace: false,
              reason: 'LEASE_REQUIRED_UNREACHABLE',
            };
          }
        }
      }
    }
  }

  return { status, entitlements: new Entitlements(status) };
}

export function inspectLicenseKey(key: string): {
  prefix: string;
  payload?: unknown;
  validFormat: boolean;
} {
  if (key.startsWith('rvlyra_dev_')) {
    return { prefix: 'dev', validFormat: key.length >= 44 };
  }
  if (key.startsWith(LICENSE_PREFIX)) {
    try {
      const parsed = parseLicenseToken(key);
      return { prefix: 'license', payload: parsed.payload, validFormat: true };
    } catch {
      return { prefix: 'license', validFormat: false };
    }
  }
  return { prefix: 'unknown', validFormat: false };
}
