import { describe, expect, it } from 'vitest';
import { analyzeReview, getPolicyPreset } from '../src';

const TRAUMA_REVIEW = {
  itemId: 'resort-1',
  reviewerId: 'traveler-9',
  rating: 1,
  text: 'I was DRUGGED at the swim-up bar and blacked out. The hotel staff refused to call the police and I was assaulted on the way back to my room. I filed a police report the next morning. This needs a safety warning.',
  submittedAt: '2026-10-20T10:00:00Z',
};

const BENIGN_REVIEW = {
  itemId: 'resort-1',
  reviewerId: 'happy-guest',
  rating: 5,
  text: 'Beautiful property, spacious rooms, and the pool bar staff were amazing. We felt safe and welcomed the whole week and I loved the location near the beach.',
  submittedAt: '2026-10-20T10:00:00Z',
};

describe('safety-review routing (doc 2.2/5.1)', () => {
  it('emits SAFETY_REVIEW for incident language and routes to the human channel', () => {
    const result = analyzeReview(TRAUMA_REVIEW, {}, { now: '2026-10-25T00:00:00Z' });
    const safety = result.signals.find((signal) => signal.code === 'SAFETY_REVIEW');
    expect(safety).toBeTruthy();
    expect(result.safety?.routed).toBe(true);
    expect(result.safety?.categories.length).toBeGreaterThan(0);
    expect(['hold', 'escalate']).toContain(result.decision);
    // Auto-removal must never happen for routed safety reviews.
    expect(result.decision).not.toBe('remove');
  });

  it('does not inflate the risk score through routing', () => {
    const routed = analyzeReview(TRAUMA_REVIEW, {}, { now: '2026-10-25T00:00:00Z' });
    // The score must stay well below hold for a contextless review — escalation
    // comes from the routing rule, not score inflation.
    expect(routed.score).toBeLessThan(0.75);
  });

  it('suppresses style signals that would otherwise punish trauma prose', () => {
    const withSafety = analyzeReview(TRAUMA_REVIEW, {}, { now: '2026-10-25T00:00:00Z' });
    const generic = withSafety.signals.find((signal) => signal.code === 'TEXT_GENERIC');
    const noSomethings = withSafety.signals.find((signal) => signal.code === 'TEXT_NO_SPECIFICS');
    if (generic) {
      expect(generic.severity).toBeLessThan(0.2);
      expect(generic.evidence.styleSuppressed).toBe(true);
    }
    if (noSomethings) {
      expect(noSomethings.evidence.styleSuppressed).toBe(true);
    }
  });

  it('does not route benign reviews', () => {
    const result = analyzeReview(BENIGN_REVIEW, {}, { now: '2026-10-25T00:00:00Z' });
    expect(result.signals.some((signal) => signal.code === 'SAFETY_REVIEW')).toBe(false);
    expect(result.safety?.routed ?? false).toBe(false);
  });

  it('can be disabled by policy', () => {
    const policy = getPolicyPreset('balanced');
    policy.safety = { enabled: false, styleSuppression: false };
    const result = analyzeReview(TRAUMA_REVIEW, {}, { now: '2026-10-25T00:00:00Z', policy });
    expect(result.safety?.routed ?? false).toBe(false);
  });
});
