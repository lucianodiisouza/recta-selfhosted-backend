import { z } from 'zod';
import { AccountType } from '../../shared/enums/index.js';

/**
 * Account types enum
 */
export const accountTypeEnum = z.nativeEnum(AccountType);

/**
 * Create account request
 */
export const createAccountSchema = z.object({
  householdId: z.string().uuid().optional(), // Optional - will create personal household if not provided
  name: z.string().min(1).max(100).trim(),
  type: accountTypeEnum,
  balance: z.coerce.number().default(0),
  currency: z.string().length(3).default('BRL'),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  icon: z.string().max(50).optional(),
  creditLimit: z.coerce.number().positive().optional(),
  dueDay: z.number().int().min(1).max(31).optional(),
  closingDay: z.number().int().min(1).max(31).optional(),
  // Number of days before the invoice closes that defines the "best day to buy".
  // Default in service layer is 10 when not provided.
  bestDayOffset: z.number().int().min(1).max(30).optional(),
  linkedAccountId: z.string().uuid().optional(),
});

export type CreateAccountInput = z.infer<typeof createAccountSchema>;

/**
 * Update account request
 */
export const updateAccountSchema = z.object({
  name: z.string().min(1).max(100).trim().optional(),
  type: accountTypeEnum.optional(),
  balance: z.coerce.number().optional(), // Permitir atualização direta do balance (usado para pagamento de fatura de cartão)
  isActive: z.boolean().optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional(),
  icon: z.string().max(50).nullable().optional(),
  creditLimit: z.coerce.number().positive().nullable().optional(),
  dueDay: z.number().int().min(1).max(31).nullable().optional(),
  closingDay: z.number().int().min(1).max(31).nullable().optional(),
  bestDayOffset: z.number().int().min(1).max(30).nullable().optional(),
  linkedAccountId: z.string().uuid().nullable().optional(),
});

export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;

/**
 * Account ID param
 */
export const accountIdParamSchema = z.object({
  accountId: z.string().uuid(),
});

export type AccountIdParam = z.infer<typeof accountIdParamSchema>;

/**
 * List accounts query
 */
export const listAccountsQuerySchema = z.object({
  householdId: z.string().uuid().optional(), // Optional - will use personal household if not provided
  includeInactive: z.coerce.boolean().default(false),
});

export type ListAccountsQuery = z.infer<typeof listAccountsQuerySchema>;

/**
 * Transfer between accounts
 */
export const transferSchema = z.object({
  fromAccountId: z.string().uuid(),
  toAccountId: z.string().uuid(),
  amount: z.coerce.number().positive('Amount must be positive'),
  description: z.string().max(255).optional(),
});

export type TransferInput = z.infer<typeof transferSchema>;

/** Earliest accepted adjustment date: a typo such as 0025-12-31 must not become an entry. */
const MIN_ADJUST_DATE = new Date(1900, 0, 1);

/** Calendar day of the machine running the API, as the app does everywhere else (see localDateSchema). */
export function localToday(): Date {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

/**
 * Adjust balance manually.
 * - newBalance: the balance the account must have after the adjustment (a number or a numeric string with at most two
 *   decimals; an empty string is NOT zero).
 * - date: optional YYYY-MM-DD the adjustment entry is dated at (from 1900-01-01, not in the future); it defaults to today. Dating an
 *   opening balance at the end of the previous year keeps it out of the current year's income/expense reports.
 * - reason: optional description of the entry (default 'Balance adjustment').
 */
export const adjustBalanceSchema = z.object({
  newBalance: z.preprocess(
    (v) => (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v) ? Number(v) : v),
    z
      .number({ invalid_type_error: 'newBalance must be a number' })
      .finite()
      .refine((n) => Math.abs(n) < 1e12, 'newBalance is out of range')
      .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, 'newBalance must have at most two decimal places')
  ),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .transform((value, ctx) => {
      const [y, m, d] = value.split('-').map(Number) as [number, number, number];
      const parsed = new Date(y, m - 1, d);
      if (parsed.getFullYear() !== y || parsed.getMonth() !== m - 1 || parsed.getDate() !== d) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'date is not a valid calendar day' });
        return z.NEVER;
      }
      if (parsed.getTime() < MIN_ADJUST_DATE.getTime()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'date is too far in the past' });
        return z.NEVER;
      }
      if (parsed.getTime() > localToday().getTime()) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'date cannot be in the future' });
        return z.NEVER;
      }
      return parsed;
    })
    .optional(),
  reason: z.string().trim().max(255).optional(),
});

export type AdjustBalanceInput = z.infer<typeof adjustBalanceSchema>;







