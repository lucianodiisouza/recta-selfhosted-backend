import { describe, expect, it } from 'vitest';

import { normalizeLabel } from './labels.js';

describe('normalizeLabel', () => {
  it('lower-cases, strips accents and collapses whitespace', () => {
    expect(normalizeLabel('  Café   da ZÉ\tÁgua ')).toBe('cafe da ze agua');
  });

  it('gives equal keys to two spellings of the same description', () => {
    expect(normalizeLabel('Açaí Bar')).toBe(normalizeLabel('acai  bar'));
  });

  it('keeps digits and punctuation', () => {
    expect(normalizeLabel('Loja 3/6 - Teste')).toBe('loja 3/6 - teste');
  });
});
