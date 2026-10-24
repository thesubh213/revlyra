// biome-ignore-all lint/suspicious/noControlCharactersInRegex: control and zero-width characters are intentionally stripped
// biome-ignore-all lint/suspicious/noMisleadingCharacterClass: combining marks are intentionally stripped
const ZERO_WIDTH =
  /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\uffa0]/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

const HOMOGLYPHS: Record<string, string> = {
  // Cyrillic
  А: 'A',
  В: 'B',
  Е: 'E',
  К: 'K',
  М: 'M',
  Н: 'H',
  О: 'O',
  Р: 'P',
  С: 'C',
  Т: 'T',
  У: 'Y',
  Х: 'X',
  а: 'a',
  в: 'b',
  е: 'e',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  і: 'i',
  ј: 'j',
  ѕ: 's',
  ԁ: 'd',
  һ: 'h',
  ӏ: 'l',
  ԛ: 'q',
  ԝ: 'w',
  ɡ: 'g',
  ⅼ: 'l',
  ⅽ: 'c',
  ⅾ: 'd',
  ⅿ: 'm',
  Ⅰ: 'I',
  Ⅴ: 'V',
  Ⅹ: 'X',
  // Greek
  Α: 'A',
  Β: 'B',
  Ε: 'E',
  Ζ: 'Z',
  Η: 'H',
  Ι: 'I',
  Κ: 'K',
  Μ: 'M',
  Ν: 'N',
  Ο: 'O',
  Ρ: 'P',
  Τ: 'T',
  Υ: 'Y',
  Χ: 'X',
  α: 'a',
  ε: 'e',
  ι: 'i',
  κ: 'k',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
  ω: 'w',
  // Latin extended / lookalikes
  ı: 'i',
  ł: 'l',
  ø: 'o',
  đ: 'd',
  ħ: 'h',
  ŧ: 't',
  æ: 'ae',
  œ: 'oe',
  ß: 'ss',
  '０': '0',
  '１': '1',
  '２': '2',
  '３': '3',
  '４': '4',
  '５': '5',
  '６': '6',
  '７': '7',
  '８': '8',
  '９': '9',
};

const SCRIPT_RANGES: Array<{ name: string; re: RegExp }> = [
  { name: 'Latin', re: /\p{Script=Latin}/u },
  { name: 'Cyrillic', re: /\p{Script=Cyrillic}/u },
  { name: 'Greek', re: /\p{Script=Greek}/u },
  { name: 'Arabic', re: /\p{Script=Arabic}/u },
  { name: 'Hebrew', re: /\p{Script=Hebrew}/u },
  { name: 'Han', re: /\p{Script=Han}/u },
  { name: 'Hiragana', re: /\p{Script=Hiragana}/u },
  { name: 'Katakana', re: /\p{Script=Katakana}/u },
  { name: 'Hangul', re: /\p{Script=Hangul}/u },
  { name: 'Devanagari', re: /\p{Script=Devanagari}/u },
  { name: 'Thai', re: /\p{Script=Thai}/u },
  { name: 'Bengali', re: /\p{Script=Bengali}/u },
  { name: 'Tamil', re: /\p{Script=Tamil}/u },
  { name: 'Telugu', re: /\p{Script=Telugu}/u },
];

const LATIN_RE = /\p{Script=Latin}/u;
const LETTER_RE = /\p{L}/u;

export interface UnicodeNormalization {
  text: string;
  zeroWidthRemoved: number;
  homoglyphsMapped: number;
  mixedScriptTokens: number;
  fullWidthChars: number;
  script: string;
}

export function stripInvisible(input: string): { text: string; removed: number } {
  let removed = 0;
  const text = input
    .replace(ZERO_WIDTH, () => {
      removed += 1;
      return '';
    })
    .replace(CONTROL, () => {
      removed += 1;
      return '';
    });
  return { text, removed };
}

export function detectScript(text: string): string {
  const counts = new Map<string, number>();
  for (const ch of text) {
    if (/\s/u.test(ch)) continue;
    for (const script of SCRIPT_RANGES) {
      if (script.re.test(ch)) {
        counts.set(script.name, (counts.get(script.name) ?? 0) + 1);
        break;
      }
    }
  }
  let best = 'Unknown';
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

function isLatinDominant(text: string): boolean {
  let latin = 0;
  let other = 0;
  for (const ch of text) {
    if (/\p{L}/u.test(ch)) {
      if (LATIN_RE.test(ch)) latin += 1;
      else other += 1;
    }
  }
  return latin > 0 && latin >= other;
}

/**
 * Normalizes Unicode and maps homoglyphs only when they are being used to
 * disguise Latin text. Legitimate Cyrillic/Greek reviews are left intact.
 */
export function normalizeUnicode(input: string): UnicodeNormalization {
  const original = input;
  const fullWidthChars = (original.match(/[\uff01-\uff5e]/g) ?? []).length;
  const nfkc = original.normalize('NFKC');
  const { text: visible, removed: zeroWidthRemoved } = stripInvisible(nfkc);

  const latinDominant = isLatinDominant(visible);
  const tokens = visible.split(/(\s+)/u);
  let homoglyphsMapped = 0;
  let mixedScriptTokens = 0;

  const mapped = tokens.map((token) => {
    if (token.trim().length === 0) return token;
    const hasLatin = LATIN_RE.test(token);
    const hasNonLatin = [...token].some((char) => LETTER_RE.test(char) && !LATIN_RE.test(char));
    if (hasLatin && hasNonLatin) mixedScriptTokens += 1;

    let out = '';
    for (const ch of token) {
      const replacement = HOMOGLYPHS[ch];
      const shouldMap =
        replacement !== undefined &&
        (hasLatin || (latinDominant && !hasLatin && isConfusableToken(token)));
      if (shouldMap) {
        out += replacement;
        homoglyphsMapped += 1;
      } else {
        out += ch;
      }
    }
    return out;
  });

  return {
    text: mapped.join(''),
    zeroWidthRemoved,
    homoglyphsMapped,
    mixedScriptTokens,
    fullWidthChars,
    script: detectScript(visible),
  };
}

function isConfusableToken(token: string): boolean {
  let homoglyphCount = 0;
  let letterCount = 0;
  for (const ch of token) {
    if (/\p{L}/u.test(ch)) letterCount += 1;
    if (HOMOGLYPHS[ch] !== undefined) homoglyphCount += 1;
  }
  return letterCount > 0 && homoglyphCount / letterCount >= 0.6;
}

export function isMostlyLatin(text: string): boolean {
  return isLatinDominant(text);
}

export function hasBidiControls(input: string): boolean {
  return /[\u202a-\u202e\u2066-\u2069]/u.test(input);
}

export function hasMixedScripts(text: string): boolean {
  const seen = new Set<string>();
  for (const ch of text) {
    if (!/\p{L}/u.test(ch)) continue;
    for (const script of SCRIPT_RANGES) {
      if (script.re.test(ch)) {
        seen.add(script.name);
        break;
      }
    }
    if (seen.size > 1) return true;
  }
  return false;
}
