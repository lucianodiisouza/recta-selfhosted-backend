/**
 * Comparison key of a free-text label: lower case, accents stripped (NFD + combining marks removed) and inner
 * whitespace collapsed to a single space. Two spellings of the same description compare equal.
 */
export function normalizeLabel(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
