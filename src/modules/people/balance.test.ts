import { describe, expect, it } from 'vitest';

import {
  buildLedger,
  computeBalance,
  type LedgerSettlementSource,
  type LedgerShareSource,
} from './balance.js';

// Invented amounts and ids only.

function share(id: string, over: Partial<LedgerShareSource> = {}): LedgerShareSource {
  return {
    id,
    date: '2026-10-01',
    createdAt: 1,
    description: `Compra ${id}`,
    direction: 'THEY_OWE_ME',
    amountCents: 1000,
    transactionId: `tx-${id}`,
    transactionAmountCents: 2000,
    note: null,
    source: 'manual',
    ...over,
  };
}

function settlement(id: string, over: Partial<LedgerSettlementSource> = {}): LedgerSettlementSource {
  return {
    id,
    date: '2026-10-01',
    createdAt: 1,
    description: 'Settlement',
    direction: 'RECEIVED',
    amountCents: 1000,
    transactionId: null,
    transactionAmountCents: null,
    note: null,
    ...over,
  };
}

describe('computeBalance', () => {
  it('is zero without history', () => {
    expect(computeBalance([], [])).toEqual({ owedToMe: 0, iOwe: 0, received: 0, paid: 0, balance: 0, openShares: 0 });
  });

  it('adds shares they owe me and settlements I paid, subtracts shares I owe and settlements I received', () => {
    const result = computeBalance(
      [
        { direction: 'THEY_OWE_ME', amountCents: 5000 },
        { direction: 'THEY_OWE_ME', amountCents: 2550 },
        { direction: 'I_OWE_THEM', amountCents: 1200 },
      ],
      [
        { direction: 'RECEIVED', amountCents: 3000 },
        { direction: 'PAID', amountCents: 400 },
      ],
    );
    expect(result).toEqual({
      owedToMe: 7550,
      iOwe: 1200,
      received: 3000,
      paid: 400,
      balance: 7550 - 1200 - 3000 + 400,
      openShares: 3,
    });
  });

  it('goes negative when I owe more than they owe me (they are ahead)', () => {
    expect(computeBalance([{ direction: 'I_OWE_THEM', amountCents: 800 }], []).balance).toBe(-800);
    expect(computeBalance([{ direction: 'THEY_OWE_ME', amountCents: 800 }], [{ direction: 'RECEIVED', amountCents: 1000 }]).balance).toBe(-200);
  });
});

describe('buildLedger', () => {
  it('signs each row from my side: > 0 raises what they owe me', () => {
    const rows = buildLedger(
      [share('a', { direction: 'THEY_OWE_ME', amountCents: 5000 }), share('b', { direction: 'I_OWE_THEM', amountCents: 700, date: '2026-10-02' })],
      [
        settlement('c', { direction: 'RECEIVED', amountCents: 1000, date: '2026-10-03' }),
        settlement('d', { direction: 'PAID', amountCents: 300, date: '2026-10-04' }),
      ],
    );
    expect(rows.map((r) => [r.id, r.signedCents])).toEqual([
      ['a', 5000],
      ['b', -700],
      ['c', -1000],
      ['d', 300],
    ]);
  });

  it('computes the running balance in chronological order over the whole history', () => {
    const rows = buildLedger(
      [share('a', { amountCents: 5000, date: '2026-10-01' }), share('b', { amountCents: 2000, date: '2026-10-05' })],
      [settlement('c', { amountCents: 4000, date: '2026-10-03' })],
    );
    expect(rows.map((r) => [r.id, r.balanceAfterCents])).toEqual([
      ['a', 5000],
      ['c', 1000],
      ['b', 3000],
    ]);
    // the last balance equals computeBalance
    expect(rows[rows.length - 1]!.balanceAfterCents).toBe(
      computeBalance(
        [{ direction: 'THEY_OWE_ME', amountCents: 5000 }, { direction: 'THEY_OWE_ME', amountCents: 2000 }],
        [{ direction: 'RECEIVED', amountCents: 4000 }],
      ).balance,
    );
  });

  it('orders by day, then creation time, then id, whatever the input order', () => {
    const rows = buildLedger(
      [
        share('z', { date: '2026-10-01', createdAt: 5 }),
        share('b', { date: '2026-10-01', createdAt: 9 }),
        share('a', { date: '2026-10-01', createdAt: 9 }),
        share('early', { date: '2026-09-30', createdAt: 99 }),
      ],
      [settlement('s', { date: '2026-10-01', createdAt: 7 })],
    );
    expect(rows.map((r) => r.id)).toEqual(['early', 'z', 's', 'a', 'b']);
  });

  it('is stable: the same rows in any order give the same ledger', () => {
    const shares = [share('a', { createdAt: 3 }), share('b', { createdAt: 3, date: '2026-10-02' }), share('c', { createdAt: 1, date: '2026-10-02' })];
    const settlements = [settlement('d', { createdAt: 2, date: '2026-10-02' })];
    const forward = buildLedger(shares, settlements).map((r) => r.id);
    const backward = buildLedger([...shares].reverse(), [...settlements].reverse()).map((r) => r.id);
    expect(backward).toEqual(forward);
  });

  it('carries the transaction link, note and source, with null source for settlements', () => {
    const rows = buildLedger(
      [share('a', { note: 'jantar', source: 'import' })],
      [settlement('s', { transactionId: 'tx-9', transactionAmountCents: 4000, note: 'pix' })],
    );
    const s = rows.find((r) => r.id === 's')!;
    const a = rows.find((r) => r.id === 'a')!;
    expect(a).toMatchObject({ kind: 'share', transactionId: 'tx-a', transactionAmountCents: 2000, note: 'jantar', source: 'import' });
    expect(s).toMatchObject({ kind: 'settlement', transactionId: 'tx-9', transactionAmountCents: 4000, note: 'pix', source: null });
  });
});
