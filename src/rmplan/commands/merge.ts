import { unlink } from 'node:fs/promises';
import { relative, join, isAbsolute } from 'node:path';
import { getGitRoot } from '../../common/git.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { readAllPlans, readPlanFile, resolvePlanFile, writePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { log, warn } from '../../logging.js';

interface MergeOptions {
  children?: string[];
  all?: boolean;
}

export async function handleMergeCommand(
  planFile: string,
  options: MergeOptions,
  command: any
) {
  const globalOpts = command.parent.opts();
  const gitRoot = (await getGitRoot()) || process.cwd();
  const config = await loadEffectiveConfig(globalOpts.config);
  
  let tasksDir: string;
  if (config.paths?.tasks) {
    tasksDir = isAbsolute(config.paths.tasks)
      ? config.paths.tasks
      : join(gitRoot, config.paths.tasks);
  } else {
    tasksDir = gitRoot;
  }

  // Resolve the main plan file
  const resolvedPlanFile = await resolvePlanFile(planFile, globalOpts.config);
  const mainPlan = await readPlanFile(resolvedPlanFile);

  if (!mainPlan.id) {
    throw new Error('Main plan must have an ID');
  }

  // Read all plans to find children and handle updates
  const { plans } = await readAllPlans(tasksDir);

  // Find all direct children of the main plan and sort by ID for consistent ordering
  const allChildren = Array.from(plans.values())
    .filter((plan) => plan.parent === mainPlan.id)
    .sort((a, b) => (a.id || 0) - (b.id || 0));

  if (allChildren.length === 0) {
    log('No child plans found to merge');
    return;
  }

  // Determine which children to merge
  let childrenToMerge: (PlanSchema & { filename: string })[];
  
  if (options.children && options.children.length > 0) {
    // Merge specific children by ID or filename
    childrenToMerge = [];
    for (const childArg of options.children) {
      // Try to parse as number for ID lookup
      const childId = Number(childArg);
      let child: (PlanSchema & { filename: string }) | undefined;
      
      if (!isNaN(childId)) {
        child = allChildren.find((c) => c.id === childId);
      }
      
      // If not found by ID, try by filename
      if (!child) {
        const childPath = await resolvePlanFile(childArg, globalOpts.config).catch(() => null);
        if (childPath) {
          child = allChildren.find((c) => c.filename === childPath);
        }
      }
      
      if (!child) {
        throw new Error(`Child plan not found: ${childArg}`);
      }
      
      childrenToMerge.push(child);
    }
  } else {
    // Default to merging all direct children
    childrenToMerge = allChildren;
  }

  if (childrenToMerge.length === 0) {
    log('No matching child plans to merge');
    return;
  }

  log(`Merging ${childrenToMerge.length} child plan(s) into ${mainPlan.title || `Plan ${mainPlan.id}`}`);

  // Collect all dependencies from children
  const allChildDependencies = new Set<number>();
  for (const child of childrenToMerge) {
    if (child.dependencies) {
      for (const dep of child.dependencies) {
        // Don't add the main plan itself as a dependency
        if (dep !== mainPlan.id) {
          allChildDependencies.add(dep);
        }
      }
    }
  }

  // Merge tasks from children into main plan
  const mergedTasks = [...(mainPlan.tasks || [])];
  const mergedDetails: string[] = [];
  
  if (mainPlan.details) {
    mergedDetails.push(mainPlan.details);
  }

  for (const child of childrenToMerge) {
    // Add child's title as a section header in details
    if (child.title || child.goal) {
      mergedDetails.push(`\n## ${child.title || child.goal}`);
    }
    
    // Add child's details
    if (child.details) {
      mergedDetails.push(child.details);
    }
    
    // Merge tasks
    if (child.tasks) {
      mergedTasks.push(...child.tasks);
    }
  }

  // Update the main plan
  mainPlan.tasks = mergedTasks;
  if (mergedDetails.length > 0) {
    mainPlan.details = mergedDetails.join('\n\n');
  }

  // Add child dependencies to main plan
  if (allChildDependencies.size > 0) {
    const existingDeps = new Set(mainPlan.dependencies || []);
    for (const dep of allChildDependencies) {
      existingDeps.add(dep);
    }
    mainPlan.dependencies = Array.from(existingDeps).sort((a, b) => a - b);
  }

  // Update the main plan's updatedAt timestamp
  mainPlan.updatedAt = new Date().toISOString();

  // Find grandchildren (children of the merged children) and update their parent
  const childIds = new Set(childrenToMerge.map((c) => c.id).filter(Boolean));
  const grandchildren = Array.from(plans.values()).filter(
    (plan) => plan.parent && childIds.has(plan.parent)
  );

  // Update grandchildren to point to the main plan
  for (const grandchild of grandchildren) {
    grandchild.parent = mainPlan.id;
    grandchild.updatedAt = new Date().toISOString();
    await writePlanFile(grandchild.filename, grandchild);
    log(`Updated parent of ${grandchild.title || `Plan ${grandchild.id}`} to main plan`);
  }

  // Save the updated main plan
  await writePlanFile(resolvedPlanFile, mainPlan);
  log(`Updated main plan: ${relative(gitRoot, resolvedPlanFile)}`);

  // Delete the merged child plan files
  for (const child of childrenToMerge) {
    try {
      await unlink(child.filename);
      log(`Deleted merged child plan: ${relative(gitRoot, child.filename)}`);
    } catch (err) {
      warn(`Failed to delete child plan file ${child.filename}: ${err as Error}`);
    }
  }

  log(`Successfully merged ${childrenToMerge.length} child plan(s) into ${mainPlan.title || `Plan ${mainPlan.id}`}`);
}