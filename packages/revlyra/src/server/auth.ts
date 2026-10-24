import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { RevlyraConfig } from '../config';
import { assertScopes, hashApiKey } from '../keys';
import type { Store } from '../store';
import { ApiError } from './errors';

export interface AuthContext {
  tenantId: string;
  scopes: string[];
  apiKeyId: string | null;
  admin: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

const PUBLIC_PATHS = new Set(['/v1/health', '/v1/version', '/v1/openapi.json']);

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function pathname(request: FastifyRequest): string {
  return (request.raw.url ?? request.url).split('?')[0] ?? request.url;
}

export function tenantOf(request: FastifyRequest): string {
  if (!request.auth) throw new ApiError(401, 'AUTH_MISSING', 'Authentication is required.');
  return request.auth.tenantId;
}

export function requireScope(request: FastifyRequest, scope: string): void {
  if (!request.auth) throw new ApiError(401, 'AUTH_MISSING', 'Authentication is required.');
  if (request.auth.admin) return;
  if (!assertScopes(request.auth.scopes, [scope])) {
    throw new ApiError(403, 'SCOPE_FORBIDDEN', `API key is missing the "${scope}" scope.`);
  }
}

export function requireAdmin(request: FastifyRequest): void {
  if (!request.auth?.admin) {
    throw new ApiError(403, 'ADMIN_REQUIRED', 'Admin authentication is required.');
  }
}

export function adminTenant(request: FastifyRequest): string {
  const header = request.headers['x-revlyra-tenant'];
  if (typeof header === 'string' && header.trim().length > 0) return header.trim();
  const query = request.query as Record<string, unknown> | undefined;
  if (query && typeof query.tenantId === 'string' && query.tenantId.trim().length > 0) {
    return query.tenantId.trim();
  }
  return 'default';
}

export function createAuthHook(store: Store, config: RevlyraConfig) {
  return async function authHook(request: FastifyRequest): Promise<void> {
    const path = pathname(request);
    if (PUBLIC_PATHS.has(path) || request.method === 'OPTIONS') {
      request.auth = null;
      return;
    }

    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new ApiError(401, 'AUTH_MISSING', 'A valid API key is required.');
    }
    const presented = header.slice(7).trim();
    if (presented.length === 0) {
      throw new ApiError(401, 'AUTH_INVALID_KEY', 'A valid API key is required.');
    }

    if (config.adminKey && constantTimeEqual(presented, config.adminKey)) {
      request.auth = {
        tenantId: adminTenant(request),
        scopes: ['admin'],
        apiKeyId: null,
        admin: true,
      };
      return;
    }

    if (path.startsWith('/v1/admin')) {
      if (!config.adminKey) {
        throw new ApiError(503, 'ADMIN_DISABLED', 'Admin API is not configured.');
      }
      throw new ApiError(401, 'AUTH_INVALID_KEY', 'A valid API key is required.');
    }

    const record = await store.findApiKeyByHash(hashApiKey(presented));
    if (!record || record.revokedAt) {
      throw new ApiError(401, 'AUTH_INVALID_KEY', 'A valid API key is required.');
    }
    if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) {
      throw new ApiError(401, 'AUTH_INVALID_KEY', 'A valid API key is required.');
    }

    request.auth = {
      tenantId: record.tenantId,
      scopes: record.scopes,
      apiKeyId: record.id,
      admin: false,
    };
    void store.touchApiKey(record.id).catch(() => undefined);
  };
}
