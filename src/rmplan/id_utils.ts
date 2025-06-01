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
 * Generate a unique project ID from a title
 * @param title - The project title to slugify
 * @returns A unique project ID
 */
export function generateProjectId(): string {
  const randomStr = Math.floor(Math.random() * 46656)
    .toString(36)
    .padStart(2, '0')
    .slice(0, 2);

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
