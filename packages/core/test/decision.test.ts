import { describe, expect, it } from 'vitest';
import { decide, getPolicyPreset, riskBand } from '../src';
import { balancedPreset } from './helpers-policy';

const policy = balancedPreset();
// thresholds: label 0.3, downrank 0.55, hold 0.75, escalate 0.85, remove 0.95

describe('decide (threshold boundary semantics: >= each threshold)', () => {
  it('allows scores below the label threshold', () => {
    expect(decide(0, 1, policy)).toBe('allow');
    expect(decide(0.2999, 1, policy)).toBe('allow');
  });

  it('labels exactly at the label threshold, downranks at downrank', () => {
    expect(decide(0.3, 1, policy)).toBe('label');
    expect(decide(0.55, 1, policy)).toBe('downrank');
    expect(decide(0.6, 1, policy)).toBe('downrank');
  });

  it('holds and escalates at the respective boundaries', () => {
    expect(decide(0.75, 1, policy)).toBe('hold');
    expect(decide(0.85, 1, policy)).toBe('escalate');
  });

  it('maps removal to escalation unless autoRemove is allowed with confidence', () => {
    expect(decide(0.95, 1, policy)).toBe('escalate'); // autoRemove false
    expect(decide(0.999, 1, policy)).toBe('escalate');
    const auto = { ...policy, autoRemove: true, minConfidenceForRemove: 0.6 };
    expect(decide(0.95, 0.59, auto)).toBe('escalate');
    expect(decide(0.95, 0.6, auto)).toBe('remove');
    expect(decide(0.99, 1, auto)).toBe('remove');
  });

  it('respects a custom policy threshold order', () => {
    const strict = getPolicyPreset('strict');
    // strict: label 0.2, downrank 0.4, hold 0.6, escalate 0.72, remove 0.9
    expect(decide(0.5, 1, strict)).toBe('downrank');
    expect(decide(0.6, 1, strict)).toBe('hold');
    expect(decide(0.3, 1, strict)).toBe('label');
    expect(decide(0.4, 1, strict)).toBe('downrank');
    expect(decide(0.2, 1, strict)).toBe('label');
    expect(decide(0.19, 1, strict)).toBe('allow');
  });
});

describe('riskBand', () => {
  it('maps scores to bands by escalate/hold/label thresholds', () => {
    expect(riskBand(0, policy)).toBe('low');
    expect(riskBand(0.29, policy)).toBe('low');
    expect(riskBand(0.3, policy)).toBe('medium');
    expect(riskBand(0.55, policy)).toBe('medium');
    expect(riskBand(0.74, policy)).toBe('medium');
    expect(riskBand(0.75, policy)).toBe('high');
    expect(riskBand(0.85, policy)).toBe('critical');
    expect(riskBand(0.99, policy)).toBe('critical');
  });

  it('treats downrank as medium alongside label', () => {
    expect(riskBand(0.6, policy)).toBe('medium');
  });

  it('works for other presets', () => {
    const lenient = getPolicyPreset('lenient');
    expect(riskBand(0.45, lenient)).toBe('medium'); // label 0.4, hold 0.82
    expect(riskBand(0.82, lenient)).toBe('high');
    expect(riskBand(0.9, lenient)).toBe('critical');
  });
});
