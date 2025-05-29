import { generatePlanId } from '../common/id_generator.js';

/**
 * Generate a unique project ID from a title
 * @param title - The project title to slugify
 * @returns A unique project ID
 */
export function generateProjectId(title: string): string {
  // Slugify the title: lowercase, replace spaces and special characters with hyphens
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // Append unique component from generatePlanId
  const uniqueId = generatePlanId();

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
