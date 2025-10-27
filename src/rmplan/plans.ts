import { stat } from 'node:fs/promises';
import * as path from 'node:path';
import { Glob } from 'bun';
import { join, resolve } from 'node:path';
import * as yaml from 'yaml';
import { debugLog, warn } from '../logging.js';
import { getGitRoot, getTrunkBranch, getUsingJj } from '../common/git.js';
import { loadEffectiveConfig } from './configLoader.js';
import { resolveTasksDir } from './configSchema.js';
import { resolvePlanPathContext } from './path_resolver.js';
import { phaseSchema, type PlanSchema, type PlanSchemaInput } from './planSchema.js';
import { createModel } from '../common/model_factory.js';
import { generateText } from 'ai';
import { $ } from 'bun';

export type PlanSummary = {
  id: number;
  uuid?: string;
  title?: string;
  status?: 'pending' | 'in_progress' | 'done' | 'cancelled';
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
  {
    plans: Map<number, PlanSchema & { filename: string }>;
    maxNumericId: number;
    duplicates: Record<number, string[]>;
  }
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
): Promise<{
  plans: Map<number, PlanSchema & { filename: string }>;
  maxNumericId: number;
  duplicates: Record<number, string[]>;
}> {
  let existing = readCache ? cachedPlans.get(directory) : undefined;
  if (existing) {
    return existing;
  }

  const plans = new Map<number, PlanSchema & { filename: string }>();
  const promises: Promise<void>[] = [];
  let maxNumericId = 0;
  const seenIds = new Map<number, string[]>();

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
      let idKey: number = plan.id;
      let summaryId: number = plan.id;

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

      // Track all files for each ID
      if (seenIds.has(idKey)) {
        seenIds.get(idKey)!.push(fullPath);
      } else {
        seenIds.set(idKey, [fullPath]);
      }

      plans.set(idKey, {
        ...plan,
        id: summaryId, // Use the converted ID (numeric if it was a numeric string)
        filename: fullPath,
      });
    } catch (error) {
      if ((error as Error).name !== 'PlanFileError') {
        // Log detailed error information
        console.error(`Failed to read plan from ${fullPath}:`, error);
      }
    }
  }

  const glob = new Glob('**/*.{plan.md,yml,yaml}');
  for await (const entry of glob.scan(directory)) {
    const fullPath = join(directory, entry);
    promises.push(readFile(fullPath));
  }

  // await scanDirectory(directory);
  await Promise.all(promises);
  debugLog(`Finished scanning directory. Found ${plans.size} plans with valid IDs`);

  // Build duplicates object from seenIds - only include IDs that have more than one file
  const duplicates: Record<number, string[]> = {};
  for (const [id, files] of seenIds.entries()) {
    if (files.length > 1) {
      duplicates[id] = files;
    }
  }

  const retVal = { plans, maxNumericId, duplicates };
  cachedPlans.set(directory, retVal);
  return retVal;
}

/**
 * Get all plans that depend on this plan (inverse of dependencies)
 * @param planId - The plan ID to find dependents for
 * @param allPlans - Map of all plans
 * @returns Array of plans that list planId in their dependencies
 */
export function getBlockedPlans(
  planId: number,
  allPlans: Map<number, PlanSchema & { filename: string }>
): Array<PlanSchema & { filename: string }> {
  return Array.from(allPlans.values()).filter((plan) => plan.dependencies?.includes(planId));
}

/**
 * Get all child plans (inverse of parent)
 * @param planId - The parent plan ID
 * @param allPlans - Map of all plans
 * @returns Array of plans that have planId as their parent
 */
export function getChildPlans(
  planId: number,
  allPlans: Map<number, PlanSchema & { filename: string }>
): Array<PlanSchema & { filename: string }> {
  return Array.from(allPlans.values()).filter((plan) => plan.parent === planId);
}

/**
 * Get plans discovered from this plan during research/implementation
 * @param planId - The source plan ID
 * @param allPlans - Map of all plans
 * @returns Array of plans that were discovered from planId
 */
export function getDiscoveredPlans(
  planId: number,
  allPlans: Map<number, PlanSchema & { filename: string }>
): Array<PlanSchema & { filename: string }> {
  return Array.from(allPlans.values()).filter((plan) => plan.discoveredFrom === planId);
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
  const tasksDir = await resolveTasksDir(config);

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

  // If no extension provided, try with .plan.md extension first (default), then .yml
  if (!planArg.includes('/') && !planArg.includes('\\') && !planArg.includes('.')) {
    // Try with .plan.md extension first
    const planMdPath = path.join(tasksDir, `${planArg}.plan.md`);
    try {
      await stat(planMdPath);
      return planMdPath;
    } catch {
      // Try with .yml extension
      const ymlPath = path.join(tasksDir, `${planArg}.yml`);
      try {
        await stat(ymlPath);
        return ymlPath;
      } catch {
        // Neither exists, continue to ID lookup
      }
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
  if (duplicates[numericPlanArg]) {
    throw new Error(
      `Plan ID ${numericPlanArg} is duplicated in multiple files. Please run 'rmplan renumber' to fix this issue.`
    );
  }

  // If we successfully parsed as a number, try numeric lookup first
  if (!isNaN(numericPlanArg)) {
    const matchingPlan = plans.get(numericPlanArg);
    if (matchingPlan) {
      return matchingPlan.filename;
    }
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
): Promise<(PlanSchema & { filename: string }) | null> {
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

    if (plan.priority === 'maybe') {
      return false;
    }

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
  plan: PlanSchema & { filename: string },
  allPlans: Map<number, PlanSchema & { filename: string }>
): boolean {
  const status = plan.status || 'pending';

  // Only pending plans can be "ready"
  if (status !== 'pending') {
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
  planId: number,
  allPlans: Map<number, PlanSchema & { filename: string }>,
  visited: Set<number> = new Set()
): Promise<(PlanSchema & { filename: string })[]> {
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

  const result: (PlanSchema & { filename: string })[] = [];

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
 * Reads a plan file and validates it with the plan schema.
 * Supports both pure YAML format and YAML front matter with markdown body.
 * @param filePath - The path to the plan file
 * @returns The validated plan data
 * @throws Error if the file cannot be read or validation fails
 */
export async function readPlanFile(filePath: string): Promise<PlanSchema> {
  const absolutePath = resolve(filePath);
  const content = await Bun.file(absolutePath).text();

  let parsed: any;
  let markdownBody: string | undefined;

  function parseYaml(content: string) {
    return yaml.parse(content, {
      uniqueKeys: false,
    });
  }

  // Check if the file uses front matter format
  if (content.startsWith('---\n')) {
    // Find the closing delimiter for front matter
    const endDelimiterIndex = content.indexOf('\n---\n', 4);

    if (endDelimiterIndex !== -1) {
      // Extract front matter and body
      const frontMatter = content.substring(4, endDelimiterIndex);
      markdownBody = content.substring(endDelimiterIndex + 5).trim();

      // Parse the front matter as YAML
      parsed = parseYaml(frontMatter);
    } else {
      // No closing delimiter found, treat entire file as YAML
      parsed = parseYaml(content);
    }
  } else {
    // No front matter, parse entire content as YAML
    parsed = parseYaml(content);
  }

  // Ensure parsed is a valid object
  if (!parsed || typeof parsed !== 'object') {
    parsed = {};
  }

  // If we have a markdown body, add it to the details field
  if (markdownBody) {
    // If there's already a details field in the YAML, combine them
    if (parsed.details) {
      parsed.details = parsed.details + '\n\n' + markdownBody;
    } else {
      parsed.details = markdownBody;
    }
  } else {
    parsed.details ??= '';
  }

  const result = phaseSchema.safeParse(parsed);
  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    let e = new Error(`Invalid plan file ${filePath}:\n${errors}`);
    e.name = 'PlanFileError';
    throw e;
  }

  const plan = result.data;

  if (!plan.uuid) {
    plan.uuid = crypto.randomUUID();
    try {
      await writePlanFile(absolutePath, plan);
    } catch (error) {
      warn(
        `Failed to persist generated UUID for plan at ${absolutePath}: ${(error as Error).message}`
      );
    }
  }

  return plan;
}

/**
 * Writes a plan to a YAML file with the yaml-language-server schema line.
 * @param filePath - The path where to write the YAML file
 * @param plan - The plan data to write
 */
export async function writePlanFile(
  filePath: string,
  input: PlanSchemaInput & { filename?: string }
): Promise<void> {
  const absolutePath = resolve(filePath);
  // Plans from readAllPlans will have a filename which we want to strip out
  const { filename: _, ...plan } = input;

  // Validate the plan before writing
  const result = phaseSchema.safeParse(plan);
  if (!result.success) {
    const errors = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid plan data:\n${errors}`);
  }

  result.data.updatedAt = new Date().toISOString();

  // Separate the details field from the rest of the plan
  const { details, ...planWithoutDetails } = result.data;

  // The yaml-language-server schema line
  const schemaLine =
    '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json';

  // Convert the plan (without details) to YAML with proper formatting
  const yamlContent = yaml.stringify(planWithoutDetails);

  // Construct the front matter format
  let fullContent = '---\n';
  fullContent += schemaLine + '\n';
  fullContent += yamlContent;
  fullContent += '---\n';

  // Add the details as the body if present
  if (details) {
    fullContent += '\n' + details;
    if (!details.endsWith('\n')) {
      fullContent += '\n';
    }
  }

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

export async function generateSuggestedFilename(
  planText: string,
  suffix?: string
): Promise<string> {
  try {
    // Extract first 500 characters of the plan for context
    const planSummary = planText.slice(0, 500);

    const prompt = `Given this plan text, suggest a concise and descriptive filename (without extension).
The filename should:
- Be lowercase with hyphens between words
- Be descriptive of the main task or feature
- Be 3-8 words maximum
- Not include dates or version numbers

Plan text:
${planSummary}

Respond with ONLY the filename, nothing else.`;

    const model = await createModel('google/gemini-2.0-flash');
    const result = await generateText({
      model,
      prompt,
      maxTokens: 50,
      temperature: 0.3,
    });

    let filename = result.text
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    if (filename && suffix) {
      filename += suffix;
    }

    return filename;
  } catch (err) {
    // Fallback to default if model fails
    warn('Failed to generate filename suggestion:', err);
    return '';
  }
}

/**
 * Get all issue URLs that have already been imported by reading existing plan files
 *
 * @param tasksDir - Directory containing plan files
 * @returns Set of issue URLs that are already imported
 */
export async function getImportedIssueUrls(tasksDir: string): Promise<Set<string>> {
  const importedUrls = new Set<string>();

  try {
    const { plans } = await readAllPlans(tasksDir);

    for (const planSummary of plans.values()) {
      try {
        const planFile = await readPlanFile(planSummary.filename);
        if (planFile.issue && Array.isArray(planFile.issue)) {
          planFile.issue.forEach((url) => importedUrls.add(url));
        }
      } catch (err) {
        // Skip files that can't be read
        continue;
      }
    }
  } catch (err) {
    // If we can't read plans, just return empty set
  }

  return importedUrls;
}

export function isTaskDone(task: PlanSchema['tasks'][0]): boolean {
  return task.done || ((task.steps?.length ?? 0) > 0 && task.steps.every((step) => step.done));
}

/**
 * Gets plan files that exist only on the current branch (not on the trunk branch).
 * This is useful for finding plans created specifically for the current work.
 *
 * @param gitRoot - The git repository root
 * @param tasksDir - Directory containing plan files
 * @returns Array of plan file paths that are new on the current branch
 */
export async function getNewPlanFilesOnBranch(
  gitRoot: string,
  tasksDir: string
): Promise<string[]> {
  const trunkBranch = await getTrunkBranch(gitRoot);
  const isJj = await getUsingJj();

  let newFiles: string[] = [];

  if (isJj) {
    // Use jj to find new files
    const from = `latest(ancestors(${trunkBranch})&ancestors(@))`;
    const output = await $`jj diff --from ${from} --types`.cwd(gitRoot).nothrow().text();

    // Look for lines like "-F some/file.yml" which means file was added
    const lines = output.split('\n');
    for (const line of lines) {
      if (line.startsWith('-F ')) {
        const filePath = line.slice(3).trim();
        if (filePath.match(/\.(plan\.md|yml|yaml)$/)) {
          // Check if file is in tasks directory
          const fullPath = path.join(gitRoot, filePath);
          if (fullPath.startsWith(tasksDir)) {
            newFiles.push(fullPath);
          }
        }
      }
    }
  } else {
    // Use git to find new files
    const output = await $`git diff --name-status ${trunkBranch}`.cwd(gitRoot).nothrow().text();

    // Look for lines like "A some/file.yml" which means file was added
    const lines = output.split('\n');
    for (const line of lines) {
      if (line.startsWith('A\t')) {
        const filePath = line.slice(2).trim();
        if (filePath.match(/\.(plan\.md|yml|yaml)$/)) {
          // Check if file is in tasks directory
          const fullPath = path.join(gitRoot, filePath);
          if (fullPath.startsWith(tasksDir)) {
            newFiles.push(fullPath);
          }
        }
      }
    }
  }

  return newFiles;
}

/**
 * Finds plans that only exist on the current branch and selects the best candidate.
 * Plans are sorted by createdAt timestamp (oldest first), then by ID (lowest first).
 *
 * @param configPath - Optional path to rmplan config file
 * @returns The best plan candidate or null if none found
 */
export async function findBranchSpecificPlan(
  configPath?: string
): Promise<(PlanSchema & { filename: string }) | null> {
  const config = await loadEffectiveConfig(configPath);
  const { gitRoot, tasksDir } = await resolvePlanPathContext(config);

  // Get plan files that are new on this branch
  const newPlanFiles = await getNewPlanFilesOnBranch(gitRoot, tasksDir);

  if (newPlanFiles.length === 0) {
    return null;
  }

  // Read and parse the plan files
  const planCandidates: Array<PlanSchema & { filename: string }> = [];

  for (const filePath of newPlanFiles) {
    try {
      const planData = await readPlanFile(filePath);
      if (planData.id) {
        planCandidates.push({
          ...planData,
          filename: filePath,
        });
      }
    } catch (err) {
      // Skip files that can't be parsed
      debugLog(`Skipping unparseable plan file: ${filePath}`, err);
    }
  }

  if (planCandidates.length === 0) {
    return null;
  }

  // Sort by createdAt (oldest first), then by ID (lowest first)
  planCandidates.sort((a, b) => {
    // Compare by createdAt first if both have it
    if (a.createdAt && b.createdAt) {
      const aDate = new Date(a.createdAt);
      const bDate = new Date(b.createdAt);
      const dateComparison = aDate.getTime() - bDate.getTime();
      if (dateComparison !== 0) {
        return dateComparison;
      }
    } else if (a.createdAt && !b.createdAt) {
      return -1; // Plans with createdAt come first
    } else if (!a.createdAt && b.createdAt) {
      return 1; // Plans with createdAt come first
    }

    // If createdAt is equal or both missing, compare by ID
    const aId = a.id || 0;
    const bId = b.id || 0;

    if (typeof aId === 'number' && typeof bId === 'number') {
      return aId - bId;
    } else if (typeof aId === 'number') {
      return -1; // Numeric IDs come before string IDs
    } else if (typeof bId === 'number') {
      return 1; // Numeric IDs come before string IDs
    } else {
      return String(aId).localeCompare(String(bId));
    }
  });

  return planCandidates[0];
}
