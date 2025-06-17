import { readdir } from 'node:fs/promises';
import * as path from 'node:path';
import * as yaml from 'yaml';
import chalk from 'chalk';
import { z } from 'zod/v4';
import { loadEffectiveConfig } from '../configLoader.js';
import { phaseSchema } from '../planSchema.js';
import { resolveTasksDir } from '../configSchema.js';
interface ValidationResult {
  filename: string;
  isValid: boolean;
  errors?: string[];
  unknownKeys?: string[];
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

    // Validate with the regular schema first
    const result = phaseSchema.safeParse(parsed);

    // If validation passes, check for unknown keys manually
    if (result.success) {
      const unknownKeys: string[] = [];

      // Check for unknown keys at the root level
      const knownRootKeys = Object.keys(phaseSchema.shape);
      for (const key in parsed) {
        if (!knownRootKeys.includes(key)) {
          unknownKeys.push(key);
        }
      }

      // Check for unknown keys in tasks
      if (parsed.tasks && Array.isArray(parsed.tasks)) {
        parsed.tasks.forEach((task: any, taskIndex: number) => {
          const knownTaskKeys = ['title', 'description', 'files', 'examples', 'docs', 'steps'];
          for (const key in task) {
            if (!knownTaskKeys.includes(key)) {
              unknownKeys.push(`tasks[${taskIndex}].${key}`);
            }
          }

          // Check for unknown keys in steps
          if (task.steps && Array.isArray(task.steps)) {
            task.steps.forEach((step: any, stepIndex: number) => {
              const knownStepKeys = ['prompt', 'examples', 'done'];
              for (const key in step) {
                if (!knownStepKeys.includes(key)) {
                  unknownKeys.push(`tasks[${taskIndex}].steps[${stepIndex}].${key}`);
                }
              }
            });
          }
        });
      }

      // Check for unknown keys in project
      if (parsed.project && typeof parsed.project === 'object') {
        const knownProjectKeys = ['title', 'goal', 'details'];
        for (const key in parsed.project) {
          if (!knownProjectKeys.includes(key)) {
            unknownKeys.push(`project.${key}`);
          }
        }
      }

      if (unknownKeys.length > 0) {
        return {
          filename,
          isValid: false,
          unknownKeys,
        };
      }

      return { filename, isValid: true };
    } else {
      const errors: string[] = [];
      const unknownKeys: string[] = [];

      result.error.issues.forEach((issue) => {
        if (issue.code === z.ZodIssueCode.unrecognized_keys) {
          unknownKeys.push(...issue.keys);
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

  // Display results
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

  // Summary
  console.log(chalk.bold('\nSummary:'));
  console.log(`  ${chalk.green(`✓ ${validFiles.length} valid`)}`);
  if (invalidFiles.length > 0) {
    console.log(`  ${chalk.red(`✗ ${invalidFiles.length} invalid`)}`);

    // Exit with error code if there are invalid files
    process.exit(1);
  }
}
