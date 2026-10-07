import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { authMiddleware } from '../../shared/middleware/auth.middleware.js';
import { requireEditor, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import { NotFoundError } from '../../shared/errors/app-error.js';
import {
  createPersonSchema,
  householdHintQuerySchema,
  householdQuerySchema,
  idParamSchema,
  ledgerQuerySchema,
  listPeopleQuerySchema,
  putSharesSchema,
  updatePersonSchema,
} from './people.schema.js';
import {
  createPerson,
  deletePerson,
  findPersonHousehold,
  getLedger,
  listBalances,
  listPeople,
  updatePerson,
} from './people.service.js';
import {
  findTransactionHousehold,
  getTransactionShares,
  previewTransactionShares,
  putTransactionShares,
} from './shares.service.js';

const transactionParamSchema = z.object({ transactionId: z.string().uuid() });

type Access = 'member' | 'editor';

async function authorize(request: FastifyRequest, householdId: string, access: Access): Promise<void> {
  if (access === 'editor') await requireEditor(request, householdId);
  else await requireHouseholdMember(request, householdId);
}

/**
 * Household of a route keyed by an id alone (`PATCH /people/:id`, `PUT /transactions/:id/shares`, ...).
 *
 * With a `householdId` hint (query) the household is authorized first and scopes the lookup, so a foreign id is
 * a plain 404 inside it. Without one the household is read from the record; a caller who is not a member of it
 * gets the same 404 as for an id that does not exist, so ids of other households are not an oracle.
 */
async function resolveHousehold(
  request: FastifyRequest,
  hint: string | undefined,
  lookup: () => Promise<string | null>,
  access: Access,
  resource: string,
): Promise<string> {
  if (hint) {
    await authorize(request, hint, access);
    return hint;
  }
  const householdId = await lookup();
  if (!householdId) throw new NotFoundError(resource);
  try {
    await requireHouseholdMember(request, householdId);
  } catch (error) {
    // Not an instanceof check: AppError subclasses all end up with AppError's prototype.
    if ((error as { code?: string }).code === 'FORBIDDEN') throw new NotFoundError(resource);
    throw error;
  }
  if (access === 'editor') await requireEditor(request, householdId);
  return householdId;
}

function personHousehold(request: FastifyRequest, personId: string, hint: string | undefined, access: Access) {
  return resolveHousehold(request, hint, () => findPersonHousehold(personId), access, 'Person');
}

function transactionHousehold(request: FastifyRequest, transactionId: string, hint: string | undefined, access: Access) {
  return resolveHousehold(request, hint, () => findTransactionHousehold(transactionId), access, 'Transaction');
}

const docs = (description: string) => ({
  description,
  tags: ['People'],
  security: [{ bearerAuth: [] }],
});

/** /people: people, balances and ledgers. */
export async function peopleRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware());

  app.get('/', { schema: docs('List the people of a household (read: member)') }, async (request, reply) => {
    const query = listPeopleQuerySchema.parse(request.query);
    await requireHouseholdMember(request, query.householdId);
    const data = await listPeople(query.householdId, query.includeInactive === true);
    return reply.send({ success: true, data });
  });

  app.post('/', { schema: docs('Create a person with optional aliases (EDITOR+). 409 when a name or alias is taken') }, async (request, reply) => {
    const input = createPersonSchema.parse(request.body);
    await requireEditor(request, input.householdId);
    const data = await createPerson(input);
    return reply.status(201).send({ success: true, data });
  });

  app.get('/balances', { schema: docs('Balance of each person: positive means the person owes me (read: member)') }, async (request, reply) => {
    const query = householdQuerySchema.parse(request.query);
    await requireHouseholdMember(request, query.householdId);
    const data = await listBalances(query.householdId);
    return reply.send({ success: true, data });
  });

  app.patch('/:id', { schema: docs('Rename a person, replace the aliases, activate or deactivate (EDITOR+)') }, async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const { householdId: hint } = householdHintQuerySchema.parse(request.query);
    const input = updatePersonSchema.parse(request.body);
    const householdId = await personHousehold(request, id, hint, 'editor');
    const data = await updatePerson(householdId, id, input);
    return reply.send({ success: true, data });
  });

  app.delete('/:id', { schema: docs('Delete a person without data (204), or deactivate one that has shares or settlements (200 with the person) (EDITOR+)') }, async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const { householdId: hint } = householdHintQuerySchema.parse(request.query);
    const householdId = await personHousehold(request, id, hint, 'editor');
    const result = await deletePerson(householdId, id);
    if (result.deleted) return reply.status(204).send();
    return reply.status(200).send({ success: true, data: result.person });
  });

  app.get('/:id/ledger', { schema: docs('Shares and settlements of a person with the running balance, cursor-paginated in a total order (read: member)') }, async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const query = ledgerQuerySchema.parse(request.query);
    await requireHouseholdMember(request, query.householdId);
    const page = await getLedger(query.householdId, id, { limit: query.limit, cursor: query.cursor, order: query.order });
    return reply.send({ success: true, data: page.data, pagination: page.pagination });
  });
}

/** /transactions/:transactionId/shares: the people's parts of a transaction. */
export async function transactionSharesRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware());

  app.get('/:transactionId/shares', { schema: docs('Shares of a transaction and my part (read: member)') }, async (request, reply) => {
    const { transactionId } = transactionParamSchema.parse(request.params);
    const { householdId: hint } = householdHintQuerySchema.parse(request.query);
    const householdId = await transactionHousehold(request, transactionId, hint, 'member');
    const data = await getTransactionShares(householdId, transactionId);
    return reply.send({ success: true, data });
  });

  app.put('/:transactionId/shares', { schema: docs('Replace the shares of one direction of a transaction (EDITOR+); no entries removes them') }, async (request, reply) => {
    const { transactionId } = transactionParamSchema.parse(request.params);
    const { householdId: hint } = householdHintQuerySchema.parse(request.query);
    const input = putSharesSchema.parse(request.body);
    const householdId = await transactionHousehold(request, transactionId, hint, 'editor');
    const data = await putTransactionShares(householdId, transactionId, input);
    return reply.send({ success: true, data });
  });

  app.post('/:transactionId/shares/preview', { schema: docs('Compute a split without saving it (read: member)') }, async (request, reply) => {
    const { transactionId } = transactionParamSchema.parse(request.params);
    const { householdId: hint } = householdHintQuerySchema.parse(request.query);
    const input = putSharesSchema.parse(request.body);
    const householdId = await transactionHousehold(request, transactionId, hint, 'member');
    const data = await previewTransactionShares(householdId, transactionId, input);
    return reply.send({ success: true, data });
  });
}
