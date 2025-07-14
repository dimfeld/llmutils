import path from 'path';
import { getGitRoot } from '../../common/git.js';
import { log } from '../../logging.js';
import { readAllPlans, readPlanFile, writePlanFile, resolvePlanFile } from '../plans.js';
import type { Priority } from '../planSchema.js';
import { resolveTasksDir } from '../configSchema.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { updatePlanProperties } from '../planPropertiesUpdater.js';

type Status = 'pending' | 'in_progress' | 'done' | 'cancelled' | 'deferred';

export interface SetOptions {
  planFile: string;
  priority?: Priority;
  status?: Status;
  dependsOn?: number[];
  noDependsOn?: number[];
  parent?: number;
  noParent?: boolean;
  rmfilter?: string[];
  issue?: string[];
  noIssue?: string[];
  doc?: string[];
  noDoc?: string[];
  assign?: string;
  noAssign?: boolean;
}

export async function handleSetCommand(
  planFile: string,
  options: SetOptions,
  globalOpts: any
): Promise<void> {
  const resolvedPlanFile = await resolvePlanFile(planFile, globalOpts?.config);
  options.planFile = resolvedPlanFile;
  const plan = await readPlanFile(options.planFile);
  let modified = false;

  // Update priority
  if (options.priority) {
    plan.priority = options.priority;
    modified = true;
    log(`Updated priority to ${options.priority}`);
  }

  // Update status
  if (options.status) {
    plan.status = options.status;
    modified = true;
    log(`Updated status to ${options.status}`);
  }

  // Add dependencies
  if (options.dependsOn && options.dependsOn.length > 0) {
    if (!plan.dependencies) {
      plan.dependencies = [];
    }
    for (const dep of options.dependsOn) {
      if (!plan.dependencies.includes(dep)) {
        plan.dependencies.push(dep);
        modified = true;
        log(`Added dependency: ${dep}`);
      } else {
        log(`Dependency already exists: ${dep}`);
      }
    }
  }

  // Remove dependencies
  if (options.noDependsOn && options.noDependsOn.length > 0) {
    if (plan.dependencies) {
      const originalLength = plan.dependencies.length;
      plan.dependencies = plan.dependencies.filter((dep) => !options.noDependsOn!.includes(dep));
      if (plan.dependencies.length < originalLength) {
        modified = true;
        log(`Removed ${originalLength - plan.dependencies.length} dependencies`);
      }
    }
  }

  // Set parent
  if (options.parent !== undefined) {
    // Load all plans to check if parent exists
    // Use the directory of the current plan file as the search directory
    const config = await loadEffectiveConfig(globalOpts.config);
    const planDir = await resolveTasksDir(config);
    const { plans: allPlans } = await readAllPlans(planDir);

    const parentPlan = allPlans.get(options.parent);
    if (!parentPlan) {
      throw new Error(`Parent plan with ID ${options.parent} not found`);
    }

    plan.parent = options.parent;
    modified = true;
    log(`Set parent to ${options.parent}`);
  }

  // Remove parent
  if (options.noParent) {
    if (plan.parent !== undefined) {
      delete plan.parent;
      modified = true;
      log('Removed parent');
    } else {
      log('No parent to remove');
    }
  }

  // Update properties using shared function
  const propertiesModified = updatePlanProperties(plan, {
    rmfilter: options.rmfilter,
    issue: options.issue,
    doc: options.doc,
    assign: options.assign,
  });
  if (propertiesModified) {
    modified = true;
  }

  // Remove issue URLs
  if (options.noIssue && options.noIssue.length > 0) {
    if (plan.issue) {
      const originalLength = plan.issue.length;
      plan.issue = plan.issue.filter((url) => !options.noIssue!.includes(url));
      if (plan.issue.length < originalLength) {
        modified = true;
        log(`Removed ${originalLength - plan.issue.length} issue URLs`);
      }
    }
  }

  // Remove documentation paths
  if (options.noDoc && options.noDoc.length > 0) {
    if (plan.docs) {
      const originalLength = plan.docs.length;
      plan.docs = plan.docs.filter((url: string) => !options.noDoc!.includes(url));
      if (plan.docs.length < originalLength) {
        modified = true;
        log(`Removed ${originalLength - plan.docs.length} documentation paths`);
      }
    }
  }

  // Remove assignedTo
  if (options.noAssign) {
    if (plan.assignedTo !== undefined) {
      delete plan.assignedTo;
      modified = true;
      log('Removed assignedTo');
    } else {
      log('No assignedTo to remove');
    }
  }

  if (modified) {
    plan.updatedAt = new Date().toISOString();
    await writePlanFile(options.planFile, plan);
    log(`Plan ${options.planFile} updated successfully`);
  } else {
    log('No changes made');
  }
}
