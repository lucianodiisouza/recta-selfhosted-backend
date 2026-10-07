import { z } from 'zod';
import { RecurrenceFrequency } from '../../shared/enums/index.js';
import { localDateSchema } from '../../shared/utils/dateSchema.js';
import { categoryNameSchema } from '../categories/categories.schema.js';

/**
 * Recurrence frequency enum
 */
export const recurrenceFrequencyEnum = z.nativeEnum(RecurrenceFrequency);

/**
 * Create recurring transaction request
 */
export const createRecurringTransactionSchema = z.object({
  householdId: z.string().uuid().optional(), // Optional - will create personal household if not provided
  accountId: z.string().uuid(),
  categoryName: categoryNameSchema,
  amount: z.coerce.number().refine((val) => val !== 0, 'Amount cannot be zero'),
  description: z.string().max(255).optional(),
  frequency: recurrenceFrequencyEnum,
  startDate: localDateSchema,
  endDate: localDateSchema.optional(),
  nextRunAt: localDateSchema,
  isActive: z.boolean().default(true),
  // When true, editing the most recent occurrence updates the recurrence amount (predicts the next value)
  followLastAmount: z.boolean().default(false),
});

export type CreateRecurringTransactionInput = z.infer<
  typeof createRecurringTransactionSchema
>;

/**
 * Update recurring transaction request
 */
export const updateRecurringTransactionSchema = z.object({
  accountId: z.string().uuid().optional(),
  categoryName: categoryNameSchema.optional(),
  amount: z.coerce.number().refine((val) => val !== 0, 'Amount cannot be zero').optional(),
  description: z.string().max(255).optional(),
  frequency: recurrenceFrequencyEnum.optional(),
  startDate: localDateSchema.optional(),
  endDate: localDateSchema.nullable().optional(),
  nextRunAt: localDateSchema.optional(),
  isActive: z.boolean().optional(),
  followLastAmount: z.boolean().optional(),
});

export type UpdateRecurringTransactionInput = z.infer<
  typeof updateRecurringTransactionSchema
>;

/**
 * Recurring transaction ID param
 */
export const recurringTransactionIdParamSchema = z.object({
  recurringId: z.string().uuid(),
});

export type RecurringTransactionIdParam = z.infer<
  typeof recurringTransactionIdParamSchema
>;

/**
 * List recurring transactions query
 */
export const listRecurringTransactionsQuerySchema = z.object({
  householdId: z.string().uuid().optional(), // Optional - will use personal household if not provided
  isActive: z.coerce.boolean().optional(),
});

export type ListRecurringTransactionsQuery = z.infer<
  typeof listRecurringTransactionsQuerySchema
>;

/**
 * Execute recurring transaction
 * REGRA DE NEGÓCIO:
 * - paid: true para cartão de crédito (consome limite imediatamente)
 * - paid: false para conta bancária (pendente para revisão)
 */
export const executeRecurringTransactionSchema = z.object({
  date: localDateSchema.optional(),
  paid: z.boolean().optional(), // Se não fornecido, usa false (padrão seguro)
});

export type ExecuteRecurringTransactionInput = z.infer<
  typeof executeRecurringTransactionSchema
>;


/**
 * Detect recurring expenses (POST /recurring-transactions/detect) and apply the chosen candidates
 * (POST /recurring-transactions/detect/apply). Caps keep the work bounded.
 */
const detectWindowShape = {
  householdId: z.string().uuid(),
  minMonths: z.number().int().min(2).max(12).optional(),
  months: z.number().int().min(3).max(36).optional(),
};

function minMonthsFitsWindow(v: { minMonths?: number; months?: number }): boolean {
  return (v.minMonths ?? 3) <= (v.months ?? 12);
}

export const detectRecurringSchema = z
  .object(detectWindowShape)
  .refine(minMonthsFitsWindow, { message: 'minMonths cannot exceed months', path: ['minMonths'] });

export type DetectRecurringInput = z.infer<typeof detectRecurringSchema>;

export const MAX_DETECT_APPLY_ITEMS = 300;

export const detectApplySchema = z
  .object({
    ...detectWindowShape,
    items: z
      .array(
        z.object({
          id: z.string().min(1).max(64),
          amount: z.number().positive().max(1_000_000_000).optional(),
          dayOfMonth: z.number().int().min(1).max(31).optional(),
          description: z.string().trim().min(1).max(255).optional(),
          followLastAmount: z.boolean().optional(),
        }),
      )
      .min(1)
      .max(MAX_DETECT_APPLY_ITEMS),
  })
  .refine(minMonthsFitsWindow, { message: 'minMonths cannot exceed months', path: ['minMonths'] });

export type DetectApplyInput = z.infer<typeof detectApplySchema>;
