import type { FastifyInstance } from 'fastify';
import { authMiddleware, getAuthUser } from '../../shared/middleware/auth.middleware.js';
import {
  requireHouseholdMember,
  requireEditor,
  ensurePersonalHousehold,
  getUserByFirebaseUid,
} from '../../shared/middleware/authorization.middleware.js';
import {
  CategoryName,
  CategoryType,
  getCategoriesByType,
  getCategoryColor,
  CATEGORY_NAME_DISPLAY,
} from '../../shared/enums/index.js';
import { prisma } from '../../shared/db/prisma.js';
import { NotFoundError } from '../../shared/errors/index.js';
import {
  createCategorySchema,
  updateCategorySchema,
  categoryIdParamSchema,
  listCategoriesQuerySchema,
  mergeCategoryBodySchema,
  mergeCategoryQuerySchema,
} from './categories.schema.js';
import { toCustomCategoryName } from '../../shared/utils/categoryHelpers.js';
import * as categoriesService from './categories.service.js';
import * as mergeService from './categories.merge.service.js';

export async function categoryRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware());

  /**
   * GET /categories
   * List system + custom categories for a household.
   * householdId optional (defaults to personal).
   */
  app.get('/', {
    schema: {
      description: 'List system and custom categories for a household',
      tags: ['Categories'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          householdId: { type: 'string', format: 'uuid' },
          type: { type: 'string', enum: ['INCOME', 'EXPENSE'] },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  type: { type: 'string' },
                  color: { type: 'string' },
                  icon: { type: 'string', nullable: true },
                  isSystem: { type: 'boolean' },
                  usage: {
                    type: 'object',
                    nullable: true,
                    properties: {
                      transactions: { type: 'integer' },
                      recurringTransactions: { type: 'integer' },
                      budgets: { type: 'integer' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const query = listCategoriesQuerySchema.parse(request.query);
    const householdId = query.householdId || (await ensurePersonalHousehold(request));
    await requireHouseholdMember(request, householdId);

    const type = query.type as CategoryType | undefined;
    let systemNames: CategoryName[];
    if (type) {
      systemNames = getCategoriesByType(type);
    } else {
      systemNames = [
        ...getCategoriesByType(CategoryType.INCOME),
        ...getCategoriesByType(CategoryType.EXPENSE),
      ];
    }

    const system = systemNames.map((name) => ({
      id: name,
      name: CATEGORY_NAME_DISPLAY[name],
      type: getCategoriesByType(CategoryType.INCOME).includes(name) ? CategoryType.INCOME : CategoryType.EXPENSE,
      color: getCategoryColor(name),
      icon: null as string | null,
      isSystem: true as const,
    }));
    const usageMap = query.includeUsage === 'true' ? await categoriesService.getCategoryUsage(householdId) : null;
    const emptyUsage = { transactions: 0, recurringTransactions: 0, budgets: 0 };

    const custom = await categoriesService.listCategories({ householdId, type });
    const customMapped = custom.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      color: c.color ?? '#64748B',
      icon: c.icon,
      isSystem: false as const,
      ...(usageMap && { usage: usageMap.get(toCustomCategoryName(c.id)) ?? emptyUsage }),
    }));
    const systemMapped = usageMap
      ? system.map((c) => ({ ...c, usage: usageMap.get(c.id) ?? emptyUsage }))
      : system;

    return reply.send({
      success: true,
      data: [...systemMapped, ...customMapped],
    });
  });

  /**
   * GET /categories/:id
   * id = enum value (system) or uuid (custom)
   */
  app.get<{ Params: { id: string } }>('/:id', {
    schema: {
      description: 'Get category by id (system enum or custom uuid)',
      tags: ['Categories'],
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      response: { 200: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const { id } = request.params;

    if (Object.values(CategoryName).includes(id as CategoryName)) {
      const name = id as CategoryName;
      const type = getCategoriesByType(CategoryType.INCOME).includes(name) ? CategoryType.INCOME : CategoryType.EXPENSE;
      return reply.send({
        success: true,
        data: {
          id: name,
          name: CATEGORY_NAME_DISPLAY[name],
          type,
          color: getCategoryColor(name),
          icon: null,
          isSystem: true,
        },
      });
    }

    // Custom: fetch by id to get householdId, then check membership
    const category = await categoriesService.findCategoryById(id);
    if (!category) {
      throw new NotFoundError('Category');
    }
    await requireHouseholdMember(request, category.householdId);
    return reply.send({
      success: true,
      data: {
        id: category.id,
        name: category.name,
        type: category.type,
        color: category.color ?? '#64748B',
        icon: category.icon,
        isSystem: false,
      },
    });
  });

  /**
   * POST /categories
   * Create custom category. householdId optional (defaults to personal).
   */
  app.post('/', {
    schema: {
      description: 'Create a custom category',
      tags: ['Categories'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        properties: {
          householdId: { type: 'string', format: 'uuid' },
          name: { type: 'string' },
          type: { type: 'string', enum: ['INCOME', 'EXPENSE'] },
          icon: { type: 'string', nullable: true },
          color: { type: 'string', nullable: true },
        },
        required: ['name', 'type'],
      },
      response: { 200: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const body = createCategorySchema.parse(request.body);
    const householdId = body.householdId || (await ensurePersonalHousehold(request));
    await requireEditor(request, householdId);

    const category = await categoriesService.createCategory({ ...body, householdId });
    return reply.send({
      success: true,
      data: {
        id: category.id,
        householdId: category.householdId,
        name: category.name,
        type: category.type,
        color: category.color,
        icon: category.icon,
        isSystem: false,
      },
    });
  });

  /**
   * PATCH /categories/:categoryId
   */
  app.patch<{ Params: { categoryId: string } }>('/:categoryId', {
    schema: {
      description: 'Update a custom category',
      tags: ['Categories'],
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['categoryId'], properties: { categoryId: { type: 'string', format: 'uuid' } } },
      body: { type: 'object', properties: { name: { type: 'string' }, icon: { type: 'string', nullable: true }, color: { type: 'string', nullable: true } } },
      response: { 200: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const { categoryId } = categoryIdParamSchema.parse(request.params);
    const body = updateCategorySchema.parse(request.body);

    const authUser = getAuthUser(request);
    const user = await getUserByFirebaseUid(authUser.uid, authUser.email);
    const cat = await prisma.category.findFirst({ where: { id: categoryId }, select: { householdId: true } });
    if (!cat) throw new NotFoundError('Category');
    await requireEditor(request, cat.householdId);

    const category = await categoriesService.updateCategory(categoryId, cat.householdId, body);
    return reply.send({
      success: true,
      data: {
        id: category.id,
        householdId: category.householdId,
        name: category.name,
        type: category.type,
        color: category.color,
        icon: category.icon,
        isSystem: false,
      },
    });
  });

  /**
   * DELETE /categories/:categoryId
   */
  app.delete<{ Params: { categoryId: string } }>('/:categoryId', {
    schema: {
      description: 'Delete a custom category (only when not used)',
      tags: ['Categories'],
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['categoryId'], properties: { categoryId: { type: 'string', format: 'uuid' } } },
      response: { 200: { type: 'object', properties: { success: { type: 'boolean' } } } },
    },
  }, async (request, reply) => {
    const { categoryId } = categoryIdParamSchema.parse(request.params);

    const cat = await prisma.category.findFirst({ where: { id: categoryId }, select: { householdId: true } });
    if (!cat) throw new NotFoundError('Category');
    await requireEditor(request, cat.householdId);

    await categoriesService.deleteCategory(categoryId, cat.householdId);
    return reply.send({ success: true });
  });

  /**
   * POST /categories/:categoryId/merge[?preview=true]
   * Body: { targetCategoryId } (custom) or { targetSystemName } (system enum value, same type).
   * Moves transactions, recurring transactions and budgets of the source (a custom category) to the target and
   * deletes the source, atomically. With preview=true nothing is written and the counts are returned.
   * A source that no longer exists (already merged) is 404 and changes nothing.
   */
  app.post<{ Params: { categoryId: string } }>('/:categoryId/merge', {
    schema: {
      description: 'Merge a custom category into another category of the same type (EDITOR+); preview=true only counts',
      tags: ['Categories'],
      security: [{ bearerAuth: [] }],
      params: { type: 'object', required: ['categoryId'], properties: { categoryId: { type: 'string', format: 'uuid' } } },
      querystring: { type: 'object', properties: { preview: { type: 'string', enum: ['true', 'false'] } } },
      body: {
        type: 'object',
        properties: { targetCategoryId: { type: 'string', format: 'uuid' }, targetSystemName: { type: 'string' } },
      },
      response: { 200: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object', additionalProperties: true } } } },
    },
  }, async (request, reply) => {
    const { categoryId } = categoryIdParamSchema.parse(request.params);
    const body = mergeCategoryBodySchema.parse(request.body);
    const { preview } = mergeCategoryQuerySchema.parse(request.query);

    const householdId = await mergeService.findSourceHousehold(categoryId);
    if (!householdId) throw new NotFoundError('Category');
    await requireEditor(request, householdId);

    const data = await mergeService.mergeCategory(householdId, {
      sourceId: categoryId,
      targetCategoryId: body.targetCategoryId,
      targetSystemName: body.targetSystemName,
      preview: preview === 'true',
    });
    return reply.send({ success: true, data });
  });
}
