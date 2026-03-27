import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import * as path from 'node:path';
import * as yaml from 'yaml';
import chalk from 'chalk';
import * as z from 'zod/v4';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { createPlanSchemas, type PlanSchema } from '../planSchema.js';
import { readPlanFile, writePlanFile, writePlanToDb } from '../plans.js';
import { getLegacyAwareSearchDir, resolvePlanPathContext } from '../path_resolver.js';
import { loadPlansFromDb } from '../plans_db.js';
import {
  ensureReferences,
  verifyReferences,
  fixReferenceMismatches,
  detectMissingUuids,
  detectReferenceIssues,
  type ReferenceVerificationResult,
  fixMissingUuids,
  ensureAllReferences,
  fixReferenceIssues,
  type ReferenceFixResult,
  type ReferenceIssue,
  type UuidFixResult,
  type UuidIssue,
} from '../utils/references.js';
interface ValidationResult {
  filename: string;
  isValid: boolean;
  skipped?: boolean;
  errors?: string[];
  unknownKeys?: string[];
}

interface ParentChildInconsistency {
  parentId: number;
  parentFilename: string;
  childIds: number[];
}

interface FixResult {
  fixedRelationships: number;
  errors: string[];
}

interface DiscoveredFromIssue {
  planId: number;
  referencedPlanId: number;
  filename: string;
}

interface DiscoveredFromFixResult {
  cleared: Array<{ planId: number; referencedPlanId: number; filename: string }>;
  errors: string[];
}

interface ObsoleteKeyIssue {
  filename: string;
  planId?: number;
  taskIndices: number[];
  keysToRemove: string[];
}

interface ObsoleteKeyFixResult {
  fixedPlans: number;
  totalKeysRemoved: number;
  errors: string[];
}

interface ValidationPlanState {
  planMap: Map<number, PlanSchema & { filename: string }>;
  uuidToId: Map<string, number>;
  idToUuid: Map<number, string>;
}

const { phaseSchema: strictPhaseSchema } = createPlanSchemas((shape) =>
  z
    .object({
      ...shape,
      progressNotes: z.unknown().optional(),
      references: z.record(z.string(), z.string()).optional(),
    })
    .strict()
);

function validatePlanData(filename: string, parsed: Record<string, unknown>): ValidationResult {
  const result = strictPhaseSchema.safeParse(parsed);

  if (result.success) {
    return { filename, isValid: true };
  }

  const errors: string[] = [];
  const unknownKeys: string[] = [];

  result.error.issues.forEach((issue) => {
    if (issue.code === 'unrecognized_keys') {
      const basePath = issue.path.length > 0 ? issue.path.join('.') : '';
      issue.keys.forEach((key) => {
        const fullPath = basePath ? `${basePath}.${key}` : key;
        unknownKeys.push(fullPath);
      });
    } else {
      const path = issue.path.length > 0 ? issue.path.join('.') : 'root';
      errors.push(`${path}: ${issue.message}`);
    }
  });

  return {
    filename,
    isValid: false,
    errors: errors.length > 0 ? errors : undefined,
    unknownKeys: unknownKeys.length > 0 ? unknownKeys : undefined,
  };
}

function isDbOnlyPlan(filename: string): boolean {
  return !existsSync(filename);
}

async function writeValidationPlan(
  plan: PlanSchema & { filename: string },
  identityCwd: string
): Promise<void> {
  if (isDbOnlyPlan(plan.filename)) {
    await writePlanToDb(plan, {
      skipUpdatedAt: true,
      cwdForIdentity: identityCwd,
    });
    return;
  }

  await writePlanFile(plan.filename, plan, { skipUpdatedAt: true, cwdForIdentity: identityCwd });
}

async function validatePlanFile(filePath: string): Promise<ValidationResult> {
  const filename = path.basename(filePath);

  try {
    const content = await Bun.file(filePath).text();

    // Check for frontmatter - skip files without it
    if (!content.startsWith('---\n') || content.indexOf('\n---\n', 4) === -1) {
      return { filename, isValid: true, skipped: true };
    }

    let parsed: any;
    let markdownBody: string | undefined;

    // Find the closing delimiter for front matter
    const endDelimiterIndex = content.indexOf('\n---\n', 4);

    // Extract front matter and body
    const frontMatter = content.substring(4, endDelimiterIndex);
    markdownBody = content.substring(endDelimiterIndex + 5).trim();

    // Parse the front matter as YAML
    parsed = yaml.parse(frontMatter);

    // If we have a markdown body, add it to the details field
    if (markdownBody) {
      // If there's already a details field in the YAML, combine them
      if (parsed.details) {
        parsed.details = parsed.details + '\n\n' + markdownBody;
      } else {
        parsed.details = markdownBody;
      }
    }

    // Skip files marked as not_tim
    if (parsed.not_tim) {
      return { filename, isValid: true, skipped: true };
    }

    return validatePlanData(filename, parsed);
  } catch (error) {
    return {
      filename,
      isValid: false,
      errors: [
        `Failed to read or parse file: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

async function loadValidationPlanState(
  searchDir: string,
  repositoryId: string,
  planFiles: string[]
): Promise<ValidationPlanState> {
  const dbPlans = loadPlansFromDb(searchDir, repositoryId).plans;
  const planMap = new Map<number, PlanSchema & { filename: string }>();
  const uuidToCurrentId = new Map<string, number>();

  for (const [planId, plan] of dbPlans.entries()) {
    planMap.set(planId, plan);
    if (plan.uuid) {
      uuidToCurrentId.set(plan.uuid, planId);
    }
  }

  for (const filePath of planFiles) {
    try {
      const plan = await readPlanFile(filePath);
      if (
        plan.not_tim ||
        typeof plan.id !== 'number' ||
        !Number.isInteger(plan.id) ||
        plan.id <= 0
      ) {
        continue;
      }

      if (plan.uuid) {
        const existingId = uuidToCurrentId.get(plan.uuid);
        if (existingId !== undefined && existingId !== plan.id) {
          planMap.delete(existingId);
        }
        uuidToCurrentId.set(plan.uuid, plan.id);
      }

      planMap.set(plan.id, {
        ...plan,
        filename: filePath,
      });
    } catch {
      // Invalid files are handled separately by validatePlanFile().
    }
  }

  const uuidToId = new Map<string, number>();
  const idToUuid = new Map<number, string>();
  for (const [planId, plan] of planMap.entries()) {
    if (!plan.uuid) {
      continue;
    }
    uuidToId.set(plan.uuid, planId);
    idToUuid.set(planId, plan.uuid);
  }

  return { planMap, uuidToId, idToUuid };
}

async function findPlanFiles(
  scanDir: string,
  gitRoot: string,
  options: { includeMaterialized: boolean }
): Promise<string[]> {
  const discoveredFiles = new Set<string>();

  const addFilesFromDir = async (dir: string) => {
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      if (entry.endsWith('.plan.md') || entry.endsWith('.yml') || entry.endsWith('.yaml')) {
        discoveredFiles.add(path.join(dir, entry));
      }
    }
  };

  await addFilesFromDir(scanDir);

  const materializedDir = path.join(gitRoot, '.tim', 'plans');
  if (options.includeMaterialized && materializedDir !== scanDir) {
    await addFilesFromDir(materializedDir);
  }

  return Array.from(discoveredFiles).sort();
}

function validateParentChildRelationships(
  plans: Map<number, PlanSchema & { filename: string }>
): ParentChildInconsistency[] {
  const inconsistencies: ParentChildInconsistency[] = [];
  const parentChildMap = new Map<number, number[]>();

  // First, collect all parent-child relationships that need fixing
  for (const [childId, plan] of plans) {
    // Validate that childId is a valid positive number
    if (typeof childId !== 'number' || !Number.isInteger(childId) || childId <= 0) {
      console.warn(`Skipping plan with invalid ID: ${childId}`);
      continue;
    }

    if (plan.parent && typeof plan.parent === 'number') {
      // Validate that parent ID is a valid positive number
      if (!Number.isInteger(plan.parent) || plan.parent <= 0) {
        console.warn(`Plan ${childId} has invalid parent ID: ${plan.parent}`);
        continue;
      }

      const parentPlan = plans.get(plan.parent);

      if (!parentPlan) {
        console.warn(`Plan ${childId} references non-existent parent ${plan.parent}`);
        continue;
      }

      const dependencies = parentPlan.dependencies || [];

      // Ensure dependencies are all valid numbers
      const validDependencies = dependencies.filter(
        (dep) => typeof dep === 'number' && Number.isInteger(dep) && dep > 0
      );

      // Check if the parent includes this child in its dependencies
      if (!validDependencies.includes(childId)) {
        if (!parentChildMap.has(plan.parent)) {
          parentChildMap.set(plan.parent, []);
        }
        const existingChildren = parentChildMap.get(plan.parent);
        if (existingChildren) {
          existingChildren.push(childId);
        } else {
          // This shouldn't happen due to the check above, but being defensive
          parentChildMap.set(plan.parent, [childId]);
        }
      }
    }
  }

  // Convert to inconsistency format
  for (const [parentId, childIds] of parentChildMap) {
    const parentPlan = plans.get(parentId);
    if (parentPlan && parentPlan.filename) {
      inconsistencies.push({
        parentId,
        parentFilename: parentPlan.filename,
        childIds,
      });
    } else {
      console.warn(
        `Parent plan ${parentId} not found or missing filename, skipping inconsistency record`
      );
    }
  }

  return inconsistencies;
}

function validateDiscoveredFromReferences(
  plans: Map<number, PlanSchema & { filename: string }>
): DiscoveredFromIssue[] {
  const issues: DiscoveredFromIssue[] = [];

  for (const [planId, plan] of plans.entries()) {
    if (plan.discoveredFrom === undefined) {
      continue;
    }

    const referencedPlanId = plan.discoveredFrom;

    if (!plans.has(referencedPlanId)) {
      issues.push({
        planId,
        referencedPlanId,
        filename: plan.filename,
      });
    }
  }

  return issues;
}

export function wouldCreateCircularDependency(
  plans: Map<number, PlanSchema & { filename: string }>,
  parentId: number,
  childId: number
): boolean {
  // Check if adding childId to parentId's dependencies would create a cycle
  // This happens if parentId is already a dependency (direct or indirect) of childId

  try {
    // Use the existing collectDependenciesInOrder function to check for circular dependencies
    // If parentId is already a dependency of childId, adding childId to parentId would create a cycle
    const childPlan = plans.get(childId);
    if (!childPlan || !childPlan.dependencies || childPlan.dependencies.length === 0) {
      return false;
    }

    // Check if parentId is in childId's dependency tree (direct or indirect)
    const visited = new Set<number>();
    const checkDependencies = (planId: number): boolean => {
      if (visited.has(planId)) {
        return false; // Already checked this branch
      }
      visited.add(planId);

      const plan = plans.get(planId);
      if (!plan || !plan.dependencies) {
        return false;
      }

      for (const depId of plan.dependencies) {
        if (depId === parentId) {
          return true; // Found parentId in childId's dependency tree
        }
        if (checkDependencies(depId)) {
          return true; // Found parentId deeper in the tree
        }
      }
      return false;
    };

    return checkDependencies(childId);
  } catch (error) {
    // Log the error but don't be overly conservative
    console.warn(
      `Error checking circular dependency for parent ${parentId} -> child ${childId}:`,
      error
    );
    // Only return true for specific errors that indicate actual circular dependencies
    // For other errors, assume no circular dependency exists to avoid blocking legitimate operations
    if (error instanceof Error && error.message.includes('circular')) {
      return true;
    }
    return false;
  }
}

async function fixParentChildRelationships(
  inconsistencies: ParentChildInconsistency[],
  planMap: Map<number, PlanSchema & { filename: string }>,
  identityCwd: string
): Promise<FixResult> {
  let fixedRelationships = 0;
  const errors: string[] = [];

  for (const inconsistency of inconsistencies) {
    try {
      const parentPlan = isDbOnlyPlan(inconsistency.parentFilename)
        ? planMap.get(inconsistency.parentId)
        : await readPlanFile(inconsistency.parentFilename);
      if (!parentPlan) {
        throw new Error(`Parent plan ${inconsistency.parentId} could not be loaded`);
      }

      // Initialize dependencies array if it doesn't exist
      if (!parentPlan.dependencies) {
        parentPlan.dependencies = [];
      }

      // Add missing child IDs, avoiding duplicates
      const newDependencies = [...parentPlan.dependencies];
      let hasChanges = false;

      for (const childId of inconsistency.childIds) {
        if (!newDependencies.includes(childId)) {
          newDependencies.push(childId);
          hasChanges = true;
        }
      }

      if (hasChanges) {
        // Update the plan with new dependencies
        parentPlan.dependencies = newDependencies;

        await writeValidationPlan(
          { ...parentPlan, filename: inconsistency.parentFilename },
          identityCwd
        );

        fixedRelationships++;
      }
    } catch (error) {
      errors.push(
        `Failed to fix parent plan ${inconsistency.parentId} (${inconsistency.parentFilename}): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return { fixedRelationships, errors };
}

async function fixDiscoveredFromReferences(
  issues: DiscoveredFromIssue[],
  planMap: Map<number, PlanSchema & { filename: string }>,
  identityCwd: string
): Promise<DiscoveredFromFixResult> {
  const cleared: Array<{ planId: number; referencedPlanId: number; filename: string }> = [];
  const errors: string[] = [];

  for (const issue of issues) {
    try {
      const plan = isDbOnlyPlan(issue.filename)
        ? planMap.get(issue.planId)
        : await readPlanFile(issue.filename);
      if (!plan) {
        throw new Error(`Plan ${issue.planId} could not be loaded for discoveredFrom repair`);
      }

      if (plan.discoveredFrom !== issue.referencedPlanId) {
        continue;
      }

      // Remove the discoveredFrom field entirely
      delete (plan as { discoveredFrom?: number }).discoveredFrom;

      await writeValidationPlan({ ...plan, filename: issue.filename }, identityCwd);
      cleared.push({
        planId: issue.planId,
        referencedPlanId: issue.referencedPlanId,
        filename: issue.filename,
      });
    } catch (error) {
      errors.push(
        `Failed to remove discoveredFrom from plan ${issue.planId} (${issue.filename}): ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return { cleared, errors };
}

const OBSOLETE_TASK_KEYS = [
  'files',
  'docs',
  'steps',
  'examples',
  'include_importers',
  'include_imports',
];

function detectObsoleteTaskKeys(
  plans: Map<number, PlanSchema & { filename: string }>
): ObsoleteKeyIssue[] {
  const issues: ObsoleteKeyIssue[] = [];

  for (const [planId, plan] of plans.entries()) {
    if (!plan.tasks || plan.tasks.length === 0) {
      continue;
    }

    const taskIndices: number[] = [];
    const keysFound = new Set<string>();

    plan.tasks.forEach((task: any, index: number) => {
      const obsoleteKeys = OBSOLETE_TASK_KEYS.filter((key) => key in task);
      if (obsoleteKeys.length > 0) {
        taskIndices.push(index);
        obsoleteKeys.forEach((key) => keysFound.add(key));
      }
    });

    if (taskIndices.length > 0) {
      issues.push({
        filename: plan.filename,
        planId,
        taskIndices,
        keysToRemove: Array.from(keysFound),
      });
    }
  }

  return issues;
}

async function fixObsoleteTaskKeys(
  issues: ObsoleteKeyIssue[],
  planMap: Map<number, PlanSchema & { filename: string }>,
  identityCwd: string
): Promise<ObsoleteKeyFixResult> {
  let fixedPlans = 0;
  let totalKeysRemoved = 0;
  const errors: string[] = [];

  for (const issue of issues) {
    try {
      if (issue.planId === undefined) {
        throw new Error(`Plan ID missing for ${issue.filename}`);
      }
      const plan = isDbOnlyPlan(issue.filename)
        ? planMap.get(issue.planId)
        : await readPlanFile(issue.filename);
      if (!plan) {
        throw new Error(`Plan ${issue.planId} could not be loaded for obsolete key cleanup`);
      }

      if (!plan.tasks || plan.tasks.length === 0) {
        continue;
      }

      let hasChanges = false;
      let keysRemovedInPlan = 0;

      plan.tasks = plan.tasks.map((task: any, index: number) => {
        if (!issue.taskIndices.includes(index)) {
          return task;
        }

        const cleanedTask = { ...task };
        let taskModified = false;

        // Check if steps array exists and all steps are done
        const shouldMarkTaskDone =
          'steps' in cleanedTask &&
          Array.isArray(cleanedTask.steps) &&
          cleanedTask.steps.length > 0 &&
          cleanedTask.steps.every((step: any) => step.done === true);

        for (const key of OBSOLETE_TASK_KEYS) {
          if (key in cleanedTask) {
            delete cleanedTask[key];
            taskModified = true;
            keysRemovedInPlan++;
          }
        }

        // Set task.done = true if all steps were completed
        if (shouldMarkTaskDone) {
          cleanedTask.done = true;
          taskModified = true;
        }

        if (taskModified) {
          hasChanges = true;
        }

        return cleanedTask;
      });

      if (hasChanges) {
        await writeValidationPlan({ ...plan, filename: issue.filename }, identityCwd);
        fixedPlans++;
        totalKeysRemoved += keysRemovedInPlan;
      }
    } catch (error) {
      errors.push(
        `Failed to fix obsolete keys in ${issue.filename}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return { fixedPlans, totalKeysRemoved, errors };
}

export async function handleValidateCommand(
  options: { dir?: string; verbose?: boolean; fix?: boolean },
  command: any
): Promise<void> {
  const globalOpts = command.parent.opts();
  const config = await loadEffectiveConfig(globalOpts.config);
  const pathContext = await resolvePlanPathContext(config);
  const defaultScanDir = getLegacyAwareSearchDir(pathContext.gitRoot, pathContext.configBaseDir);

  // Determine directory to search
  const searchDir = options.dir || defaultScanDir;

  // Resolve repo identity from the actual scan directory.
  const identityCwd = options.dir || pathContext.configBaseDir;
  const repository = await getRepositoryIdentity({ cwd: identityCwd });

  const planFiles = await findPlanFiles(searchDir, pathContext.gitRoot, {
    includeMaterialized: options.dir === undefined,
  });

  // First pass: Load all plans to check for obsolete keys
  let planMap: Map<number, PlanSchema & { filename: string }> | null = null;
  let obsoleteKeyIssues: ObsoleteKeyIssue[] = [];
  let obsoleteKeyFixResult: ObsoleteKeyFixResult | null = null;
  let dbOnlyPlanCount = 0;

  try {
    const planResults = await loadValidationPlanState(
      searchDir,
      repository.repositoryId,
      planFiles
    );
    planMap = planResults.planMap;
    dbOnlyPlanCount = Array.from(planMap.values()).filter((plan) =>
      isDbOnlyPlan(plan.filename)
    ).length;

    console.log(
      chalk.bold(
        `Validating ${planFiles.length} plan file${planFiles.length === 1 ? '' : 's'}${
          dbOnlyPlanCount > 0
            ? ` and ${dbOnlyPlanCount} DB-only plan${dbOnlyPlanCount === 1 ? '' : 's'}`
            : ''
        } in ${searchDir}\n`
      )
    );

    // Detect obsolete keys
    obsoleteKeyIssues = detectObsoleteTaskKeys(planMap);

    if (obsoleteKeyIssues.length > 0) {
      const totalTasks = obsoleteKeyIssues.reduce(
        (sum, issue) => sum + issue.taskIndices.length,
        0
      );
      console.log(
        chalk.yellow.bold(
          `Found ${obsoleteKeyIssues.length} plan${obsoleteKeyIssues.length === 1 ? '' : 's'} with ${totalTasks} task${totalTasks === 1 ? '' : 's'} containing obsolete keys.`
        )
      );

      if (options.fix === false) {
        console.log(chalk.yellow('--no-fix flag specified, will report as validation errors.\n'));
      } else {
        console.log(chalk.blue('Auto-fixing obsolete task keys before validation...'));
        obsoleteKeyFixResult = await fixObsoleteTaskKeys(obsoleteKeyIssues, planMap, identityCwd);

        if (obsoleteKeyFixResult.fixedPlans > 0) {
          console.log(
            chalk.green(
              `✓ Fixed ${obsoleteKeyFixResult.fixedPlans} plan${obsoleteKeyFixResult.fixedPlans === 1 ? '' : 's'}, removed ${obsoleteKeyFixResult.totalKeysRemoved} obsolete key${obsoleteKeyFixResult.totalKeysRemoved === 1 ? '' : 's'}\n`
            )
          );

          // Reload plans to get the fixed data (prevents later operations from overwriting the fix)
          const reloadedPlans = await loadValidationPlanState(
            searchDir,
            repository.repositoryId,
            planFiles
          );
          planMap = reloadedPlans.planMap;
        }

        if (obsoleteKeyFixResult.errors.length > 0) {
          console.log(chalk.red.bold('Errors during obsolete key fixes:'));
          obsoleteKeyFixResult.errors.forEach((error) => {
            console.log(chalk.red(`  • ${error}`));
          });
          console.log();
        }
      }
    }
  } catch (error) {
    console.log(
      chalk.yellow(
        `Warning: Could not check for obsolete keys: ${error instanceof Error ? error.message : String(error)}`
      )
    );
  }

  // UUID validation and fixing
  let uuidIssues: UuidIssue[] = [];
  let uuidFixResult: UuidFixResult | null = null;
  let uuidToId = new Map<string, number>();
  let idToUuid = new Map<number, string>();

  if (planMap) {
    console.log(chalk.blue.bold('Checking for missing UUIDs...'));
    uuidIssues = detectMissingUuids(planMap);

    if (uuidIssues.length > 0) {
      console.log(
        chalk.yellow.bold(
          `\nFound ${uuidIssues.length} plan${uuidIssues.length === 1 ? '' : 's'} without UUIDs.`
        )
      );

      if (options.fix === false) {
        console.log(chalk.yellow('--no-fix flag specified, will report as validation errors.\n'));
      } else {
        console.log(chalk.blue('Auto-generating UUIDs...'));
        uuidFixResult = await fixMissingUuids(uuidIssues, planMap, identityCwd);

        if (uuidFixResult.generated.length > 0) {
          console.log(
            chalk.green(
              `✓ Generated ${uuidFixResult.generated.length} UUID${uuidFixResult.generated.length === 1 ? '' : 's'}\n`
            )
          );

          // Reload plans to get the new UUIDs
          const reloadedPlans = await loadValidationPlanState(
            searchDir,
            repository.repositoryId,
            planFiles
          );
          planMap = reloadedPlans.planMap;
          uuidToId = reloadedPlans.uuidToId;
          idToUuid = reloadedPlans.idToUuid;
        }

        if (uuidFixResult.errors.length > 0) {
          console.log(chalk.red.bold('Errors during UUID generation:'));
          uuidFixResult.errors.forEach((error) => {
            console.log(chalk.red(`  • ${error}`));
          });
          console.log();
        }
      }
    } else {
      // Load UUID maps even if no missing UUIDs
      const planResults = await loadValidationPlanState(
        searchDir,
        repository.repositoryId,
        planFiles
      );
      uuidToId = planResults.uuidToId;
      idToUuid = planResults.idToUuid;
    }
  }

  // Reference validation and fixing
  let referenceIssues: ReferenceIssue[] = [];
  let referenceFixResult: ReferenceFixResult | null = null;

  if (planMap && uuidToId.size > 0) {
    console.log(chalk.blue.bold('Checking reference consistency...'));
    referenceIssues = detectReferenceIssues(planMap, uuidToId);

    if (referenceIssues.length > 0) {
      console.log(
        chalk.yellow.bold(
          `\nFound ${referenceIssues.length} plan${referenceIssues.length === 1 ? '' : 's'} with reference mismatches.`
        )
      );

      if (options.fix === false) {
        console.log(chalk.yellow('--no-fix flag specified, will report as validation errors.\n'));
      } else {
        console.log(chalk.blue('Auto-fixing reference mismatches...'));
        referenceFixResult = await fixReferenceIssues(referenceIssues, planMap, identityCwd);

        if (referenceFixResult.updated.length > 0) {
          console.log(
            chalk.green(
              `✓ Fixed ${referenceFixResult.updated.length} plan${referenceFixResult.updated.length === 1 ? '' : 's'} with reference mismatches\n`
            )
          );

          // Reload plans to get updated references
          const reloadedPlans = await loadValidationPlanState(
            searchDir,
            repository.repositoryId,
            planFiles
          );
          planMap = reloadedPlans.planMap;
        }

        if (referenceFixResult.errors.length > 0) {
          console.log(chalk.red.bold('Errors during reference fixes:'));
          referenceFixResult.errors.forEach((error) => {
            console.log(chalk.red(`  • ${error}`));
          });
          console.log();
        }
      }
    }
  }

  // Validate all files (after fixing obsolete keys if applicable)
  const fileResults = await Promise.all(planFiles.map((filePath) => validatePlanFile(filePath)));
  const dbOnlyResults =
    planMap === null
      ? []
      : Array.from(planMap.entries())
          .filter(([, plan]) => isDbOnlyPlan(plan.filename))
          .map(([planId, plan]) => {
            const { filename: _filename, ...rest } = plan;
            return validatePlanData(`Plan ${planId} (DB-only)`, rest);
          });
  const results = [...fileResults, ...dbOnlyResults];

  // Separate valid, invalid, and skipped files
  const skippedFiles = results.filter((r) => r.skipped);
  const validFiles = results.filter((r) => r.isValid && !r.skipped);
  const invalidFiles = results.filter((r) => !r.isValid);

  // Parent-child validation (only for schema-valid files)
  let parentChildInconsistencies: ParentChildInconsistency[] = [];
  let fixResult: FixResult | null = null;
  let discoveredFromIssues: DiscoveredFromIssue[] = [];
  let discoveredFixResult: DiscoveredFromFixResult | null = null;

  if (planMap && planMap.size > 0) {
    console.log(chalk.blue.bold('Checking parent-child relationships...'));

    try {
      // Find parent-child inconsistencies
      parentChildInconsistencies = validateParentChildRelationships(planMap);

      if (parentChildInconsistencies.length > 0) {
        console.log(
          chalk.yellow.bold(
            `\nFound ${parentChildInconsistencies.length} parent-child inconsistencies:`
          )
        );

        parentChildInconsistencies.forEach((inconsistency) => {
          const childrenText =
            inconsistency.childIds.length === 1
              ? `child ${inconsistency.childIds[0]}`
              : `children ${inconsistency.childIds.join(', ')}`;
          console.log(
            chalk.yellow(
              `  • Parent plan ${inconsistency.parentId} missing dependencies for ${childrenText}`
            )
          );
        });

        // Check for circular dependencies before fixing and filter individual children
        const safeInconsistencies: ParentChildInconsistency[] = [];

        for (const inconsistency of parentChildInconsistencies) {
          const safeChildren: number[] = [];

          for (const childId of inconsistency.childIds) {
            const wouldCreateCycle = wouldCreateCircularDependency(
              planMap,
              inconsistency.parentId,
              childId
            );
            if (wouldCreateCycle) {
              console.log(
                chalk.red(
                  `    ⚠ Skipping ${inconsistency.parentId} → ${childId}: would create circular dependency`
                )
              );
            } else {
              safeChildren.push(childId);
            }
          }

          // Only include inconsistencies that have at least one safe child
          if (safeChildren.length > 0) {
            safeInconsistencies.push({
              parentId: inconsistency.parentId,
              parentFilename: inconsistency.parentFilename,
              childIds: safeChildren,
            });
          }
        }

        if (options.fix === false) {
          console.log(chalk.yellow(`\n--no-fix flag specified, not auto-fixing inconsistencies.`));
          console.log(
            chalk.yellow('Run without --no-fix to automatically fix these relationships.')
          );
        } else if (safeInconsistencies.length > 0) {
          // Auto-fix the inconsistencies
          console.log(chalk.blue('\nAuto-fixing parent-child relationships...'));
          fixResult = await fixParentChildRelationships(safeInconsistencies, planMap, identityCwd);

          if (fixResult.fixedRelationships > 0) {
            // Reload plans to pick up the new dependencies
            const reloadedPlans = await loadValidationPlanState(
              searchDir,
              repository.repositoryId,
              planFiles
            );
            planMap = reloadedPlans.planMap;
          }
        }
      }
    } catch (error) {
      console.log(
        chalk.red(
          `Error during parent-child validation: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    }

    if (planMap) {
      console.log(); // Separate sections
      console.log(chalk.blue.bold('Checking discoveredFrom references...'));

      discoveredFromIssues = validateDiscoveredFromReferences(planMap);

      if (discoveredFromIssues.length > 0) {
        const issueCount = discoveredFromIssues.length;
        console.log(
          chalk.yellow.bold(
            `\nFound ${issueCount} orphaned discovery reference${issueCount === 1 ? '' : 's'}:`
          )
        );

        discoveredFromIssues.forEach((issue) => {
          console.log(
            chalk.yellow(
              `  • Plan ${issue.planId} references missing discoveredFrom plan ${issue.referencedPlanId}`
            )
          );
        });

        if (options.fix === false) {
          console.log(
            chalk.yellow(`\n--no-fix flag specified, not removing discoveredFrom references.`)
          );
          console.log(
            chalk.yellow('Run without --no-fix to automatically remove invalid references.')
          );
        } else {
          console.log(chalk.blue('\nRemoving invalid discoveredFrom references...'));
          discoveredFixResult = await fixDiscoveredFromReferences(
            discoveredFromIssues,
            planMap,
            identityCwd
          );

          if (discoveredFixResult.cleared.length > 0) {
            // Reload plans to pick up the removed references
            const reloadedPlans = await loadValidationPlanState(
              searchDir,
              repository.repositoryId,
              planFiles
            );
            planMap = reloadedPlans.planMap;
          }
        }
      } else if (options.verbose) {
        console.log(chalk.green('  No orphaned discovery references found.'));
      }

      console.log(); // Extra line for spacing after discoveredFrom check

      // Ensure all plans have complete references (after all fixes that may add dependencies)
      if (options.fix !== false && uuidToId.size > 0) {
        console.log(chalk.blue.bold('Ensuring all references are complete...'));
        const ensureResult = await ensureAllReferences(planMap, identityCwd);

        if (ensureResult.updated > 0) {
          console.log(
            chalk.green(
              `✓ Updated ${ensureResult.updated} plan${ensureResult.updated === 1 ? '' : 's'} with missing references\n`
            )
          );

          // Reload plans one more time
          const reloadedPlans = await loadValidationPlanState(
            searchDir,
            repository.repositoryId,
            planFiles
          );
          planMap = reloadedPlans.planMap;
        }

        if (ensureResult.errors.length > 0) {
          console.log(chalk.red.bold('Errors during reference updates:'));
          ensureResult.errors.forEach((error) => {
            console.log(chalk.red(`  • ${error}`));
          });
          console.log();
        }
      }
    } else {
      console.log(); // Maintain spacing when plan map unavailable
    }
  }

  // Display schema validation results
  if (skippedFiles.length > 0 && options.verbose) {
    console.log(chalk.gray.bold('⊘ Skipped files (not_tim: true):'));
    skippedFiles.forEach((result) => {
      console.log(chalk.gray(`  • ${result.filename}`));
    });
    console.log();
  }

  if (validFiles.length > 0 && options.verbose) {
    console.log(chalk.green.bold('✓ Valid files:'));
    validFiles.forEach((result) => {
      console.log(chalk.green(`  • ${result.filename}`));
    });
    console.log();
  }

  if (invalidFiles.length > 0) {
    console.log(chalk.red.bold('✗ Invalid files:'));
    invalidFiles.forEach((result) => {
      console.log(chalk.red(`\n  ${result.filename}:`));

      if (result.errors && result.errors.length > 0) {
        result.errors.forEach((error) => {
          console.log(chalk.red(`    - ${error}`));
        });
      }

      if (result.unknownKeys && result.unknownKeys.length > 0) {
        console.log(chalk.yellow(`    - Unknown keys: ${result.unknownKeys.join(', ')}`));
      }
    });
    console.log();
  }

  // Display parent-child fix results
  if (fixResult && fixResult.fixedRelationships > 0) {
    console.log(chalk.blue.bold('Parent-Child Relationships Fixed:'));
    parentChildInconsistencies.forEach((inconsistency) => {
      const childrenText =
        inconsistency.childIds.length === 1
          ? `child ${inconsistency.childIds[0]}`
          : `children ${inconsistency.childIds.join(', ')}`;
      console.log(
        chalk.green(
          `  ✓ Updated plan ${inconsistency.parentId} to include ${childrenText} in dependencies`
        )
      );
    });
    console.log();
  }

  if (fixResult && fixResult.errors.length > 0) {
    console.log(chalk.red.bold('Errors during parent-child fixes:'));
    fixResult.errors.forEach((error) => {
      console.log(chalk.red(`  • ${error}`));
    });
    console.log();
  }

  if (discoveredFixResult && discoveredFixResult.cleared.length > 0) {
    console.log(chalk.blue.bold('DiscoveredFrom References Fixed:'));
    discoveredFixResult.cleared.forEach((cleared) => {
      console.log(
        chalk.green(
          `  ✓ Removed discoveredFrom reference to ${cleared.referencedPlanId} from plan ${cleared.planId}`
        )
      );
    });
    console.log();
  }

  if (discoveredFixResult && discoveredFixResult.errors.length > 0) {
    console.log(chalk.red.bold('Errors during discoveredFrom fixes:'));
    discoveredFixResult.errors.forEach((error) => {
      console.log(chalk.red(`  • ${error}`));
    });
    console.log();
  }

  // Summary
  console.log(chalk.bold('Summary:'));
  console.log(`  ${chalk.green(`✓ ${validFiles.length} valid`)}`);
  if (invalidFiles.length > 0) {
    console.log(`  ${chalk.red(`✗ ${invalidFiles.length} invalid`)}`);
  }
  if (skippedFiles.length > 0) {
    console.log(`  ${chalk.gray(`⊘ ${skippedFiles.length} skipped (not_tim)`)}`);
  }
  if (fixResult && fixResult.fixedRelationships > 0) {
    console.log(
      `  ${chalk.green(`✓ ${fixResult.fixedRelationships} parent-child relationships fixed`)}`
    );
  } else if (parentChildInconsistencies.length > 0 && options.fix === false) {
    console.log(
      `  ${chalk.yellow(`⚠ ${parentChildInconsistencies.length} parent-child inconsistencies found (not fixed due to --no-fix)`)}`
    );
  }

  const clearedDiscoveredCount = discoveredFixResult?.cleared.length ?? 0;
  if (clearedDiscoveredCount > 0) {
    console.log(
      `  ${chalk.green(`✓ ${clearedDiscoveredCount} discoveredFrom reference${clearedDiscoveredCount === 1 ? '' : 's'} removed`)}`
    );
  } else if (discoveredFromIssues.length > 0 && options.fix === false) {
    console.log(
      `  ${chalk.yellow(`⚠ ${discoveredFromIssues.length} orphaned discoveredFrom reference${discoveredFromIssues.length === 1 ? '' : 's'} found (not fixed due to --no-fix)`)}`
    );
  }

  const fixedObsoleteCount = obsoleteKeyFixResult?.fixedPlans ?? 0;
  const totalKeysRemoved = obsoleteKeyFixResult?.totalKeysRemoved ?? 0;
  if (fixedObsoleteCount > 0) {
    console.log(
      `  ${chalk.green(`✓ Removed ${totalKeysRemoved} obsolete key${totalKeysRemoved === 1 ? '' : 's'} from ${fixedObsoleteCount} plan${fixedObsoleteCount === 1 ? '' : 's'}`)}`
    );
  } else if (obsoleteKeyIssues.length > 0 && options.fix === false) {
    const totalObsoleteTasks = obsoleteKeyIssues.reduce(
      (sum, issue) => sum + issue.taskIndices.length,
      0
    );
    console.log(
      `  ${chalk.yellow(`⚠ ${obsoleteKeyIssues.length} plan${obsoleteKeyIssues.length === 1 ? '' : 's'} with ${totalObsoleteTasks} task${totalObsoleteTasks === 1 ? '' : 's'} containing obsolete keys (not fixed due to --no-fix)`)}`
    );
  }

  const generatedUuidCount = uuidFixResult?.generated.length ?? 0;
  if (generatedUuidCount > 0) {
    console.log(
      `  ${chalk.green(`✓ Generated ${generatedUuidCount} UUID${generatedUuidCount === 1 ? '' : 's'}`)}`
    );
  } else if (uuidIssues.length > 0 && options.fix === false) {
    console.log(
      `  ${chalk.yellow(`⚠ ${uuidIssues.length} plan${uuidIssues.length === 1 ? '' : 's'} missing UUID${uuidIssues.length === 1 ? '' : 's'} (not fixed due to --no-fix)`)}`
    );
  }

  const fixedReferenceCount = referenceFixResult?.updated.length ?? 0;
  if (fixedReferenceCount > 0) {
    console.log(
      `  ${chalk.green(`✓ Fixed ${fixedReferenceCount} plan${fixedReferenceCount === 1 ? '' : 's'} with reference mismatches`)}`
    );
  } else if (referenceIssues.length > 0 && options.fix === false) {
    console.log(
      `  ${chalk.yellow(`⚠ ${referenceIssues.length} plan${referenceIssues.length === 1 ? '' : 's'} with reference mismatches (not fixed due to --no-fix)`)}`
    );
  }

  // Exit with error code if there are invalid files
  if (invalidFiles.length > 0) {
    process.exit(1);
  }
}
