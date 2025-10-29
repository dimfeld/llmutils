import path from 'path';
import { getGitRoot } from '../../common/git.js';
import { log, warn } from '../../logging.js';
import { readAllPlans, readPlanFile, writePlanFile, resolvePlanFile } from '../plans.js';
import { resolveTasksDir } from '../configSchema.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { updatePlanProperties } from '../planPropertiesUpdater.js';
import { wouldCreateCircularDependency } from './validate.js';
import { checkAndMarkParentDone } from './agent/parent_plans.js';
import { removeAssignment } from '../assignments/assignments_io.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import type { PlanSchema, Priority } from '../planSchema.js';

type Status = 'pending' | 'in_progress' | 'done' | 'cancelled' | 'deferred';

export interface SetOptions {
  planFile: string;
  priority?: Priority;
  status?: Status;
  statusDescription?: string;
  noStatusDescription?: boolean;
  dependsOn?: number[];
  noDependsOn?: number[];
  parent?: number;
  noParent?: boolean;
  discoveredFrom?: number;
  noDiscoveredFrom?: boolean;
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
  let shouldRemoveAssignment = false;

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

    // Clear status description when changing status unless explicitly provided
    if (!options.statusDescription && plan.statusDescription) {
      delete plan.statusDescription;
      log('Cleared status description (status changed)');
    }

    if (plan.parent && plan.status === 'done') {
      const config = await loadEffectiveConfig(globalOpts?.config);
      await checkAndMarkParentDone(plan.parent, config);
    }

    if (plan.uuid && (plan.status === 'done' || plan.status === 'cancelled')) {
      shouldRemoveAssignment = true;
    }
  }

  // Update status description
  if (options.statusDescription) {
    plan.statusDescription = options.statusDescription;
    modified = true;
    log(`Updated status description`);
  }

  // Remove status description
  if (options.noStatusDescription) {
    if (plan.statusDescription !== undefined) {
      delete plan.statusDescription;
      modified = true;
      log('Removed status description');
    } else {
      log('No status description to remove');
    }
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

  // Handle parent operations (set parent or remove parent)
  if (options.parent !== undefined || options.noParent) {
    // Load all plans once for both operations
    const config = await loadEffectiveConfig(globalOpts.config);
    const planDir = await resolveTasksDir(config);
    const { plans: allPlans } = await readAllPlans(planDir);

    const currentPlanId = plan.id;
    if (!currentPlanId) {
      throw new Error('Current plan has no ID');
    }

    // Set parent
    if (options.parent !== undefined) {
      const parentPlan = allPlans.get(options.parent);
      if (!parentPlan) {
        throw new Error(`Parent plan with ID ${options.parent} not found`);
      }

      // Check for circular dependencies before making any changes
      if (wouldCreateCircularDependency(allPlans, options.parent, currentPlanId)) {
        throw new Error(`Setting parent ${options.parent} would create a circular dependency`);
      }

      // Handle changing parents - remove from old parent's dependencies if it exists
      const oldParentId = plan.parent;
      if (oldParentId !== undefined && oldParentId !== options.parent) {
        const oldParentPlan = allPlans.get(oldParentId);
        if (oldParentPlan && oldParentPlan.dependencies) {
          const originalLength = oldParentPlan.dependencies.length;
          oldParentPlan.dependencies = oldParentPlan.dependencies.filter(
            (dep) => dep !== currentPlanId
          );
          if (oldParentPlan.dependencies.length < originalLength) {
            oldParentPlan.updatedAt = new Date().toISOString();
            await writePlanFile(oldParentPlan.filename, oldParentPlan);
            log(`Removed ${currentPlanId} from old parent ${oldParentId}'s dependencies`);
          }
        }
      }

      // Add this plan's ID to the parent's dependencies (if not already present)
      if (!parentPlan.dependencies) {
        parentPlan.dependencies = [];
      }
      if (!parentPlan.dependencies.includes(currentPlanId)) {
        parentPlan.dependencies.push(currentPlanId);
        parentPlan.updatedAt = new Date().toISOString();

        // Write the updated parent plan
        await writePlanFile(parentPlan.filename, parentPlan);
        log(`Updated parent plan ${options.parent} to include dependency on ${currentPlanId}`);
      }

      plan.parent = options.parent;
      modified = true;
      log(`Set parent to ${options.parent}`);
    }

    // Remove parent
    if (options.noParent) {
      if (plan.parent !== undefined) {
        const oldParentId = plan.parent;

        // Remove this plan from the old parent's dependencies
        const oldParentPlan = allPlans.get(oldParentId);
        if (oldParentPlan && oldParentPlan.dependencies) {
          const originalLength = oldParentPlan.dependencies.length;
          oldParentPlan.dependencies = oldParentPlan.dependencies.filter(
            (dep) => dep !== currentPlanId
          );
          if (oldParentPlan.dependencies.length < originalLength) {
            oldParentPlan.updatedAt = new Date().toISOString();
            await writePlanFile(oldParentPlan.filename, oldParentPlan);
            log(`Removed ${currentPlanId} from parent ${oldParentId}'s dependencies`);
          }
        }

        delete plan.parent;
        modified = true;
        log('Removed parent');
      } else {
        log('No parent to remove');
      }
    }
  }

  // Handle discoveredFrom operations (set discoveredFrom or remove discoveredFrom)
  if (options.discoveredFrom !== undefined) {
    plan.discoveredFrom = options.discoveredFrom;
    modified = true;
    log(`Set discoveredFrom to ${options.discoveredFrom}`);
  } else if (options.noDiscoveredFrom) {
    if (plan.discoveredFrom !== undefined) {
      delete plan.discoveredFrom;
      modified = true;
      log('Removed discoveredFrom');
    } else {
      log('No discoveredFrom to remove');
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

    if (shouldRemoveAssignment) {
      await removeAssignmentsForPlan(plan);
    }
  } else {
    log('No changes made');
  }
}

async function removeAssignmentsForPlan(plan: PlanSchema): Promise<void> {
  if (!plan.uuid) {
    return;
  }

  try {
    const repository = await getRepositoryIdentity();
    await removeAssignment({
      repositoryId: repository.repositoryId,
      repositoryRemoteUrl: repository.remoteUrl,
      uuid: plan.uuid,
    });
  } catch (error) {
    const planLabel = plan.id !== undefined ? `plan ${plan.id}` : `plan ${plan.uuid}`;
    warn(
      `Failed to remove assignment for ${planLabel}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}
