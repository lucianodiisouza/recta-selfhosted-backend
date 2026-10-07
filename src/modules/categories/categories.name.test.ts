import { describe, expect, it } from 'vitest';
import { normalizeCategoryName } from './categories.service.js';

describe('normalizeCategoryName', () => {
  it('ignores case, accents and extra spaces', () => {
    expect(normalizeCategoryName('  Vale   Alimentação ')).toBe('vale alimentacao');
    expect(normalizeCategoryName('INVESTIMENTOS')).toBe(normalizeCategoryName('investimentos'));
  });
  it('keeps singular and plural apart (they are merged by the user, not guessed)', () => {
    expect(normalizeCategoryName('Investimento')).not.toBe(normalizeCategoryName('Investimentos'));
  });
});
