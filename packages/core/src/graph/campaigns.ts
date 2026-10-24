import { fnv1a32 } from '../hash/fnv';
import type { CampaignEdge, CampaignEdgeKind, CampaignOptions, DetectedCampaign } from '../types';

const HOUR_MS = 3_600_000;

const EDGE_KIND_WEIGHTS: Record<CampaignEdgeKind, number> = {
  co_review: 1,
  same_template: 0.8,
  same_media: 0.8,
  same_device: 0.5,
  same_subnet: 0.3,
};

interface ReviewRef {
  reviewerId: string;
  itemId: string;
  submittedAt: number;
  signals: string[];
  risk: number;
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value));
}

class UnionFind {
  private parent = new Map<string, string>();
  private rank = new Map<string, number>();

  find(value: string): string {
    const parent = this.parent.get(value);
    if (parent === undefined) {
      this.parent.set(value, value);
      this.rank.set(value, 0);
      return value;
    }
    if (parent !== value) {
      const root = this.find(parent);
      this.parent.set(value, root);
      return root;
    }
    return value;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;
    const rankA = this.rank.get(rootA) ?? 0;
    const rankB = this.rank.get(rootB) ?? 0;
    if (rankA < rankB) {
      this.parent.set(rootA, rootB);
    } else if (rankA > rankB) {
      this.parent.set(rootB, rootA);
    } else {
      this.parent.set(rootB, rootA);
      this.rank.set(rootA, rankA + 1);
    }
  }

  groups(): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const node of this.parent.keys()) {
      const root = this.find(node);
      const list = groups.get(root) ?? [];
      list.push(node);
      groups.set(root, list);
    }
    return groups;
  }
}

export function labelPropagation(
  adjacency: Map<string, Map<string, number>>,
  iterations = 8,
): Map<string, string[]> {
  const labels = new Map<string, string>();
  for (const node of adjacency.keys()) labels.set(node, node);

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let changed = false;
    const nodes = Array.from(adjacency.keys()).sort();
    for (const node of nodes) {
      const neighbors = adjacency.get(node);
      if (!neighbors || neighbors.size === 0) continue;
      const scores = new Map<string, number>();
      for (const [neighbor, weight] of neighbors) {
        const label = labels.get(neighbor) ?? neighbor;
        scores.set(label, (scores.get(label) ?? 0) + weight);
      }
      let bestLabel = labels.get(node) ?? node;
      let bestScore = -1;
      for (const [label, score] of scores) {
        if (score > bestScore || (score === bestScore && label < bestLabel)) {
          bestLabel = label;
          bestScore = score;
        }
      }
      if (bestLabel !== labels.get(node)) {
        labels.set(node, bestLabel);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const groups = new Map<string, string[]>();
  for (const [node, label] of labels) {
    const list = groups.get(label) ?? [];
    list.push(node);
    groups.set(label, list);
  }
  return groups;
}

/**
 * Greedy dense-block refinement (FRAUDAR-inspired). Removes the reviewer with
 * the lowest weighted contribution to the current block while tracking the
 * densest prefix. Column weighting (1/log(itemDegree+5)) reduces the pull of
 * popular items.
 */
export function refineDenseBlock(
  reviewerIds: string[],
  refs: ReviewRef[],
  minMembers: number,
): string[] {
  const current = new Set(reviewerIds);
  let best = new Set(current);
  let bestDensity = 0;

  const itemsByReviewer = new Map<string, Set<string>>();
  const itemDegree = new Map<string, number>();
  for (const ref of refs) {
    if (!current.has(ref.reviewerId)) continue;
    const set = itemsByReviewer.get(ref.reviewerId) ?? new Set<string>();
    set.add(ref.itemId);
    itemsByReviewer.set(ref.reviewerId, set);
    itemDegree.set(ref.itemId, (itemDegree.get(ref.itemId) ?? 0) + 1);
  }

  while (current.size > minMembers) {
    const items = new Set<string>();
    for (const reviewer of current) {
      for (const item of itemsByReviewer.get(reviewer) ?? []) items.add(item);
    }
    const currentRefs = refs.filter((ref) => current.has(ref.reviewerId)).length;
    const density =
      current.size > 0 && items.size > 0 ? currentRefs / (current.size * items.size) : 0;
    const weightedDensity =
      items.size > 0
        ? Array.from(current).reduce((sum, reviewer) => {
            let weight = 0;
            for (const item of itemsByReviewer.get(reviewer) ?? []) {
              weight += 1 / Math.log((itemDegree.get(item) ?? 1) + 5);
            }
            return sum + weight;
          }, 0) /
          (current.size * items.size)
        : 0;
    const score = weightDensity(weightedDensity, density);
    if (score > bestDensity) {
      bestDensity = score;
      best = new Set(current);
    }

    let weakest: string | null = null;
    let weakestScore = Number.POSITIVE_INFINITY;
    for (const reviewer of current) {
      let weight = 0;
      for (const item of itemsByReviewer.get(reviewer) ?? []) {
        weight += 1 / Math.log((itemDegree.get(item) ?? 1) + 5);
      }
      if (weight < weakestScore) {
        weakestScore = weight;
        weakest = reviewer;
      }
    }
    if (!weakest) break;
    current.delete(weakest);
  }

  return Array.from(best);
}

function weightDensity(weighted: number, raw: number): number {
  return 0.7 * (1 - Math.exp(-weighted * 4)) + 0.3 * raw;
}

export function detectCampaigns(
  edges: CampaignEdge[],
  options: CampaignOptions = {},
): DetectedCampaign[] {
  const windowHours = options.windowHours ?? 48;
  const minMembers = Math.max(2, options.minMembers ?? 3);
  const minDensity = options.minDensity ?? 0.05;
  const maxNodes = options.maxNodes ?? 50_000;

  const refs: ReviewRef[] = [];
  for (const edge of edges.slice(0, maxNodes * 4)) {
    const reviewEdge = edge.kind === undefined || edge.kind === 'co_review';
    if (!reviewEdge) continue;
    const submitted = new Date(edge.submittedAt).getTime();
    if (!Number.isFinite(submitted)) continue;
    refs.push({
      reviewerId: edge.reviewerId,
      itemId: edge.itemId,
      submittedAt: submitted,
      signals: edge.signals ?? [],
      risk: edge.risk ?? 0,
    });
  }

  // Reviewer adjacency (weighted) plus per-pair edge-kind bookkeeping so
  // campaigns can require heterogeneous corroboration (doc 3.2: coordinated
  // rings show up as structural anomalies across relation types).
  const adjacency = new Map<string, Map<string, number>>();
  const pairKinds = new Map<string, Set<CampaignEdgeKind>>();
  const reviewerRefs = new Map<string, ReviewRef[]>();

  const ensure = (reviewerId: string): Map<string, number> => {
    const existing = adjacency.get(reviewerId);
    if (existing) return existing;
    const created = new Map<string, number>();
    adjacency.set(reviewerId, created);
    return created;
  };

  const linkPair = (a: string, b: string, weight: number, kind: CampaignEdgeKind): void => {
    if (a === b) return;
    const aMap = ensure(a);
    const bMap = ensure(b);
    aMap.set(b, Math.max(aMap.get(b) ?? 0, weight));
    bMap.set(a, Math.max(bMap.get(a) ?? 0, weight));
    const pairKey = a < b ? `${a}|${b}` : `${b}|${a}`;
    const kinds = pairKinds.get(pairKey) ?? new Set<CampaignEdgeKind>();
    kinds.add(kind);
    pairKinds.set(pairKey, kinds);
  };

  for (const ref of refs) {
    const list = reviewerRefs.get(ref.reviewerId) ?? [];
    list.push(ref);
    reviewerRefs.set(ref.reviewerId, list);
  }

  // Co-review edges within the temporal window.
  const byItem = new Map<string, ReviewRef[]>();
  for (const ref of refs) {
    const list = byItem.get(ref.itemId) ?? [];
    list.push(ref);
    byItem.set(ref.itemId, list);
  }
  for (const list of byItem.values()) {
    list.sort((a, b) => a.submittedAt - b.submittedAt);
    const limit = Math.min(list.length, 30);
    for (let i = 0; i < limit; i += 1) {
      for (let j = i + 1; j < limit; j += 1) {
        const a = list[i]!;
        const b = list[j]!;
        if (a.reviewerId === b.reviewerId) continue;
        const hours = Math.abs(a.submittedAt - b.submittedAt) / HOUR_MS;
        if (hours > windowHours) break;
        linkPair(a.reviewerId, b.reviewerId, 1 + 1 / (1 + hours), 'co_review');
      }
    }
  }

  // Heterogeneous same-attribute edges (template/media/device/subnet).
  const groups = new Map<string, { kind: CampaignEdgeKind; reviewers: Set<string> }>();
  for (const edge of edges) {
    const kind = edge.kind;
    if (!kind || kind === 'co_review') continue;
    if (!edge.groupKey) continue;
    const submitted = new Date(edge.submittedAt).getTime();
    if (!Number.isFinite(submitted)) continue;
    const key = `${kind}:${edge.groupKey}`;
    const group = groups.get(key) ?? { kind, reviewers: new Set<string>() };
    group.reviewers.add(edge.reviewerId);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    const reviewers = Array.from(group.reviewers).sort().slice(0, 30);
    const weight = EDGE_KIND_WEIGHTS[group.kind];
    for (let i = 0; i < reviewers.length; i += 1) {
      for (let j = i + 1; j < reviewers.length; j += 1) {
        linkPair(reviewers[i]!, reviewers[j]!, weight, group.kind);
      }
    }
  }

  const union = new UnionFind();
  for (const [reviewer, neighbors] of adjacency) {
    for (const [neighbor, weight] of neighbors) {
      if (weight >= 1.2) union.union(reviewer, neighbor);
    }
  }

  const campaignGroups = new Map<string, string[]>();
  for (const [root, members] of union.groups()) {
    if (members.length < minMembers) continue;
    campaignGroups.set(root, members);
  }

  for (const [label, members] of labelPropagation(adjacency)) {
    if (members.length < minMembers) continue;
    const key = `lp:${label}`;
    if (!campaignGroups.has(key)) campaignGroups.set(key, members);
  }

  const campaigns: DetectedCampaign[] = [];

  for (const members of campaignGroups.values()) {
    const memberSet = new Set(members);
    const groupRefs = refs.filter((ref) => memberSet.has(ref.reviewerId));
    const items = new Set(groupRefs.map((ref) => ref.itemId));
    if (items.size === 0) continue;

    const refined = refineDenseBlock(members, groupRefs, minMembers);
    if (refined.length < minMembers) continue;
    const refinedSet = new Set(refined);
    const refinedRefs = groupRefs.filter((ref) => refinedSet.has(ref.reviewerId));
    const refinedItems = new Set(refinedRefs.map((ref) => ref.itemId));

    const density = refinedRefs.length / (refined.length * Math.max(1, refinedItems.size));
    if (density < minDensity) continue;

    const signals = new Set<string>();
    for (const ref of refinedRefs) for (const signal of ref.signals) signals.add(signal);
    const averageRisk =
      refinedRefs.reduce((sum, ref) => sum + ref.risk, 0) / Math.max(1, refinedRefs.length);

    const edgeKinds = new Set<CampaignEdgeKind>();
    for (let i = 0; i < refined.length; i += 1) {
      for (let j = i + 1; j < refined.length; j += 1) {
        const pairKey =
          refined[i]! < refined[j]!
            ? `${refined[i]!}|${refined[j]!}`
            : `${refined[j]!}|${refined[i]!}`;
        const kinds = pairKinds.get(pairKey);
        if (kinds) for (const kind of kinds) edgeKinds.add(kind);
      }
    }

    const timestamps = refinedRefs.map((ref) => ref.submittedAt).sort((a, b) => a - b);
    const spanHours =
      timestamps.length > 1 ? (timestamps[timestamps.length - 1]! - timestamps[0]!) / HOUR_MS : 0;
    const cohesion = clamp(1 - spanHours / (windowHours * 4));

    // A single heterogeneous edge kind (e.g. shared subnet alone) must not
    // create a campaign without temporal cohesion (doc: no NAT punishment).
    if (edgeKinds.size < 2 && cohesion < 0.35) continue;

    const score = clamp(
      0.28 * clamp(density * 3) +
        0.22 * clamp(refined.length / 10) +
        0.18 * cohesion +
        0.12 * clamp(signals.size / 4) +
        0.1 * clamp(averageRisk) +
        0.1 * clamp((edgeKinds.size - 1) / 3),
    );

    if (score < 0.35) continue;

    campaigns.push({
      id: `cmp_${fnv1a32([...refined].sort().join('|')).toString(16)}`,
      reviewerIds: [...refined].sort(),
      itemIds: [...refinedItems].sort(),
      density: Number(density.toFixed(4)),
      score: Number(score.toFixed(4)),
      signalFamilies: [...signals].sort(),
      edgeKinds: Array.from(edgeKinds).sort(),
      reason: `${refined.length} reviewers posted on ${refinedItems.size} shared items within ${windowHours}h; density ${density.toFixed(3)}; edge kinds ${Array.from(edgeKinds).sort().join(', ')}.`,
    });
  }

  return campaigns
    .sort((a, b) => b.score - a.score)
    .filter(
      (campaign, index, list) =>
        list.findIndex(
          (other) =>
            other.reviewerIds.length === campaign.reviewerIds.length &&
            other.reviewerIds.every((id, i) => id === campaign.reviewerIds[i]),
        ) === index,
    )
    .slice(0, 500);
}
