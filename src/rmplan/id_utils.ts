import { getMaxNumericPlanId } from './plans.js';

const EPOCH = new Date('2025-05-01T00:00:00.000Z').getTime();

export function timestamp(): string {
  const timestamp = Math.round((Date.now() - EPOCH) / 1000);
  return Math.abs(timestamp).toString(36).padStart(5, '0');
}

/**
 * Convert text to a URL-friendly slug
 * @param text - The text to slugify
 * @returns A slugified version of the text
 */
export function slugify(text: string, maxLength = 50): string {
  let slug = text
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-') // Replace non-alphanumeric (except hyphens) with hyphens
    .replace(/-+/g, '-') // Replace multiple consecutive hyphens with single hyphen
    .replace(/^-+|-+$/g, ''); // Remove leading and trailing hyphens

  // If slug is longer than maxLength, truncate at word boundary
  if (slug.length > maxLength) {
    // Find the last hyphen before or at maxLength
    const lastHyphenIndex = slug.lastIndexOf('-', maxLength);

    if (lastHyphenIndex > 0) {
      // Truncate at the last word boundary
      slug = slug.slice(0, lastHyphenIndex);
    } else {
      // If no hyphen found, just truncate at maxLength
      slug = slug.slice(0, maxLength);
    }
  }

  // Remove trailing hyphen if present
  if (slug.endsWith('-')) {
    slug = slug.slice(0, -1);
  }

  return slug;
}

/**
 * Generate a unique alphanumeric ID (legacy format)
 * @returns A unique alphanumeric ID
 */
export function generateAlphanumericId(): string {
  const randomStr = Math.floor(Math.random() * 46656)
    .toString(36)
    .padStart(2, '0')
    .slice(0, 2);

  return timestamp() + randomStr;
}

/**
 * Generate a sequential numeric plan ID
 * @param tasksDir - The directory containing plan files
 * @returns The next available numeric ID (maxId + 1)
 */
export async function generateNumericPlanId(tasksDir: string): Promise<number> {
  const maxId = await getMaxNumericPlanId(tasksDir);
  return maxId + 1;
}
