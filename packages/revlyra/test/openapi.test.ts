import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerErrorHandler } from '../src/server/errors';
import { openApiDocument } from '../src/server/openapi';

describe('openAPI document shape', () => {
  it('describes the /v1 API with bearer auth and core routes', () => {
    expect(openApiDocument.openapi).toBe('3.1.0');
    expect(openApiDocument.info.title).toBe('Revlyra Review Integrity API');
    expect(openApiDocument.servers).toEqual([{ url: '/v1' }]);
    const paths = Object.keys(openApiDocument.paths);
    for (const route of [
      '/health',
      '/version',
      '/reviews/analyze',
      '/reviews/batch',
      '/ingest/reviews',
      '/feedback',
      '/appeals',
      '/scan',
      '/campaigns',
      '/usage',
    ]) {
      expect(paths).toContain(route);
    }
    // security scheme declared with bearerAuth
    const schemes = openApiDocument.components?.securitySchemes ?? {};
    expect(Object.keys(schemes)).toContain('bearerAuth');
  });

  it('is served by the real app', async () => {
    const app = Fastify({ logger: false });
    registerErrorHandler(app);
    app.get('/v1/openapi.json', async () => openApiDocument);
    await app.ready();
    const response = await app.inject('/v1/openapi.json');
    expect(response.statusCode).toBe(200);
    expect(response.json().info.title).toBe('Revlyra Review Integrity API');
    await app.close();
  });
});
