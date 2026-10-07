/**
 * Canonical form used for every label comparison: trimmed, lower-cased, accents of Latin letters stripped (NFD, then
 * the combining diacritical marks U+0300-U+036F removed after a Latin letter) and inner whitespace collapsed to a
 * single space. Marks on other scripts are kept: in Japanese, Cyrillic or Devanagari they tell different words apart
 * (かい/がい, Сергей/Сергеи, कमल/कामल).
 */
export function normalizeLabel(s: string): string {
  return s
    .normalize('NFD')
    .replace(/(\p{Script=Latin})[̀-ͯ]+/gu, '$1')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
