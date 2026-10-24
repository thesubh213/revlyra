import { describe, expect, it } from 'vitest';
import {
  detectScript,
  hasBidiControls,
  hasMixedScripts,
  isMostlyLatin,
  normalizeUnicode,
  stripInvisible,
} from '../src';

describe('stripInvisible', () => {
  it('removes zero-width characters and counts them', () => {
    const input = 'hidden\u200b\u200bfine\u00adtext\ufeff';
    const result = stripInvisible(input);
    expect(result.removed).toBe(4);
    expect(result.text).toBe('hiddenfinetext');
  });

  it('removes control characters separately', () => {
    const result = stripInvisible('a\u0000b\u0007c\u007fd');
    expect(result.removed).toBe(3);
    expect(result.text).toBe('abcd');
  });

  it('counts unicode bidi controls (they are also zero-width)', () => {
    const result = stripInvisible('ok\u202a\u2062');
    expect(result.removed).toBe(2);
  });

  it('returns the input unchanged (removed 0) for plain text', () => {
    const result = stripInvisible('plain text with punctuation!?,');
    expect(result).toEqual({ text: 'plain text with punctuation!?,', removed: 0 });
  });

  it('handles the empty string', () => {
    expect(stripInvisible('')).toEqual({ text: '', removed: 0 });
  });
});

describe('detectScript', () => {
  it('identifies the single dominant scripts', () => {
    expect(detectScript('This is plain English text')).toBe('Latin');
    expect(detectScript('Отличный товар полностью')).toBe('Cyrillic');
    expect(detectScript(' happiness')).toBe('Latin');
    expect(detectScript('ผลิตภัณฑ์ดีมาก')).toBe('Thai');
    expect(detectScript('سلام عليكم')).toBe('Arabic');
    expect(detectScript('שלום עליכם')).toBe('Hebrew');
    // 6 hiragana (のはいですか) outnumber 5 han (商品品質良) -> Hiragana wins.
    expect(detectScript('商品の品質は良いですか')).toBe('Hiragana');
    expect(detectScript('拼多多拼多多評価')).toBe('Han');
    expect(detectScript('नमस्ते दोस्तों')).toBe('Devanagari');
    expect(detectScript('অসমীয়া তে রিভিউ')).toBe('Bengali');
    expect(detectScript('அருமையான தயாரிப்பு')).toBe('Tamil');
    expect(detectScript('ఇది మంచి ఉత్పత్తి')).toBe('Telugu');
  });

  it('identifies Japanese scripts and kana', () => {
    expect(detectScript('ブランド品')).toBe('Katakana');
    expect(detectScript('ありがとう')).toBe('Hiragana');
  });

  it('identifies Hangul and Greek', () => {
    expect(detectScript('아주 좋아요')).toBe('Hangul');
    expect(detectScript('Εξαιρετικό προϊόν')).toBe('Greek');
  });

  it('returns Unknown for text without script letters', () => {
    expect(detectScript('12345 !!! !!! ()')).toBe('Unknown');
  });

  it('returns Unknown for empty input', () => {
    expect(detectScript('')).toBe('Unknown');
  });

  it('picks the most frequent script when mixed, preserving the first lead on ties', () => {
    // 15 Latin vs 15 Cyrillic -> the earlier-inserted Latin wins the tie.
    expect(detectScript('hello везде везде везде everywhere')).toBe('Latin');
    // 20 Cyrillic vs 15 Latin -> Cyrillic wins outright.
    expect(detectScript('hello везде везде везде везде everywhere')).toBe('Cyrillic');
  });
});

describe('isMostlyLatin', () => {
  it('is true when Latin letters meet or exceed all other letters', () => {
    expect(isMostlyLatin('Hello world')).toBe(true);
    expect(isMostlyLatin('')).toBe(false);
    expect(isMostlyLatin('123 !!')).toBe(false);
  });

  it('is false when Latin letters are a minority', () => {
    expect(isMostlyLatin('好的好的好的 fine')).toBe(false);
  });

  it('is false when there are no Latin letters at all', () => {
    expect(isMostlyLatin('好的好的')).toBe(false);
    expect(isMostlyLatin('Отлично!')).toBe(false);
  });

  it('counts other scripts including accented-neighbor letters', () => {
    expect(isMostlyLatin('café')).toBe(true);
    expect(isMostlyLatin('café 好的好的好的好的好的')).toBe(false);
  });
});

describe('hasBidiControls', () => {
  it('detects bidi embedding controls', () => {
    expect(hasBidiControls('\u202Aoverride')).toBe(true);
    expect(hasBidiControls('just text')).toBe(false);
    expect(hasBidiControls('')).toBe(false);
  });

  for (const ch of [
    '\u202b',
    '\u202c',
    '\u202d',
    '\u202e',
    '\u2066',
    '\u2067',
    '\u2068',
    '\u2069',
  ]) {
    it(`matches \\u${ch.charCodeAt(0).toString(16)}`, () => {
      expect(hasBidiControls(`a${ch}b`)).toBe(true);
    });
  }
});

describe('hasMixedScripts', () => {
  it('is true when two scripts appear among letters', () => {
    expect(hasMixedScripts('passwordВ')).toBe(true);
    expect(hasMixedScripts('hello Καλημέρα')).toBe(true);
  });

  it('is false for single-script text', () => {
    expect(hasMixedScripts('all english')).toBe(false);
    expect(hasMixedScripts('Отличный товар')).toBe(false);
    expect(hasMixedScripts('Εξαιρετικό προϊόν')).toBe(false);
  });

  it('ignores digits, punctuation, and emoji', () => {
    expect(hasMixedScripts('1234 🎉 ok!!!')).toBe(false);
    expect(hasMixedScripts('')).toBe(false);
  });
});

describe('normalizeUnicode', () => {
  it('NFKC-folds fullwidth characters and counts them on the original', () => {
    const result = normalizeUnicode('Ｔｅｓｔ！ １２３');
    expect(result.fullWidthChars).toBe(8);
    expect(result.text).toBe('Test! 123');
  });

  it('strips zero-width characters and reports the count', () => {
    const result = normalizeUnicode('sm\u200bal\u200c text');
    expect(result.zeroWidthRemoved).toBe(2);
    expect(result.text).not.toContain('\u200b');
  });

  it('maps Cyrillic homoglyphs inside Latin words but not inside pure Cyrillic text', () => {
    const sneaky = normalizeUnicode('іnvoice supеr');
    expect(sneaky.homoglyphsMapped).toBe(2);
    expect(sneaky.text).toBe('invoice super');

    const legit = normalizeUnicode('Отличный товар!');
    expect(legit.homoglyphsMapped).toBe(0);
    expect(legit.text).toBe('Отличный товар!');
    expect(legit.script).toBe('Cyrillic');
  });

  it('counts mixed-script tokens but never counts emoji or symbols', () => {
    const result = normalizeUnicode('passwordВ oguncathan');
    // Only "password" + Cyrillic В is one mixed token.
    expect(result.mixedScriptTokens).toBe(1);
    const emojiOnly = normalizeUnicode('🎉 Супер товар 🎉');
    expect(emojiOnly.mixedScriptTokens).toBe(0);
    expect(emojiOnly.homoglyphsMapped).toBe(0);
  });

  it('maps homoglyph-only tokens in latin-dominant documents (confusability gate)', () => {
    // "всегда": В С Е А are lookalikes (4/6 letters >= 0.6) and the sentence
    // is latin-dominant, so the whole token passes the confusability gate and
    // each mapped character is counted.
    const result = normalizeUnicode('the всегда venue');
    expect(result.homoglyphsMapped).toBe(4);
    // The Cyrillic а (U+0430) at the end maps to Latin 'a'.
    expect(result.text).toBe('the bceгдa venue');
    const fully = normalizeUnicode('pay Via PayPal using ВСЕ микро');
    // "ВСЕ" flips entirely; "микро" is 4/5 lookalike (и is not in the map).
    expect(fully.homoglyphsMapped).toBe(7);
    expect(fully.text).toBe('pay Via PayPal using BCE mиkpo');
  });

  it('does not treat digits/punctuation as mixed scripts', () => {
    const result = normalizeUnicode('golden 1234!!!');
    expect(result.mixedScriptTokens).toBe(0);
  });

  it('reports the script of stripped text', () => {
    const result = normalizeUnicode('\u200b totally fine');
    expect(result.script).toBe('Latin');
  });
});
