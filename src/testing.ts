import yaml from 'yaml';
import { clearConfigCache } from './tim/configLoader.js';
import { clearAllGitCaches } from './common/git.js';
import type { PlanSchema } from './tim/planSchema.js';

/**
 * Converts a plan object to a string with YAML frontmatter format.
 * This is useful for writing plan files in tests since tim now requires
 * files to have frontmatter delimiters.
 */
export function stringifyPlanWithFrontmatter(plan: PlanSchema): string {
  const { details, ...planWithoutDetails } = plan;
  const yamlContent = yaml.stringify(planWithoutDetails);
  let content = `---\n${yamlContent}---\n`;
  if (details) {
    content += `\n${details}\n`;
  }
  return content;
}

/**
 * Clears all tim-related caches. Call this in beforeEach and afterEach
 * to ensure tests don't pollute each other's state.
 */
export function clearAllTimCaches(): void {
  clearConfigCache();
  clearAllGitCaches();
}
