import type { InjectionHit } from '../types';

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+/giu;
const EMAIL_RE = /\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/giu;
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/gu;
const EMOJI_RE = /\p{Extended_Pictographic}/gu;

const SEGMENTER =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter('und', { granularity: 'word' })
    : null;
const SENTENCE_SEGMENTER =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter('und', { granularity: 'sentence' })
    : null;

export interface MaskedText {
  text: string;
  urlCount: number;
  emailCount: number;
  phoneCount: number;
}

export function maskContacts(input: string): MaskedText {
  let urlCount = 0;
  let emailCount = 0;
  let phoneCount = 0;

  let text = input.replace(URL_RE, () => {
    urlCount += 1;
    return ' [url] ';
  });
  text = text.replace(EMAIL_RE, () => {
    emailCount += 1;
    return ' [email] ';
  });
  text = text.replace(PHONE_RE, (match) => {
    // Avoid treating years and short numeric ranges as phone numbers.
    const digits = match.replace(/\D/gu, '');
    if (digits.length < 9 || digits.length > 16) return match;
    phoneCount += 1;
    return ' [phone] ';
  });

  return { text, urlCount, emailCount, phoneCount };
}

export function collapseWhitespace(input: string): string {
  return input.replace(/\s+/gu, ' ').trim();
}

/**
 * Aggressive normalization used for exact-duplicate fingerprints. It removes
 * punctuation, casing, contact details, and spacing differences so trivial
 * edits do not evade the exact hash.
 */
export function fingerprintText(input: string): string {
  const masked = maskContacts(input).text;
  return collapseWhitespace(
    masked
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim(),
  );
}

/**
 * Light normalization used for near-duplicate features. Keeps punctuation
 * shape (useful for style signals) while removing surface noise.
 */
export function lightNormalize(input: string): string {
  return collapseWhitespace(
    input
      .normalize('NFKC')
      .replace(/[\u2018\u2019]/gu, "'")
      .replace(/[\u201c\u201d]/gu, '"')
      .replace(/[\u2013\u2014]/gu, '-'),
  );
}

export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  if (SEGMENTER) {
    for (const segment of SEGMENTER.segment(input)) {
      if (!segment.isWordLike) continue;
      const token = segment.segment.normalize('NFKC').toLowerCase();
      if (token.length > 0) tokens.push(token);
      if (tokens.length >= 4000) break;
    }
    return tokens;
  }
  const matches =
    input
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? [];
  return matches.slice(0, 4000);
}

export function sentences(input: string): string[] {
  if (SENTENCE_SEGMENTER) {
    return Array.from(SENTENCE_SEGMENTER.segment(input), (s) => s.segment.trim()).filter(Boolean);
  }
  return input
    .split(/(?<=[.!?])\s+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Detect prompt-injection phrases aimed at AI review processors. Hits whose
 * context suggests a quoted transcript (surrounding quote marks) are flagged
 * so severity can be discounted — reviews of AI products legitimately quote
 * prompts in criticism.
 */
export function analyzeInjection(
  text: string,
  patterns: Array<{ code: string; re: RegExp }>,
): InjectionHit[] {
  const hits: InjectionHit[] = [];
  const quotePositions: number[] = [];
  const quoteRegex = /["“”«»‹›]/gu;
  let quoteMatch: RegExpExecArray | null = quoteRegex.exec(text);
  while (quoteMatch !== null) {
    quotePositions.push(quoteMatch.index);
    quoteMatch = quoteRegex.exec(text);
  }

  for (const pattern of patterns) {
    const re = new RegExp(pattern.re.source, pattern.re.flags);
    let match: RegExpExecArray | null = re.exec(text);
    while (match !== null) {
      const start = match.index;
      const end = match.index + match[0].length;
      let opens = 0;
      for (const position of quotePositions) {
        if (position > start) break;
        opens += 1;
      }
      hits.push({ code: pattern.code, start, end, quoted: opens % 2 === 1 });
      if (match[0].length === 0) break;
      match = re.exec(text);
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}

/**
 * Replace injection phrase spans with a neutral marker so the text handed to
 * semantic classifiers, embeddings, or LLM enrichment cannot carry injected
 * instructions. Non-hit text is unchanged.
 */
export function sanitizeForModel(
  text: string,
  hits: InjectionHit[],
  marker = '[sanitized]',
): { text: string; replaced: number } {
  if (hits.length === 0) return { text, replaced: 0 };
  let output = '';
  let cursor = 0;
  let replaced = 0;
  for (const hit of hits) {
    if (hit.start < cursor) continue;
    output += text.slice(cursor, hit.start);
    output += marker;
    cursor = hit.end;
    replaced += 1;
  }
  output += text.slice(cursor);
  return { text: output, replaced };
}

export function wordNgrams(tokens: string[], n: number, limit = 800): string[] {
  if (tokens.length < n) return [];
  const out: string[] = [];
  for (let i = 0; i <= tokens.length - n && out.length < limit; i += 1) {
    out.push(tokens.slice(i, i + n).join(' '));
  }
  return out;
}

export function charNgrams(text: string, n: number, limit = 800): string[] {
  const compact = text.replace(/\s+/gu, ' ').toLowerCase();
  if (compact.length < n) return [];
  const out: string[] = [];
  for (let i = 0; i <= compact.length - n && out.length < limit; i += 1) {
    out.push(compact.slice(i, i + n));
  }
  return out;
}

export function countEmoji(input: string): number {
  return (input.match(EMOJI_RE) ?? []).length;
}

export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  let intersection = 0;
  for (const value of setA) {
    if (setB.has(value)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function shingles(tokens: string[], n = 5, limit = 600): string[] {
  return wordNgrams(tokens, n, limit);
}

export function sentencesLengthVariance(sentenceList: string[]): number {
  if (sentenceList.length < 2) return 0;
  const lengths = sentenceList.map((s) => tokenize(s).length);
  const mean = lengths.reduce((sum, v) => sum + v, 0) / lengths.length;
  if (mean === 0) return 0;
  const variance = lengths.reduce((sum, v) => sum + (v - mean) ** 2, 0) / lengths.length;
  return Math.sqrt(variance) / mean;
}
