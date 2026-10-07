import { z } from 'zod';

import { MAX_ALIASES } from './people.common.js';
import { MAX_AMOUNT } from './money.js';
import { MAX_SHARES, MAX_SPLIT_ENTRIES, SPLIT_STRATEGIES } from './split-strategies.js';

// Every list and string below is capped: the bodies come from the browser.

export const uuid = z.string().uuid();
export const personName = z.string().trim().min(1, 'Name is required').max(100);
export const aliasList = z.array(personName).max(MAX_ALIASES, `At most ${MAX_ALIASES} aliases`);
const noteText = z.string().trim().max(500);
export const amount = z.number().positive().max(MAX_AMOUNT);

const queryBoolean = z.preprocess((value) => {
  if (value === 'true' || value === '1' || value === true) return true;
  if (value === 'false' || value === '0' || value === false) return false;
  return value;
}, z.boolean().optional());

export const shareDirectionSchema = z.enum(['THEY_OWE_ME', 'I_OWE_THEM']);

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
