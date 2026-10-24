import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { LicenseError, LimitError } from '../engine/service';
import { EntitlementError } from '../license';

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, request, reply) => {
    const requestId = request.id;

    if (error instanceof ApiError) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          request_id: requestId,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      });
    }

    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed.',
          request_id: requestId,
          details: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      });
    }

    if (error instanceof EntitlementError) {
      return reply.code(403).send({
        error: {
          code: error.code,
          message: error.message,
          request_id: requestId,
          details: { feature: error.feature },
        },
      });
    }

    if (error instanceof LicenseError) {
      return reply.code(403).send({
        error: {
          code: error.code,
          message: error.message,
          request_id: requestId,
        },
      });
    }

    if (error instanceof LimitError) {
      return reply.code(402).send({
        error: {
          code: error.code,
          message: error.message,
          request_id: requestId,
        },
      });
    }

    if ((error as { code?: string }).code === 'VALIDATION_ERROR') {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: (error as Error).message,
          request_id: requestId,
        },
      });
    }

    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      return reply.code(statusCode).send({
        error: {
          code: (error as { code?: string }).code ?? 'BAD_REQUEST',
          message: (error as Error).message,
          request_id: requestId,
        },
      });
    }

    request.log.error({ err: error }, 'Unhandled request error');
    return reply.code(500).send({
      error: {
        code: 'INTERNAL',
        message: 'An internal error occurred.',
        request_id: requestId,
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: {
        code: 'NOT_FOUND',
        message: `Route not found: ${request.method} ${request.url}`,
        request_id: request.id,
      },
    });
  });
}
