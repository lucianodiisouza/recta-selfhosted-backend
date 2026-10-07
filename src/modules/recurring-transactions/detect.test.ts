import { describe, expect, it } from 'vitest';

import {
  MAX_CANDIDATES,
  candidateId,
  detectRecurring,
  normalizeDescription,
  toPublicCandidate,
  type DetectTransaction,
} from './detect.js';

// Invented data only.
const TODAY = '2026-10-05';
const ACC = 'acc-card';
const BILLS = 'acc-bills';

let seq = 0;

function tx(overrides: Partial<DetectTransaction> & { description: string; date: string; amount: number }): DetectTransaction {
  seq += 1;
  return {
    id: `t${String(seq).padStart(6, '0')}`,
    accountId: ACC,
    accountName: 'Cartao Teste',
    type: 'EXPENSE',
    paid: true,
    categoryName: 'SUBSCRIPTIONS',
    ...overrides,
  };
}

function monthDay(year: number, month: number, day = 1): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** One transaction per listed month of 2026 (1-10), amount per month from a function or a constant. */
function series(
  description: string,
  months: number[],
  amount: number | ((month: number) => number),
  extra: Partial<Omit<DetectTransaction, 'description'>> = {},
  day = 1,
): DetectTransaction[] {
  return months.map((m) =>
    tx({ description, date: monthDay(2026, m, day), amount: typeof amount === 'function' ? amount(m) : amount, ...extra }),
  );
}

const ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const detect = (txs: DetectTransaction[], options: Partial<Parameters<typeof detectRecurring>[1]> = {}) =>
  detectRecurring(txs, { today: TODAY, ...options });

describe('normalizeDescription', () => {
  it('drops accents, case, punctuation, installment tokens and loose numbers', () => {
    expect(normalizeDescription('Energia 09/2026 - CELESC')).toBe('energia celesc');
    expect(normalizeDescription('  Água  ')).toBe('agua');
    expect(normalizeDescription('Loja A 3/10')).toBe('loja a');
    expect(normalizeDescription('Curso B 5/12 +7')).toBe('curso b');
    expect(normalizeDescription('Streamly #2')).toBe('streamly');
    expect(normalizeDescription('Plano 5G')).toBe('plano 5g');
    expect(normalizeDescription('Internet R$ 99,90')).toBe('internet r');
  });

  it('falls back to the label when nothing but numbers is left, and is empty for blank text', () => {
    expect(normalizeDescription('12345')).toBe('12345');
    expect(normalizeDescription('   ')).toBe('');
    expect(normalizeDescription(null)).toBe('');
  });
});

describe('detectRecurring: what enters', () => {
  it('proposes a stable subscription with its figures and a deterministic id', () => {
    const txs = series('Streaming Alfa', ALL, 21.9, {}, 3);
    const { candidates, skipped } = detect(txs);
    expect(candidates).toHaveLength(1);
    const c = candidates[0]!;
    expect(c).toMatchObject({
      id: candidateId(ACC, 'streaming alfa'),
      accountId: ACC,
      accountName: 'Cartao Teste',
      description: 'Streaming Alfa',
      categoryName: 'SUBSCRIPTIONS',
      amount: 21.9,
      medianAmount: 21.9,
      minAmount: 21.9,
      maxAmount: 21.9,
      dayOfMonth: 3,
      monthsSeen: 10,
      windowMonths: 12,
      lastMonth: '2026-10',
      kind: 'stable',
      defaultSelected: true,
      followLastAmount: true,
    });
    expect(c.confidence).toBeGreaterThan(0.9);
    expect(skipped).toEqual({ alreadyRecurring: 0, installments: 0, sparse: 0, consumption: 0 });
    // The id does not depend on the order or on the amounts.
    expect(detect([...txs].reverse()).candidates[0]!.id).toBe(c.id);
    expect(candidateId('acc-other', 'streaming alfa')).not.toBe(c.id);
  });

  it('proposes a variable monthly bill from its category, suggesting the last value', () => {
    const amounts = [140, 98, 123, 150, 87, 160, 105, 133, 119, 128];
    const txs = ALL.map((m) =>
      tx({
        description: 'Energia',
        accountId: BILLS,
        accountName: 'Conta Teste',
        categoryName: 'UTILITIES',
        date: monthDay(2026, m),
        amount: amounts[m - 1]!,
      }),
    );
    const { candidates } = detect(txs);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ kind: 'bill', amount: 128, minAmount: 87, maxAmount: 160, followLastAmount: true, defaultSelected: true });
    expect(candidates[0]!.medianAmount).toBeCloseTo(125.5, 2);
  });

  it('proposes a bill for HOUSING as well as UTILITIES', () => {
    const water = series('Agua', [5, 6, 7, 8, 9], (m) => 40 + m * 3, { categoryName: 'UTILITIES', accountId: BILLS, accountName: 'Conta Teste' });
    const rent = series('Aluguel', [6, 7, 8, 9, 10], (m) => 900 + m, { categoryName: 'HOUSING', accountId: BILLS, accountName: 'Conta Teste' });
    const { candidates } = detect([...water, ...rent]);
    expect(candidates.map((c) => [c.description, c.kind]).sort()).toEqual([['Agua', 'bill'], ['Aluguel', 'bill']]);
  });

  it('keeps a variable-amount charge out when it is not a bill (consumption)', () => {
    const fuel = series('Fuel Beta', ALL, (m) => 80 + ((m * 37) % 90), { categoryName: 'FUEL' });
    const { candidates, skipped } = detect(fuel);
    expect(candidates).toEqual([]);
    expect(skipped.consumption).toBe(1);
  });

  it('keeps out a charge repeated several times per month even with equal amounts', () => {
    const bakery = ALL.flatMap((m) => [
      tx({ description: 'Bakery Gamma', date: monthDay(2026, m, 3), amount: 12, categoryName: 'FOOD' }),
      tx({ description: 'Bakery Gamma', date: monthDay(2026, m, 15), amount: 12, categoryName: 'FOOD' }),
      tx({ description: 'Bakery Gamma', date: monthDay(2026, m, 24), amount: 12, categoryName: 'FOOD' }),
    ]);
    const { candidates, skipped } = detect(bakery);
    expect(candidates).toEqual([]);
    expect(skipped.consumption).toBe(1);
  });

  it('calls a value stable within max(0.50, 10% of the median): tolerance floor for small amounts', () => {
    const cheap = series('Nuvem Delta', ALL, (m) => (m % 2 ? 9.9 : 10.3));
    expect(detect(cheap).candidates).toHaveLength(1);
    const drifting = series('Nuvem Delta', ALL, (m) => 9.9 + m); // 10.9 .. 19.9
    expect(detect(drifting).candidates).toEqual([]);
  });

  it('groups by normalized description: spelling, accents and trailing numbers do not split a charge', () => {
    const txs = [
      ...series('Clube Épsilon', [1, 2, 3], 50),
      ...series('CLUBE EPSILON', [4, 5], 50),
      ...series('clube epsilon 2026', [6, 7, 8, 9, 10], 50),
    ];
    const { candidates } = detect(txs);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.monthsSeen).toBe(10);
    expect(candidates[0]!.description).toBe('clube epsilon 2026');
  });

  it('keeps the same description on two accounts as two candidates', () => {
    const txs = [...series('Plano Zeta', ALL, 30), ...series('Plano Zeta', ALL, 30, { accountId: BILLS, accountName: 'Conta Teste' })];
    const { candidates } = detect(txs);
    expect(candidates).toHaveLength(2);
    expect(new Set(candidates.map((c) => c.id)).size).toBe(2);
  });

  it('uses the most frequent category, spelling and day, newest on ties', () => {
    const txs = [
      tx({ description: 'Seguro Eta', date: '2026-07-04', amount: 70, categoryName: 'HEALTHCARE' }),
      tx({ description: 'Seguro Eta', date: '2026-08-04', amount: 70, categoryName: 'HEALTHCARE' }),
      tx({ description: 'Seguro ETA', date: '2026-09-02', amount: 70, categoryName: 'OTHER_EXPENSES' }),
      tx({ description: 'Seguro Eta', date: '2026-10-04', amount: 70, categoryName: 'HEALTHCARE' }),
    ];
    const c = detect(txs).candidates[0]!;
    expect(c).toMatchObject({ categoryName: 'HEALTHCARE', description: 'Seguro Eta', dayOfMonth: 4 });
  });

  it('lists up to 6 examples, newest first, and keeps every transaction id for linking', () => {
    const c = detect(series('Streaming Alfa', ALL, 21.9)).candidates[0]!;
    expect(c.examples).toHaveLength(6);
    expect(c.examples.map((e) => e.date)).toEqual(['2026-10-01', '2026-09-01', '2026-08-01', '2026-07-01', '2026-06-01', '2026-05-01']);
    expect(c.examples[0]).toEqual({ transactionId: expect.any(String), date: '2026-10-01', amount: 21.9, description: 'Streaming Alfa' });
    expect(c.transactionIds).toHaveLength(10);
    expect(toPublicCandidate(c)).not.toHaveProperty('transactionIds');
    expect(toPublicCandidate(c)).not.toHaveProperty('nextMonth');
    expect(toPublicCandidate(c)).not.toHaveProperty('key');
  });

  it('takes the newest transaction of a month as its value and counts the month once', () => {
    const txs = [
      ...series('Streaming Alfa', [7, 8, 9, 10], 20),
      tx({ description: 'Streaming Alfa', date: '2026-10-04', amount: 21 }),
    ];
    const c = detect(txs).candidates[0]!;
    expect(c.monthsSeen).toBe(4);
    expect(c.amount).toBe(21);
  });
});

describe('detectRecurring: what stays out', () => {
  it('excludes installments (field or N/M token) and counts them as skipped', () => {
    const byField = series('Notebook Teta', [4, 5, 6, 7, 8], 300, { installmentId: 'inst-notebook-1', installmentNumber: 1, totalInstallments: 10 });
    const byToken = ['Loja Iota 1/6', 'Loja Iota 2/6', 'Loja Iota 3/6', 'Loja Iota 4/6'].map((d, i) =>
      tx({ description: d, date: monthDay(2026, 6 + i), amount: 80 }),
    );
    const { candidates, skipped } = detect([...byField, ...byToken]);
    expect(candidates).toEqual([]);
    expect(skipped.installments).toBe(2);
  });

  it('excludes income, unpaid, future-dated and generated future installments', () => {
    const income = series('Salario Kappa', ALL, 3000, { type: 'INCOME' });
    const unpaid = series('Conta Lambda', ALL, 90, { paid: false });
    const future = [tx({ description: 'Conta Mu', date: '2026-11-01', amount: 90 }), tx({ description: 'Conta Mu', date: '2026-12-01', amount: 90 })];
    const placeholders = [6, 7, 8, 9, 10].map((m) =>
      tx({ description: 'Sofa Ni', date: monthDay(2026, m), amount: 100, installmentId: 'inst-sofa-1', installmentNumber: m - 5, totalInstallments: 12 }),
    );
    const invoice = series('Pagamento de fatura', ALL, 1500, { attachmentUrl: 'invoice_pay:acc-card:2026-1' });
    const result = detect([...income, ...unpaid, ...future, ...placeholders, ...invoice]);
    expect(result.candidates).toEqual([]);
  });

  it('does not count an unpaid month as evidence, only as covered for the first run', () => {
    const paid = series('Streaming Alfa', [6, 7, 8, 9], 21.9);
    const pendingOctober = tx({ description: 'Streaming Alfa', date: '2026-10-01', amount: 21.9, paid: false });
    const c = detect([...paid, pendingOctober]).candidates[0]!;
    expect(c.monthsSeen).toBe(4);
    expect(c.lastMonth).toBe('2026-09');
    // October already has its (pending) occurrence: the first run is November.
    expect(c.nextMonth).toBe('2026-11');
  });

  it('puts the first run in the month after the last paid one when nothing covers it', () => {
    expect(detect(series('Streaming Alfa', [5, 6, 7, 8, 9], 21.9)).candidates[0]!.nextMonth).toBe('2026-10');
    expect(detect(series('Streaming Alfa', [6, 7, 8, 9, 10], 21.9)).candidates[0]!.nextMonth).toBe('2026-11');
  });

  it('excludes what an active recurrence already covers (same account and normalized description)', () => {
    const txs = [...series('Streaming Alfa', ALL, 21.9), ...series('Outro Plano', ALL, 40)];
    const active = [{ id: 'r1', accountId: ACC, description: 'STREAMING  alfa 2026' }];
    const { candidates, skipped } = detect(txs, { activeRecurrences: active });
    expect(candidates.map((c) => c.description)).toEqual(['Outro Plano']);
    expect(skipped.alreadyRecurring).toBe(1);
    // Another account is not covered.
    expect(detect(txs, { activeRecurrences: [{ id: 'r1', accountId: BILLS, description: 'Streaming Alfa' }] }).candidates).toHaveLength(2);
  });

  it('excludes a group already linked to an active recurrence even when the spelling differs', () => {
    const linked = series('Streaming Alfa', ALL, 21.9, { recurringTransactionId: 'r9' });
    const { candidates, skipped } = detect(linked, { activeRecurrences: [{ id: 'r9', accountId: ACC, description: 'Assinatura renomeada' }] });
    expect(candidates).toEqual([]);
    expect(skipped.alreadyRecurring).toBe(1);
    // A link to a recurrence that is not active does not hide it.
    expect(detect(linked, { activeRecurrences: [] }).candidates).toHaveLength(1);
  });

  it('ignores transactions older than the window', () => {
    const old = [1, 2, 3].map((m) => tx({ description: 'Streaming Alfa', date: monthDay(2025, m), amount: 20 }));
    expect(detect(old).candidates).toEqual([]);
    const some = series('Streaming Alfa', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 20);
    // A 4-month window sees June to October only (3 + 2 = 5 months, window = Jul..Oct).
    const narrow = detect(some, { months: 4 }).candidates[0]!;
    expect(narrow).toMatchObject({ monthsSeen: 4, windowMonths: 4 });
  });

  it('skips a history with too many holes between its first and last month', () => {
    const sparse = series('Clube Pi', [1, 4, 7, 10], 60);
    const { candidates, skipped } = detect(sparse);
    expect(candidates).toEqual([]);
    expect(skipped.sparse).toBe(1);
  });

  it('keeps a hole of two months but does not select it by default', () => {
    const holes = series('Clube Pi', [1, 2, 3, 4, 7, 8, 9, 10], 60);
    const c = detect(holes).candidates[0]!;
    expect(c.monthsSeen).toBe(8);
    expect(c.defaultSelected).toBe(false);
    // A single missing month is fine.
    expect(detect(series('Clube Pi', [1, 2, 3, 5, 6, 7, 8, 9, 10], 60)).candidates[0]!.defaultSelected).toBe(true);
  });

  it('drops a charge that stopped (last paid month older than the previous one) and tolerates one month late', () => {
    const stopped = series('Revista Rho', [2, 3, 4, 5, 6, 7], 30);
    const r = detect(stopped);
    expect(r.candidates).toEqual([]);
    expect(r.skipped.sparse).toBe(1);

    const late = detect(series('Revista Rho', [4, 5, 6, 7, 8, 9], 30)).candidates[0]!;
    const current = detect(series('Revista Rho', [5, 6, 7, 8, 9, 10], 30)).candidates[0]!;
    expect(late.lastMonth).toBe('2026-09');
    expect(late.confidence).toBeLessThan(current.confidence);
  });

  it('honours minMonths: fewer months than asked is not proposed, and two months are never selected by default', () => {
    const two = series('Streaming Alfa', [9, 10], 21.9);
    expect(detect(two).candidates).toEqual([]);
    const lowered = detect(two, { minMonths: 2 }).candidates;
    expect(lowered).toHaveLength(1);
    expect(lowered[0]!.defaultSelected).toBe(false);
  });

  it('needs three months for a bill whatever minMonths says, and a bill with only two is judged as an ordinary charge', () => {
    const bill = series('Agua', [9, 10], (m) => (m === 9 ? 40 : 100), { categoryName: 'UTILITIES' });
    expect(detect(bill, { minMonths: 2 }).candidates).toEqual([]);
  });

  it('caps the answer at MAX_CANDIDATES', () => {
    const many = Array.from({ length: MAX_CANDIDATES + 20 }, (_, i) => series(`Servico ${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}x`, [8, 9, 10], 10 + i)).flat();
    expect(detect(many).candidates).toHaveLength(MAX_CANDIDATES);
  });
});

describe('detectRecurring: selection and confidence', () => {
  it('selects stable and bill candidates with 3 or more months and no big gap, and orders them by confidence', () => {
    const strong = series('Streaming Alfa', ALL, 21.9);
    const weak = series('Seguro Eta', [8, 9, 10], 70);
    const out = detect([...weak, ...strong]).candidates;
    expect(out.map((c) => c.description)).toEqual(['Streaming Alfa', 'Seguro Eta']);
    expect(out.every((c) => c.defaultSelected)).toBe(true);
    expect(out[0]!.confidence).toBeGreaterThan(out[1]!.confidence);
    expect(out.every((c) => c.confidence >= 0 && c.confidence <= 1)).toBe(true);
  });
});

describe('detectRecurring: performance', () => {
  it('handles 20,000 transactions fast', () => {
    const txs: DetectTransaction[] = [];
    for (let i = 0; i < 20_000; i++) {
      const month = (i % 10) + 1;
      txs.push(tx({ description: `Shop ${i % 1500}`, date: monthDay(2026, month, (i % 27) + 1), amount: 5 + (i % 97), accountId: `acc-${i % 4}` }));
    }
    const started = performance.now();
    const result = detect(txs);
    const elapsed = performance.now() - started;
    expect(result.skipped.consumption + result.candidates.length + result.skipped.sparse).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(1500);
  });
});
