import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import type { RevlyraConfig } from '../config';
import type { ReviewService } from '../engine/service';
import { type JobHandler, JobWorker } from '../jobs';
import type { Store } from '../store';
import { createAuthHook } from './auth';
import { registerErrorHandler } from './errors';
import { registerRoutes } from './routes';
import { WebhookDispatcher } from './webhooks';

export interface BuildServerOptions {
  config: RevlyraConfig;
  store: Store;
  service: ReviewService;
  worker?: JobWorker;
  webhooks?: WebhookDispatcher;
  customHandlers?: Record<string, JobHandler>;
  logger?: boolean;
  version?: string;
}

export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const { config, store, service } = options;
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: config.logLevel,
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.headers["x-revlyra-license"]',
              ],
              censor: '[redacted]',
            },
          },
    trustProxy: config.server.trustProxy,
    bodyLimit: config.server.bodyLimit,
    requestIdHeader: 'x-request-id',
  });

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  });

  if (config.server.corsOrigins.length > 0) {
    await app.register(cors, {
      origin: config.server.corsOrigins,
      credentials: false,
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['authorization', 'content-type', 'idempotency-key', 'x-revlyra-tenant'],
    });
  }

  await app.register(rateLimit, {
    max: Math.max(1, config.limits.rps),
    timeWindow: '1 second',
    allowList: (request) => {
      const path = (request.raw.url ?? request.url).split('?')[0];
      return path === '/v1/health' || path === '/v1/version' || path === '/v1/openapi.json';
    },
    errorResponseBuilder: (request) => ({
      error: {
        code: 'RATE_LIMITED',
        message: 'Too many requests. Retry after the rate-limit window.',
        request_id: request.id,
      },
    }),
  });

  app.decorateRequest('auth', null);
  app.addHook('onRequest', createAuthHook(store, config));
  registerErrorHandler(app);

  const webhooks = options.webhooks ?? new WebhookDispatcher(config);
  registerRoutes(app, {
    config,
    store,
    service,
    webhooks,
    ...(options.worker ? { worker: options.worker } : {}),
    version: options.version ?? '0.1.0',
  });

  app.addHook('onReady', async () => {
    service.assertLicense();
  });

  return app;
}

export interface StartServerOptions extends BuildServerOptions {
  startWorker?: boolean;
}

export async function startServer(options: StartServerOptions): Promise<FastifyInstance> {
  const worker =
    options.worker ??
    (options.config.jobs.mode === 'off'
      ? undefined
      : new JobWorker({
          store: options.store,
          service: options.service,
          config: options.config,
          ...(options.customHandlers ? { handlers: options.customHandlers } : {}),
        }));

  const app = await buildServer({ ...options, ...(worker ? { worker } : {}) });

  if (worker) {
    app.addHook('onClose', async () => {
      await worker.stop();
    });
  }

  await app.listen({ host: options.config.server.host, port: options.config.server.port });

  if (options.startWorker !== false && worker && options.config.jobs.mode !== 'off') {
    worker.start();
  }

  return app;
}

export * from './auth';
export * from './errors';
export * from './openapi';
export * from './routes';
export * from './webhooks';
