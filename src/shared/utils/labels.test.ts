import { describe, expect, it } from 'vitest';

import { normalizeLabel } from './labels.js';

describe('normalizeLabel', () => {
  it('trims, lower-cases, strips accents and collapses whitespace', () => {
    expect(normalizeLabel('  Educação   Física ')).toBe('educacao fisica');
    expect(normalizeLabel('SAÚDE')).toBe('saude');
    expect(normalizeLabel('Cartão\tde\n crédito')).toBe('cartao de credito');
    expect(normalizeLabel('Ação')).toBe('acao');
  });

  it('keeps an empty or blank label empty', () => {
    expect(normalizeLabel('')).toBe('');
    expect(normalizeLabel('   ')).toBe('');
  });

  it('keeps apart words that differ only by a combining mark outside the Latin accents', () => {
    const pairs: Array<[string, string]> = [['かい', 'がい'], ['Сергей', 'Сергеи'], ['कमल', 'कामल']];
    for (const [a, b] of pairs) expect(normalizeLabel(a), `${a} / ${b}`).not.toBe(normalizeLabel(b));
  });

  it('still folds the decomposed Latin accents', () => {
    expect(normalizeLabel('José')).toBe('jose');
    expect(normalizeLabel('Á̧o')).toBe('ao');
  });

  it('gives the same key to the precomposed and the decomposed spelling of a letter', () => {
    expect(normalizeLabel('José')).toBe(normalizeLabel('José'));
  });
});
