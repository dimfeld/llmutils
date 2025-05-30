import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as yaml from 'yaml';
import { phaseSchema, type PlanSchema } from './planSchema.js';
import { loadEffectiveConfig } from './configLoader.js';

export type PlanSummary = {
  id: string;
  title?: string;
  status?: 'pending' | 'in_progress' | 'done';
  priority?: 'unknown' | 'low' | 'medium' | 'high' | 'urgent';
  dependencies?: string[];
  goal: string;
  createdAt?: string;
  updatedAt?: string;
  filename: string;
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
  const tasksDir = config.paths?.tasks || process.cwd();

  const plans = await readAllPlans(tasksDir);
  const matchingPlan = plans.get(planArg);

  if (matchingPlan) {
    return matchingPlan.filename;
  }

  throw new Error(`No plan found with ID or file path: ${planArg}`);
}
