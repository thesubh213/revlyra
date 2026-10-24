import type { Detector, DetectorContext, Signal } from '../types';
import { isEnabled, signal } from './helpers';

function run(ctx: DetectorContext): Signal[] {
  if (!isEnabled('semantic', ctx.policy, 'content')) return [];
  const semantic = ctx.analysis.semantic;
  if (!semantic) return [];
  const signals: Signal[] = [];

  if (semantic.paraphraseSimilarity !== undefined && semantic.paraphraseSimilarity >= 0.86) {
    signals.push(
      signal(
        'SEM_PARAPHRASE_CLUSTER',
        'content',
        Math.min(0.7, 0.3 + (semantic.paraphraseSimilarity - 0.8) * 2.5),
        0.65,
        'A semantic model found a close paraphrase of another account’s review.',
        {
          similarity: Number(semantic.paraphraseSimilarity.toFixed(3)),
          neighborId: semantic.paraphraseNeighborId ?? null,
        },
      ),
    );
  }

  if (semantic.llmLikelihood !== undefined && semantic.llmLikelihood >= 0.8) {
    signals.push(
      signal(
        'SEM_LLM_TEXT_LIKELIHOOD',
        'content',
        Math.min(0.35, semantic.llmLikelihood * 0.4),
        0.45,
        'A local classifier estimated a high likelihood of machine-generated text; this is weak and imperfect evidence.',
        { likelihood: Number(semantic.llmLikelihood.toFixed(3)) },
      ),
    );
  }

  return signals;
}

export const semanticDetector: Detector = {
  id: 'semantic',
  version: '1.0.0',
  families: ['content'],
  run,
};
