import { describe, expect, it } from 'vitest';
import { selectReviews } from '../src';
import { SELECTION_EXCLUSION_REASONS } from '../src/codes';

const VARIANTS = [
  'Bought this for weekend projects and the torque out of the box is impressive. The carry case is compact.',
  'Setup took about ten minutes and the guide is clear about the torque settings for soft wood.',
  'The battery clicked into place firmly and I finished a whole deck build on one charge.',
  'Lighter than my old drill and the variable trigger gives good control at low speed.',
  'Arrived two days early. The chuck grips small bits cleanly without wobbling at speed.',
  'I used it to assemble cabinets all week; the clutch adjustment stopped cam-out nicely.',
  'Quiet motor compared to my previous machine and the LED light is genuinely useful in corners.',
  'Good balance in hand while drilling overhead, and the belt hook feels sturdy.',
  'Swap between pilot bits quickly thanks to the keyless chuck; no bit drops so far.',
  'The two-speed gearbox helps with bigger spade bits; no bogging at the lowest gear.',
  'Charging took a bit under an hour and the indicator lights are easy to read in the dark.',
  'Nice touch that the case has molded slots for the driver bits sold with the kit.',
];

function review(
  id: string,
  rating: number,
  overrides: Partial<Parameters<typeof selectReviews>[0][number]> = {},
): Parameters<typeof selectReviews>[0][number] {
  return {
    id,
    rating,
    text:
      rating <= 3
        ? `Disappointing experience with item ${id}: the bracket sheared after three uses and the finish chipped.`
        : `${VARIANTS[Number(id.match(/\d+$/u)?.[0] ?? 0) % VARIANTS.length]} ${id}`,
    submittedAt: new Date(Date.parse('2026-10-24T00:00:00Z') - 10 * 86_400_000).toISOString(),
    trustScore: 0.9,
    decision: 'allow',
    helpfulness: 0.6,
    ...overrides,
  };
}

describe('selector critical-review guarantee + exclusions', () => {
  it('keeps a lone 2-star representative visible among many 5-star reviews', () => {
    const result = selectReviews(
      [review('crit-1', 2), ...Array.from({ length: 9 }, (_, index) => review(`good-${index}`, 5))],
      { limit: 10, ensureCritical: true },
    );
    expect(result.reviews.some((item) => Math.round(item.rating) === 2)).toBe(true);
    expect(result.exclusions.every((item) => item.reason.length > 0)).toBe(true);
  });

  it('displaces the weakest positive pick when capacity is full, with a stated reason', () => {
    const positives = Array.from({ length: 12 }, (_, index) => review(`good-${index}`, 5));
    const critical = review('crit-1', 1, {
      trustScore: 0.05,
      submittedAt: new Date(Date.parse('2024-10-24T00:00:00Z')).toISOString(),
    });
    // diversify:false makes the pre-guarantee selection purely score-ordered,
    // so the guarantee must displace to satisfy coverage.
    const result = selectReviews([critical, ...positives], {
      limit: 10,
      ensureCritical: true,
      diversify: false,
    });
    expect(result.reviews.some((item) => Math.round(item.rating) === 1)).toBe(true);
    const displaced = result.exclusions.filter(
      (item) => item.reason === SELECTION_EXCLUSION_REASONS.REPLACED_FOR_CRITICAL_COVERAGE,
    );
    expect(displaced.length).toBe(1);
  });

  it('records duplicate-cluster and capacity exclusions', () => {
    const near = review('dup-b', 4);
    const result = selectReviews(
      [
        review('dup-a', 4, { text: near.text }),
        near,
        ...Array.from({ length: 10 }, (_, index) => review(`good-${index}`, 5)),
      ],
      { limit: 10 },
    );
    const clusterCollapse = result.exclusions.filter(
      (item) => item.reason === SELECTION_EXCLUSION_REASONS.DUPLICATE_CLUSTER,
    );
    expect(clusterCollapse.length).toBeGreaterThanOrEqual(1);
    expect(result.clusters).toBeLessThan(12);
  });

  it('excludes flagged reviews with a stated decision when not included', () => {
    const result = selectReviews([review('flag-1', 5, { decision: 'hold' })], { limit: 10 });
    expect(result.exclusions[0]?.reason).toBe(SELECTION_EXCLUSION_REASONS.FLAGGED_DECISION);
    expect(result.reviews).toHaveLength(0);
  });
});
