import { detectScript } from './unicode';

const STOPWORDS: Record<string, string[]> = {
  en: [
    'the',
    'and',
    'is',
    'it',
    'this',
    'that',
    'was',
    'are',
    'with',
    'for',
    'have',
    'not',
    'but',
    'you',
    'my',
    'very',
    'product',
    'review',
    'good',
    'bad',
  ],
  es: [
    'el',
    'la',
    'los',
    'las',
    'de',
    'que',
    'y',
    'en',
    'un',
    'una',
    'es',
    'por',
    'con',
    'muy',
    'pero',
    'me',
    'mi',
    'producto',
  ],
  fr: [
    'le',
    'la',
    'les',
    'de',
    'des',
    'et',
    'est',
    'un',
    'une',
    'en',
    'que',
    'pour',
    'avec',
    'très',
    'mais',
    'je',
    'mon',
    'produit',
  ],
  de: [
    'der',
    'die',
    'das',
    'und',
    'ist',
    'ein',
    'eine',
    'mit',
    'für',
    'sehr',
    'aber',
    'ich',
    'mein',
    'nicht',
    'auf',
    'produkt',
  ],
  pt: [
    'o',
    'a',
    'os',
    'as',
    'de',
    'que',
    'e',
    'em',
    'um',
    'uma',
    'é',
    'por',
    'com',
    'muito',
    'mas',
    'eu',
    'meu',
    'produto',
  ],
  it: [
    'il',
    'la',
    'gli',
    'le',
    'di',
    'che',
    'e',
    'in',
    'un',
    'una',
    'è',
    'per',
    'con',
    'molto',
    'ma',
    'io',
    'mio',
    'prodotto',
  ],
  nl: [
    'de',
    'het',
    'een',
    'en',
    'is',
    'van',
    'dat',
    'voor',
    'met',
    'zeer',
    'maar',
    'ik',
    'mijn',
    'niet',
    'product',
  ],
  tr: ['bir', 've', 'bu', 'için', 'ile', 'çok', 'ama', 'ben', 'benim', 'değil', 'gibi', 'ürün'],
  id: [
    'yang',
    'dan',
    'ini',
    'itu',
    'untuk',
    'dengan',
    'sangat',
    'tetapi',
    'saya',
    'tidak',
    'produk',
  ],
  vi: ['và', 'là', 'của', 'cho', 'với', 'rất', 'nhưng', 'tôi', 'không', 'một', 'sản', 'phẩm'],
  pl: ['i', 'jest', 'to', 'nie', 'że', 'na', 'z', 'do', 'bardzo', 'ale', 'mój', 'produkt'],
  ru: ['и', 'в', 'не', 'на', 'что', 'это', 'с', 'как', 'очень', 'но', 'мой', 'товар'],
};

const STOPWORD_SETS = new Map(
  Object.entries(STOPWORDS).map(([code, words]) => [code, new Set(words)]),
);

const SCRIPT_LANGUAGE: Record<string, string> = {
  Han: 'zh',
  Hiragana: 'ja',
  Katakana: 'ja',
  Hangul: 'ko',
  Arabic: 'ar',
  Hebrew: 'he',
  Cyrillic: 'ru',
  Devanagari: 'hi',
  Thai: 'th',
  Bengali: 'bn',
  Tamil: 'ta',
  Telugu: 'te',
};

export interface LanguageDetection {
  code: string;
  confidence: number;
}

export function detectLanguage(tokens: string[], fallbackText = ''): LanguageDetection {
  if (tokens.length === 0) {
    const script = detectScript(fallbackText);
    return { code: SCRIPT_LANGUAGE[script] ?? 'und', confidence: 0.2 };
  }

  const sample = tokens.slice(0, 400);
  let bestCode = 'und';
  let bestHits = 0;

  for (const [code, words] of STOPWORD_SETS) {
    let hits = 0;
    for (const token of sample) {
      if (words.has(token)) hits += 1;
    }
    if (hits > bestHits) {
      bestHits = hits;
      bestCode = code;
    }
  }

  const ratio = bestHits / sample.length;
  if (bestCode !== 'und' && ratio >= 0.02) {
    return { code: bestCode, confidence: Math.min(0.99, 0.35 + ratio * 4) };
  }

  const script = detectScript(fallbackText);
  const scriptCode = SCRIPT_LANGUAGE[script];
  if (scriptCode) {
    return { code: scriptCode, confidence: 0.45 };
  }
  if (script === 'Latin') {
    return { code: 'en', confidence: 0.15 };
  }
  return { code: 'und', confidence: 0.1 };
}
