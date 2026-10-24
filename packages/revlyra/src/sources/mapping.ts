import type { CanonicalReview, ReviewMedia } from '@revlyra/core';
import type { FieldSource, SourceMapping, SourceReview } from './types';

const AUTO_FIELDS: Record<string, string[]> = {
  id: ['id', 'review_id', 'reviewId', '_id'],
  externalId: ['external_id', 'externalId', 'review_id', 'reviewId'],
  itemId: ['item_id', 'itemId', 'product_id', 'productId', 'business_id', 'businessId', 'sku'],
  reviewerId: [
    'reviewer_id',
    'reviewerId',
    'user_id',
    'userId',
    'author_id',
    'authorId',
    'customer_id',
  ],
  rating: ['rating', 'stars', 'score', 'review_rating'],
  text: ['text', 'review', 'review_text', 'content', 'body', 'comment'],
  title: ['title', 'headline', 'summary'],
  language: ['language', 'lang', 'locale'],
  submittedAt: [
    'submitted_at',
    'submittedAt',
    'created_at',
    'createdAt',
    'date',
    'review_date',
    'timestamp',
  ],
  verifiedPurchase: ['verified_purchase', 'verifiedPurchase', 'verified', 'is_verified'],
  reviewerAccountCreatedAt: [
    'reviewer_account_created_at',
    'reviewerCreatedAt',
    'user_created_at',
    'author_created_at',
  ],
  itemCategory: ['category', 'item_category', 'product_category'],
  media: ['media', 'images', 'photos', 'attachments'],
};

export function getPath(value: unknown, path: string): unknown {
  if (!path) return undefined;
  const segments = path
    .replace(/\[(\d+)\]/gu, '.$1')
    .split('.')
    .filter(Boolean);
  let current: unknown = value;
  for (const segment of segments) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function coerce(value: unknown, transform?: FieldSource['transform']): unknown {
  if (value === undefined || value === null) return value;
  switch (transform) {
    case 'string':
      return String(value);
    case 'number':
      return typeof value === 'number' ? value : Number(value);
    case 'boolean':
      return value === true || value === 'true' || value === '1' || value === 1;
    case 'date': {
      if (typeof value === 'number') {
        return new Date(value < 10_000_000_000 ? value * 1000 : value).toISOString();
      }
      const date = new Date(String(value));
      return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
    }
    case 'json':
      if (typeof value === 'string') {
        try {
          return JSON.parse(value);
        } catch {
          return undefined;
        }
      }
      return value;
    default:
      return value;
  }
}

function resolveValue(record: unknown, source: string | FieldSource): unknown {
  if (typeof source === 'string') return getPath(record, source);
  const value = getPath(record, source.path);
  const transformed = coerce(value, source.transform);
  return transformed === undefined ? source.default : transformed;
}

export function resolveMapping(mapping: SourceMapping | undefined, sample: unknown): SourceMapping {
  const base = mapping ?? {};
  const fields = { ...(base.fields ?? {}) };
  for (const [target, candidates] of Object.entries(AUTO_FIELDS)) {
    if (fields[target] !== undefined) continue;
    for (const candidate of candidates) {
      const value = getPath(sample, candidate);
      if (value !== undefined && value !== null && value !== '') {
        fields[target] = candidate;
        break;
      }
    }
  }
  return {
    ...base,
    fields,
    reviewerFields: { ...(base.reviewerFields ?? {}) },
    itemFields: { ...(base.itemFields ?? {}) },
  };
}

function normalizeMedia(value: unknown, mapping: SourceMapping): ReviewMedia[] {
  if (!Array.isArray(value)) return [];
  const media: ReviewMedia[] = [];
  for (const raw of value.slice(0, 50)) {
    if (typeof raw === 'string') {
      media.push({ url: raw });
      continue;
    }
    if (!raw || typeof raw !== 'object') continue;
    const item: ReviewMedia = {};
    const fields = mapping.mediaFields;
    if (fields) {
      for (const [target, path] of Object.entries(fields)) {
        const mapped = coerce(getPath(raw, path));
        if (mapped !== undefined) (item as Record<string, unknown>)[target] = mapped;
      }
    } else {
      for (const key of [
        'url',
        'sha256',
        'dhash',
        'phash',
        'width',
        'height',
        'mime',
        'exif',
        'capturedAt',
      ] as const) {
        const mapped = (raw as Record<string, unknown>)[key];
        if (mapped !== undefined) (item as Record<string, unknown>)[key] = mapped;
      }
    }
    if (Object.keys(item).length > 0) media.push(item);
  }
  return media;
}

export function mapRecord(
  record: unknown,
  mapping: SourceMapping,
  sourceKind: string,
): SourceReview {
  const fields = mapping.fields ?? {};
  const value = (target: string): unknown =>
    fields[target] === undefined ? undefined : resolveValue(record, fields[target]!);

  const submittedAtRaw = value('submittedAt');
  const submittedAt = submittedAtRaw ? coerce(submittedAtRaw, 'date') : new Date().toISOString();

  const ratingRaw = value('rating');
  const rating = typeof ratingRaw === 'number' ? ratingRaw : Number(ratingRaw);
  if (!Number.isFinite(rating)) {
    throw new Error(`Mapped rating is not numeric for source ${sourceKind}.`);
  }

  const itemId = value('itemId');
  const reviewerId = value('reviewerId');
  if (itemId === undefined || reviewerId === undefined) {
    throw new Error(
      `Source ${sourceKind} is missing itemId or reviewerId. Provide a mapping for both fields.`,
    );
  }

  const text = value('text');
  const externalId = value('externalId') ?? value('id');
  const review: CanonicalReview = {
    id: String(
      value('id') ?? externalId ?? `${String(itemId)}:${String(reviewerId)}:${String(submittedAt)}`,
    ),
    ...(externalId !== undefined ? { externalId: String(externalId) } : {}),
    itemId: String(itemId),
    reviewerId: String(reviewerId),
    rating,
    text: text === undefined || text === null ? '' : String(text),
    ...(value('title') !== undefined ? { title: String(value('title')) } : {}),
    ...(value('language') !== undefined ? { language: String(value('language')) } : {}),
    submittedAt: String(submittedAt),
    ...(value('verifiedPurchase') !== undefined
      ? { verifiedPurchase: Boolean(coerce(value('verifiedPurchase'), 'boolean')) }
      : {}),
    media: normalizeMedia(value('media'), mapping),
    metadata: { sourceKind },
  };

  const reviewerFields = mapping.reviewerFields ?? {};
  const itemFields = mapping.itemFields ?? {};
  const reviewerAccountCreatedAt =
    reviewerFields.accountCreatedAt !== undefined
      ? coerce(resolveValue(record, reviewerFields.accountCreatedAt), 'date')
      : value('reviewerAccountCreatedAt') !== undefined
        ? coerce(value('reviewerAccountCreatedAt'), 'date')
        : undefined;
  const reviewerStats =
    reviewerFields.stats !== undefined
      ? coerce(resolveValue(record, reviewerFields.stats), 'json')
      : undefined;
  const itemCategory =
    itemFields.category !== undefined
      ? resolveValue(record, itemFields.category)
      : value('itemCategory');
  const itemAttributes =
    itemFields.attributes !== undefined
      ? coerce(resolveValue(record, itemFields.attributes), 'json')
      : undefined;
  const itemStats =
    itemFields.stats !== undefined
      ? coerce(resolveValue(record, itemFields.stats), 'json')
      : undefined;

  return {
    review,
    ...(reviewerAccountCreatedAt || reviewerStats
      ? {
          reviewer: {
            ...(reviewerAccountCreatedAt
              ? { accountCreatedAt: String(reviewerAccountCreatedAt) }
              : {}),
            ...(reviewerStats && typeof reviewerStats === 'object'
              ? { stats: reviewerStats as Record<string, unknown> }
              : {}),
          },
        }
      : {}),
    ...(itemCategory || itemAttributes || itemStats
      ? {
          item: {
            ...(itemCategory ? { category: String(itemCategory) } : {}),
            ...(itemAttributes && typeof itemAttributes === 'object'
              ? { attributes: itemAttributes as Record<string, unknown> }
              : {}),
            ...(itemStats && typeof itemStats === 'object'
              ? { stats: itemStats as Record<string, unknown> }
              : {}),
          },
        }
      : {}),
  };
}
