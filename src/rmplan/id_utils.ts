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
export function generateProjectId(title: string): string {
  let slug = slugify(title);

  // Truncate slug if it's too long (max 50 characters for the slug part)
  const maxSlugLength = 50;
  if (slug.length > maxSlugLength) {
    slug = slug.substring(0, maxSlugLength).replace(/-+$/, ''); // Remove trailing hyphens after truncation
  }

  // Get a short unique component (4-6 characters)
  // Add a random component to ensure uniqueness even when called quickly
  const timestamp = generatePlanId();
  const random = Math.random().toString(36).substring(2, 5);
  const uniqueId = (timestamp + random).substring(0, 6);

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
