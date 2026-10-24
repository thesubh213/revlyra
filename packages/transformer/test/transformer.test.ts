import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cosineSimilarity, createTransformer } from '../src';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'revlyra-transformer-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('transformer tier', () => {
  it('computes cosine similarity', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
  });

  it('returns no semantic hints when disabled and there are no neighbors', async () => {
    const tier = createTransformer({
      modelDir: tempDir(),
      allowDownload: false,
      offline: true,
    });
    const hints = await tier.analyze('This is a review.');
    expect(hints).toEqual({});
    const status = await tier.status();
    expect(status.embeddingModel).toContain('MiniLM');
    expect(status.classifierModel).toBeNull();
  });

  it('requires explicit download consent before loading a model', async () => {
    const tier = createTransformer({
      modelDir: tempDir(),
      allowDownload: false,
      offline: true,
    });
    await expect(tier.embed('hello')).rejects.toBeTruthy();
    await tier.dispose();
  });
});
