import { describe, expect, it } from 'vitest';
import { detectCampaigns } from '../src';
import type { CampaignEdge } from '../src/types';

const BASE = Date.parse('2026-10-20T00:00:00Z');

function reviewEdge(reviewerId: string, itemId: string, minutesAfterBase: number): CampaignEdge {
  return {
    reviewerId,
    itemId,
    reviewId: `${reviewerId}:${itemId}`,
    submittedAt: new Date(BASE + minutesAfterBase * 60_000).toISOString(),
  };
}

function groupEdge(
  reviewerId: string,
  kind: CampaignEdge['kind'],
  groupKey: string,
  minutesAfterBase: number,
): CampaignEdge {
  return {
    reviewerId,
    itemId: '',
    reviewId: `${reviewerId}:group:${groupKey}`,
    submittedAt: new Date(BASE + minutesAfterBase * 60_000).toISOString(),
    kind,
    groupKey,
  };
}

describe('heterogeneous campaign edges', () => {
  it('detects a template-sharing ring on disjoint items within a tight window', () => {
    const edges: CampaignEdge[] = [];
    // Each reviewer reviews a DIFFERENT item (no co-review edges possible).
    edges.push(
      reviewEdge('r1', 'item-a', 10),
      reviewEdge('r2', 'item-b', 30),
      reviewEdge('r3', 'item-c', 50),
    );
    for (const reviewer of ['r1', 'r2', 'r3']) {
      edges.push(groupEdge(reviewer, 'same_template', 'tpl-shared-1', 10));
    }
    const campaigns = detectCampaigns(edges, { windowHours: 48, minMembers: 3 });
    expect(campaigns.length).toBeGreaterThanOrEqual(1);
    const campaign = campaigns[0]!;
    expect(campaign.reviewerIds.length).toBe(3);
    expect(campaign.edgeKinds).toContain('same_template');
  });

  it('does not punish a device-only group spread over a long window (NAT safety)', () => {
    const edges: CampaignEdge[] = [];
    edges.push(
      reviewEdge('n1', 'item-a', 10),
      reviewEdge('n2', 'item-b', 9_000),
      reviewEdge('n3', 'item-c', 18_000),
    );
    for (const [reviewer, minutes] of [
      ['n1', 10],
      ['n2', 9_000],
      ['n3', 18_000],
    ] as const) {
      edges.push(groupEdge(reviewer, 'same_device', 'dev-shared-1', minutes));
    }
    const campaigns = detectCampaigns(edges, { windowHours: 48, minMembers: 3 });
    expect(campaigns).toHaveLength(0);
  });

  it('raises the score when multiple edge kinds corroborate', () => {
    const edges: CampaignEdge[] = [];
    edges.push(
      reviewEdge('h1', 'item-a', 20),
      reviewEdge('h2', 'item-a', 40),
      reviewEdge('h3', 'item-a', 60),
    );
    for (const reviewer of ['h1', 'h2', 'h3']) {
      edges.push(groupEdge(reviewer, 'same_template', 'tpl-shared-2', 20));
      edges.push(groupEdge(reviewer, 'same_media', 'media-shared-2', 20));
    }
    const campaigns = detectCampaigns(edges, { windowHours: 48, minMembers: 3 });
    expect(campaigns.length).toBeGreaterThanOrEqual(1);
    const campaign = campaigns[0]!;
    expect(campaign.edgeKinds).toEqual(
      expect.arrayContaining(['co_review', 'same_media', 'same_template']),
    );
    expect(campaign.score).toBeGreaterThan(0.4);
  });

  it('keeps plain co-review campaigns working (back-compat)', () => {
    const edges: CampaignEdge[] = [];
    for (const reviewer of ['c1', 'c2', 'c3']) {
      edges.push(reviewEdge(reviewer, 'item-a', 15), reviewEdge(reviewer, 'item-b', 40));
    }
    const campaigns = detectCampaigns(edges, { windowHours: 48, minMembers: 3 });
    expect(campaigns.length).toBeGreaterThanOrEqual(1);
    expect(campaigns[0]!.reviewerIds.length).toBe(3);
  });
});
