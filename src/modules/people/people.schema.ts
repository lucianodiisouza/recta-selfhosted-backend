import { z } from 'zod';

import { categoryNameSchema } from '../categories/categories.schema.js';
import { parseLocalDateString } from '../../shared/utils/local-date.js';
import { MAX_ALIASES } from './people.common.js';
import { MAX_AMOUNT } from './money.js';
import { MAX_SHARES, MAX_SPLIT_ENTRIES, SPLIT_STRATEGIES } from './split-strategies.js';

// Every list and string below is capped: the bodies come from the browser.

export const uuid = z.string().uuid();
export const personName = z.string().trim().min(1, 'Name is required').max(100);
export const aliasList = z.array(personName).max(MAX_ALIASES, `At most ${MAX_ALIASES} aliases`);
const noteText = z.string().trim().max(500);
export const amount = z.number().positive().max(MAX_AMOUNT);

/** 'YYYY-MM-DD' that is a real calendar day. */
export const dayString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
  .refine((value) => {
    try {
      parseLocalDateString(value);
      return true;
    } catch {
      return false;
    }
  }, 'Not a real calendar day');

const queryBoolean = z.preprocess((value) => {
  if (value === 'true' || value === '1' || value === true) return true;
  if (value === 'false' || value === '0' || value === false) return false;
  return value;
}, z.boolean().optional());

export const shareDirectionSchema = z.enum(['THEY_OWE_ME', 'I_OWE_THEM']);
export const settlementDirectionSchema = z.enum(['RECEIVED', 'PAID']);

export const idParamSchema = z.object({ id: uuid });
/** Routes keyed by an id alone accept the household as a hint: it is authorized first and scopes the lookup. */
export const householdHintQuerySchema = z.object({ householdId: uuid.optional() });
export const householdQuerySchema = z.object({ householdId: uuid });

export const listPeopleQuerySchema = z.object({ householdId: uuid, includeInactive: queryBoolean });

export const createPersonSchema = z.object({
  householdId: uuid,
  name: personName,
  aliases: aliasList.optional(),
});

export const updatePersonSchema = z
  .object({
    name: personName.optional(),
    aliases: aliasList.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => value.name !== undefined || value.aliases !== undefined || value.isActive !== undefined, {
    message: 'Nothing to update',
  });

export const ledgerQuerySchema = z.object({
  householdId: uuid,
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(100).optional(),
  /** `desc` (default): newest first. The running balance is the same either way. */
  order: z.enum(['asc', 'desc']).default('desc'),
});

export const shareEntrySchema = z.object({
  personId: uuid,
  amount: amount.optional(),
  percent: z.number().positive().max(100).optional(),
  shares: z.number().int().min(1).max(MAX_SHARES).optional(),
  note: noteText.optional(),
});

export const putSharesSchema = z.object({
  direction: shareDirectionSchema,
  strategy: z.enum(SPLIT_STRATEGIES),
  entries: z.array(shareEntrySchema).max(MAX_SPLIT_ENTRIES),
  myShares: z.number().int().min(0).max(MAX_SHARES).optional(),
});
export type PutSharesInput = z.infer<typeof putSharesSchema>;

export const createSettlementSchema = z
  .object({
    householdId: uuid,
    direction: settlementDirectionSchema,
    amount,
    date: dayString,
    note: noteText.optional(),
    transactionId: uuid.optional(),
    createTransaction: z
      .object({
        accountId: uuid,
        description: z.string().trim().min(1).max(255).optional(),
        categoryName: categoryNameSchema.optional(),
      })
      .optional(),
  })
  .refine((value) => !(value.transactionId && value.createTransaction), {
    message: 'Send either transactionId or createTransaction, not both',
    path: ['createTransaction'],
  });
export type CreateSettlementInput = z.infer<typeof createSettlementSchema>;
