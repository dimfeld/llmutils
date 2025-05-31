import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as path from 'node:path';
import * as yaml from 'yaml';
import { phaseSchema, type PlanSchema } from './planSchema.js';
import { loadEffectiveConfig } from './configLoader.js';
import { getGitRoot } from '../rmfilter/utils.js';
import { debugLog } from '../logging.js';
import { generateProjectId } from './id_utils.js';

export type PlanSummary = {
  id: string;
  title?: string;
  status?: 'pending' | 'in_progress' | 'done';
  priority?: 'low' | 'medium' | 'high' | 'urgent';
  dependencies?: string[];
  goal: string;
  createdAt?: string;
  updatedAt?: string;
  filename: string;
  taskCount?: number;
  stepCount?: number;
  hasPrompts?: boolean;
  project?: {
    title: string;
    goal: string;
    details: string;
  };
};

export async function readAllPlans(directory: string): Promise<Map<string, PlanSummary>> {
  const plans = new Map<string, PlanSummary>();
  const promises: Promise<void>[] = [];

  debugLog(`Starting to scan directory for plan files: ${directory}`);

  async function readFile(fullPath: string) {
    debugLog(`Reading plan file: ${fullPath}`);
    try {
      const content = await Bun.file(fullPath).text();
      const parsed = yaml.parse(content);

      const result = phaseSchema.safeParse(parsed);
      if (result.success) {
        const plan = result.data;
        // Only add plans that have an ID. Legacy plans are only created as they're executed so will rarely be in
        // progress
        if (!plan.id) {
          return;
        }

        debugLog(`Successfully parsed plan with ID: ${plan.id} from ${fullPath}`);

        // Count tasks and steps, check for prompts
        let taskCount = 0;
        let stepCount = 0;
        let hasPrompts = false;

        if (plan.tasks) {
          taskCount = plan.tasks.length;
          for (const task of plan.tasks) {
            if (task.steps) {
              stepCount += task.steps.length;
              // Check if any step has a prompt
              if (
                !hasPrompts &&
                task.steps.some((step) => step.prompt && step.prompt.trim() !== '')
              ) {
                hasPrompts = true;
              }
            }
          }
        }

        plans.set(plan.id, {
          id: plan.id,
          title: plan.title,
          status: plan.status,
          priority: plan.priority,
          dependencies: plan.dependencies,
          goal: plan.goal,
          filename: fullPath,
          createdAt: plan.createdAt,
          updatedAt: plan.updatedAt,
          taskCount,
          stepCount,
          hasPrompts,
          project: plan.project,
        });
      } else {
        // Log validation errors
        debugLog(`Schema validation failed for ${fullPath}:`);
        result.error.issues.forEach((issue) => {
          debugLog(`  - ${issue.path.join('.')}: ${issue.message}`);
        });
      }
    } catch (error) {
      // Log detailed error information
      console.error(`Failed to read plan from ${fullPath}:`, error);
      if (error instanceof Error) {
        debugLog(`Error details: ${error.message}`);
        if (error.stack) {
          debugLog(`Stack trace: ${error.stack}`);
        }
      }
    }
  }

  async function scanDirectory(dir: string) {
    debugLog(`Scanning directory: ${dir}`);
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        debugLog(`Found subdirectory: ${fullPath}`);
        await scanDirectory(fullPath);
      } else if (entry.isFile() && (entry.name.endsWith('.yml') || entry.name.endsWith('.yaml'))) {
        debugLog(`Found YAML file: ${fullPath}`);
        promises.push(readFile(fullPath));
      } else {
        debugLog(`Skipping non-YAML file: ${fullPath}`);
      }
    }
  }

  await scanDirectory(directory);
  await Promise.all(promises);
  debugLog(`Finished scanning directory. Found ${plans.size} plans with valid IDs`);
  return plans;
}

/**
 * Resolves a plan argument which can be either a file path or a plan ID.
 * If the argument is a file path that exists, returns the absolute path.
 * If the argument looks like a plan ID, searches for a matching plan in the tasks directory.
 *
 * @param planArg - The plan file path or plan ID
 * @param configPath - Optional path to rmplan config file
 * @returns The resolved absolute file path
 * @throws Error if the plan cannot be found
 */
export async function resolvePlanFile(planArg: string, configPath?: string): Promise<string> {
  // First, check if it's a file path that exists
  try {
    const absolutePath = resolve(planArg);
    await stat(absolutePath);
    return absolutePath;
  } catch {
    // Not a valid file path, continue to check if it's a plan ID
  }

  // If the argument contains path separators or file extensions, it's likely a file path
  if (planArg.includes('/') || planArg.includes('\\') || planArg.includes('.')) {
    // It was meant to be a file path but doesn't exist
    throw new Error(`Plan file not found: ${planArg}`);
  }

  // Try to find by plan ID
  const config = await loadEffectiveConfig(configPath);
  const gitRoot = (await getGitRoot()) || process.cwd();

  let tasksDir: string;
  if (config.paths?.tasks) {
    tasksDir = path.isAbsolute(config.paths.tasks)
      ? config.paths.tasks
      : path.join(gitRoot, config.paths.tasks);
  } else {
    tasksDir = gitRoot;
  }

  const plans = await readAllPlans(tasksDir);
  const matchingPlan = plans.get(planArg);

  if (matchingPlan) {
    return matchingPlan.filename;
  }

  throw new Error(`No plan found with ID or file path: ${planArg}`);
}

export type PlanFilterOptions = {
  includePending?: boolean;
  includeInProgress?: boolean;
};

/**
 * Finds the next plan based on filter options.
 * By default finds pending plans only (for backward compatibility).
 *
 * A plan is ready if:
 * - Its status matches the filter options
 * - All its dependencies have status 'done'
 *
 * Plans are prioritized by:
 * 1. Status (in_progress > pending) when both are included
 * 2. Priority (urgent > high > medium > low > undefined)
 * 3. ID (alphabetically)
 *
 * @param directory - The directory to search for plans
 * @param options - Filter options for status types to include
 * @returns The highest priority plan matching criteria, or null if none found
 */
export async function findNextPlan(
  directory: string,
  options: PlanFilterOptions = { includePending: true }
): Promise<PlanSummary | null> {
  const plans = await readAllPlans(directory);

  // Convert to array and filter based on options
  let candidates = Array.from(plans.values()).filter((plan) => {
    const status = plan.status || 'pending';

    if (options.includeInProgress && status === 'in_progress') {
      return true;
    }
    if (options.includePending && status === 'pending') {
      return true;
    }
    return false;
  });

  // Check dependencies for each candidate
  const readyCandidates = candidates.filter((plan) => {
    const status = plan.status || 'pending';

    // In-progress plans are always ready
    if (status === 'in_progress') {
      return true;
    }

    // For pending plans, check dependencies
    if (!plan.dependencies || plan.dependencies.length === 0) {
      // No dependencies, so it's ready
      return true;
    }

    // Check if all dependencies are done
    return plan.dependencies.every((depId) => {
      const depPlan = plans.get(depId);
      return depPlan && depPlan.status === 'done';
    });
  });

  if (readyCandidates.length === 0) {
    return null;
  }

  // Sort by status first (if both types included), then priority, then by ID
  readyCandidates.sort((a, b) => {
    // Status order - in_progress comes first (only when both types are included)
    if (options.includeInProgress && options.includePending) {
      const aStatus = a.status || 'pending';
      const bStatus = b.status || 'pending';

      if (aStatus !== bStatus) {
        // in_progress should come before pending
        if (aStatus === 'in_progress') return -1;
        if (bStatus === 'in_progress') return 1;
      }
    }

    // Define priority order - higher number means higher priority
    const priorityOrder: Record<string, number> = { urgent: 4, high: 3, medium: 2, low: 1 };
    const aPriority = a.priority ? priorityOrder[a.priority] || 0 : 0;
    const bPriority = b.priority ? priorityOrder[b.priority] || 0 : 0;

    // Sort by priority descending (highest first)
    if (aPriority !== bPriority) {
      return bPriority - aPriority;
    }

    // If priorities are the same, sort by ID ascending
    const aId = a.id || '';
    const bId = b.id || '';
    return aId.localeCompare(bId);
  });

  return readyCandidates[0];
}

/**
 * Finds the next plan that is ready to be implemented.
 * @deprecated Use findNextPlan with { includePending: true } instead
 */
export async function findNextReadyPlan(directory: string): Promise<PlanSummary | null> {
  return findNextPlan(directory, { includePending: true });
}

/**
 * Finds the next plan that is currently being worked on or ready to be implemented.
 * @deprecated Use findNextPlan with { includePending: true, includeInProgress: true } instead
 */
export async function findCurrentPlan(directory: string): Promise<PlanSummary | null> {
  return findNextPlan(directory, { includePending: true, includeInProgress: true });
}
