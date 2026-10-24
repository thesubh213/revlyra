import { canonicalReviewSchema } from '@revlyra/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { RevlyraConfig } from '../config';
import { buildTransparencyReport, renderTransparencyHtml } from '../engine/compliance';
import type { ReviewService } from '../engine/service';
import { buildStatementOfReasons, renderStatementOfReasonsMarkdown } from '../engine/sor';
import { defaultHandlers, type JobWorker } from '../jobs';
import { generateApiKey, SCOPES } from '../keys';
import { scopedHmac } from '../privacy';
import type { Store } from '../store';
import type { JobRecord, ReviewRecord } from '../store/types';
import { adminTenant, requireAdmin, requireScope, tenantOf } from './auth';
import { ApiError } from './errors';
import { openApiDocument } from './openapi';
import type { WebhookDispatcher } from './webhooks';

const isoDate = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: 'Must be a valid ISO date',
});

const reviewerHintsSchema = z.record(z.string(), z.unknown()).optional();
const itemHintsSchema = z
  .object({
    category: z.string().max(200).optional(),
    attributes: z.record(z.string(), z.unknown()).optional(),
    stats: z.record(z.string(), z.unknown()).optional(),
  })
  .optional();

const analyzeBodySchema = z.object({
  review: canonicalReviewSchema,
  reviewer: reviewerHintsSchema,
  item: itemHintsSchema,
  sourceId: z.string().max(200).optional(),
});

const feedbackBodySchema = z.object({
  reviewId: z.string().min(1).max(200),
  label: z.enum(['genuine', 'fake', 'unsure', 'policy_violation']),
  reasonCode: z.string().min(1).max(100),
  notes: z.string().max(2000).optional(),
});

const appealBodySchema = z.object({
  reviewId: z.string().min(1).max(200),
  reason: z.string().max(2000).optional(),
});

const selectBodySchema = z.object({
  limit: z.number().int().min(1).max(100).optional(),
  minTrust: z.number().min(0).max(1).optional(),
  diversify: z.boolean().optional(),
  includeFlagged: z.boolean().optional(),
  lambda: z.number().min(0).max(1).optional(),
});

const scanBodySchema = z.object({
  sourceId: z.string().min(1).max(200),
  limit: z.number().int().positive().max(1_000_000).optional(),
  batchSize: z.number().int().positive().max(5000).optional(),
  sync: z.boolean().optional(),
});

const adminKeyBodySchema = z.object({
  tenantId: z.string().min(1).max(200).optional(),
  scopes: z.array(z.enum(SCOPES)).min(1).optional(),
  expiresAt: isoDate.optional(),
  rateLimit: z.number().int().positive().max(100_000).optional(),
});

const adminSourceBodySchema = z.object({
  tenantId: z.string().min(1).max(200).optional(),
  kind: z.enum(['files', 'sqlite', 'postgres', 'mysql', 'mongodb', 'rest']),
  name: z.string().min(1).max(200),
  config: z.record(z.string(), z.unknown()),
  mapping: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

const listQuerySchema = z.object({
  tenantId: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

const appealsQuerySchema = z.object({
  status: z.enum(['open', 'upheld', 'overturned']).optional(),
});

const adjudicationBodySchema = z.object({
  outcome: z.enum(['upheld', 'overturned']),
  reason: z.string().max(2000).optional(),
  /** HMAC of the human handler; required by DSA Art. 20 — appeals are never
   * denied or overturned purely by automation. */
  handlerHmac: z.string().min(1).max(200),
});

const noticeBodySchema = z.object({
  reviewId: z.string().min(1).max(200),
  type: z.enum(['complaint', 'legal', 'authority']),
  claim: z.string().min(1).max(5000),
  substantiated: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const noticeStatusBodySchema = z.object({
  status: z.enum(['received', 'under_review', 'actioned', 'rejected', 'expired']),
  note: z.string().max(2000).optional(),
});

const noticesQuerySchema = z.object({
  status: z.enum(['received', 'under_review', 'actioned', 'rejected', 'expired']).optional(),
  reviewId: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

const sorQuerySchema = z.object({
  format: z.enum(['json', 'md']).optional(),
});

const transparencyQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(3650).optional(),
  format: z.enum(['json', 'html']).optional(),
});

const includeTextQuerySchema = z.object({
  includeText: z.enum(['0', '1', 'true', 'false']).optional(),
});

export interface RouteDeps {
  config: RevlyraConfig;
  store: Store;
  service: ReviewService;
  webhooks: WebhookDispatcher;
  worker?: JobWorker;
  version: string;
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      'Request validation failed.',
      result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

function reviewerHints(value?: Record<string, unknown>) {
  if (!value) return undefined;
  const { accountCreatedAt, ...stats } = value;
  return {
    ...(typeof accountCreatedAt === 'string' ? { accountCreatedAt } : {}),
    stats,
  };
}

function currentPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function summarizeReview(review: ReviewRecord, includeText: boolean): Record<string, unknown> {
  return {
    id: review.id,
    sourceId: review.sourceId,
    itemId: review.itemId,
    reviewerId: review.reviewerId,
    rating: review.rating,
    submittedAt: review.submittedAt,
    language: review.language,
    verified: review.verified,
    decision: review.decision,
    band: review.band,
    score: review.score,
    confidence: review.confidence,
    provisional: review.provisional,
    modelVersion: review.modelVersion,
    policyVersion: review.policyVersion,
    ...(includeText ? { text: review.text } : {}),
  };
}

function flagged(decision: string | null | undefined): boolean {
  return (
    decision === 'downrank' ||
    decision === 'hold' ||
    decision === 'remove' ||
    decision === 'escalate'
  );
}

async function runSyncScan(job: JobRecord, deps: RouteDeps): Promise<Record<string, unknown>> {
  const scanHandler = defaultHandlers.scan;
  if (!scanHandler)
    throw new ApiError(500, 'SCAN_HANDLER_MISSING', 'Scan handler is not configured.');
  try {
    const result = await scanHandler(job, {
      store: deps.store,
      service: deps.service,
      config: deps.config,
    });
    await deps.store.completeJob(job.id, result);
    return result;
  } catch (error) {
    await deps.store.failJob(job.id, String((error as Error).message ?? error));
    throw error;
  }
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { store, service, webhooks, config } = deps;

  app.get('/v1/health', async () => ({
    status: 'ok',
    version: deps.version,
    time: new Date().toISOString(),
    license: service.getEntitlements().toJSON(),
  }));

  app.get('/v1/version', async () => ({
    server: deps.version,
    core: '0.1.0',
    model: service.getModel().version,
    policy: service.getPolicy().version,
  }));

  app.get('/v1/openapi.json', async () => openApiDocument);

  app.post('/v1/reviews/analyze', async (request, reply) => {
    requireScope(request, 'analyze:write');
    const tenantId = tenantOf(request);
    const body = parse(analyzeBodySchema, request.body);
    const reviewer = reviewerHints(body.reviewer);
    const result = await service.ingest(
      tenantId,
      {
        review: body.review as never,
        ...(reviewer ? { reviewer } : {}),
        ...(body.item ? { item: body.item } : {}),
        ...(body.sourceId ? { sourceId: body.sourceId } : {}),
      },
      request.auth?.apiKeyId ?? 'admin',
    );
    if (flagged(result.result.decision)) {
      void webhooks.emit('review.flagged', {
        reviewId: result.review.id,
        itemId: result.review.itemId,
        reviewerId: result.review.reviewerId,
        score: result.result.score,
        band: result.result.band,
        decision: result.result.decision,
        reasonCodes: result.result.reasons.slice(0, 5).map((reason) => reason.code),
      });
    }
    if (result.result.safety?.routed) {
      await store.appendAudit({
        tenantId,
        actor: request.auth?.apiKeyId ?? 'admin',
        action: 'safety_review.routed',
        targetType: 'review',
        targetId: result.review.id,
        payload: {
          decision: result.result.decision,
          categories: result.result.safety.categories,
        },
      });
      void webhooks.emit('safety.escalated', {
        reviewId: result.review.id,
        itemId: result.review.itemId,
        decision: result.result.decision,
        categories: result.result.safety.categories,
      });
    }
    return reply.send({
      ...result.result,
      reviewId: result.review.id,
      ...(result.mediaWarnings ? { mediaWarnings: result.mediaWarnings } : {}),
    });
  });

  app.post('/v1/reviews/batch', async (request) => {
    requireScope(request, 'analyze:write');
    const tenantId = tenantOf(request);
    const body = parse(
      z.object({
        reviews: z.array(canonicalReviewSchema).min(1).max(config.limits.maxBatch),
        reviewer: reviewerHintsSchema,
        item: itemHintsSchema,
        sourceId: z.string().max(200).optional(),
      }),
      request.body,
    );
    const reviewer = reviewerHints(body.reviewer);
    const results: Array<Record<string, unknown>> = [];
    let succeeded = 0;
    let failed = 0;
    for (const review of body.reviews) {
      try {
        const result = await service.ingest(
          tenantId,
          {
            review: review as never,
            ...(reviewer ? { reviewer } : {}),
            ...(body.item ? { item: body.item } : {}),
            ...(body.sourceId ? { sourceId: body.sourceId } : {}),
          },
          request.auth?.apiKeyId ?? 'admin',
        );
        succeeded += 1;
        results.push({
          ok: true,
          reviewId: result.review.id,
          score: result.result.score,
          band: result.result.band,
          decision: result.result.decision,
          confidence: result.result.confidence,
          reasonCodes: result.result.reasons.map((reason) => reason.code),
        });
      } catch (error) {
        failed += 1;
        results.push({
          ok: false,
          error: {
            code: (error as { code?: string }).code ?? 'ANALYSIS_FAILED',
            message: String((error as Error).message ?? error),
          },
        });
      }
    }
    return { total: body.reviews.length, succeeded, failed, results };
  });

  app.post('/v1/ingest/reviews', async (request, reply) => {
    requireScope(request, 'analyze:write');
    const tenantId = tenantOf(request);
    const body = parse(
      z.object({
        reviews: z.array(canonicalReviewSchema).min(1).max(config.limits.maxBatch),
        reviewer: reviewerHintsSchema,
        item: itemHintsSchema,
        sourceId: z.string().max(200).optional(),
      }),
      request.body,
    );
    const reviewer = reviewerHints(body.reviewer);

    if (body.reviews.length > 50) {
      const job = await store.createJob({
        tenantId,
        kind: 'bulk_ingest',
        payload: {
          reviews: body.reviews,
          ...(reviewer ? { reviewer } : {}),
          ...(body.item ? { item: body.item } : {}),
          ...(body.sourceId ? { sourceId: body.sourceId } : {}),
        },
        maxAttempts: 2,
      });
      void webhooks.emit('ingest.queued', { jobId: job.id, count: body.reviews.length });
      return reply
        .code(202)
        .send({ jobId: job.id, accepted: body.reviews.length, status: 'pending' });
    }

    let imported = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const review of body.reviews) {
      try {
        await service.ingest(
          tenantId,
          {
            review: review as never,
            ...(reviewer ? { reviewer } : {}),
            ...(body.item ? { item: body.item } : {}),
            ...(body.sourceId ? { sourceId: body.sourceId } : {}),
          },
          request.auth?.apiKeyId ?? 'admin',
        );
        imported += 1;
      } catch (error) {
        failed += 1;
        if (errors.length < 20) errors.push(String((error as Error).message ?? error));
      }
    }
    return { imported, failed, errors };
  });

  app.get<{ Params: { id: string } }>('/v1/reviews/:id', async (request) => {
    requireScope(request, 'analyze:write');
    const tenantId = tenantOf(request);
    const query = parse(includeTextQuerySchema, request.query);
    const result = await service.getResult(tenantId, request.params.id);
    if (!result) throw new ApiError(404, 'REVIEW_NOT_FOUND', 'Review not found.');
    return {
      review: summarizeReview(
        result.review,
        query.includeText === '1' || query.includeText === 'true',
      ),
      result: result.result,
    };
  });

  app.get<{ Params: { id: string } }>('/v1/reviews/:id/explain', async (request) => {
    requireScope(request, 'analyze:write');
    const tenantId = tenantOf(request);
    const result = await service.getResult(tenantId, request.params.id);
    if (!result) throw new ApiError(404, 'REVIEW_NOT_FOUND', 'Review not found.');
    return {
      review: summarizeReview(result.review, false),
      decision: result.result.decision,
      score: result.result.score,
      confidence: result.result.confidence,
      band: result.result.band,
      reasons: result.result.reasons,
      signals: result.result.signals,
      modelVersion: result.result.modelVersion,
      policyVersion: result.result.policyVersion,
    };
  });

  app.post('/v1/feedback', async (request, reply) => {
    requireScope(request, 'feedback:write');
    const tenantId = tenantOf(request);
    const body = parse(feedbackBodySchema, request.body);
    const actorHmac = scopedHmac(
      config.privacy.pepper,
      tenantId,
      'actor',
      request.auth?.apiKeyId ?? 'admin',
    );
    const record = await service.feedback(tenantId, {
      reviewId: body.reviewId,
      label: body.label,
      reasonCode: body.reasonCode,
      ...(body.notes ? { notes: body.notes } : {}),
      actorHmac,
    });
    void webhooks.emit('review.feedback', {
      reviewId: body.reviewId,
      label: body.label,
      reasonCode: body.reasonCode,
    });
    return reply.code(201).send({ id: record.id, reviewId: body.reviewId, label: body.label });
  });

  app.post('/v1/appeals', async (request, reply) => {
    requireScope(request, 'feedback:write');
    const tenantId = tenantOf(request);
    const body = parse(appealBodySchema, request.body);
    const review = await store.getReview(tenantId, body.reviewId);
    if (!review) throw new ApiError(404, 'REVIEW_NOT_FOUND', 'Review not found.');
    const slaDueAt = new Date(
      Date.now() + config.governance.appealSlaDays * 86_400_000,
    ).toISOString();
    const appeal = await store.createAppeal({
      tenantId,
      reviewId: body.reviewId,
      reason: body.reason ?? null,
      slaDueAt,
    });
    await store.appendAudit({
      tenantId,
      actor: request.auth?.apiKeyId ?? 'admin',
      action: 'appeal.opened',
      targetType: 'review',
      targetId: body.reviewId,
      payload: { appealId: appeal.id, slaDueAt },
    });
    return reply.code(201).send(appeal);
  });

  app.get('/v1/appeals', async (request) => {
    requireScope(request, 'feedback:write');
    const tenantId = tenantOf(request);
    const query = parse(appealsQuerySchema, request.query);
    return { appeals: await store.listAppeals(tenantId, query.status) };
  });

  // DSA Art. 20: internal complaints-handling by qualified human staff —
  // overturns and upholds must carry a human handler identity.
  app.post<{ Params: { id: string } }>('/v1/appeals/:id/adjudication', async (request) => {
    requireScope(request, 'feedback:write');
    const tenantId = tenantOf(request);
    const body = parse(adjudicationBodySchema, request.body);
    const handlerHmac = scopedHmac(config.privacy.pepper, tenantId, 'actor', body.handlerHmac);
    const appeal = await store.resolveAppeal(
      tenantId,
      request.params.id,
      body.outcome,
      handlerHmac,
      body.reason ?? null,
    );
    if (!appeal) throw new ApiError(404, 'APPEAL_NOT_FOUND', 'Appeal not found.');
    const review = await store.getReview(tenantId, appeal.reviewId);
    if (review && body.outcome === 'overturned') {
      const reviewerRecord = await store.getReviewerById(tenantId, review.reviewerId);
      if (reviewerRecord) {
        const priorCount =
          typeof reviewerRecord.stats.priorAppealsOverturned === 'number'
            ? reviewerRecord.stats.priorAppealsOverturned
            : 0;
        await store.upsertReviewer({
          tenantId,
          externalHmac: reviewerRecord.externalHmac,
          stats: { ...reviewerRecord.stats, priorAppealsOverturned: priorCount + 1 },
          riskScore: reviewerRecord.riskScore,
          riskBand: reviewerRecord.riskBand,
        });
      }
    }
    await store.appendAudit({
      tenantId,
      actor: handlerHmac,
      action: 'appeal.resolved',
      targetType: 'appeal',
      targetId: request.params.id,
      payload: { outcome: body.outcome, reviewId: appeal.reviewId },
    });
    void webhooks.emit('appeal.resolved', {
      appealId: appeal.id,
      reviewId: appeal.reviewId,
      outcome: body.outcome,
    });
    return appeal;
  });

  // DSA Art. 17: a statement of reasons for every demote/suppress decision.
  app.get<{ Params: { id: string } }>(
    '/v1/reviews/:id/statement-of-reasons',
    async (request, reply) => {
      requireScope(request, 'analyze:write');
      const tenantId = tenantOf(request);
      const query = parse(sorQuerySchema, request.query);
      const result = await service.getResult(tenantId, request.params.id);
      if (!result) throw new ApiError(404, 'REVIEW_NOT_FOUND', 'Review not found.');
      const sor = buildStatementOfReasons({
        review: result.review,
        result: result.result,
        config,
      });
      if (['downrank', 'hold', 'escalate', 'remove'].includes(result.result.decision)) {
        await store.appendAudit({
          tenantId,
          actor: request.auth?.apiKeyId ?? 'admin',
          action: 'review.sor_issued',
          targetType: 'review',
          targetId: result.review.id,
          payload: {
            sorId: sor.id,
            decision: result.result.decision,
            digest: sor.evidenceDigest,
          },
        });
      }
      if (query.format === 'md') {
        return reply
          .header('content-type', 'text/markdown; charset=utf-8')
          .send(renderStatementOfReasonsMarkdown(sor));
      }
      return sor;
    },
  );

  // DSA Art. 16: notice and action workflow for hosted reviews.
  app.post('/v1/notices', async (request, reply) => {
    requireScope(request, 'feedback:write');
    const tenantId = tenantOf(request);
    const body = parse(noticeBodySchema, request.body);
    const review = await store.getReview(tenantId, body.reviewId);
    if (!review) throw new ApiError(404, 'REVIEW_NOT_FOUND', 'Review not found.');
    const notice = await store.insertNotice({
      tenantId,
      reviewId: body.reviewId,
      type: body.type,
      claim: body.claim,
      substantiated: body.substantiated ?? false,
      ...(body.metadata ? { metadata: body.metadata } : {}),
    });
    await store.appendAudit({
      tenantId,
      actor: request.auth?.apiKeyId ?? 'admin',
      action: 'notice.received',
      targetType: 'review',
      targetId: body.reviewId,
      payload: { noticeId: notice.id, type: notice.type, substantiated: notice.substantiated },
    });
    void webhooks.emit('notice.received', {
      noticeId: notice.id,
      reviewId: notice.reviewId,
      type: notice.type,
      substantiated: notice.substantiated,
    });
    return reply.code(201).send(notice);
  });

  app.get('/v1/notices', async (request) => {
    requireScope(request, 'feedback:write');
    const tenantId = tenantOf(request);
    const query = parse(noticesQuerySchema, request.query);
    return {
      notices: await store.listNotices(tenantId, {
        ...(query.status ? { status: query.status } : {}),
        ...(query.reviewId ? { reviewId: query.reviewId } : {}),
        limit: query.limit ?? 100,
      }),
    };
  });

  app.get<{ Params: { id: string } }>('/v1/notices/:id', async (request) => {
    requireScope(request, 'feedback:write');
    const tenantId = tenantOf(request);
    const notice = await store.getNotice(tenantId, request.params.id);
    if (!notice) throw new ApiError(404, 'NOTICE_NOT_FOUND', 'Notice not found.');
    return notice;
  });

  app.patch<{ Params: { id: string } }>('/v1/notices/:id/status', async (request) => {
    requireScope(request, 'feedback:write');
    const tenantId = tenantOf(request);
    const body = parse(noticeStatusBodySchema, request.body);
    const notice = await store.updateNoticeStatus(tenantId, request.params.id, body);
    if (!notice) throw new ApiError(404, 'NOTICE_NOT_FOUND', 'Notice not found.');
    await store.appendAudit({
      tenantId,
      actor: request.auth?.apiKeyId ?? 'admin',
      action: 'notice.status_changed',
      targetType: 'notice',
      targetId: request.params.id,
      payload: { status: notice.status, note: body.note ?? undefined },
    });
    return notice;
  });

  app.get<{ Params: { id: string } }>('/v1/reviewers/:id/risk', async (request) => {
    requireScope(request, 'analyze:write');
    const tenantId = tenantOf(request);
    let reviewer = await store.getReviewerById(tenantId, request.params.id);
    if (!reviewer) {
      const hmac = scopedHmac(config.privacy.pepper, tenantId, 'reviewer', request.params.id);
      reviewer = await store.getReviewer(tenantId, hmac);
    }
    if (!reviewer) throw new ApiError(404, 'REVIEWER_NOT_FOUND', 'Reviewer not found.');
    const [snapshot, aggregates] = await Promise.all([
      store.getRiskSnapshot(tenantId, 'reviewer', reviewer.id),
      store.getReviewerAggregates(tenantId, reviewer.id),
    ]);
    return {
      reviewer: {
        id: reviewer.id,
        riskScore: reviewer.riskScore,
        riskBand: reviewer.riskBand,
        firstSeen: reviewer.firstSeen,
        lastSeen: reviewer.lastSeen,
      },
      snapshot,
      aggregates,
    };
  });

  app.get<{ Params: { id: string } }>('/v1/items/:id/integrity', async (request) => {
    requireScope(request, 'analyze:write');
    const tenantId = tenantOf(request);
    const result = await service.computeIntegrity(tenantId, request.params.id);
    if (!result) throw new ApiError(404, 'ITEM_NOT_FOUND', 'Item not found.');
    return result;
  });

  app.post<{ Params: { id: string } }>('/v1/items/:id/select', async (request) => {
    requireScope(request, 'analyze:write');
    const tenantId = tenantOf(request);
    const body = parse(selectBodySchema, request.body ?? {});
    const result = await service.selectReviews(tenantId, request.params.id, body);
    if (!result) throw new ApiError(404, 'ITEM_NOT_FOUND', 'Item not found.');
    return result;
  });

  app.get('/v1/campaigns', async (request) => {
    requireScope(request, 'analyze:write');
    const tenantId = tenantOf(request);
    const query = parse(listQuerySchema, request.query);
    return { campaigns: await store.listCampaigns(tenantId, query.limit ?? 100) };
  });

  app.get<{ Params: { id: string } }>('/v1/campaigns/:id', async (request) => {
    requireScope(request, 'analyze:write');
    const tenantId = tenantOf(request);
    const campaign = await store.getCampaign(tenantId, request.params.id);
    if (!campaign) throw new ApiError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found.');
    return campaign;
  });

  app.post('/v1/scan', async (request, reply) => {
    requireScope(request, 'scan:write');
    const tenantId = tenantOf(request);
    const body = parse(scanBodySchema, request.body);
    const source = await store.getSource(tenantId, body.sourceId);
    if (!source) throw new ApiError(404, 'SOURCE_NOT_FOUND', 'Source not found.');
    const job = await store.createJob({
      tenantId,
      kind: 'scan',
      payload: {
        sourceId: body.sourceId,
        ...(body.limit ? { limit: body.limit } : {}),
        ...(body.batchSize ? { batchSize: body.batchSize } : {}),
      },
      maxAttempts: 2,
    });
    if (body.sync) {
      const result = await runSyncScan(job, deps);
      return { jobId: job.id, status: 'completed', result };
    }
    void webhooks.emit('scan.queued', { jobId: job.id, sourceId: body.sourceId });
    return reply.code(202).send({ jobId: job.id, status: 'pending' });
  });

  app.get<{ Params: { id: string } }>('/v1/jobs/:id', async (request) => {
    requireScope(request, 'scan:write');
    const tenantId = tenantOf(request);
    const job = await store.getJob(tenantId, request.params.id);
    if (!job) throw new ApiError(404, 'JOB_NOT_FOUND', 'Job not found.');
    return job;
  });

  app.get('/v1/usage', async (request) => {
    requireScope(request, 'analyze:write');
    const tenantId = tenantOf(request);
    const period = currentPeriod();
    const [reviewsUsed, usage] = await Promise.all([
      store.getUsage(tenantId, 'reviews', period),
      store.listUsage(tenantId, period),
    ]);
    return {
      period,
      reviewsUsed,
      reviewsLimit: service.getEntitlements().reviewsPerMonth,
      entitlements: service.getEntitlements().toJSON(),
      usage,
    };
  });

  // ---------------------------------------------------------------------------
  // Admin
  // ---------------------------------------------------------------------------

  // DSA Art. 15/24-style transparency + UK DMCCA proportionate-steps evidence.
  app.get('/v1/admin/transparency', async (request, reply) => {
    requireAdmin(request);
    const query = parse(transparencyQuerySchema, request.query);
    const tenantId = adminTenant(request);
    const report = await buildTransparencyReport(store, tenantId, { sinceDays: query.days });
    if (query.format === 'html') {
      return reply
        .header('content-type', 'text/html; charset=utf-8')
        .send(renderTransparencyHtml(report));
    }
    return report;
  });

  app.post('/v1/admin/keys', async (request, reply) => {
    requireAdmin(request);
    const body = parse(adminKeyBodySchema, request.body);
    const tenantId = body.tenantId ?? adminTenant(request);
    await store.ensureTenant(tenantId);
    const material = generateApiKey('live');
    const record = await store.createApiKey({
      tenantId,
      prefix: material.prefix,
      keyHash: material.hash,
      scopes: body.scopes ?? ['analyze:write', 'feedback:write', 'scan:write'],
      rateLimit: body.rateLimit ?? null,
      expiresAt: body.expiresAt ?? null,
    });
    await store.appendAudit({
      tenantId,
      actor: 'admin',
      action: 'api_key.created',
      targetType: 'api_key',
      targetId: record.id,
      payload: { scopes: record.scopes },
    });
    return reply.code(201).send({
      id: record.id,
      key: material.key,
      prefix: material.prefix,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      warning: 'Store this key now. It will not be shown again.',
    });
  });

  app.get('/v1/admin/keys', async (request) => {
    requireAdmin(request);
    const query = parse(listQuerySchema, request.query);
    const tenantId = query.tenantId ?? adminTenant(request);
    const keys = await store.listApiKeys(tenantId);
    return {
      keys: keys.map((key) => ({
        id: key.id,
        prefix: key.prefix,
        scopes: key.scopes,
        createdAt: key.createdAt,
        expiresAt: key.expiresAt,
        revokedAt: key.revokedAt,
        lastUsedAt: key.lastUsedAt,
      })),
    };
  });

  app.post<{ Params: { id: string } }>('/v1/admin/keys/:id/revoke', async (request) => {
    requireAdmin(request);
    const tenantId = adminTenant(request);
    const revoked = await store.revokeApiKey(tenantId, request.params.id);
    if (!revoked) throw new ApiError(404, 'API_KEY_NOT_FOUND', 'API key not found.');
    await store.appendAudit({
      tenantId,
      actor: 'admin',
      action: 'api_key.revoked',
      targetType: 'api_key',
      targetId: request.params.id,
      payload: {},
    });
    return { id: request.params.id, revoked: true };
  });

  app.post('/v1/admin/sources', async (request, reply) => {
    requireAdmin(request);
    const body = parse(adminSourceBodySchema, request.body);
    const tenantId = body.tenantId ?? adminTenant(request);
    await store.ensureTenant(tenantId);
    const source = await store.createSource({
      tenantId,
      kind: body.kind,
      name: body.name,
      config: body.config,
      mapping: body.mapping ?? {},
      enabled: body.enabled ?? true,
    });
    await store.appendAudit({
      tenantId,
      actor: 'admin',
      action: 'source.created',
      targetType: 'source',
      targetId: source.id,
      payload: { kind: source.kind, name: source.name },
    });
    return reply.code(201).send(source);
  });

  app.get('/v1/admin/sources', async (request) => {
    requireAdmin(request);
    const query = parse(listQuerySchema, request.query);
    const tenantId = query.tenantId ?? adminTenant(request);
    return { sources: await store.listSources(tenantId) };
  });

  app.delete<{ Params: { id: string } }>('/v1/admin/sources/:id', async (request) => {
    requireAdmin(request);
    const tenantId = adminTenant(request);
    const deleted = await store.deleteSource(tenantId, request.params.id);
    if (!deleted) throw new ApiError(404, 'SOURCE_NOT_FOUND', 'Source not found.');
    await store.appendAudit({
      tenantId,
      actor: 'admin',
      action: 'source.deleted',
      targetType: 'source',
      targetId: request.params.id,
      payload: {},
    });
    return { id: request.params.id, deleted: true };
  });

  app.get('/v1/admin/audit', async (request) => {
    requireAdmin(request);
    const query = parse(listQuerySchema, request.query);
    const tenantId = query.tenantId ?? adminTenant(request);
    return { audit: await store.listAudit(tenantId, query.limit ?? 200) };
  });

  app.get('/v1/admin/audit/verify', async (request) => {
    requireAdmin(request);
    const query = parse(listQuerySchema, request.query);
    const tenantId = query.tenantId ?? adminTenant(request);
    return store.verifyAudit(tenantId);
  });

  app.get('/v1/admin/license', async (request) => {
    requireAdmin(request);
    return service.getEntitlements().toJSON();
  });

  app.post('/v1/admin/campaigns/run', async (request, reply) => {
    requireAdmin(request);
    const tenantId = adminTenant(request);
    const job = await store.createJob({ tenantId, kind: 'campaigns', payload: {} });
    return reply.code(202).send({ jobId: job.id, status: 'pending' });
  });

  app.post('/v1/admin/retention', async (request, reply) => {
    requireAdmin(request);
    const tenantId = adminTenant(request);
    const job = await store.createJob({ tenantId, kind: 'retention', payload: {} });
    return reply.code(202).send({ jobId: job.id, status: 'pending' });
  });
}

export function requestTenant(request: FastifyRequest): string {
  return tenantOf(request);
}
