import { generatePlanId } from '../common/id_generator.js';

/**
 * Convert text to a URL-friendly slug
 * @param text - The text to slugify
 * @returns A slugified version of the text
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-') // Replace non-alphanumeric (except hyphens) with hyphens
    .replace(/-+/g, '-') // Replace multiple consecutive hyphens with single hyphen
    .replace(/^-+|-+$/g, ''); // Remove leading and trailing hyphens
}

/**
 * Generate a unique project ID from a title
 * @param title - The project title to slugify
 * @returns A unique project ID
 */
// Counter for ensuring uniqueness when called in rapid succession
let counter = 0;

export function generateProjectId(title: string): string {
  let slug = slugify(title);

  // Truncate slug if it's too long (max 50 characters for the slug part)
  const maxSlugLength = 50;
  if (slug.length > maxSlugLength) {
    slug = slug.substring(0, maxSlugLength).replace(/-+$/, ''); // Remove trailing hyphens after truncation
  }

  // Get a short unique component (6 characters)
  // Use timestamp for first 3-4 chars, counter + random for remaining
  const timestamp = Date.now().toString(36);
  counter = (counter + 1) % 1296; // 36^2 = 1296, fits in 2 base36 chars
  const counterStr = counter.toString(36).padStart(2, '0');
  const randomStr = Math.floor(Math.random() * 46656)
    .toString(36)
    .padStart(3, '0'); // 36^3 = 46656

  // Take last 3 chars of timestamp + 2 chars counter + 1 char random
  const uniqueId = (timestamp.slice(-3) + counterStr + randomStr.charAt(0)).padEnd(6, '0');

  return `${slug}-${uniqueId}`;
}

/**
 * Generate a phase ID from project ID and phase index
 * @param projectId - The project ID
 * @param phaseIndex - The phase index (1-based)
 * @returns A phase ID in format ${projectId}-${phaseIndex}
 */
export function generatePhaseId(projectId: string, phaseIndex: number): string {
  return `${projectId}-${phaseIndex}`;
}
