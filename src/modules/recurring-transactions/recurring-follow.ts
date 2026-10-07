import { Prisma } from '../../generated/prisma/client.js';
import { dayString } from './recurring-dates.js';

/** How far ahead an occurrence still counts as "the current one" (days). */
export const FOLLOW_LOOKAHEAD_DAYS = 31;

export interface FollowedTransaction {
  id: string;
  householdId: string;
  recurringTransactionId: string | null;
  /** Stored date (@db.Date or local midnight). */
  date: Date;
  amount: number;
}

export interface FollowedUpdate {
  amount?: number;
  date?: Date;
  recurringTransactionId?: string | null;
}

/** 'YYYY-MM-DD' of today + n days (local calendar). */
export function plusDays(now: Date, n: number): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + n);
  return dayString(d);
}

/**
 * "Follow the last amount": when the edited transaction is the most recent occurrence (largest date, not beyond
 * today + 31 days) of an active recurrence that follows the last amount and whose amount the update actually changes, the recurrence takes the new amount, so
 * next month's occurrence is born with it. Older occurrences never change the recurrence. Runs on the same
 * database transaction as the transaction update. Returns the recurrence change, or null when nothing changed.
 */
export async function followLastAmountInTx(
  tx: Prisma.TransactionClient,
  before: FollowedTransaction,
  update: FollowedUpdate,
  now: Date = new Date(),
): Promise<{ id: string; amount: number } | null> {
  const recurringId = update.recurringTransactionId !== undefined ? update.recurringTransactionId : before.recurringTransactionId;
  if (!recurringId || update.amount === undefined) return null;
  // A non-positive value is not the price of the next occurrence (a refund or a mistake): never follow it.
  if (!(update.amount > 0)) return null;
  const newAmount = Math.round(update.amount * 100) / 100;
  // An update that leaves the amount as it was (a note, the paid mark) says nothing about the price: it must not overwrite a
  // recurrence amount that was edited by hand since.
  if (Math.abs(newAmount - before.amount) < 0.005) return null;

  const recurrence = await tx.recurringTransaction.findFirst({
    where: { id: recurringId, householdId: before.householdId, isActive: true, followLastAmount: true },
    select: { id: true, amount: true },
  });
  if (!recurrence || Math.abs(recurrence.amount.toNumber() - newAmount) < 0.005) return null;

  const limit = plusDays(now, FOLLOW_LOOKAHEAD_DAYS);
  const editedDay = dayString(update.date ?? before.date);
  if (editedDay > limit) return null;

  const others = await tx.transaction.findMany({
    where: { householdId: before.householdId, recurringTransactionId: recurringId },
    select: { id: true, date: true },
  });
  const newerExists = others.some((o) => o.id !== before.id && dayString(o.date) > editedDay && dayString(o.date) <= limit);
  if (newerExists) return null;

  await tx.recurringTransaction.update({ where: { id: recurringId }, data: { amount: new Prisma.Decimal(newAmount) } });
  return { id: recurringId, amount: newAmount };
}
