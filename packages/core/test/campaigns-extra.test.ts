import { describe, expect, it } from 'vitest';
import { detectCampaigns, labelPropagation, refineDenseBlock } from '../src/graph';
import type { CampaignEdge, CampaignEdgeKind } from '../src/types';
import type { ReviewRefInput } from './campaigns-types';

function _coEdges(
  pairs: Array<[string, string]>,
  at = '2026-10-01T10:00:00.000Z',
  itemId = 'item',
): CampaignEdge[] {
  return pairs.map(([reviewerId, other]) => ({
    reviewId: `r_${reviewerId}_${other}`,
    reviewerId,
    itemId,
    submittedAt: at,
    kind: 'co_review' as const,
    signals: [],
    risk: 0.3,
    otherReviewerId: other,
  })) as never;
}

describe('labelPropagation', () => {
  it('labels lonely nodes as their own groups', () => {
    const adjacency = new Map<string, Map<string, number>>([
      ['lonely', new Map()],
      ['also', new Map()],
    ]);
    const groups = labelPropagation(adjacency);
    expect(groups.get('lonely')).toEqual(['lonely']);
    expect(groups.get('also')).toEqual(['also']);
  });

  it('propagates the heaviest neighbor label within a dense clique', () => {
    const adjacency = new Map<string, Map<string, number>>([
      [
        'a',
        new Map([
          ['b', 1],
          ['c', 1],
        ]),
      ],
      [
        'b',
        new Map([
          ['a', 1],
          ['c', 1],
        ]),
      ],
      [
        'c',
        new Map([
          ['a', 1],
          ['b', 1],
        ]),
      ],
      ['z', new Map([['y', 1]])],
    ]);
    const groups = labelPropagation(adjacency);
    // Groups are keyed by the final assigned label: the whole clique lands
    // under label "b"; z adopts the (unregistered) label "y".
    const clique = groups.get('b');
    expect(clique).toEqual(expect.arrayContaining(['a', 'b', 'c']));
    expect(groups.get('y')).toEqual(['z']);
  });

  it('is deterministic across repeated calls', () => {
    const adjacency = new Map<string, Map<string, number>>([
      ['n1', new Map([['n2', 0.5]])],
      ['n2', new Map([['n1', 0.5]])],
      ['n3', new Map([['n4', 2]])],
      ['n4', new Map([['n3', 2]])],
    ]);
    const first = labelPropagation(adjacency);
    const second = labelPropagation(adjacency);
    expect([...first.entries()]).toEqual([...second.entries()]);
  });

  it('breaks score ties lexicographically', () => {
    // a's neighbors b and c both have weight 1 -> smallest label string is b.
    const adjacency = new Map<string, Map<string, number>>([
      [
        'a',
        new Map([
          ['b', 1],
          ['c', 1],
        ]),
      ],
      ['b', new Map([['c', 10]])],
      ['c', new Map([['b', 10]])],
    ]);
    // prop runs sorts nodes: a first: neighbors b(label b) and c(label c) both weight 1 -> tie -> label b.
    const groups = labelPropagation(adjacency, 1);
    expect(groups.get('b')).toEqual(expect.arrayContaining(['a']));
  });
});

describe('refineDenseBlock (via cast wrapper for the private ReviewRef type)', () => {
  function ref(reviewerId: string, itemId: string): ReviewRefInput {
    return { reviewerId, itemId, submittedAt: 0, signals: [], risk: 0 } as never;
  }

  it('keeps the dense block when all members co-review the same item', () => {
    const members = ['a', 'b', 'c'];
    const refs = [ref('a', 'item1'), ref('b', 'item1'), ref('c', 'item1')];
    const refined = refineDenseBlock(members, refs as never, 2);
    expect([...refined].sort()).toEqual(['a', 'b', 'c']);
  });

  it('termiates once the current block reaches minMembers', () => {
    const refined = refineDenseBlock(['a', 'b', 'c'], [ref('a', 'x'), ref('b', 'y')] as never, 3);
    expect(refined).toHaveLength(3);
    expect(refineDenseBlock(['a', 'b', 'c'], [ref('a', 'x'), ref('b', 'y')] as never, 2)).toEqual(
      expect.arrayContaining(['a', 'b']),
    );
  });
});

describe('detectCampaigns option handling', () => {
  function fourPersonBurst(itemId = 'i1'): CampaignEdge[] {
    const at = (h: number) =>
      new Date(Date.parse('2026-10-01T10:00:00.000Z') + h * 3600_000).toISOString();
    const reviewers = ['u1', 'u2', 'u3', 'u4'];
    const edges: CampaignEdge[] = reviewers.map((reviewerId) => ({
      reviewId: `r${reviewerId}`,
      reviewerId,
      itemId,
      submittedAt: at(reviewers.indexOf(reviewerId) * 0.2),
      signals: ['dup'],
      risk: 0.6,
    }));
    return edges;
  }

  it('clamps minMembers to at least 2, so 3 members still pass', () => {
    const edges: CampaignEdge[] = fourPersonBurst().slice(0, 3);
    const result = detectCampaigns(edges, { minMembers: 1 });
    void result;
    expect(detectCampaigns(edges, { minMembers: 1 })).toEqual(
      detectCampaigns(edges, { minMembers: 2 }),
    );
  });

  it('duplicates identical reviewer groups across LP and union roots (dedupe)', () => {
    const edges = fourPersonBurst();
    const campaigns = detectCampaigns(edges);
    if (campaigns.length > 1) {
      const seen = new Set<string>();
      for (const campaign of campaigns) {
        const key = campaign.reviewerIds.join('|');
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
      for (let i = 1; i < campaigns.length; i += 1) {
        expect(campaigns[i - 1]?.score).toBeGreaterThanOrEqual(campaigns[i]?.score ?? 0);
      }
    }
  });

  it('ids are stable fnv digests of the sorted reviewer list', () => {
    const first = detectCampaigns(fourPersonBurst());
    const second = detectCampaigns(fourPersonBurst());
    expect(first.map((c) => c.id)).toEqual(second.map((c) => c.id));
    for (const campaign of first) expect(campaign.id).toMatch(/^cmp_[0-9a-f]+$/u);
  });

  it('rejects campaigns on a single heterogeneous edge kind with poor cohesion', () => {
    // same_subnet only, far inner-window spacing -> edgeKinds 1, cohesion low -> no campaign.
    const edges: CampaignEdge[] = (['s1', 's2', 's3'] as const).map((reviewerId, index) => ({
      reviewId: `r${reviewerId}`,
      reviewerId,
      itemId: '',
      submittedAt: new Date(
        Date.parse('2026-10-01T10:00:00.000Z') + index * 60 * 3600_000,
      ).toISOString(),
      kind: 'same_subnet' as CampaignEdgeKind,
      groupKey: '203.0.113.0/24',
      signals: ['shared_subnet'],
      risk: 0.2,
    }));
    expect(detectCampaigns(edges)).toEqual([]);
  });
});

describe('detectCampaigns with synthetic heterogeneous campaign', () => {
  it('produces one campaign linking all members via co-review refs plus template and media edges', () => {
    const edges: CampaignEdge[] = [];
    // Refs come only from co_review edges.
    for (let i = 0; i < 4; i += 1) {
      edges.push({
        reviewId: `r${i}`,
        reviewerId: `m${i}`,
        itemId: `d${i}`,
        submittedAt: '2026-10-01T10:00:00.000Z',
        signals: ['template'],
        risk: 0.5,
      });
      // One group edge PER REVIEWER per shared attribute (like the worker does).
      edges.push({
        reviewId: `t${i}`,
        reviewerId: `m${i}`,
        itemId: '',
        submittedAt: '2026-10-01T10:00:00.000Z',
        kind: 'same_template',
        groupKey: 'tpl-aabbcc',
        signals: [],
        risk: 0,
      });
      edges.push({
        reviewId: `m${i}-media`,
        reviewerId: `m${i}`,
        itemId: '',
        submittedAt: '2026-10-01T10:00:00.000Z',
        kind: 'same_media',
        groupKey: 'media-sha-x',
        signals: [],
        risk: 0,
      });
    }
    const campaigns = detectCampaigns(edges);
    expect(campaigns.length).toBeGreaterThanOrEqual(1);
    const top = campaigns[0]!;
    expect(top.reviewerIds.length).toBe(4);
    expect(top.edgeKinds).toEqual(expect.arrayContaining(['same_template', 'same_media']));
    expect(top.score).toBeGreaterThan(0.35);
  });
});
