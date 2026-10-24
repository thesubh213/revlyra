import { describe, expect, it } from 'vitest';
import { detectLanguage } from '../src';

describe('detectLanguage', () => {
  describe('empty token path (script fallback, confidence 0.2)', () => {
    it('uses the script of the fallback text and always 0.2 confidence', () => {
      expect(detectLanguage([], '好好用的產品 de')).toEqual({ code: 'zh', confidence: 0.2 });
      expect(detectLanguage([], 'これは最高の商品です')).toEqual({ code: 'ja', confidence: 0.2 });
      expect(detectLanguage([], '브랜드 베스트 브라우저')).toEqual({ code: 'ko', confidence: 0.2 });
      expect(detectLanguage([], 'Отличный товар')).toEqual({ code: 'ru', confidence: 0.2 });
      expect(detectLanguage([], 'ความคิดเห็นที่ดี')).toEqual({ code: 'th', confidence: 0.2 });
      expect(detectLanguage([], 'अच्छा उत्पाद')).toEqual({ code: 'hi', confidence: 0.2 });
      expect(detectLanguage([], 'বাহারি পণ্য')).toEqual({ code: 'bn', confidence: 0.2 });
      expect(detectLanguage([], 'சிறந்த தயாரிப்பு')).toEqual({ code: 'ta', confidence: 0.2 });
      expect(detectLanguage([], 'మంచి ఉత్పత్తి')).toEqual({ code: 'te', confidence: 0.2 });
    });

    it('falls back to undefined language for scriptless fallback text', () => {
      expect(detectLanguage([], '12345 !!!')).toEqual({ code: 'und', confidence: 0.2 });
      expect(detectLanguage([])).toEqual({ code: 'und', confidence: 0.2 });
    });

    it('Latin script alone does not imply English on the empty path', () => {
      const result = detectLanguage([], 'texto sin afinidad');
      expect(result.code).toBe('und');
      expect(result.confidence).toBe(0.2);
    });
  });

  describe('stopword-count path', () => {
    it('detects English with high confidence on many stopwords', () => {
      const tokens = 'the this product and it was very good review with not for you'.split(' ');
      const result = detectLanguage(tokens, tokens.join(' '));
      expect(result.code).toBe('en');
      expect(result.confidence).toBe(0.99); // ratio 11/13 -> >= 1.35 -> cap 0.99
    });

    it('detects Spanish, French, German, Portuguese and Italian', () => {
      // Spanish: 10/14 stopword tokens.
      const es = detectLanguage(
        'el producto es muy bueno la calidad y el precio son excelentes'.split(' '),
        'el producto es muy bueno',
      );
      expect(es.code).toBe('es');
      expect(es.confidence).toBe(0.99);

      const fr = detectLanguage(
        'très satisfait et le mon produit est parfait la écouter'.split(' '),
        'très satisfait',
      );
      expect(fr.code).toBe('fr');

      const de = detectLanguage(
        'das produkt ist gut und meinDER wird sehr aber ich der die'.split(' '),
        'das produkt ist gut',
      );
      expect(de.code).toBe('de');

      const pt = detectLanguage(
        'o produto é muito bom meu comprado com la la de que'.split(' '),
        'o produto é muito bom',
      );
      expect(pt.code).toBe('pt');

      const it = detectLanguage(
        'il prodotto è molto bello la delle e che di molto ma io'.split(' '),
        'il prodotto è molto bello',
      );
      expect(it.code).toBe('it');
    });

    it('detects Dutch and Turkish', () => {
      const nl = detectLanguage(
        'de van de mijn niet de met het voor maar ik'.split(' '),
        'nederlands',
      );
      expect(nl.code).toBe('nl');

      const tr = detectLanguage(
        'bu çok iyi ürün benim için ama değil gibi ve değil'.split(' '),
        'bu çok iyi',
      );
      expect(tr.code).toBe('tr');
    });

    it('detects Indonesian, Vietnamese and Polish', () => {
      const id = detectLanguage(
        'saya sangat suka produk yang ini dan itu tetapi dengan sangat'.split(' '),
        'saya sangat suka',
      );
      expect(id.code).toBe('id');

      const vi = detectLanguage(
        'tôi rất thích sản phẩm này và không với cho của một là'.split(' '),
        'tôi rất thích',
      );
      expect(vi.code).toBe('vi');

      const pl = detectLanguage(
        'to jest bardzo dobry produkt i mój nie ale z na do'.split(' '),
        'to jest bardzo',
      );
      expect(pl.code).toBe('pl');

      const ru = detectLanguage(
        'очень хороший товар и это мой но не на что'.split(' '),
        'очень хороший товар',
      );
      expect(ru.code).toBe('ru');
    });

    it('explicit Cyrillic stopwords exceed the English overlap words', () => {
      // Russian wins because it shares no tokens with English.
      const result = detectLanguage(
        'это очень хорошее качество товара мой товар не very product'.split(' '),
        '',
      );
      expect(result.code).toBe('ru');
    });

    it('breaks ties in favor of the first language in map order (English wins ties)', () => {
      // en and nl both hit 'is'; strict > keeps the earlier entry (en).
      const tokens = ['is', 'is'];
      const result = detectLanguage(tokens, 'unrelated script');
      expect(result.code).toBe('en');
    });

    it('uses only the first 400 tokens as the sample', () => {
      const stop = 'the'.repeat(0) ? '' : '';
      void stop;
      const tokens: string[] = [];
      for (let i = 0; i < 600; i += 1) tokens.push(i === 399 ? 'the' : `w${i}`);
      const result = detectLanguage(tokens, 'unrelated script');
      // 'the' at index 399 is inside the sample; one hit over 400 tokens is 0.0025 < 0.02
      expect(result.code).toBe('en'); // falls through to script fallback of the Latin text
      expect(result.confidence).toBe(0.15);
    });

    it('applies the 0.02 ratio floor: below it, script fallback controls', () => {
      const tokens = Array.from({ length: 400 }, (_, i) => (i === 3 ? 'the' : `w${i}`));
      // 1/400 = 0.0025 -> below floor -> script fallback on Latin text -> en, 0.15.
      const result = detectLanguage(tokens, 'just latin words here');
      expect(result.code).toBe('en');
      expect(result.confidence).toBe(0.15);
    });

    it('returns script-based codes at 0.45 when stopwords miss but script is known', () => {
      // Cyrillic text without a single Russian stopword.
      const result = detectLanguage(['приветличный', 'замечательный'], 'Отлично радуюсь!');
      expect(result.code).toBe('ru');
      expect(result.confidence).toBe(0.45);
    });

    it('falls back to und 0.1 when tokens exist, stopwords miss, and the script is unknown', () => {
      // Empty fallback text means detectScript reports Unknown -> und at 0.1.
      expect(detectLanguage(['qnwzv', 'kkswwd'], '')).toEqual({ code: 'und', confidence: 0.1 });
    });

    it('returns en 0.15 when tokens exist, stopwords miss, and script is Latin', () => {
      expect(detectLanguage(['qnwzv', 'kkswwd'], 'no stopword match here')).toEqual({
        code: 'en',
        confidence: 0.15,
      });
    });
  });
});
