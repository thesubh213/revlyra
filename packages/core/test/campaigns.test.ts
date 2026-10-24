import { describe, expect, it } from 'vitest';
import type { CampaignEdge } from '../src';
import { detectCampaigns } from '../src/graph';

function edge(
  reviewerId: string,
  itemId: string,
  minutes: number,
  signals: string[] = ['text', 'temporal'],
): CampaignEdge {
  return {
    reviewerId,
    itemId,
    reviewId: `${reviewerId}-${itemId}`,
    submittedAt: new Date(Date.UTC(2026, 9, 20, 12, minutes)).toISOString(),
    signals,
    risk: 0.7,
  };
}

describe('campaign detection', () => {
  it('finds a coordinated block across shared items', () => {
    const reviewers = ['a', 'b', 'c', 'd'];
    const items = ['p1', 'p2', 'p3'];
    const edges: CampaignEdge[] = [];
    for (const reviewer of reviewers) {
      for (const item of items) {
        edges.push(edge(reviewer, item, reviewers.indexOf(reviewer) * 2));
      }
    }

    const campaigns = detectCampaigns(edges, { windowHours: 48, minMembers: 3 });
    expect(campaigns.length).toBeGreaterThan(0);
    expect(campaigns[0]?.reviewerIds.length).toBeGreaterThanOrEqual(3);
    expect(campaigns[0]?.score).toBeGreaterThan(0.4);
  });

  it('does not group unrelated reviewers', () => {
    const edges: CampaignEdge[] = [edge('a', 'p1', 0), edge('b', 'p2', 500), edge('c', 'p3', 1000)];
    const campaigns = detectCampaigns(edges, { windowHours: 24, minMembers: 3 });
    expect(campaigns).toHaveLength(0);
  });
});
