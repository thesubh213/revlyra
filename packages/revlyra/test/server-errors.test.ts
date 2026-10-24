import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerErrorHandler } from '../src/server/errors';

describe('registerErrorHandler ladder', () => {
  it('ApiError renders statusCode/code/message/request_id/details', async () => {
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    app.get('/fail', async () => {
      throw new (await import('../src/server/errors')).ApiError(
        400,
        'VALIDATION_ERROR',
        'bad input',
        { field: 'x' },
      );
    });
    await app.ready();
    const response = await app.inject('/fail');
    const body = response.json();
    expect(response.statusCode).toBe(400);
    expect(body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'bad input',
      details: { field: 'x' },
    });
    expect(typeof body.error.request_id).toBe('string');
    await app.close();
  });

  it('ZodError renders VALIDATION_ERROR with issue list', async () => {
    const { ZodError } = await import('zod');
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    app.get('/fail', async () => {
      throw new ZodError([]);
    });
    await app.ready();
    const response = await app.inject('/fail');
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(response.json().error.details)).toBe(true);
    await app.close();
  });

  it('EntitlementError renders 403 FEATURE_NOT_ENTITLED with feature', async () => {
    const { EntitlementError } = await import('../src/license');
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    app.get('/fail', async () => {
      throw new EntitlementError('not allowed', 'transformer');
    });
    await app.ready();
    const response = await app.inject('/fail');
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toMatchObject({
      code: 'FEATURE_NOT_ENTITLED',
      details: { feature: 'transformer' },
    });
    await app.close();
  });

  it('LicenseError renders 403 and LimitError renders 402', async () => {
    const { LicenseError, LimitError } = await import('../src/engine/service');
    const licenseApp = Fastify({ logger: false });
    registerErrorHandler(licenseApp);
    licenseApp.get('/fail', async () => {
      throw new LicenseError('License is not valid.');
    });
    await licenseApp.ready();
    const licenseResponse = await licenseApp.inject('/fail');
    expect(licenseResponse.statusCode).toBe(403);
    await licenseApp.close();

    const limitApp = Fastify({ logger: false });
    registerErrorHandler(limitApp);
    limitApp.get('/fail', async () => {
      throw new LimitError('Monthly review limit reached.');
    });
    await limitApp.ready();
    const limitResponse = await limitApp.inject('/fail');
    expect(limitResponse.statusCode).toBe(402);
    expect(limitResponse.json().error.code).toBe('LIMIT_EXCEEDED');
    await limitApp.close();
  });

  it('downgrades bare VALIDATION_ERROR-coded errors to 400', async () => {
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    app.get('/fail', async () => {
      const error = new Error('Review.rating must be between 1 and 5.');
      (error as { code?: string }).code = 'VALIDATION_ERROR';
      throw error;
    });
    await app.ready();
    const response = await app.inject('/fail');
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toContain('between 1 and 5');
    await app.close();
  });

  it('passes through errors carrying 4xx statusCode with their code', async () => {
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    app.get('/fail', async () => {
      const error = new Error('Review not found');
      (error as { statusCode?: number }).statusCode = 404;
      (error as { code?: string }).code = 'REVIEW_NOT_FOUND';
      throw error;
    });
    await app.ready();
    const response = await app.inject('/fail');
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('REVIEW_NOT_FOUND');
    await app.close();
  });

  it('unknown errors hide their message behind a 500 INTERNAL', async () => {
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    app.get('/fail', async () => {
      throw new Error('super-secret stack detail');
    });
    await app.ready();
    const response = await app.inject('/fail');
    expect(response.statusCode).toBe(500);
    expect(response.json().error).toMatchObject({
      code: 'INTERNAL',
      message: 'An internal error occurred.',
    });
    expect(response.body).not.toContain('super-secret');
    await app.close();
  });

  it('404s carry NOT_FOUND and route info', async () => {
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    await app.ready();
    const response = await app.inject('/apis/unknown/route');
    const body = response.json();
    expect(response.statusCode).toBe(404);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.message).toContain('GET /apis/unknown/route');
    await app.close();
  });
});
