import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BASELINE_MODEL,
  getPolicyPreset,
  isPolicyPreset,
  type ModelArtifact,
  type Policy,
  validatePolicy,
} from '@revlyra/core';
import type { RevlyraConfig } from '../config';

export function loadPolicy(config: RevlyraConfig): Policy {
  const value = config.detection.policy;
  if (isPolicyPreset(value)) return getPolicyPreset(value);
  const path = resolve(config.cwd, value);
  if (!existsSync(path)) {
    throw new Error(`Policy not found: ${value}`);
  }
  return validatePolicy(JSON.parse(readFileSync(path, 'utf8')));
}

export function loadModel(config: RevlyraConfig): ModelArtifact {
  if (!config.detection.modelPath) return BASELINE_MODEL;
  const path = resolve(config.cwd, config.detection.modelPath);
  if (!existsSync(path)) throw new Error(`Model not found: ${path}`);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as ModelArtifact;
  if (!parsed.version || typeof parsed.intercept !== 'number' || !parsed.weights) {
    throw new Error(`Invalid model artifact: ${path}`);
  }
  return parsed;
}
