import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SemanticHints } from '@revlyra/core';

type TransformersModule = {
  pipeline: (task: string, model: string, options?: Record<string, unknown>) => Promise<unknown>;
  env: {
    cacheDir?: string;
    allowRemoteModels?: boolean;
    allowLocalModels?: boolean;
  };
};

export interface TransformerOptions {
  /** Directory used by transformers.js for downloaded model files. */
  modelDir?: string;
  /** Allow downloading models from Hugging Face on first use. */
  allowDownload?: boolean;
  /** Require cached/local models only. */
  offline?: boolean;
  embeddingModel?: string;
  /** Optional text-classification model that outputs fake/spam likelihood. */
  classifierModel?: string;
  dtype?: 'q8' | 'fp32' | 'fp16';
  device?: 'cpu' | 'webgpu';
}

export interface ClassifierOutput {
  fakeProbability: number;
  labels: Array<{ label: string; score: number }>;
}

export interface TransformerStatus {
  available: boolean;
  embeddingLoaded: boolean;
  classifierLoaded: boolean;
  embeddingModel: string;
  classifierModel: string | null;
  modelDir: string;
  error?: string;
}

const DEFAULT_EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

function resolveModelDir(options: TransformerOptions): string {
  return options.modelDir ?? join(homedir(), '.cache', 'revlyra', 'models');
}

function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export class TransformerTier {
  private readonly options: Required<
    Pick<TransformerOptions, 'allowDownload' | 'offline' | 'dtype' | 'device'>
  > &
    TransformerOptions;
  private readonly modelDir: string;
  private modulePromise: Promise<TransformersModule> | null = null;
  private embeddingPipeline: Promise<unknown> | null = null;
  private classifierPipeline: Promise<unknown> | null = null;
  private lastError: string | undefined;

  constructor(options: TransformerOptions = {}) {
    this.options = {
      ...options,
      allowDownload: options.allowDownload ?? false,
      offline: options.offline ?? false,
      dtype: options.dtype ?? 'q8',
      device: options.device ?? 'cpu',
    };
    this.modelDir = resolveModelDir(options);
    mkdirSync(this.modelDir, { recursive: true });
  }

  get embeddingModel(): string {
    return this.options.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
  }

  get classifierModel(): string | null {
    return this.options.classifierModel ?? null;
  }

  private async loadModule(): Promise<TransformersModule> {
    if (!this.modulePromise) {
      this.modulePromise = import('@huggingface/transformers' as string).then((module) => {
        const transformers = module as unknown as TransformersModule;
        transformers.env.cacheDir = this.modelDir;
        transformers.env.allowRemoteModels = !this.options.offline && this.options.allowDownload;
        transformers.env.allowLocalModels = true;
        return transformers;
      });
    }
    return this.modulePromise;
  }

  private async loadEmbedding(): Promise<unknown> {
    if (!this.embeddingPipeline) {
      this.embeddingPipeline = (async () => {
        const transformers = await this.loadModule();
        return transformers.pipeline('feature-extraction', this.embeddingModel, {
          dtype: this.options.dtype,
          device: this.options.device,
        });
      })().catch((error) => {
        this.lastError = String((error as Error).message ?? error);
        this.embeddingPipeline = null;
        throw error;
      });
    }
    return this.embeddingPipeline;
  }

  private async loadClassifier(): Promise<unknown> {
    const classifierModel = this.classifierModel;
    if (!classifierModel) throw new Error('CLASSIFIER_MODEL_NOT_CONFIGURED');
    if (!this.classifierPipeline) {
      this.classifierPipeline = (async () => {
        const transformers = await this.loadModule();
        return transformers.pipeline('text-classification', classifierModel, {
          dtype: this.options.dtype,
          device: this.options.device,
        });
      })().catch((error) => {
        this.lastError = String((error as Error).message ?? error);
        this.classifierPipeline = null;
        throw error;
      });
    }
    return this.classifierPipeline;
  }

  async embed(text: string): Promise<number[]> {
    const extractor = (await this.loadEmbedding()) as (
      input: string,
      options: Record<string, unknown>,
    ) => Promise<{ data?: ArrayLike<number> } | ArrayLike<number>>;
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    const data =
      output && typeof output === 'object' && 'data' in output
        ? (output as { data: ArrayLike<number> }).data
        : (output as ArrayLike<number>);
    return Array.from(data, (value) => Number(value));
  }

  async classify(text: string): Promise<ClassifierOutput> {
    const classifier = (await this.loadClassifier()) as (
      input: string,
      options: Record<string, unknown>,
    ) => Promise<
      | Array<{ label: string; score: number }>
      | Array<Array<{ label: string; score: number }>>
      | { label: string; score: number }
    >;
    const raw = await classifier(text, { topk: null });
    const flat = (Array.isArray(raw) && Array.isArray(raw[0]) ? raw[0] : raw) as
      | Array<{ label: string; score: number }>
      | { label: string; score: number };
    const labels = (Array.isArray(flat) ? flat : [flat]).map((entry) => ({
      label: String(entry.label),
      score: Number(entry.score),
    }));
    const fakeLabel = labels.find((entry) =>
      /fake|spam|deceptive|computer|generated|cg\b/iu.test(entry.label),
    );
    if (fakeLabel) return { fakeProbability: fakeLabel.score, labels };
    const realLabel = labels.find((entry) =>
      /real|human|genuine|authentic|or\b/iu.test(entry.label),
    );
    if (realLabel) return { fakeProbability: 1 - realLabel.score, labels };
    return { fakeProbability: labels[0]?.score ?? 0, labels };
  }

  async analyze(
    text: string,
    neighbors: Array<{ id: string; text: string }> = [],
  ): Promise<SemanticHints> {
    const hints: SemanticHints = {};

    if (this.classifierModel) {
      try {
        const result = await this.classify(text);
        hints.llmLikelihood = Math.min(1, Math.max(0, result.fakeProbability));
      } catch (error) {
        this.lastError = String((error as Error).message ?? error);
      }
    }

    if (neighbors.length > 0) {
      try {
        const vector = await this.embed(text);
        let bestSimilarity = 0;
        let bestId: string | undefined;
        for (const neighbor of neighbors.slice(0, 10)) {
          const other = await this.embed(neighbor.text);
          const similarity = cosineSimilarity(vector, other);
          if (similarity > bestSimilarity) {
            bestSimilarity = similarity;
            bestId = neighbor.id;
          }
        }
        if (bestSimilarity > 0) {
          hints.paraphraseSimilarity = Math.min(1, Math.max(0, bestSimilarity));
          if (bestId) hints.paraphraseNeighborId = bestId;
        }
      } catch (error) {
        this.lastError = String((error as Error).message ?? error);
      }
    }

    return hints;
  }

  async warmup(): Promise<void> {
    try {
      await this.embed('warmup');
      if (this.classifierModel) await this.classify('warmup');
    } catch (error) {
      this.lastError = String((error as Error).message ?? error);
      throw error;
    }
  }

  async status(): Promise<TransformerStatus> {
    const modelsAvailable = existsSync(this.modelDir);
    return {
      available: modelsAvailable && this.lastError === undefined,
      embeddingLoaded: this.embeddingPipeline !== null,
      classifierLoaded: this.classifierPipeline !== null,
      embeddingModel: this.embeddingModel,
      classifierModel: this.classifierModel,
      modelDir: this.modelDir,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  async dispose(): Promise<void> {
    this.embeddingPipeline = null;
    this.classifierPipeline = null;
    this.modulePromise = null;
  }
}

export function createTransformer(options: TransformerOptions = {}): TransformerTier {
  return new TransformerTier(options);
}

export { cosineSimilarity };
