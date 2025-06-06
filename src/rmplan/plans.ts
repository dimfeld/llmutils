import { readdir, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { join, resolve } from 'node:path';
import * as yaml from 'yaml';
import { debugLog } from '../logging.js';
import { getGitRoot } from '../common/git.js';
import { loadEffectiveConfig } from './configLoader.js';
import { phaseSchema, type PlanSchema } from './planSchema.js';

export type PlanSummary = {
  id: string | number;
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

let cachedPlans = new Map<
  string,
  { plans: Map<string | number, PlanSummary>; maxNumericId: number; duplicates: (string | number)[] }
>();

/**
 * Clears the plan cache. This is primarily for testing purposes.
 */
export function clearPlanCache(): void {
  cachedPlans.clear();
}

export async function readAllPlans(
  directory: string,
  readCache = true
): Promise<{ plans: Map<string | number, PlanSummary>; maxNumericId: number; duplicates: (string | number)[] }> {
  let existing = readCache ? cachedPlans.get(directory) : undefined;
  if (existing) {
    return existing;
  }

  const plans = new Map<string | number, PlanSummary>();
  const promises: Promise<void>[] = [];
  let maxNumericId = 0;
  const duplicates: (string | number)[] = [];
  const seenIds = new Set<string | number>();

  debugLog(`Starting to scan directory for plan files: ${directory}`);

  async function readFile(fullPath: string) {
    debugLog(`Reading plan file: ${fullPath}`);
    try {
      const plan = await readPlanFile(fullPath);

      // Only add plans that have an ID. Legacy plan files would not.
      if (!plan.id) {
        return;
      }

      debugLog(`Successfully parsed plan with ID: ${plan.id} from ${fullPath}`);

      // Determine if the ID is numeric
      let idKey: string | number = plan.id;
      let summaryId: string | number = plan.id;

      if (typeof plan.id === 'number') {
        // ID is already a number
        idKey = plan.id;
        summaryId = plan.id;
        if (plan.id > maxNumericId) {
          maxNumericId = plan.id;
        }
      } else if (typeof plan.id === 'string' && /^\d+$/.test(plan.id)) {
        // ID is a string that represents a number
        const numericId = parseInt(plan.id, 10);
        idKey = numericId;
        summaryId = numericId;
        if (numericId > maxNumericId) {
          maxNumericId = numericId;
        }
      }

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

      // Check for duplicate IDs
      if (seenIds.has(idKey)) {
        if (!duplicates.includes(idKey)) {
          duplicates.push(idKey);
        }
      } else {
        seenIds.add(idKey);
      }

      plans.set(idKey, {
        id: summaryId,
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
    } catch (error) {
      if ((error as Error).name !== 'PlanFileError') {
        // Log detailed error information
        console.error(`Failed to read plan from ${fullPath}:`, error);
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
  const retVal = { plans, maxNumericId, duplicates };
  cachedPlans.set(directory, retVal);
  return retVal;
}

/**
 * Gets the maximum numeric plan ID from the tasks directory.
 * @param tasksDir - The directory containing plan files
 * @returns The maximum numeric ID found, or 0 if none exist
 */
export async function getMaxNumericPlanId(tasksDir: string): Promise<number> {
  const { maxNumericId } = await readAllPlans(tasksDir);
  return maxNumericId;
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

  // Get the tasks directory configuration
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

  // If it's just a filename (no path separators), check in the tasks directory
  if (!planArg.includes('/') && !planArg.includes('\\') && planArg.includes('.')) {
    const potentialPath = path.join(tasksDir, planArg);
    try {
      await stat(potentialPath);
      return potentialPath;
    } catch {
      // File doesn't exist in tasks directory
    }
  }

  // If the argument contains path separators, it's likely a file path
  if (planArg.includes('/') || planArg.includes('\\')) {
    // It was meant to be a file path but doesn't exist
    throw new Error(`Plan file not found: ${planArg}`);
  }

  // Try to parse planArg as a number
  const numericPlanArg = Number(planArg);

  // Read all plans and search by ID
  const { plans, duplicates } = await readAllPlans(tasksDir);

  // Check if the requested plan ID is a duplicate
  const planId = !isNaN(numericPlanArg) ? numericPlanArg : planArg;
  if (duplicates.includes(planId)) {
    throw new Error(`Plan ID ${planId} is duplicated in multiple files. Please run 'rmplan renumber' to fix this issue.`);
  }

  // If we successfully parsed as a number, try numeric lookup first
  if (!isNaN(numericPlanArg)) {
    const matchingPlan = plans.get(numericPlanArg);
    if (matchingPlan) {
      return matchingPlan.filename;
    }
  }

  // Try string lookup (for both string IDs and numeric string IDs that weren't found above)
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
  const { plans } = await readAllPlans(directory);

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
      // Try to get the dependency plan by string ID first
      let depPlan = plans.get(depId);

      // If not found and the dependency ID is a numeric string, try as a number
      if (!depPlan && typeof depId === 'string' && /^\d+$/.test(depId)) {
        depPlan = plans.get(parseInt(depId, 10));
      }

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

    // Handle both string and numeric IDs
    if (typeof aId === 'number' && typeof bId === 'number') {
      return aId - bId;
    } else if (typeof aId === 'number') {
      return -1; // Numeric IDs come before string IDs
    } else if (typeof bId === 'number') {
      return 1; // Numeric IDs come before string IDs
    } else {
      return aId.localeCompare(bId);
    }
  });

  return readyCandidates[0];
}

/**
 * Collects all dependencies of a plan in topological order (dependencies first).
 * This ensures that when executing plans, dependencies are completed before their dependents.
 *
 * @param planId - The ID of the plan to collect dependencies for
 * @param allPlans - Map of all available plans
 * @param visited - Set of already visited plan IDs (to detect cycles)
 * @returns Array of plan summaries in execution order
 * @throws Error if a circular dependency is detected
 */
/**
 * Checks if a plan is ready to be executed.
 * A plan is ready if:
 * - Its status is 'pending' (or not set)
 * - All its dependencies have status 'done'
 */
export function isPlanReady(
  plan: PlanSummary,
  allPlans: Map<string | number, PlanSummary>
): boolean {
  const status = plan.status || 'pending';

  // Only pending plans can be "ready"
  if (status !== 'pending') {
    return false;
  }

  if (!plan.taskCount) {
    return false;
  }

  // If no dependencies, it's ready
  if (!plan.dependencies || plan.dependencies.length === 0) {
    return true;
  }

  // Check if all dependencies are done
  return plan.dependencies.every((depId) => {
    // Try to get the dependency plan by string ID first
    let depPlan = allPlans.get(depId);

    // If not found and the dependency ID is a numeric string, try as a number
    if (!depPlan && typeof depId === 'string' && /^\d+$/.test(depId)) {
      depPlan = allPlans.get(parseInt(depId, 10));
    }

    return depPlan && depPlan.status === 'done';
  });
}

export async function collectDependenciesInOrder(
  planId: string | number,
  allPlans: Map<string | number, PlanSummary>,
  visited: Set<string | number> = new Set()
): Promise<PlanSummary[]> {
  // Check for circular dependencies
  if (visited.has(planId)) {
    throw new Error(
      `Circular dependency detected: ${Array.from(visited).join(' -> ')} -> ${planId}`
    );
  }

  const plan = allPlans.get(planId);
  if (!plan) {
    throw new Error(`Plan not found: ${planId}`);
  }

  // Mark this plan as visited
  visited.add(planId);

  const result: PlanSummary[] = [];

  // First, collect all dependencies
  if (plan.dependencies && plan.dependencies.length > 0) {
    for (const depId of plan.dependencies) {
      const depPlan = allPlans.get(depId);
      if (!depPlan) {
        throw new Error(`Dependency not found: ${depId} (required by ${planId})`);
      }

      // Skip dependencies that are already done
      if (depPlan.status === 'done') {
        continue;
      }

      // Recursively collect dependencies of this dependency
      const subDeps = await collectDependenciesInOrder(depId, allPlans, new Set(visited));

      // Add sub-dependencies that aren't already in our result
      for (const subDep of subDeps) {
        if (!result.some((p) => p.id === subDep.id)) {
          result.push(subDep);
        }
      }
    }
  }

  // Finally, add the current plan itself (if not done)
  if (plan.status !== 'done' && !result.some((p) => p.id === plan.id)) {
    result.push(plan);
  }

  return result;
}

/**
 * Reads a plan YAML file and validates it with the plan schema.
 * @param filePath - The path to the plan YAML file
 * @returns The validated plan data
 * @throws Error if the file cannot be read or validation fails
 */
export async function readPlanFile(filePath: string): Promise<PlanSchema> {
  const absolutePath = resolve(filePath);
  const content = await Bun.file(absolutePath).text();
  const parsed = yaml.parse(content);

  const result = phaseSchema.safeParse(parsed);
  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    let e = new Error(`Invalid plan file ${filePath}:\n${errors}`);
    e.name = 'PlanFileError';
    throw e;
  }

  return result.data;
}

/**
 * Writes a plan to a YAML file with the yaml-language-server schema line.
 * @param filePath - The path where to write the YAML file
 * @param plan - The plan data to write
 */
export async function writePlanFile(filePath: string, plan: PlanSchema): Promise<void> {
  const absolutePath = resolve(filePath);

  // Validate the plan before writing
  const result = phaseSchema.safeParse(plan);
  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid plan data:\n${errors}`);
  }

  // Convert to YAML with proper formatting
  const yamlContent = yaml.stringify(result.data);

  // Add the yaml-language-server schema line at the top
  const schemaLine =
    '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json\n';
  const fullContent = schemaLine + yamlContent;

  await Bun.write(absolutePath, fullContent);
}

/**
 * Updates the status and updatedAt fields of a plan file.
 *
 * @param planFilePath - The path to the plan YAML file
 * @param newStatus - The new status to set
 * @throws Error if the file cannot be read, parsed, or validated
 */
export async function setPlanStatus(
  planFilePath: string,
  newStatus: PlanSchema['status']
): Promise<void> {
  // Read the content of the plan file
  const plan = await readPlanFile(planFilePath);
  plan.status = newStatus;
  plan.updatedAt = new Date().toISOString();
  await writePlanFile(planFilePath, plan);

  debugLog(`Updated plan status in ${planFilePath} to ${newStatus}`);
}
