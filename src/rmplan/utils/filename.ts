import { slugify } from '../id_utils.js';

/**
 * Generates a plan filename from an ID and title.
 * Creates a slug from the title and combines it with the ID.
 * @param id - The plan ID
 * @param title - The plan title
 * @returns A filename in the format: {id}-{slug}.plan.md
 */
export function generatePlanFilename(id: number, title: string): string {
  const slug = slugify(title);
  return `${id}-${slug}.plan.md`;
}
