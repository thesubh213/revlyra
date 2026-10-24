import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const transformersEnv = { cacheDir: '', allowRemoteModels: false, allowLocalModels: true };
const pipelineState = {
  calls: [] as Array<{ task: string; model: string; options?: Record<string, unknown> }>,
  response: ((..._args: unknown[]) => ({ data: [1, 0, 0] })) as unknown,
};

vi.mock('@huggingface/transformers', () => ({
  pipeline: async (task: string, model: string, options?: Record<string, unknown>) => {
    pipelineState.calls.push({ task, model, options });
    return pipelineState.response;
  },
  env: transformersEnv,
}));

const { TransformerTier, createTransformer } = await import('../src/index');

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'revlyra-transformer-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  pipelineState.calls.length = 0;
  pipelineState.response = ((..._args: unknown[]) => ({ data: [1, 0, 0] })) as unknown;
});

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

describe('transformer env-gating', () => {
  it('locks remote models off without download consent', async () => {
    const tier = new TransformerTier({ modelDir: tempDir(), embeddingModel: 'm1' });
    await tier.embed('hello');
    expect(pipelineState.calls).toHaveLength(1);
    expect(transformersEnv.allowRemoteModels).toBe(false);
    expect(transformersEnv.allowLocalModels).toBe(true);
    expect(transformersEnv.cacheDir.startsWith(tempDirPrefix())).toBe(true);
  });

  it('unlocks remote models only with allowDownload && !offline', async () => {
    for (const [allowDownload, offline, expected] of [
      [true, false, true],
      [true, true, false],
      [false, false, false],
      [false, true, false],
    ] as Array<[boolean, boolean, boolean]>) {
      const tier = new TransformerTier({
        modelDir: tempDir(),
        embeddingModel: 'm1',
        allowDownload,
        offline,
      });
      await tier.embed('hello');
      expect(transformersEnv.allowRemoteModels).toBe(expected);
    }
  });

  it('forwards dtype and device to the pipeline call', async () => {
    const tier = new TransformerTier({
      modelDir: tempDir(),
      embeddingModel: 'custom-embed',
      dtype: 'fp32',
      device: 'webgpu',
    });
    await tier.embed('x');
    expect(pipelineState.calls[0]).toMatchObject({
      task: 'feature-extraction',
      model: 'custom-embed',
      options: { dtype: 'fp32', device: 'webgpu' },
    });
  });
});

function tempDirPrefix(): string {
  return join(tmpdir(), 'revlyra-transformer-');
}

describe('transformer pipelines', () => {
  it('memoizes the pipeline and reloads after dispose', async () => {
    const tier = createTransformer({ modelDir: tempDir(), embeddingModel: 'm2' });
    await tier.embed('a');
    await tier.embed('b');
    expect(pipelineState.calls).toHaveLength(1);
    await tier.dispose();
    await tier.embed('c');
    expect(pipelineState.calls).toHaveLength(2);
  });

  it('supports tensor {data} and bare-array outputs', async () => {
    const tier = createTransformer({ modelDir: tempDir(), embeddingModel: 'm3' });
    expect(await tier.embed('x')).toEqual([1, 0, 0]);
    pipelineState.response = (..._args: unknown[]) => [0.5, 0.5, 0];
    await tier.dispose();
    expect(await tier.embed('y')).toEqual([0.5, 0.5, 0]);
  });

  it('classifies fake/real/generic labels and nested arrays', async () => {
    const tier = createTransformer({
      modelDir: tempDir(),
      embeddingModel: 'm4',
      classifierModel: 'cls-x',
    });
    pipelineState.response = async () => [{ label: 'fake', score: 0.42 }] as never;
    expect((await tier.classify('text')).fakeProbability).toBe(0.42);

    await tier.dispose();
    pipelineState.response = async () => [{ label: 'real', score: 0.3 }] as never;
    expect((await tier.classify('text')).fakeProbability).toBeCloseTo(0.7, 10);

    await tier.dispose();
    pipelineState.response = async () => [[{ label: 'computer_generated', score: 0.9 }]] as never;
    expect((await tier.classify('text')).fakeProbability).toBe(0.9);
  });
});
