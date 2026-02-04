import { log } from '../logging.js';
import type { TimConfig } from './configSchema.js';
import type { PlanSchema } from './planSchema.js';
import { normalizeTags, validateTags } from './utils/tags.js';

export interface PlanPropertyOptions {
  rmfilter?: string[];
  issue?: string[];
  doc?: string[];
  assign?: string;
  tag?: string[];
  noTag?: string[];
}

/**
 * Updates plan properties that are commonly shared between set and add commands
 * @param plan The plan to update
 * @param options The options containing property values to set
 * @returns true if any modifications were made
 */
export function updatePlanProperties(
  plan: PlanSchema,
  options: PlanPropertyOptions,
  config?: TimConfig
): boolean {
  let modified = false;

  // Update rmfilter
  if (options.rmfilter && options.rmfilter.length > 0) {
    plan.rmfilter = Array.from(new Set([...(plan.rmfilter || []), ...options.rmfilter])).sort();
    modified = true;
    log(`Updated rmfilter patterns`);
  }

  // Add issue URLs
  if (options.issue && options.issue.length > 0) {
    if (!plan.issue) {
      plan.issue = [];
    }
    for (const issueUrl of options.issue) {
      if (!plan.issue.includes(issueUrl)) {
        plan.issue.push(issueUrl);
        modified = true;
        log(`Added issue URL: ${issueUrl}`);
      } else {
        log(`Issue URL already exists: ${issueUrl}`);
      }
    }
  }

  // Add documentation paths
  if (options.doc && options.doc.length > 0) {
    if (!plan.docs) {
      plan.docs = [];
    }
    for (const docUrl of options.doc) {
      if (!plan.docs.includes(docUrl)) {
        plan.docs.push(docUrl);
        modified = true;
        log(`Added documentation path: ${docUrl}`);
      } else {
        log(`Documentation path already exists: ${docUrl}`);
      }
    }
  }

  // Set assignedTo
  if (options.assign !== undefined) {
    plan.assignedTo = options.assign;
    modified = true;
    log(`Assigned to ${options.assign}`);
  }

  if (options.tag && options.tag.length > 0) {
    const validatedTags = validateTags(options.tag, config);
    if (validatedTags.length > 0) {
      const existingTags = normalizeTags(plan.tags);
      const mergedTags = normalizeTags([...existingTags, ...validatedTags]);
      if (!arraysEqual(existingTags, mergedTags)) {
        plan.tags = mergedTags;
        modified = true;
        log(`Updated tags: ${mergedTags.join(', ')}`);
      }
    }
  }

  if (options.noTag && options.noTag.length > 0) {
    const tagsToRemove = new Set(normalizeTags(options.noTag));
    if (tagsToRemove.size > 0) {
      const existingTags = normalizeTags(plan.tags);
      if (existingTags.length > 0) {
        const filteredTags = existingTags.filter((tag) => !tagsToRemove.has(tag));
        if (!arraysEqual(existingTags, filteredTags)) {
          plan.tags = filteredTags;
          modified = true;
          log(`Removed ${existingTags.length - filteredTags.length} tag(s)`);
        }
      }
    }
  }

  return modified;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }

  return a.every((value, index) => value === b[index]);
}
