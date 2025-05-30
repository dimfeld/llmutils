import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as path from 'node:path';
import * as yaml from 'yaml';
import { phaseSchema, type PlanSchema } from './planSchema.js';
import { loadEffectiveConfig } from './configLoader.js';
import { getGitRoot } from '../rmfilter/utils.js';

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
};

export async function readAllPlans(directory: string): Promise<Map<string, PlanSummary>> {
  const plans = new Map<string, PlanSummary>();
  const promises: Promise<void>[] = [];

  async function readFile(fullPath: string) {
    try {
      const content = await Bun.file(fullPath).text();
      const parsed = yaml.parse(content);

      const result = phaseSchema.safeParse(parsed);
      if (result.success) {
        const plan = result.data;
        // Only add plans that have an ID
        if (plan.id) {
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
          });
        }
      }
    } catch (error) {
      // Skip files that fail to parse or validate
      console.error(`Failed to read plan from ${fullPath}:`, error);
    }
  }

  async function scanDirectory(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        await scanDirectory(fullPath);
      } else if (entry.isFile() && (entry.name.endsWith('.yml') || entry.name.endsWith('.yaml'))) {
        promises.push(readFile(fullPath));
      }
    }
  }

  await scanDirectory(directory);
  await Promise.all(promises);
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

/**
 * Finds the next plan that is ready to be implemented.
 * A plan is ready if:
 * - Its status is 'pending' (or not set, which defaults to pending)
 * - All its dependencies have status 'done'
 *
 * Plans are prioritized by:
 * 1. Priority (urgent > high > medium > low > undefined)
 * 2. ID (alphabetically)
 *
 * @param directory - The directory to search for plans
 * @returns The highest priority ready plan, or null if none found
 */
export async function findNextReadyPlan(directory: string): Promise<PlanSummary | null> {
  const plans = await readAllPlans(directory);

  // Convert to array and filter for pending plans
  let candidates = Array.from(plans.values()).filter((plan) => {
    const status = plan.status || 'pending';
    return status === 'pending';
  });

  // Check dependencies for each candidate
  const readyCandidates = candidates.filter((plan) => {
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

  // Sort by priority first (highest priority first), then by ID
  readyCandidates.sort((a, b) => {
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
