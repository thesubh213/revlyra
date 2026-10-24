import type { CampaignEdge } from '@revlyra/core';
import { detectCampaigns } from '@revlyra/core';
import type { RevlyraConfig } from '../config';
import type { ReviewService } from '../engine/service';
import { createSource, type SourceConfig } from '../sources';
import type { Store } from '../store';
import type { JobRecord } from '../store/types';

export type JobHandler = (
  job: JobRecord,
  context: { store: Store; service: ReviewService; config: RevlyraConfig },
) => Promise<Record<string, unknown>>;

export interface JobWorkerOptions {
  store: Store;
  service: ReviewService;
  config: RevlyraConfig;
  pollMs?: number;
  concurrency?: number;
  handlers?: Record<string, JobHandler>;
}

const DAY_MS = 86_400_000;

export const defaultHandlers: Record<string, JobHandler> = {
  async scan(job, { store, service, config }) {
    const sourceId = String(job.payload.sourceId ?? '');
    if (!sourceId) throw new Error('SCAN_SOURCE_ID_MISSING');
    const source = await store.getSource(job.tenantId, sourceId);
    if (!source) throw new Error('SOURCE_NOT_FOUND');
    if (!source.enabled) throw new Error('SOURCE_DISABLED');

    const sourceClient = createSource(source.id, {
      ...(source.config as Record<string, unknown>),
      kind: source.kind,
      mapping: source.mapping,
    } as SourceConfig);

    let imported = 0;
    let failed = 0;
    let lastSubmittedAt: string | undefined;
    const errors: string[] = [];
    const limit =
      typeof job.payload.limit === 'number'
        ? job.payload.limit
        : config.database.driver === 'sqlite'
          ? 100_000
          : 1_000_000;

    try {
      for await (const record of sourceClient.pull({
        limit,
        batchSize: typeof job.payload.batchSize === 'number' ? job.payload.batchSize : 500,
      })) {
        try {
          await service.ingest(
            job.tenantId,
            {
              review: record.review,
              ...(record.reviewer ? { reviewer: record.reviewer } : {}),
              ...(record.item ? { item: record.item } : {}),
              sourceId: source.id,
            },
            'worker',
          );
          imported += 1;
          lastSubmittedAt = record.review.submittedAt;
        } catch (error) {
          failed += 1;
          if (errors.length < 20) errors.push(String((error as Error).message ?? error));
        }
      }
    } finally {
      await sourceClient.close?.();
    }

    if (lastSubmittedAt) {
      await store.updateSourceCursor(job.tenantId, source.id, {
        ...(source.cursor ?? {}),
        lastSubmittedAt,
        updatedAt: new Date().toISOString(),
      });
    }

    return { imported, failed, errors, lastSubmittedAt: lastSubmittedAt ?? null };
  },

  async bulk_ingest(job, { service }) {
    const reviews = Array.isArray(job.payload.reviews) ? job.payload.reviews : [];
    const reviewer =
      job.payload.reviewer && typeof job.payload.reviewer === 'object'
        ? (job.payload.reviewer as Record<string, unknown>)
        : undefined;
    const item =
      job.payload.item && typeof job.payload.item === 'object'
        ? (job.payload.item as Record<string, unknown>)
        : undefined;
    const sourceId = typeof job.payload.sourceId === 'string' ? job.payload.sourceId : undefined;

    let imported = 0;
    let failed = 0;
    const errors: string[] = [];
    for (const review of reviews) {
      try {
        await service.ingest(
          job.tenantId,
          {
            review: review as never,
            ...(reviewer ? { reviewer: reviewer as never } : {}),
            ...(item ? { item: item as never } : {}),
            ...(sourceId ? { sourceId } : {}),
          },
          'worker',
        );
        imported += 1;
      } catch (error) {
        failed += 1;
        if (errors.length < 20) errors.push(String((error as Error).message ?? error));
      }
    }
    return { imported, failed, errors };
  },

  async campaigns(job, { store }) {
    const since = new Date(Date.now() - 180 * DAY_MS).toISOString();
    const edges = await store.listReviewEdges(job.tenantId, since, 200_000);
    const reviewEdges: CampaignEdge[] = edges.map((edge) => ({
      reviewerId: edge.reviewerId,
      itemId: edge.itemId,
      reviewId: edge.reviewId,
      submittedAt: edge.submittedAt,
      signals: edge.signals,
      risk: edge.risk,
    }));

    // Heterogeneous edges (doc 3.2): template, media, device, and subnet
    // group keys collected from the reviews/media tables. Group keys are
    // pseudonymous (hashes / HMACs); k >= 2 distinct reviewers per key.
    const groupEdges: CampaignEdge[] = [];
    const groupRows = await store.listReviewGroupKeys(job.tenantId, since, 100_000);

    type AttributeGroup = {
      reviewers: Set<string>;
      rows: Array<{ reviewerId: string; reviewId: string; submittedAt: string }>;
    };

    const pushGroupEdges = (
      kind: CampaignEdge['kind'],
      groups: Map<string, AttributeGroup>,
    ): void => {
      for (const [groupKey, group] of groups) {
        if (group.reviewers.size < 2 || group.reviewers.size > 30) continue;
        for (const row of group.rows) {
          groupEdges.push({
            reviewerId: row.reviewerId,
            itemId: '',
            reviewId: row.reviewId,
            submittedAt: row.submittedAt,
            kind,
            groupKey,
          });
        }
      }
    };

    const textGroups = new Map<string, AttributeGroup>();
    const deviceGroups = new Map<string, AttributeGroup>();
    const subnetGroups = new Map<string, AttributeGroup>();

    const addRow = (
      groups: Map<string, AttributeGroup>,
      groupKey: string,
      row: { reviewerId: string; reviewId: string; submittedAt: string },
    ): void => {
      const group = groups.get(groupKey) ?? { reviewers: new Set<string>(), rows: [] };
      group.reviewers.add(row.reviewerId);
      group.rows.push(row);
      groups.set(groupKey, group);
    };

    for (const row of groupRows) {
      if (row.textSha256) addRow(textGroups, `text:${row.textSha256}`, row);
      const deviceId = typeof row.context?.deviceId === 'string' ? row.context.deviceId : null;
      if (deviceId) addRow(deviceGroups, `dev:${deviceId}`, row);
      const subnet = typeof row.context?.subnet === 'string' ? row.context.subnet : null;
      if (subnet) addRow(subnetGroups, `net:${subnet}`, row);
    }
    pushGroupEdges('same_template', textGroups);
    pushGroupEdges('same_device', deviceGroups);
    pushGroupEdges('same_subnet', subnetGroups);

    const mediaRows = await store.listRecentMedia(job.tenantId, since, 50_000);
    const mediaGroups = new Map<string, AttributeGroup>();
    for (const row of mediaRows) {
      if (!row.sha256) continue;
      addRow(mediaGroups, `media:${row.sha256}`, row);
    }
    pushGroupEdges('same_media', mediaGroups);

    const campaigns = detectCampaigns([...reviewEdges, ...groupEdges], {
      windowHours: 48,
      minMembers: 3,
    });

    const now = new Date().toISOString();
    for (const campaign of campaigns) {
      await store.upsertCampaign({
        id: campaign.id,
        tenantId: job.tenantId,
        kind: campaign.edgeKinds.length > 1 ? 'coordinated_heterogeneous' : 'coordinated',
        score: campaign.score,
        density: campaign.density,
        memberCount: campaign.reviewerIds.length,
        reviewerIds: campaign.reviewerIds,
        itemIds: campaign.itemIds,
        evidence: {
          reason: campaign.reason,
          signalFamilies: campaign.signalFamilies,
          edgeKinds: campaign.edgeKinds,
          algorithm: 'fraudar-lite-heterogeneous',
        },
        status: 'candidate',
        createdAt: now,
        updatedAt: now,
      });
    }
    return {
      campaigns: campaigns.length,
      edges: edges.length,
      groupEdges: groupEdges.length,
    };
  },

  async retention(job, { store, config }) {
    const before = new Date(Date.now() - config.privacy.retentionDays * DAY_MS).toISOString();
    const purged = await store.purgeOlderThan(job.tenantId, before);
    return { before, ...purged };
  },

  async integrity(job, { store, service }) {
    const reviews = await store.listRecentReviews(job.tenantId, 5000);
    const itemIds = Array.from(new Set(reviews.map((review) => review.itemId))).slice(0, 500);
    let updated = 0;
    for (const itemId of itemIds) {
      const result = await service.computeIntegrity(job.tenantId, itemId);
      if (!result) continue;
      const score = result.integrity.suspicionRate;
      const band =
        score >= 0.5 ? 'critical' : score >= 0.3 ? 'high' : score >= 0.1 ? 'medium' : 'low';
      await store.upsertRiskSnapshot({
        tenantId: job.tenantId,
        entityType: 'item',
        entityId: itemId,
        score,
        band,
        version: '1.0.0',
      });
      updated += 1;
    }
    return { items: updated };
  },
};

export class JobWorker {
  private readonly store: Store;
  private readonly service: ReviewService;
  private readonly config: RevlyraConfig;
  private readonly handlers: Record<string, JobHandler>;
  private readonly concurrency: number;
  private readonly pollMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;

  constructor(options: JobWorkerOptions) {
    this.store = options.store;
    this.service = options.service;
    this.config = options.config;
    this.handlers = { ...defaultHandlers, ...(options.handlers ?? {}) };
    this.concurrency = Math.max(1, options.concurrency ?? options.config.jobs.concurrency);
    this.pollMs = Math.max(100, options.pollMs ?? options.config.jobs.pollMs);
  }

  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let processed = 0;
    try {
      await this.store.recoverStaleJobs(15 * 60_000);
      const jobs: JobRecord[] = [];
      for (let i = 0; i < this.concurrency; i += 1) {
        const job = await this.store.claimJob();
        if (!job) break;
        jobs.push(job);
      }
      await Promise.all(
        jobs.map(async (job) => {
          const handler = this.handlers[job.kind];
          if (!handler) {
            await this.store.failJob(job.id, `NO_HANDLER:${job.kind}`);
            return;
          }
          try {
            const result = await handler(job, {
              store: this.store,
              service: this.service,
              config: this.config,
            });
            await this.store.completeJob(job.id, result);
          } catch (error) {
            const message = String((error as Error).message ?? error);
            const backoff = Math.min(60_000, 1000 * 2 ** Math.max(0, job.attempts - 1));
            await this.store.failJob(job.id, message, backoff);
          }
        }),
      );
      processed = jobs.length;
    } finally {
      this.running = false;
    }
    return processed;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const tick = async () => {
      if (this.stopped) return;
      try {
        const processed = await this.runOnce();
        this.timer = setTimeout(tick, processed > 0 ? 50 : this.pollMs);
      } catch {
        this.timer = setTimeout(tick, this.pollMs);
      }
    };
    this.timer = setTimeout(tick, 10);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.running) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
