import { readdir } from 'node:fs/promises';
import * as path from 'node:path';
import * as yaml from 'yaml';
import chalk from 'chalk';
import { z } from 'zod/v4';
import { loadEffectiveConfig } from '../configLoader.js';
import { phaseSchema } from '../planSchema.js';
import { resolveTasksDir } from '../configSchema.js';
import { readAllPlans, readPlanFile, writePlanFile } from '../plans.js';
interface ValidationResult {
  filename: string;
  isValid: boolean;
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

async function validatePlanFile(filePath: string): Promise<ValidationResult> {
  const filename = path.basename(filePath);

  try {
    const content = await Bun.file(filePath).text();

    let parsed: any;
    let markdownBody: string | undefined;

    // Check if the file uses front matter format
    if (content.startsWith('---\n')) {
      // Find the closing delimiter for front matter
      const endDelimiterIndex = content.indexOf('\n---\n', 4);

      if (endDelimiterIndex !== -1) {
        // Extract front matter and body
        const frontMatter = content.substring(4, endDelimiterIndex);
        markdownBody = content.substring(endDelimiterIndex + 5).trim();

        // Parse the front matter as YAML
        parsed = yaml.parse(frontMatter);
      } else {
        // No closing delimiter found, treat entire file as YAML
        parsed = yaml.parse(content);
      }
    } else {
      // No front matter, parse entire content as YAML
      parsed = yaml.parse(content);
    }

    // If we have a markdown body, add it to the details field
    if (markdownBody) {
      // If there's already a details field in the YAML, combine them
      if (parsed.details) {
        parsed.details = parsed.details + '\n\n' + markdownBody;
      } else {
        parsed.details = markdownBody;
      }
    }

    // Validate with the strict schema
    const result = phaseSchema.safeParse(parsed);

    if (result.success) {
      return { filename, isValid: true };
    } else {
      const errors: string[] = [];
      const unknownKeys: string[] = [];

      result.error.issues.forEach((issue) => {
        if (issue.code === 'unrecognized_keys') {
          // For unrecognized keys, combine the path with the unknown keys
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

function validateParentChildRelationships(
  plans: Map<number, any>
): ParentChildInconsistency[] {
  const inconsistencies: ParentChildInconsistency[] = [];
  const parentChildMap = new Map<number, number[]>();

  // First, collect all parent-child relationships that need fixing
  for (const [childId, plan] of plans) {
    if (plan.parent && typeof plan.parent === 'number') {
      const parentPlan = plans.get(plan.parent);
      
      if (!parentPlan) {
        // Parent doesn't exist - this is an error but not something we can auto-fix
        continue;
      }

      const dependencies = parentPlan.dependencies || [];
      
      // Check if the parent includes this child in its dependencies
      if (!dependencies.includes(childId)) {
        if (!parentChildMap.has(plan.parent)) {
          parentChildMap.set(plan.parent, []);
        }
        parentChildMap.get(plan.parent)!.push(childId);
      }
    }
  }

  // Convert to inconsistency format
  for (const [parentId, childIds] of parentChildMap) {
    const parentPlan = plans.get(parentId);
    inconsistencies.push({
      parentId,
      parentFilename: parentPlan.filename,
      childIds,
    });
  }

  return inconsistencies;
}

function wouldCreateCircularDependency(
  plans: Map<number, any>,
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
  } catch {
    // If there's any error in dependency checking, be conservative and assume it would create a cycle
    return true;
  }
}

async function fixParentChildRelationships(
  inconsistencies: ParentChildInconsistency[]
): Promise<FixResult> {
  let fixedRelationships = 0;
  const errors: string[] = [];

  for (const inconsistency of inconsistencies) {
    try {
      // Read the current version of the parent plan
      const parentPlan = await readPlanFile(inconsistency.parentFilename);
      
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
        // Update the plan with new dependencies and updatedAt timestamp
        parentPlan.dependencies = newDependencies;
        parentPlan.updatedAt = new Date().toISOString();
        
        // Write the updated plan back to file
        await writePlanFile(inconsistency.parentFilename, parentPlan);
        
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

export async function handleValidateCommand(options: any, command: any): Promise<void> {
  const globalOpts = command.parent.opts();
  const config = await loadEffectiveConfig(globalOpts.config);

  // Determine directory to search
  const tasksDir = options.dir || (await resolveTasksDir(config));

  // Read all plan files
  const files = await readdir(tasksDir);
  const planFiles = files.filter(
    (file) => file.endsWith('.plan.md') || file.endsWith('.yml') || file.endsWith('.yaml')
  );

  if (planFiles.length === 0) {
    console.log(chalk.yellow('No plan files found in'), tasksDir);
    return;
  }

  console.log(
    chalk.bold(
      `Validating ${planFiles.length} plan file${planFiles.length === 1 ? '' : 's'} in ${tasksDir}\n`
    )
  );

  // Validate all files
  const results = await Promise.all(
    planFiles.map((file) => validatePlanFile(path.join(tasksDir, file)))
  );

  // Separate valid and invalid files
  const validFiles = results.filter((r) => r.isValid);
  const invalidFiles = results.filter((r) => !r.isValid);

  // Parent-child validation (only for schema-valid files)
  let parentChildInconsistencies: ParentChildInconsistency[] = [];
  let fixResult: FixResult | null = null;
  
  if (validFiles.length > 0) {
    console.log(chalk.blue.bold('Checking parent-child relationships...'));
    
    try {
      // Load all plans for cross-referencing
      const { plans } = await readAllPlans(tasksDir);
      
      // Find parent-child inconsistencies
      parentChildInconsistencies = validateParentChildRelationships(plans);
      
      if (parentChildInconsistencies.length > 0) {
        console.log(chalk.yellow.bold(`\nFound ${parentChildInconsistencies.length} parent-child inconsistencies:`));
        
        parentChildInconsistencies.forEach((inconsistency) => {
          const childrenText = inconsistency.childIds.length === 1 
            ? `child ${inconsistency.childIds[0]}` 
            : `children ${inconsistency.childIds.join(', ')}`;
          console.log(chalk.yellow(`  • Parent plan ${inconsistency.parentId} missing dependencies for ${childrenText}`));
        });
        
        // Check for circular dependencies before fixing
        const safeInconsistencies = parentChildInconsistencies.filter((inconsistency) => {
          return inconsistency.childIds.every((childId) => {
            const wouldCreateCycle = wouldCreateCircularDependency(plans, inconsistency.parentId, childId);
            if (wouldCreateCycle) {
              console.log(chalk.red(`    ⚠ Skipping ${inconsistency.parentId} → ${childId}: would create circular dependency`));
            }
            return !wouldCreateCycle;
          });
        });

        if (options.fix === false) {
          console.log(chalk.yellow(`\n--no-fix flag specified, not auto-fixing inconsistencies.`));
          console.log(chalk.yellow('Run without --no-fix to automatically fix these relationships.'));
        } else if (safeInconsistencies.length > 0) {
          // Auto-fix the inconsistencies
          console.log(chalk.blue('\nAuto-fixing parent-child relationships...'));
          fixResult = await fixParentChildRelationships(safeInconsistencies);
        }
      }
    } catch (error) {
      console.log(chalk.red(`Error during parent-child validation: ${error instanceof Error ? error.message : String(error)}`));
    }
    
    console.log(); // Extra line for spacing
  }

  // Display schema validation results
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
      const childrenText = inconsistency.childIds.length === 1 
        ? `child ${inconsistency.childIds[0]}` 
        : `children ${inconsistency.childIds.join(', ')}`;
      console.log(chalk.green(`  ✓ Updated plan ${inconsistency.parentId} to include ${childrenText} in dependencies`));
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

  // Summary
  console.log(chalk.bold('Summary:'));
  console.log(`  ${chalk.green(`✓ ${validFiles.length} valid`)}`);
  if (invalidFiles.length > 0) {
    console.log(`  ${chalk.red(`✗ ${invalidFiles.length} invalid`)}`);
  }
  if (fixResult && fixResult.fixedRelationships > 0) {
    console.log(`  ${chalk.green(`✓ ${fixResult.fixedRelationships} parent-child relationships fixed`)}`);
  } else if (parentChildInconsistencies.length > 0 && options.fix === false) {
    console.log(`  ${chalk.yellow(`⚠ ${parentChildInconsistencies.length} parent-child inconsistencies found (not fixed due to --no-fix)`)}`);
  }

  // Exit with error code if there are invalid files
  if (invalidFiles.length > 0) {
    process.exit(1);
  }
}
