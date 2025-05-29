const EPOCH = new Date('2025-05-01T00:00:00.000Z').getTime();

export function timestamp(): string {
  const timestamp = Date.now() - EPOCH;
  return Math.abs(timestamp).toString(36).padStart(6, '0');
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
    .replace(/^-+|-+$/g, '') // Remove leading and trailing hyphens
    .slice(0, maxLength);
  if (slug.endsWith('-')) {
    slug = slug.slice(0, -1);
  }
  return slug;
}

/**
 * Generate a unique project ID from a title
 * @param title - The project title to slugify
 * @returns A unique project ID
 */
export function generateProjectId(): string {
  // Get a short unique component (6 characters)
  // Use timestamp for first 3-4 chars, counter + random for remaining
  const randomStr = Math.floor(Math.random() * 46656)
    .toString(36)
    .padStart(3, '0'); // 36^3 = 46656

  return timestamp() + randomStr;
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
