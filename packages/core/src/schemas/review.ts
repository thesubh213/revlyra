import { z } from 'zod';

const isoDate = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
  message: 'Must be a valid ISO date',
});

export const reviewMediaSchema = z.object({
  url: z.string().max(2048).optional(),
  sha256: z.string().max(128).optional(),
  dhash: z.string().max(64).optional(),
  phash: z.string().max(64).optional(),
  width: z.number().int().positive().max(100_000).optional(),
  height: z.number().int().positive().max(100_000).optional(),
  mime: z.string().max(100).optional(),
  exif: z.record(z.string(), z.unknown()).optional(),
  capturedAt: isoDate.optional(),
});

export const reviewContextSchema = z.object({
  ip: z.string().max(100).optional(),
  ipCountry: z.string().max(8).optional(),
  ipAsn: z.union([z.string(), z.number()]).optional(),
  ipAsnOrg: z.string().max(200).optional(),
  subnet: z.string().max(100).optional(),
  deviceId: z.string().max(512).optional(),
  userAgent: z.string().max(2048).optional(),
  locale: z.string().max(35).optional(),
  timezone: z.string().max(100).optional(),
  tlsFingerprint: z.string().max(256).optional(),
  headersHash: z.string().max(128).optional(),
  emailDomain: z.string().max(255).optional(),
  phoneCountry: z.string().max(8).optional(),
  recentAccountsOnSubnet: z.number().int().nonnegative().optional(),
  recentReviewsOnSubnet: z.number().int().nonnegative().optional(),
  recentAccountsOnDevice: z.number().int().nonnegative().optional(),
  isDatacenterAsn: z.boolean().optional(),
  localeMismatch: z.boolean().optional(),
  headlessUserAgent: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const reviewerRelationshipSchema = z.enum([
  'customer',
  'employee',
  'former_employee',
  'owner',
  'contractor',
  'family',
  'competitor',
  'other',
]);

export const canonicalReviewSchema = z.object({
  id: z.string().max(200).optional(),
  tenantId: z.string().max(200).optional(),
  externalId: z.string().max(500).optional(),
  itemId: z.string().min(1).max(500),
  reviewerId: z.string().min(1).max(500),
  rating: z.number().min(1).max(5),
  text: z.string().max(20_000),
  title: z.string().max(1000).optional(),
  language: z.string().max(35).optional(),
  submittedAt: isoDate,
  verifiedPurchase: z.boolean().optional(),
  reviewerRelationship: reviewerRelationshipSchema.optional(),
  media: z.array(reviewMediaSchema).max(50).optional(),
  context: reviewContextSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const reviewerProfileSchema = z.object({
  id: z.string().min(1),
  accountCreatedAt: isoDate.optional(),
  totalReviews: z.number().int().nonnegative().optional(),
  reviewsLast24h: z.number().int().nonnegative().optional(),
  reviewsLast7d: z.number().int().nonnegative().optional(),
  reviewsLast30d: z.number().int().nonnegative().optional(),
  averageRating: z.number().min(1).max(5).optional(),
  ratingStdDev: z.number().nonnegative().optional(),
  ratingDistribution: z.array(z.number().nonnegative()).length(5).optional(),
  fiveStarRatio: z.number().min(0).max(1).optional(),
  ratingEntropy: z.number().nonnegative().optional(),
  verifiedPurchaseRatio: z.number().min(0).max(1).optional(),
  categoryEntropy: z.number().nonnegative().optional(),
  firstReviewAt: isoDate.optional(),
  lastReviewAt: isoDate.optional(),
  sharedDeviceCount: z.number().int().nonnegative().optional(),
  sharedSubnetCount: z.number().int().nonnegative().optional(),
  priorFlags: z.number().int().nonnegative().optional(),
  priorAppealsOverturned: z.number().int().nonnegative().optional(),
  recentIntervalsSeconds: z.array(z.number().nonnegative()).max(500).optional(),
  recentReviewTimestamps: z.array(isoDate).max(500).optional(),
  timezone: z.string().max(100).optional(),
  locale: z.string().max(35).optional(),
  relationship: reviewerRelationshipSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const itemProfileSchema = z.object({
  id: z.string().min(1),
  category: z.string().max(200).optional(),
  totalReviews: z.number().int().nonnegative().optional(),
  averageRating: z.number().min(1).max(5).optional(),
  ratingStdDev: z.number().nonnegative().optional(),
  fiveStarRatio: z.number().min(0).max(1).optional(),
  ratingDistribution: z.array(z.number().nonnegative()).length(5).optional(),
  recentReviews24h: z.number().int().nonnegative().optional(),
  recentReviews7d: z.number().int().nonnegative().optional(),
  expectedReviewsPerDay: z.number().nonnegative().optional(),
  baselineMean: z.number().min(1).max(5).optional(),
  baselineFiveStarRatio: z.number().min(0).max(1).optional(),
  baselineDistribution: z.array(z.number().nonnegative()).length(5).optional(),
  localTimezone: z.string().max(100).optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});

export const analysisContextSchema = z.object({
  reviewer: reviewerProfileSchema.optional(),
  item: itemProfileSchema.optional(),
  now: isoDate.optional(),
  corpus: z
    .object({
      totalReviews: z.number().int().nonnegative(),
      documentFrequency: z.record(z.string(), z.number()).optional(),
      tokenIdf: z.record(z.string(), z.number()).optional(),
    })
    .optional(),
  textMatches: z
    .array(
      z.object({
        reviewId: z.string(),
        reviewerId: z.string(),
        itemId: z.string(),
        similarity: z.number().min(0).max(1),
        kind: z.enum(['exact', 'near', 'template']),
        submittedAt: isoDate.optional(),
      }),
    )
    .max(100)
    .optional(),
  mediaMatches: z
    .array(
      z.object({
        reviewId: z.string(),
        reviewerId: z.string(),
        itemId: z.string(),
        kind: z.enum(['exact', 'near']),
        distance: z.number().nonnegative(),
      }),
    )
    .max(100)
    .optional(),
  campaign: z
    .object({
      id: z.string(),
      score: z.number().min(0).max(1),
      memberCount: z.number().int().nonnegative(),
      signalFamilies: z.array(z.string()),
    })
    .optional(),
  semantic: z
    .object({
      paraphraseSimilarity: z.number().min(0).max(1).optional(),
      paraphraseNeighborId: z.string().optional(),
      llmLikelihood: z.number().min(0).max(1).optional(),
    })
    .optional(),
  peer: z
    .object({
      medianReviewsPerDay: z.number().nonnegative().optional(),
      medianRatingDeviation: z.number().nonnegative().optional(),
      medianAccountAgeDays: z.number().nonnegative().optional(),
    })
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const analyzeRequestSchema = z.object({
  review: canonicalReviewSchema,
  context: analysisContextSchema.optional(),
  policy: z.string().max(100).optional(),
});

export type AnalyzeRequest = z.infer<typeof analyzeRequestSchema>;
