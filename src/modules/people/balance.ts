/**
 * Balance and ledger of a person, from the person's shares and settlements. Pure, on integer cents.
 *
 * balance = owedToMe - iOwe - received + paid ; positive = the person owes me.
 */
export type ShareDirection = 'THEY_OWE_ME' | 'I_OWE_THEM';
export type SettlementDirection = 'RECEIVED' | 'PAID';

export interface ShareFact {
  direction: ShareDirection;
  amountCents: number;
}

export interface SettlementFact {
  direction: SettlementDirection;
  amountCents: number;
}

export interface BalanceCents {
  owedToMe: number;
  iOwe: number;
  received: number;
  paid: number;
  balance: number;
  openShares: number;
}

export function emptyBalance(): BalanceCents {
  return { owedToMe: 0, iOwe: 0, received: 0, paid: 0, balance: 0, openShares: 0 };
}

export function shareSign(direction: ShareDirection): 1 | -1 {
  return direction === 'THEY_OWE_ME' ? 1 : -1;
}

/** A settlement the person made to me lowers what they owe; one I made to them raises it. */
export function settlementSign(direction: SettlementDirection): 1 | -1 {
  return direction === 'RECEIVED' ? -1 : 1;
}

export function computeBalance(shares: ShareFact[], settlements: SettlementFact[]): BalanceCents {
  const result = emptyBalance();
  for (const share of shares) {
    if (share.direction === 'THEY_OWE_ME') result.owedToMe += share.amountCents;
    else result.iOwe += share.amountCents;
  }
  for (const settlement of settlements) {
    if (settlement.direction === 'RECEIVED') result.received += settlement.amountCents;
    else result.paid += settlement.amountCents;
  }
  result.openShares = shares.length;
  result.balance = result.owedToMe - result.iOwe - result.received + result.paid;
  return result;
}

export interface LedgerShareSource {
  id: string;
  /** YYYY-MM-DD: the date of the transaction */
  date: string;
  /** Creation time (ms), to order rows of the same day */
  createdAt: number;
  description: string;
  direction: ShareDirection;
  amountCents: number;
  transactionId: string;
  transactionAmountCents: number;
  note: string | null;
  source: 'manual' | 'import';
}

export interface LedgerSettlementSource {
  id: string;
  /** YYYY-MM-DD */
  date: string;
  createdAt: number;
  description: string;
  direction: SettlementDirection;
  amountCents: number;
  transactionId: string | null;
  transactionAmountCents: number | null;
  note: string | null;
}

export interface LedgerRow {
  kind: 'share' | 'settlement';
  id: string;
  date: string;
  description: string;
  direction: ShareDirection | SettlementDirection;
  amountCents: number;
  /** > 0 raises what the person owes me */
  signedCents: number;
  balanceAfterCents: number;
  transactionId: string | null;
  transactionAmountCents: number | null;
  note: string | null;
  source: 'manual' | 'import' | null;
  /** Ordering keys */
  createdAt: number;
}

/** Total order of the ledger: day, then creation time, then id. */
export function compareLedgerRows(
  a: { date: string; createdAt: number; id: string },
  b: { date: string; createdAt: number; id: string },
): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/** The whole history in chronological order, each row with the running balance after it. */
export function buildLedger(shares: LedgerShareSource[], settlements: LedgerSettlementSource[]): LedgerRow[] {
  const rows: LedgerRow[] = [
    ...shares.map<LedgerRow>((s) => ({
      kind: 'share',
      id: s.id,
      date: s.date,
      description: s.description,
      direction: s.direction,
      amountCents: s.amountCents,
      signedCents: shareSign(s.direction) * s.amountCents,
      balanceAfterCents: 0,
      transactionId: s.transactionId,
      transactionAmountCents: s.transactionAmountCents,
      note: s.note,
      source: s.source,
      createdAt: s.createdAt,
    })),
    ...settlements.map<LedgerRow>((s) => ({
      kind: 'settlement',
      id: s.id,
      date: s.date,
      description: s.description,
      direction: s.direction,
      amountCents: s.amountCents,
      signedCents: settlementSign(s.direction) * s.amountCents,
      balanceAfterCents: 0,
      transactionId: s.transactionId,
      transactionAmountCents: s.transactionAmountCents,
      note: s.note,
      source: null,
      createdAt: s.createdAt,
    })),
  ];
  rows.sort(compareLedgerRows);
  let running = 0;
  for (const row of rows) {
    running += row.signedCents;
    row.balanceAfterCents = running;
  }
  return rows;
}
