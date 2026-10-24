export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Revlyra Review Integrity API',
    version: '0.1.0',
    description:
      'Risk scoring, explanations, review selection, and item integrity. This API returns risk signals, not proof that a review is fraudulent.',
  },
  servers: [{ url: '/v1' }],
  security: [{ bearerAuth: [] }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'Tenant API key: rvlyra_live_<prefix>_<secret>',
      },
    },
    schemas: {
      Review: {
        type: 'object',
        required: ['itemId', 'reviewerId', 'rating', 'text', 'submittedAt'],
        properties: {
          id: { type: 'string' },
          externalId: { type: 'string' },
          itemId: { type: 'string' },
          reviewerId: { type: 'string' },
          rating: { type: 'number', minimum: 1, maximum: 5 },
          text: { type: 'string', maxLength: 20000 },
          title: { type: 'string' },
          language: { type: 'string' },
          submittedAt: { type: 'string', format: 'date-time' },
          verifiedPurchase: { type: 'boolean' },
          media: { type: 'array', items: { type: 'object' } },
          context: { type: 'object' },
        },
      },
      AnalyzeRequest: {
        type: 'object',
        required: ['review'],
        properties: {
          review: { $ref: '#/components/schemas/Review' },
          reviewer: { type: 'object', additionalProperties: true },
          item: { type: 'object', additionalProperties: true },
          sourceId: { type: 'string' },
        },
      },
      Error: {
        type: 'object',
        properties: {
          error: {
            type: 'object',
            properties: {
              code: { type: 'string' },
              message: { type: 'string' },
              request_id: { type: 'string' },
            },
          },
        },
      },
    },
  },
  paths: {
    '/health': {
      get: {
        security: [],
        summary: 'Liveness and license status',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/version': {
      get: {
        security: [],
        summary: 'Versions',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/reviews/analyze': {
      post: {
        summary: 'Analyze one review',
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/AnalyzeRequest' } },
          },
        },
        responses: {
          '200': { description: 'Analysis result' },
          '400': {
            description: 'Validation error',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
          },
          '402': { description: 'License limit exceeded' },
          '403': { description: 'License or scope error' },
        },
      },
    },
    '/reviews/batch': {
      post: {
        summary: 'Analyze a batch of reviews synchronously',
        responses: { '200': { description: 'Batch results' } },
      },
    },
    '/ingest/reviews': {
      post: {
        summary: 'Bulk ingest reviews (async above 50 items)',
        responses: {
          '200': { description: 'Ingest result' },
          '202': { description: 'Job accepted' },
        },
      },
    },
    '/reviews/{id}': {
      get: {
        summary: 'Get stored analysis result',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Result' }, '404': { description: 'Not found' } },
      },
    },
    '/reviews/{id}/explain': {
      get: {
        summary: 'Explain a stored decision',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Explanation' }, '404': { description: 'Not found' } },
      },
    },
    '/feedback': {
      post: {
        summary: 'Record a human label or override',
        responses: { '201': { description: 'Created' } },
      },
    },
    '/appeals': {
      post: { summary: 'Open an appeal', responses: { '201': { description: 'Created' } } },
      get: { summary: 'List appeals', responses: { '200': { description: 'Appeals' } } },
    },
    '/reviewers/{id}/risk': {
      get: {
        summary: 'Reviewer risk snapshot',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Risk' }, '404': { description: 'Not found' } },
      },
    },
    '/items/{id}/integrity': {
      get: {
        summary: 'Trust-weighted item integrity',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Integrity' }, '404': { description: 'Not found' } },
      },
    },
    '/items/{id}/select': {
      post: {
        summary: 'Select trustworthy, diverse reviews',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Selection' }, '404': { description: 'Not found' } },
      },
    },
    '/campaigns': {
      get: {
        summary: 'List detected coordination clusters',
        responses: { '200': { description: 'Campaigns' } },
      },
    },
    '/campaigns/{id}': {
      get: {
        summary: 'Get a campaign',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Campaign' }, '404': { description: 'Not found' } },
      },
    },
    '/scan': {
      post: {
        summary: 'Scan a configured source',
        responses: { '202': { description: 'Job accepted' } },
      },
    },
    '/jobs/{id}': {
      get: {
        summary: 'Get job status',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Job' }, '404': { description: 'Not found' } },
      },
    },
    '/usage': {
      get: { summary: 'Current license usage', responses: { '200': { description: 'Usage' } } },
    },
  },
} as const;
