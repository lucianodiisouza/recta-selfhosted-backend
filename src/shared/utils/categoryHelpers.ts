/**
 * Helpers for custom categories.
 * categoryName in Transaction/Budget/Recurring: enum value (e.g. FOOD) or "CUSTOM:<uuid>"
 */

export const CUSTOM_CATEGORY_PREFIX = 'CUSTOM:';

export function isCustomCategoryName(categoryName: string): boolean {
  return typeof categoryName === 'string' && categoryName.startsWith(CUSTOM_CATEGORY_PREFIX);
}

export function toCustomCategoryId(categoryName: string): string | null {
  if (!isCustomCategoryName(categoryName)) return null;
  return categoryName.slice(CUSTOM_CATEGORY_PREFIX.length);
}

export function toCustomCategoryName(categoryId: string): string {
  return `${CUSTOM_CATEGORY_PREFIX}${categoryId}`;
}

/** Case/accent/space-insensitive form used to compare category names. */
export function normalizeCategoryName(name: string): string {
  return name.normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim().toLowerCase();
}
