#!/usr/bin/env bun
import { input } from '@inquirer/prompts';
import { generateText } from 'ai';
import { $ } from 'bun';
import chalk from 'chalk';
import { Command } from 'commander';
import * as fs from 'node:fs/promises';
import os from 'os';
import path from 'path';
import { table } from 'table';
import yaml from 'yaml';
import * as clipboard from '../common/clipboard.ts';
import { loadEnv } from '../common/env.js';
import { getInstructionsFromGithubIssue } from '../common/github/issues.js';
import { createModel } from '../common/model_factory.ts';
import { runStreamingPrompt } from '../common/run_and_apply.ts';
import { sshAwarePasteAction } from '../common/ssh_detection.ts';
import { waitForEnter } from '../common/terminal.js';
import { error, log, warn } from '../logging.js';
import { getGitRoot, logSpawn, setDebug, setQuiet } from '../rmfilter/utils.js';
import { findFilesCore, type RmfindOptions } from '../rmfind/core.js';
import { argsFromRmprOptions, type RmprOptions } from '../rmpr/comment_options.js';
import { handleRmprCommand } from '../rmpr/main.js';
import { markStepDone, prepareNextStep, preparePhase } from './actions.js';
import { rmplanAgent } from './agent.js';
import { cleanupEolComments } from './cleanup.js';
import { loadEffectiveConfig } from './configLoader.js';
import { DEFAULT_EXECUTOR } from './constants.js';
import { getCombinedGoal, getCombinedTitle, getCombinedTitleFromSummary } from './display_utils.js';
import { executors } from './executors/index.js';
import { fixYaml } from './fix_yaml.js';
import { generateAlphanumericPlanId, slugify } from './id_utils.js';
import {
  collectDependenciesInOrder,
  findNextPlan,
  isPlanReady,
  readAllPlans,
  readPlanFile,
  resolvePlanFile,
  setPlanStatus,
  writePlanFile,
} from './plans.js';
import { multiPhasePlanSchema, type PlanSchema } from './planSchema.js';
import {
  extractMarkdownToYaml,
  findYamlStart,
  saveMultiPhaseYaml,
  type ExtractMarkdownToYamlOptions,
} from './process_markdown.ts';
import { generateSplitPlanPrompt, planPrompt, simplePlanPrompt } from './prompt.js';
import { WorkspaceAutoSelector } from './workspace/workspace_auto_selector.js';
import { WorkspaceLock } from './workspace/workspace_lock.js';
import { createWorkspace } from './workspace/workspace_manager.js';

await loadEnv();

/**
 * Resolves the tasks directory path, handling both absolute and relative paths.
 * If tasks path is relative, it's resolved relative to the git root.
 */
async function resolveTasksDir(config: any): Promise<string> {
  const gitRoot = (await getGitRoot()) || process.cwd();

  if (config.paths?.tasks) {
    return path.isAbsolute(config.paths.tasks)
      ? config.paths.tasks
      : path.join(gitRoot, config.paths.tasks);
  }

  return gitRoot;
}

async function generateSuggestedFilename(planText: string, config: any): Promise<string> {
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

    const model = createModel('google/gemini-2.0-flash');
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

    // Ensure it's not empty and has reasonable length
    if (!filename || filename.length < 3) {
      filename = 'rmplan-task';
    }

    // Add to tasks directory if configured
    const tasksDir = config.paths?.tasks;
    const fullPath = tasksDir ? path.join(tasksDir, `${filename}.md`) : `${filename}.md`;

    return fullPath;
  } catch (err) {
    // Fallback to default if model fails
    warn('Failed to generate filename suggestion:', err);
    return '';
  }
}

const program = new Command();
program.name('rmplan').description('Generate and execute task plans using LLMs');
program.option(
  '-c, --config <path>',
  'Specify path to the rmplan configuration file (default: .rmfilter/rmplan.yml)'
);

program.option('--debug', 'Enable debug logging', () => setDebug(true));

program
  .command('generate')
  .description('Generate planning prompt and context for a task')
  .option('--plan <file>', 'Plan text file to use')
  .option('--plan-editor', 'Open plan in editor')
  .option('--issue <url|number>', 'Issue URL or number to use for the plan text')
  .option(
    '--simple',
    'For simpler tasks, generate a single-phase plan that already includes the prompts'
  )
  .option('--autofind', 'Automatically find relevant files based on plan')
  .option('--quiet', 'Suppress informational output')
  .option(
    '--no-extract',
    'Do not automatically run the extract command after generating the prompt'
  )
  .option('--commit', 'Commit changes to jj/git after successful plan generation')
  .allowExcessArguments(true)
  .allowUnknownOption(true)
  .action(async (options, command) => {
    const globalOpts = program.opts();
    const config = await loadEffectiveConfig(globalOpts.config);
    const gitRoot = (await getGitRoot()) || process.cwd();

    // Find '--' in process.argv to get extra args for rmfilter
    const doubleDashIdx = process.argv.indexOf('--');
    const userCliRmfilterArgs = doubleDashIdx !== -1 ? process.argv.slice(doubleDashIdx + 1) : [];

    let planOptionsSet = [options.plan, options.planEditor, options.issue].reduce(
      (acc, val) => acc + (val ? 1 : 0),
      0
    );

    // Manual conflict check for --plan and --plan-editor
    if (planOptionsSet !== 1) {
      error(
        'You must provide one and only one of --plan <file>, --plan-editor, or --issue <url|number>'
      );
      process.exit(1);
    }

    let planText: string | undefined;
    let combinedRmprOptions: RmprOptions | null = null;
    let issueResult: Awaited<ReturnType<typeof getInstructionsFromGithubIssue>> | undefined;
    let issueUrlsForExtract: string[] = [];

    let planFile: string | undefined = options.plan;

    if (options.plan) {
      try {
        const filePath = await resolvePlanFile(options.plan, globalOpts.config);
        const fileContent = await Bun.file(filePath).text();
        planFile = filePath;

        // Check if the file is a YAML plan file by trying to parse it
        let isYamlPlan = false;
        let parsedPlan: PlanSchema | null = null;

        try {
          // Try to parse as YAML
          const yamlContent = findYamlStart(fileContent);
          parsedPlan = yaml.parse(yamlContent) as PlanSchema;

          // Validate that it has plan structure (at least id or goal)
          if (parsedPlan && (parsedPlan.id || parsedPlan.goal)) {
            isYamlPlan = true;
          }
        } catch {
          // Not a valid YAML plan, treat as markdown
          isYamlPlan = false;
        }

        if (isYamlPlan && parsedPlan) {
          // Check if it's a stub plan (no tasks or empty tasks array)
          const isStubPlan = !parsedPlan.tasks || parsedPlan.tasks.length === 0;

          if (!isStubPlan) {
            // Plan already has tasks - log a message and continue with normal flow
            log(
              chalk.yellow(
                'Plan already contains tasks. To regenerate, remove the tasks array from the YAML file.'
              )
            );
            planText = fileContent;
          } else {
            // It's a stub plan - we'll handle task generation below
            // For now, set planText to null to trigger special handling
            planText = null as any;
          }
        } else {
          // Regular markdown file
          planText = fileContent;
        }
      } catch (err) {
        error(`Failed to read plan file: ${options.plan}`);
        process.exit(1);
      }
    } else if (options.planEditor) {
      try {
        // Create a temporary file for the plan editor
        const tmpPlanPath = path.join(os.tmpdir(), `rmplan-editor-${Date.now()}.md`);

        // Open editor with the temporary file
        const editor = process.env.EDITOR || 'nano';
        const editorProcess = logSpawn([editor, tmpPlanPath], {
          stdio: ['inherit', 'inherit', 'inherit'],
        });
        await editorProcess.exited;

        // Read the plan text from the temporary file
        try {
          planText = await Bun.file(tmpPlanPath).text();
        } catch (err) {
          error('Failed to read plan from editor.');
          process.exit(1);
        } finally {
          // Clean up the temporary file
          try {
            await Bun.file(tmpPlanPath).unlink();
          } catch (e) {
            // Ignore cleanup errors
          }
        }

        if (!planText || !planText.trim()) {
          error('No plan text was provided from the editor.');
          process.exit(1);
        }

        // Copy the plan to clipboard
        await clipboard.write(planText);
        log(chalk.green('✓ Plan copied to clipboard'));

        // Generate suggested filename using Gemini Flash 2.0
        let suggestedFilename = await generateSuggestedFilename(planText, config);

        // Prompt for save location
        let savePath = await input({
          message: 'Save plan to this file (or clear the line to skip): ',
          required: false,
          default: suggestedFilename,
        });

        if (savePath) {
          // If the path is relative resolve it against the git root
          if (!path.isAbsolute(savePath) && config.paths?.tasks) {
            savePath = path.resolve(gitRoot, suggestedFilename);
          }

          try {
            await Bun.write(savePath, planText);
            planFile = savePath;
            log('Plan saved to:', savePath);
          } catch (err) {
            error('Failed to save plan to file:', err);
            process.exit(1);
          }
        }
      } catch (err) {
        error('Failed to get plan from editor:', err);
        process.exit(1);
      }
    } else if (options.issue) {
      issueResult = await getInstructionsFromGithubIssue(options.issue);
      planText = issueResult.plan;
      // Extract combinedRmprOptions from the result if it exists
      combinedRmprOptions = issueResult.rmprOptions ?? null;

      // Construct the issue URL
      issueUrlsForExtract.push(issueResult.issue.url);

      let tasksDir = await resolveTasksDir(config);
      let suggestedFilename = config.paths?.tasks
        ? path.join(tasksDir, issueResult.suggestedFileName)
        : issueResult.suggestedFileName;

      let savePath = await input({
        message: 'Save plan to this file (or clear the line to skip): ',
        required: false,
        default: suggestedFilename,
      });

      if (savePath) {
        try {
          await Bun.write(savePath, planText);
          planFile = savePath;
          log('Plan saved to:', savePath);
        } catch (err) {
          error('Failed to save plan to file:', err);
          process.exit(1);
        }
      }
    }

    // Special handling for stub YAML plans
    let stubPlanData: PlanSchema | null = null;
    if (options.plan && planFile && planText === null) {
      // We detected a stub plan earlier, now we need to load it properly
      try {
        const fileContent = await Bun.file(planFile).text();
        const yamlContent = findYamlStart(fileContent);
        stubPlanData = yaml.parse(yamlContent) as PlanSchema;

        const goal = stubPlanData.goal === 'Goal to be defined.' ? '' : stubPlanData.goal;
        const details = stubPlanData.details === 'Details to be added.' ? '' : stubPlanData.details;

        if (!goal && !details) {
          error('Stub plan must have at least a goal or details to generate tasks.');
          process.exit(1);
        }

        // Construct planText from stub's title, goal, and details
        const planParts: string[] = [];
        if (stubPlanData.title) {
          planParts.push(`# ${stubPlanData.title}`);
        }
        if (goal) {
          planParts.push(`\n## Goal\n${goal}`);
        }
        if (details) {
          planParts.push(`\n## Details\n${details}`);
        }

        planText = planParts.join('\n');

        log(chalk.blue('🔄 Detected stub plan. Generating detailed tasks for:'), planFile);
      } catch (err) {
        error(`Failed to process stub plan: ${err as Error}`);
        process.exit(1);
      }
    }

    if (!planText) {
      error('No plan text was provided.');
      process.exit(1);
    }

    // planText now contains the loaded plan
    const promptString = options.simple ? simplePlanPrompt(planText) : planPrompt(planText);
    const tmpPromptPath = path.join(os.tmpdir(), `rmplan-prompt-${Date.now()}.md`);
    let exitRes: number | undefined;
    let wrotePrompt = false;
    try {
      await Bun.write(tmpPromptPath, promptString);
      wrotePrompt = true;
      log('Prompt written to:', tmpPromptPath);

      // Call rmfilter with constructed args
      let additionalFiles: string[] = [];
      if (options.autofind) {
        log('[Autofind] Searching for relevant files based on plan...');
        const query = planText;

        const rmfindOptions: RmfindOptions = {
          baseDir: gitRoot,
          query: query,
          classifierModel: process.env.RMFIND_CLASSIFIER_MODEL || process.env.RMFIND_MODEL,
          grepGeneratorModel: process.env.RMFIND_GREP_GENERATOR_MODEL || process.env.RMFIND_MODEL,
          globs: [],
          quiet: options.quiet ?? false,
        };

        try {
          const rmfindResult = await findFilesCore(rmfindOptions);
          if (rmfindResult && rmfindResult.files.length > 0) {
            if (!options.quiet) {
              log(`[Autofind] Found ${rmfindResult.files.length} potentially relevant files:`);
              rmfindResult.files.forEach((f) => log(`  - ${path.relative(gitRoot, f)}`));
            }
            additionalFiles = rmfindResult.files.map((f) => path.relative(gitRoot, f));
          }
        } catch (error) {
          warn(
            `[Autofind] Warning: Failed to find files: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      // Process the combinedRmprOptions if available
      let issueRmfilterOptions: string[] = [];
      if (combinedRmprOptions) {
        issueRmfilterOptions = argsFromRmprOptions(combinedRmprOptions);
        if (issueRmfilterOptions.length > 0 && !options.quiet) {
          log(chalk.blue('Applying rmpr options from issue:'), issueRmfilterOptions.join(' '));
        }
      }

      // Combine user CLI args and issue rmpr options
      const allRmfilterOptions: string[] = [];
      for (const argList of [userCliRmfilterArgs, issueRmfilterOptions, stubPlanData?.rmfilter]) {
        if (!argList?.length) continue;
        // Add a separator if some options already exist
        if (allRmfilterOptions.length) allRmfilterOptions.push('--');
        allRmfilterOptions.push(...argList);
      }

      // Check if no files are provided to rmfilter
      const hasNoFiles = additionalFiles.length === 0 && allRmfilterOptions.length === 0;

      if (hasNoFiles) {
        warn(
          chalk.yellow(
            '\n⚠️  Warning: No files specified for rmfilter. The prompt will only contain the planning instructions without any code context.'
          )
        );

        // Copy the prompt directly to clipboard without running rmfilter
        await clipboard.write(promptString);
        log('Prompt copied to clipboard');
        exitRes = 0;
      } else {
        // Append autofound files to rmfilter args
        const rmfilterFullArgs = [
          'rmfilter',
          ...allRmfilterOptions,
          '--',
          ...additionalFiles,
          '--bare',
          '--copy',
          '--instructions',
          `@${tmpPromptPath}`,
        ];
        const proc = logSpawn(rmfilterFullArgs, {
          cwd: gitRoot,
          stdio: ['inherit', 'inherit', 'inherit'],
        });
        exitRes = await proc.exited;
      }

      if (exitRes === 0 && !options.noExtract) {
        log(
          chalk.bold(
            `\nPlease paste the prompt into the chat interface. Then ${sshAwarePasteAction()} to extract the copied Markdown to a YAML plan file, or Ctrl+C to exit.`
          )
        );

        let input = await waitForEnter(true);

        let outputPath: string;
        if (planFile) {
          if (planFile.endsWith('.yml')) {
            outputPath = planFile;
          } else {
            // Use the directory of the plan file for output
            outputPath = path.join(path.dirname(planFile), path.basename(planFile, '.md'));
          }
        } else {
          // Default to current directory with a generated name
          outputPath = 'rmplan-output';
        }

        const extractOptions: ExtractMarkdownToYamlOptions = {
          output: outputPath,
          planRmfilterArgs: allRmfilterOptions,
          issueUrls: issueUrlsForExtract,
          stubPlanData: stubPlanData || undefined,
          commit: options.commit,
        };

        const result = await extractMarkdownToYaml(
          input,
          config,
          options.quiet ?? false,
          extractOptions
        );

        // If we generated from a stub plan, handle file cleanup
        if (stubPlanData && planFile) {
          // Check if the result indicates multiple files were created
          const isMultiPhase = result.includes('phase files');

          if (isMultiPhase) {
            // Multiple phase files were created in a subdirectory, remove the original stub
            try {
              await fs.unlink(planFile);
              if (!options.quiet) {
                log(chalk.blue('✓ Removed original stub plan file:', planFile));
              }
            } catch (err) {
              warn(`Failed to remove original stub plan: ${err as Error}`);
            }
          } else {
            // Single file was created, it should have overwritten the original
            if (!options.quiet) {
              log(chalk.blue('✓ Updated plan file in place:', outputPath));
            }
          }
        }
      }
    } finally {
      if (wrotePrompt) {
        try {
          await Bun.file(tmpPromptPath).unlink();
        } catch (e) {
          warn('Warning: failed to clean up temp file:', tmpPromptPath);
        }
      }
    }

    if (exitRes !== 0) {
      error(`rmfilter exited with code ${exitRes}`);
      process.exit(exitRes ?? 1);
    }
  });

program
  .command('extract [inputFile]')
  .description('Convert a Markdown project plan into YAML')
  .option('-o, --output <outputFile>', 'Write result to a file instead of stdout')
  .option(
    '--plan <planFile>',
    'The path of the original Markdown project description file. If set, rmplan will write the output to the same path, but with a .yml extension.'
  )
  .option(
    '--project-id <id>',
    'Specify a project ID for multi-phase plans. If not provided, the project ID will be inferred from the plan.'
  )
  .option(
    '--issue <issue_number_or_url>',
    'GitHub issue number or URL to associate with the project and use for naming.'
  )
  .option('--quiet', 'Suppress informational output')
  .allowExcessArguments(true)
  .action(async (inputFile, options) => {
    setQuiet(options.quiet);

    let inputText: string;
    if (inputFile) {
      inputText = await Bun.file(inputFile).text();
    } else if (!process.stdin.isTTY) {
      inputText = await Bun.stdin.text();
    } else {
      inputText = await clipboard.read();
    }

    let outputPath = options.output;
    if (options.plan && !options.output) {
      let name = options.plan.endsWith('.yml')
        ? options.plan
        : path.basename(options.plan, '.md') + '.yml';
      outputPath = path.join(path.dirname(options.plan), name);
    }

    // Determine output path
    if (!outputPath) {
      error('Either --output or --plan must be specified');
      process.exit(1);
    }

    try {
      const config = await loadEffectiveConfig(options.config);

      // Check if output file already exists and is a stub plan
      let stubPlanData: PlanSchema | undefined;
      const outputYmlPath = outputPath.endsWith('.yml') ? outputPath : `${outputPath}.yml`;
      try {
        const existingPlan = await readPlanFile(outputYmlPath);
        // Check if it's a stub plan (has structure but no tasks)
        if (existingPlan && (!existingPlan.tasks || existingPlan.tasks.length === 0)) {
          stubPlanData = existingPlan;
          if (!options.quiet) {
            log(chalk.blue('Found existing stub plan, preserving metadata'));
          }
        }
      } catch {
        // File doesn't exist or isn't valid YAML, that's fine
      }

      // Extract markdown to YAML using LLM
      const extractOptions: ExtractMarkdownToYamlOptions = {
        output: outputPath,
        projectId: options.projectId,
        issueUrls: options.issue ? [options.issue] : [],
        stubPlanData,
      };

      await extractMarkdownToYaml(inputText, config, options.quiet ?? false, extractOptions);
    } catch (e) {
      error('Failed to extract markdown to YAML:', e);
      process.exit(1);
    }
  });

program
  .command('add <title...>')
  .description('Create a new plan stub file that can be filled with tasks using generate')
  .option('--edit', 'Open the newly created plan file in your editor')
  .option('--depends-on <ids...>', 'Specify plan IDs that this plan depends on')
  .option('--priority <level>', 'Set the priority level (low, medium, high, urgent)')
  .action(async (title, options) => {
    const globalOpts = program.opts();

    try {
      // Join the title arguments to form the complete plan title
      const planTitle = title.join(' ');

      // Load the effective configuration
      const config = await loadEffectiveConfig(globalOpts.config);

      // Determine the target directory for the new plan file
      let targetDir: string;
      if (config.paths?.tasks) {
        if (path.isAbsolute(config.paths.tasks)) {
          targetDir = config.paths.tasks;
        } else {
          // Resolve relative to git root
          const gitRoot = (await getGitRoot()) || process.cwd();
          targetDir = path.join(gitRoot, config.paths.tasks);
        }
      } else {
        targetDir = process.cwd();
      }

      // Ensure the target directory exists
      await fs.mkdir(targetDir, { recursive: true });

      // Generate a unique plan ID
      const planId = generateAlphanumericPlanId();

      // Create a slugified filename from the plan title
      const filename = slugify(planTitle) + '.yml';

      // Construct the full path to the new plan file
      const filePath = path.join(targetDir, filename);

      // Validate priority if provided
      if (options.priority) {
        const validPriorities = ['low', 'medium', 'high', 'urgent'];
        if (!validPriorities.includes(options.priority)) {
          error(
            `Invalid priority level: ${options.priority}. Must be one of: ${validPriorities.join(', ')}`
          );
          process.exit(1);
        }
      }

      // Create the initial plan object adhering to PlanSchema
      const plan: PlanSchema = {
        id: planId,
        title: planTitle,
        goal: 'Goal to be defined.',
        details: 'Details to be added.',
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tasks: [],
      };

      // Add dependencies if provided
      if (options.dependsOn && options.dependsOn.length > 0) {
        plan.dependencies = options.dependsOn;
      }

      // Add priority if provided
      if (options.priority) {
        plan.priority = options.priority as 'low' | 'medium' | 'high' | 'urgent';
      }

      // Write the plan to the new file
      await writePlanFile(filePath, plan);

      // Log success message
      log(chalk.green('✓ Created plan stub:'), filePath);
      log(chalk.gray('  Next step: Use "rmplan generate" to add detailed tasks to this plan'));

      // Open in editor if requested
      if (options.edit) {
        const editor = process.env.EDITOR || 'nano';
        const editorProcess = Bun.spawn([editor, filePath], {
          stdio: ['inherit', 'inherit', 'inherit'],
        });
        await editorProcess.exited;
      }
    } catch (err) {
      error(`Failed to create plan: ${err as Error}`);
      process.exit(1);
    }
  });

program
  .command('done <planFile>')
  .description('Mark the next step/task in a plan YAML as done. Can be a file path or plan ID.')
  .option('--steps <steps>', 'Number of steps to mark as done', '1')
  .option('--task', 'Mark all steps in the current task as done')
  .option('--commit', 'Commit changes to jj/git')
  .action(async (planFile, options) => {
    const globalOpts = program.opts();
    const gitRoot = (await getGitRoot()) || process.cwd();

    try {
      const config = await loadEffectiveConfig(globalOpts.config);
      const resolvedPlanFile = await resolvePlanFile(planFile, globalOpts.config);
      const result = await markStepDone(
        resolvedPlanFile,
        {
          task: options.task,
          steps: options.steps ? parseInt(options.steps, 10) : 1,
          commit: options.commit,
        },
        undefined,
        gitRoot,
        config
      );

      // If plan is complete and we're in a workspace, release the lock
      if (result.planComplete) {
        try {
          await WorkspaceLock.releaseLock(gitRoot);
          log('Released workspace lock');
        } catch (err) {
          // Ignore lock release errors - workspace might not be locked
        }
      }
    } catch (err) {
      error(`Failed to process plan: ${err as Error}`);
      process.exit(1);
    }
  });

program
  .command('next <planFile>')
  .description(
    'Prepare the next step(s) from a plan YAML for execution. Can be a file path or plan ID.'
  )
  .option('--rmfilter', 'Use rmfilter to generate the prompt')
  .option('--previous', 'Include information about previous completed steps')
  .option('--with-imports', 'Include direct imports of files found in the prompt or task files')
  .option(
    '--with-all-imports',
    'Include the entire import tree of files found in the prompt or task files'
  )
  .option('--with-importers', 'Include importers of files found in the prompt or task files')
  .option('--autofind', 'Automatically run rmfind to find relevant files based on the plan task')
  .allowExcessArguments(true)
  .allowUnknownOption(true)
  .action(async (planFile, options) => {
    const globalOpts = program.opts();
    // Find '--' in process.argv to get extra args for rmfilter
    const doubleDashIdx = process.argv.indexOf('--');
    const cmdLineRmfilterArgs = doubleDashIdx !== -1 ? process.argv.slice(doubleDashIdx + 1) : [];
    const config = await loadEffectiveConfig(globalOpts.config);
    const gitRoot = (await getGitRoot()) || process.cwd();

    try {
      const resolvedPlanFile = await resolvePlanFile(planFile, globalOpts.config);
      const result = await prepareNextStep(
        config,
        resolvedPlanFile,
        {
          rmfilter: options.rmfilter,
          previous: options.previous,
          withImports: options.withImports,
          withAllImports: options.withAllImports,
          withImporters: options.withImporters,
          selectSteps: true,
          autofind: options.autofind,
          rmfilterArgs: cmdLineRmfilterArgs,
        },
        gitRoot
      );

      if (options.rmfilter && result.promptFilePath && result.rmfilterArgs) {
        try {
          const proc = logSpawn(['rmfilter', '--copy', ...result.rmfilterArgs], {
            cwd: gitRoot,
            stdio: ['inherit', 'inherit', 'inherit'],
          });
          const exitRes = await proc.exited;
          if (exitRes !== 0) {
            error(`rmfilter exited with code ${exitRes}`);
            process.exit(exitRes ?? 1);
          }
        } finally {
          try {
            await Bun.file(result.promptFilePath).unlink();
          } catch (e) {
            warn('Warning: failed to clean up temp file:', result.promptFilePath);
          }
        }
      } else {
        log('\n----- LLM PROMPT -----\n');
        log(result.prompt);
        log('\n---------------------\n');
        await clipboard.write(result.prompt);
        log('Prompt copied to clipboard');
      }
    } catch (err) {
      error('Failed to process plan file:', err);
      process.exit(1);
    }
  });

program
  .command('cleanup [files...]')
  .description('Remove end-of-line comments from changed files or specified files')
  .option(
    '--diff-from <branch>',
    'Compare to this branch/revision when no files provided. Default is current diff'
  )
  .action(async (files, options) => {
    try {
      await cleanupEolComments(options.diffFrom, files);
    } catch (err) {
      error('Failed to cleanup comments:', err);
      process.exit(1);
    }
  });

const executorNames = executors
  .values()
  .map((e) => e.name)
  .toArray()
  .join(', ');

// Shared function to create the agent/run command configuration
function createAgentCommand(command: Command, description: string) {
  return command
    .description(description)
    .option('-m, --model <model>', 'Model to use for LLM')
    .option(`-x, --executor <name>`, 'The executor to use for plan execution')
    .addHelpText('after', `Available executors: ${executorNames}`)
    .option('--steps <steps>', 'Number of steps to execute')
    .option('--no-log', 'Do not log to file')
    .option(
      '--workspace <id>',
      'ID for the task, used for workspace naming and tracking. If provided, a new workspace will be created.'
    )
    .option('--auto-workspace', 'Automatically select an available workspace or create a new one')
    .option(
      '--new-workspace',
      'Allow creating a new workspace. When used with --workspace, creates a new workspace with the specified ID. When used with --auto-workspace, always creates a new workspace instead of reusing existing ones.'
    )
    .option('--non-interactive', 'Do not prompt for user input (e.g., when clearing stale locks)')
    .option('--require-workspace', 'Fail if workspace creation is requested but fails', false)
    .option('--next', 'Execute the next plan that is ready to be implemented')
    .option('--current', 'Execute the current plan (in_progress or next ready plan)')
    .option('--with-dependencies', 'Also execute all dependencies first in the correct order')
    .option(
      '--direct',
      'Call LLM directly instead of copying prompt to clipboard during preparation'
    )
    .allowExcessArguments(true)
    .allowUnknownOption(true)
    .action(async (planFile, options) => {
      const globalOpts = program.opts();

      // Find '--' in process.argv to get extra args for rmfilter
      const doubleDashIdx = process.argv.indexOf('--');
      const rmfilterArgs = doubleDashIdx !== -1 ? process.argv.slice(doubleDashIdx + 1) : [];

      try {
        let resolvedPlanFile: string;

        if (options.next || options.current) {
          // Find the next ready plan or current plan
          const config = await loadEffectiveConfig(globalOpts.config);
          const tasksDir = await resolveTasksDir(config);
          const plan = await findNextPlan(tasksDir, {
            includeInProgress: options.current,
            includePending: true,
          });

          if (!plan) {
            if (options.current) {
              log('No current plans found. No plans are in progress or ready to be implemented.');
            } else {
              log('No ready plans found. All pending plans have incomplete dependencies.');
            }
            return;
          }

          const message = options.current
            ? `Found current plan: ${plan.id} - ${getCombinedTitleFromSummary(plan)}`
            : `Found next ready plan: ${plan.id} - ${getCombinedTitleFromSummary(plan)}`;
          log(chalk.green(message));
          resolvedPlanFile = plan.filename;
        } else {
          if (!planFile) {
            error('Please provide a plan file or use --next/--current to find a plan');
            process.exit(1);
          }
          resolvedPlanFile = await resolvePlanFile(planFile, globalOpts.config);
        }

        // Check if we need to execute dependencies first
        if (options.withDependencies) {
          const config = await loadEffectiveConfig(globalOpts.config);
          const tasksDir = await resolveTasksDir(config);
          const { plans: allPlans } = await readAllPlans(tasksDir);

          // Get the plan's ID
          const planData = await readPlanFile(resolvedPlanFile);

          if (!planData.id) {
            error('Plan must have an ID to execute with dependencies');
            process.exit(1);
          }

          try {
            // Collect all plans to execute in order
            const plansToExecute = await collectDependenciesInOrder(planData.id, allPlans);

            if (plansToExecute.length > 1) {
              log(chalk.bold('\n📋 Plans to execute in order:'));
              plansToExecute.forEach((plan, index) => {
                const status = plan.status || 'pending';
                const statusIcon = status === 'done' ? '✓' : status === 'in_progress' ? '⏳' : '○';
                log(
                  `  ${index + 1}. ${statusIcon} ${plan.id} - ${getCombinedTitleFromSummary(plan)}`
                );
              });
              log('');
            }

            // Execute each plan in order
            for (const plan of plansToExecute) {
              if (plan.status === 'done') {
                log(chalk.gray(`Skipping completed plan: ${plan.id}`));
                continue;
              }

              log(
                chalk.bold(`\n🚀 Executing plan: ${plan.id} - ${getCombinedTitleFromSummary(plan)}`)
              );
              log('─'.repeat(80));

              // Pass rmfilterArgs to rmplanAgent
              const planOptions = { ...options, rmfilterArgs };
              await rmplanAgent(plan.filename, planOptions, globalOpts);

              log(chalk.green(`✓ Completed plan: ${plan.id}`));
            }

            log(chalk.bold('\n✅ All plans executed successfully!'));
          } catch (err) {
            if (err instanceof Error && err.message.includes('Circular dependency')) {
              error(err.message);
            } else {
              error(`Failed to collect dependencies: ${err as Error}`);
            }
            process.exit(1);
          }
        } else {
          // Pass rmfilterArgs to rmplanAgent
          options.rmfilterArgs = rmfilterArgs;
          await rmplanAgent(resolvedPlanFile, options, globalOpts);
        }
      } catch (err) {
        error(`Failed to process plan: ${err as Error}`);
        process.exit(1);
      }
    });
}

// Create the agent command
createAgentCommand(
  program.command('agent [planFile]'),
  'Automatically execute steps in a plan YAML file. Can be a file path or plan ID.'
);

// Create the run command as an alias
createAgentCommand(
  program.command('run [planFile]'),
  'Alias for "agent". Automatically execute steps in a plan YAML file. Can be a file path or plan ID.'
);

program
  .command('list')
  .description('List all plan files in the tasks directory')
  .option(
    '--dir <directory>',
    'Directory to search for plan files (defaults to configured tasks directory)'
  )
  .option(
    '--sort <field>',
    'Sort by: id, title, status, priority, created, updated (default: id)',
    'id'
  )
  .option('--reverse', 'Reverse sort order')
  .option(
    '--status <status...>',
    'Filter by status (can specify multiple). Valid values: pending, in_progress, done, ready'
  )
  .option('--all', 'Show all plans regardless of status (overrides default filter)')
  .action(async (options) => {
    try {
      const globalOpts = program.opts();
      const config = await loadEffectiveConfig(globalOpts.config);

      // Determine directory to search
      let searchDir = options.dir || (await resolveTasksDir(config));

      // Read all plans
      const { plans } = await readAllPlans(searchDir);

      if (plans.size === 0) {
        log('No plan files found in', searchDir);
        return;
      }

      // Filter plans based on status
      let planArray = Array.from(plans.values());

      if (!options.all) {
        // Determine which statuses to show
        let statusesToShow: Set<string>;

        if (options.status && options.status.length > 0) {
          // Use explicitly specified statuses
          statusesToShow = new Set(options.status);
        } else {
          // Default: show pending and in_progress
          statusesToShow = new Set(['pending', 'in_progress']);
        }

        // Filter plans
        planArray = planArray.filter((plan) => {
          const status = plan.status || 'pending';

          // Handle "ready" status filter
          if (statusesToShow.has('ready')) {
            if (isPlanReady(plan, plans)) {
              return true;
            }
          }

          return statusesToShow.has(status);
        });
      }

      // Sort based on the specified field
      planArray.sort((a, b) => {
        let aVal: string | number;
        let bVal: string | number;
        switch (options.sort) {
          case 'title':
            aVal = (a.title || a.goal || '').toLowerCase();
            bVal = (b.title || b.goal || '').toLowerCase();
            break;
          case 'status':
            aVal = a.status || '';
            bVal = b.status || '';
            break;
          case 'priority': {
            // Sort priority in reverse (high first)
            const priorityOrder: Record<string, number> = { urgent: 5, high: 4, medium: 3, low: 2 };
            aVal = a.priority ? priorityOrder[a.priority] || 0 : 0;
            bVal = b.priority ? priorityOrder[b.priority] || 0 : 0;
            break;
          }
          case 'created':
            aVal = a.createdAt || '';
            bVal = b.createdAt || '';
            break;
          case 'updated':
            aVal = a.updatedAt || '';
            bVal = b.updatedAt || '';
            break;
          case 'id':
          default:
            aVal = a.id || '';
            bVal = b.id || '';
            break;
        }

        if (aVal < bVal) return options.reverse ? 1 : -1;
        if (aVal > bVal) return options.reverse ? -1 : 1;
        return 0;
      });

      // Display as table
      log(chalk.bold('Plan Files:'));
      log('');

      // Prepare table data
      const tableData: string[][] = [];

      // Header row
      tableData.push([
        chalk.bold('ID'),
        chalk.bold('Title'),
        chalk.bold('Status'),
        chalk.bold('Priority'),
        chalk.bold('Tasks'),
        chalk.bold('Steps'),
        chalk.bold('Depends On'),
        chalk.bold('File'),
      ]);

      // Data rows
      for (const plan of planArray) {
        // Display "ready" for pending plans whose dependencies are all done
        const actualStatus = plan.status || 'pending';
        const isReady = isPlanReady(plan, plans);
        const statusDisplay = isReady ? 'ready' : actualStatus;

        const statusColor =
          actualStatus === 'done'
            ? chalk.green
            : isReady
              ? chalk.cyan
              : actualStatus === 'in_progress'
                ? chalk.yellow
                : actualStatus === 'pending'
                  ? chalk.white
                  : chalk.gray;

        const priorityColor =
          plan.priority === 'urgent'
            ? chalk.magenta
            : plan.priority === 'high'
              ? chalk.red
              : plan.priority === 'medium'
                ? chalk.yellow
                : plan.priority === 'low'
                  ? chalk.blue
                  : chalk.white;

        const priorityDisplay = plan.priority || '';

        tableData.push([
          chalk.cyan(plan.id || 'no-id'),
          getCombinedTitleFromSummary(plan),
          statusColor(statusDisplay),
          priorityColor(priorityDisplay),
          (plan.taskCount || 0).toString(),
          plan.stepCount === 0 || !plan.stepCount ? '-' : plan.stepCount.toString(),
          plan.dependencies?.join(', ') || '-',
          chalk.gray(path.relative(searchDir, plan.filename)),
        ]);
      }

      // Configure table options
      const tableConfig = {
        columns: {
          1: { width: 50, wrapWord: true },
          6: { width: 15, wrapWord: true },
          7: { width: 20, wrapWord: true },
        },
        border: {
          topBody: '─',
          topJoin: '┬',
          topLeft: '┌',
          topRight: '┐',
          bottomBody: '─',
          bottomJoin: '┴',
          bottomLeft: '└',
          bottomRight: '┘',
          bodyLeft: '│',
          bodyRight: '│',
          bodyJoin: '│',
          joinBody: '─',
          joinLeft: '├',
          joinRight: '┤',
          joinJoin: '┼',
        },
      };

      const output = table(tableData, tableConfig);
      log(output);

      log(`Showing: ${planArray.length} of ${plans.size} plan(s)`);
    } catch (err) {
      error('Failed to list plans:', err);
      process.exit(1);
    }
  });

program
  .command('prepare [yamlFile]')
  .description(
    'Generate detailed steps and prompts for a specific phase. Can be a file path or plan ID.'
  )
  .option('--force', 'Override dependency completion check and proceed with generation.')
  .option('-m, --model <model_id>', 'Specify the LLM model to use for generating phase details.')
  .option('--next', 'Prepare the next plan that is ready to be implemented')
  .option('--current', 'Prepare the current plan (in_progress or next ready plan)')
  .option('--direct', 'Call LLM directly instead of copying prompt to clipboard')
  .allowExcessArguments(true)
  .allowUnknownOption(true)
  .action(async (yamlFile, options) => {
    const globalOpts = program.opts();

    // Find '--' in process.argv to get extra args for rmfilter
    const doubleDashIdx = process.argv.indexOf('--');
    const rmfilterArgs = doubleDashIdx !== -1 ? process.argv.slice(doubleDashIdx + 1) : [];

    try {
      // Load RmplanConfig using loadEffectiveConfig
      const config = await loadEffectiveConfig(globalOpts.config);

      let phaseYamlFile: string;

      if (options.next || options.current) {
        // Find the next ready plan or current plan
        const tasksDir = await resolveTasksDir(config);
        const plan = await findNextPlan(tasksDir, {
          includePending: true,
          includeInProgress: options.current,
        });

        if (!plan) {
          if (options.current) {
            log('No current plans found. No plans are in progress or ready to be implemented.');
          } else {
            log('No ready plans found. All pending plans have incomplete dependencies.');
          }
          return;
        }

        const message = options.current
          ? `Found current plan: ${plan.id} - ${getCombinedTitleFromSummary(plan)}`
          : `Found next ready plan: ${plan.id} - ${getCombinedTitleFromSummary(plan)}`;
        log(chalk.green(message));
        phaseYamlFile = plan.filename;
      } else {
        if (!yamlFile) {
          error('Please provide a plan file or use --next/--current to find a plan');
          process.exit(1);
        }
        // Resolve plan file (ID or path)
        phaseYamlFile = await resolvePlanFile(yamlFile, globalOpts.config);
      }

      await preparePhase(phaseYamlFile, config, {
        force: options.force,
        model: options.model,
        rmfilterArgs: rmfilterArgs,
        direct: options.direct,
      });
    } catch (err) {
      error('Failed to generate phase details:', err);
      process.exit(1);
    }
  });

program
  .command('show [planFile]')
  .description('Display detailed information about a plan. Can be a file path or plan ID.')
  .option('--next', 'Show the next plan that is ready to be implemented')
  .option('--current', 'Show the current plan (in_progress or next ready plan)')
  .action(async (planFile, options) => {
    const globalOpts = program.opts();

    try {
      const config = await loadEffectiveConfig(globalOpts.config);

      let resolvedPlanFile: string;

      if (options.next || options.current) {
        // Find the next ready plan or current plan
        const tasksDir = await resolveTasksDir(config);
        const plan = await findNextPlan(tasksDir, {
          includePending: true,
          includeInProgress: options.current,
        });

        if (!plan) {
          if (options.current) {
            log('No current plans found. No plans are in progress or ready to be implemented.');
          } else {
            log('No ready plans found. All pending plans have incomplete dependencies.');
          }
          return;
        }

        const message = options.current
          ? `Found current plan: ${plan.id}`
          : `Found next ready plan: ${plan.id}`;
        log(chalk.green(message));
        resolvedPlanFile = plan.filename;
      } else {
        if (!planFile) {
          error('Please provide a plan file or use --next/--current to find a plan');
          process.exit(1);
        }
        resolvedPlanFile = await resolvePlanFile(planFile, globalOpts.config);
      }

      // Read the plan file
      const plan = await readPlanFile(resolvedPlanFile);

      // Check if plan is ready (we'll need to load all plans to check dependencies)
      const tasksDir = await resolveTasksDir(config);
      const { plans: allPlans } = await readAllPlans(tasksDir);

      // Display basic information
      log(chalk.bold('\nPlan Information:'));
      log('─'.repeat(60));
      log(`${chalk.cyan('ID:')} ${plan.id || 'Not set'}`);
      log(`${chalk.cyan('Title:')} ${getCombinedTitle(plan)}`);

      // Display "ready" for pending plans whose dependencies are done
      const actualStatus = plan.status || 'pending';
      const isReady = plan.id
        ? isPlanReady(
            {
              id: plan.id,
              status: actualStatus,
              dependencies: plan.dependencies,
              goal: plan.goal,
              filename: resolvedPlanFile,
            },
            allPlans
          )
        : false;
      const statusDisplay = isReady ? 'ready' : actualStatus;
      const statusColor = isReady ? chalk.cyan : chalk.white;
      log(`${chalk.cyan('Status:')} ${statusColor(statusDisplay)}`);

      log(`${chalk.cyan('Priority:')} ${plan.priority || ''}`);
      log(`${chalk.cyan('Goal:')} ${getCombinedGoal(plan)}`);
      log(`${chalk.cyan('File:')} ${resolvedPlanFile}`);

      if (plan.baseBranch) {
        log(`${chalk.cyan('Base Branch:')} ${plan.baseBranch}`);
      }

      if (plan.createdAt) {
        log(`${chalk.cyan('Created:')} ${new Date(plan.createdAt).toLocaleString()}`);
      }

      if (plan.updatedAt) {
        log(`${chalk.cyan('Updated:')} ${new Date(plan.updatedAt).toLocaleString()}`);
      }

      // Display dependencies with resolution
      if (plan.dependencies && plan.dependencies.length > 0) {
        log('\n' + chalk.bold('Dependencies:'));
        log('─'.repeat(60));

        for (const depId of plan.dependencies) {
          const depPlan = allPlans.get(depId);
          if (depPlan) {
            const statusIcon =
              depPlan.status === 'done' ? '✓' : depPlan.status === 'in_progress' ? '⏳' : '○';
            const statusColor =
              depPlan.status === 'done'
                ? chalk.green
                : depPlan.status === 'in_progress'
                  ? chalk.yellow
                  : chalk.gray;
            log(
              `  ${statusIcon} ${chalk.cyan(depId)} - ${getCombinedTitleFromSummary(depPlan)} ${statusColor(`[${depPlan.status || 'pending'}]`)}`
            );
          } else {
            log(`  ○ ${chalk.cyan(depId)} ${chalk.red('[Not found]')}`);
          }
        }
      }

      // Display issues and PRs
      if (plan.issue && plan.issue.length > 0) {
        log('\n' + chalk.bold('Issues:'));
        log('─'.repeat(60));
        plan.issue.forEach((url) => log(`  • ${url}`));
      }

      if (plan.pullRequest && plan.pullRequest.length > 0) {
        log('\n' + chalk.bold('Pull Requests:'));
        log('─'.repeat(60));
        plan.pullRequest.forEach((url) => log(`  • ${url}`));
      }

      // Display details
      if (plan.details) {
        log('\n' + chalk.bold('Details:'));
        log('─'.repeat(60));
        log(plan.details);
      }

      // Display tasks with completion status
      if (plan.tasks && plan.tasks.length > 0) {
        log('\n' + chalk.bold('Tasks:'));
        log('─'.repeat(60));

        plan.tasks.forEach((task, taskIdx) => {
          const totalSteps = task.steps.length;
          const doneSteps = task.steps.filter((s) => s.done).length;
          const taskComplete = totalSteps > 0 && doneSteps === totalSteps;
          const taskIcon = taskComplete ? '✓' : totalSteps > 0 && doneSteps > 0 ? '⏳' : '○';
          const taskColor = taskComplete
            ? chalk.green
            : totalSteps > 0 && doneSteps > 0
              ? chalk.yellow
              : chalk.white;

          log(`\n${taskIcon} ${chalk.bold(`Task ${taskIdx + 1}:`)} ${taskColor(task.title)}`);
          if (totalSteps > 0) {
            log(`  Progress: ${doneSteps}/${totalSteps} steps completed`);
          }
          log(`  ${chalk.gray(task.description)}`);

          if (task.files && task.files.length > 0) {
            log(`  Files: ${task.files.join(', ')}`);
          }

          if (task.steps && task.steps.length > 0) {
            log('  Steps:');
            task.steps.forEach((step, stepIdx) => {
              const stepIcon = step.done ? '✓' : '○';
              const stepColor = step.done ? chalk.green : chalk.gray;
              const prompt = step.prompt.split('\n')[0];
              const truncated = prompt.length > 60 ? prompt.substring(0, 60) + '...' : prompt;
              log(`    ${stepIcon} ${stepColor(`Step ${stepIdx + 1}: ${truncated}`)}`);
            });
          }
        });
      }

      // Display rmfilter args if present
      if (plan.rmfilter && plan.rmfilter.length > 0) {
        log('\n' + chalk.bold('RmFilter Arguments:'));
        log('─'.repeat(60));
        log(`  ${plan.rmfilter.join(' ')}`);
      }

      // Display changed files if present
      if (plan.changedFiles && plan.changedFiles.length > 0) {
        log('\n' + chalk.bold('Changed Files:'));
        log('─'.repeat(60));
        plan.changedFiles.forEach((file) => log(`  • ${file}`));
      }

      log('');
    } catch (err) {
      error(`Failed to show plan: ${err as Error}`);
      process.exit(1);
    }
  });

program
  .command('edit <planArg>')
  .description('Open a plan file in your editor. Can be a file path or plan ID.')
  .option('--editor <editor>', 'Editor to use (defaults to $EDITOR or nano)')
  .action(async (planArg, options) => {
    const globalOpts = program.opts();
    try {
      const resolvedPlanFile = await resolvePlanFile(planArg, globalOpts.config);
      const editor = options.editor || process.env.EDITOR || 'nano';

      const editorProcess = logSpawn([editor, resolvedPlanFile], {
        stdio: ['inherit', 'inherit', 'inherit'],
      });
      await editorProcess.exited;
    } catch (err) {
      error(`Failed to open plan file: ${err as Error}`);
      process.exit(1);
    }
  });

program
  .command('split <planArg>')
  .description(
    'Use LLM to intelligently split a large plan into smaller, phase-based plans with dependencies'
  )
  .action(async (planArg) => {
    const globalOpts = program.opts();

    try {
      // Step 1: Resolve the input plan file path
      const resolvedPlanFile = await resolvePlanFile(planArg, globalOpts.config);

      // Step 2: Read and validate the plan file
      let validatedPlan: PlanSchema;
      try {
        validatedPlan = await readPlanFile(resolvedPlanFile);
      } catch (err) {
        error(`Failed to read or validate plan file '${resolvedPlanFile}': ${err as Error}`);
        process.exit(1);
      }

      // Step 3: Generate the prompt for splitting the plan
      log(chalk.blue('📄 Plan loaded successfully:'));
      log(`  Title: ${validatedPlan.title || 'No title'}`);
      log(`  Goal: ${validatedPlan.goal}`);
      if (validatedPlan.tasks) {
        log(`  Tasks: ${validatedPlan.tasks.length}`);
      }

      // Step 6: Load configuration and generate the prompt
      const splitConfig = await loadEffectiveConfig(globalOpts.config);
      const prompt = generateSplitPlanPrompt(validatedPlan);

      // Step 7: Call the LLM to reorganize the plan
      log(chalk.blue('\n🤖 Analyzing plan structure and identifying logical phases...'));
      const modelSpec = splitConfig.models?.stepGeneration || 'google/gemini-2.0-flash';
      const model = createModel(modelSpec);

      let llmResponse: string;
      try {
        const llmResult = await runStreamingPrompt({
          model,
          messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
          temperature: 0.2,
        });
        llmResponse = llmResult.text;
      } catch (err) {
        error(`Failed to call LLM for plan splitting: ${err as Error}`);
        error('Check your model configuration and API credentials.');
        process.exit(1);
      }

      // Step 8: Extract and parse the YAML from the LLM response
      log(chalk.blue('\n📝 Processing LLM-generated phase structure...'));
      let parsedMultiPhase: any;
      let cleanedYaml: string;
      try {
        const yamlContent = findYamlStart(llmResponse);
        cleanedYaml = fixYaml(yamlContent);
        parsedMultiPhase = yaml.parse(cleanedYaml);
      } catch (err) {
        error(`Failed to parse multi-phase plan from LLM response: ${err as Error}`);

        // Save raw response for debugging
        const debugFile = 'rmplan-split-raw-response.yml';
        await Bun.write(debugFile, llmResponse);
        error(`\nRaw LLM response saved to ${debugFile} for debugging.`);
        process.exit(1);
      }

      // Step 9: Validate the multi-phase plan structure
      const validationResult = multiPhasePlanSchema.safeParse(parsedMultiPhase);

      if (!validationResult.success) {
        error(
          'Multi-phase plan validation failed. The LLM output does not match expected structure:'
        );
        validationResult.error.issues.forEach((issue) => {
          error(`  - ${issue.path.join('.')}: ${issue.message}`);
        });

        // Save invalid YAML for debugging
        const debugFile = 'rmplan-split-invalid.yml';
        await Bun.write(debugFile, cleanedYaml);
        error(`\nInvalid YAML saved to ${debugFile} for debugging.`);
        process.exit(1);
      }

      // Step 10: Process the validated multi-phase plan
      const multiPhasePlan = validationResult.data;
      log(chalk.green('\n✓ Successfully reorganized plan into phases:'));
      log(`  Total phases: ${multiPhasePlan.phases.length}`);
      multiPhasePlan.phases.forEach((phase, index) => {
        log(`  Phase ${index + 1}: ${phase.title || 'Untitled'} (${phase.tasks.length} tasks)`);
      });

      // Step 11: Save the multi-phase plan using saveMultiPhaseYaml
      // Determine output directory path
      const outputDir = path.join(
        path.dirname(resolvedPlanFile),
        path.basename(resolvedPlanFile, path.extname(resolvedPlanFile))
      );

      // Prepare options for saveMultiPhaseYaml
      const extractOptions: ExtractMarkdownToYamlOptions = {
        output: outputDir,
        projectId: validatedPlan.id,
        issueUrls: validatedPlan.issue,
      };

      // Call saveMultiPhaseYaml
      const quiet = false;
      const message = await saveMultiPhaseYaml(multiPhasePlan, extractOptions, splitConfig, quiet);

      // Log the result message
      log(message);
    } catch (err) {
      error(`Unexpected error while splitting plan: ${err as Error}`);
      process.exit(1);
    }
  });

program
  .command('answer-pr [prIdentifier]')
  .description(
    'Address Pull Request (PR) review comments using an LLM. If no PR identifier is provided, it will try to detect the PR from the current branch.'
  )
  .option(
    '--mode <mode>',
    "Specify the editing mode. 'inline-comments' (default) inserts comments into code. 'separate-context' adds them to the prompt.",
    'inline-comments'
  )
  .option(`-x, --executor <name>`, 'The executor to use for execution')
  .addHelpText('after', `Available executors: ${executorNames}`)
  .option(
    '--yes',
    'Automatically proceed without interactive prompts (e.g., for reviewing AI comments in files).',
    false
  )
  .option(
    '-m, --model <model>',
    'Specify the LLM model to use. Overrides model from rmplan config.'
  )
  .option(
    '--dry-run',
    'Prepare and print the LLM prompt, but do not call the LLM or apply edits.',
    false
  )
  .option('--commit', 'Commit changes to jj/git', false)
  .option('--comment', 'Post replies to review threads after committing changes', false)
  .action(async (prIdentifier, options) => {
    // Pass global options (like --debug) along with command-specific options
    const globalOpts = program.opts();
    const config = await loadEffectiveConfig(globalOpts.config);

    // Use executor from CLI options, fallback to config defaultExecutor, or fallback to the default executor
    if (!options.executor) {
      options.executor = config.defaultExecutor || DEFAULT_EXECUTOR;
    }

    await handleRmprCommand(prIdentifier, options, globalOpts, config);
  });

// Create the workspace command
const workspaceCommand = program.command('workspace').description('Manage workspaces for plans');

// Add the 'list' subcommand to workspace
workspaceCommand
  .command('list')
  .description('List all workspaces and their lock status')
  .option('--repo <url>', 'Filter by repository URL (defaults to current repo)')
  .action(async (options) => {
    try {
      const globalOpts = program.opts();
      const config = await loadEffectiveConfig(globalOpts.config);
      const trackingFilePath = config.paths?.trackingFile;

      let repoUrl = options.repo;
      if (!repoUrl) {
        // Try to get repo URL from current directory
        try {
          const gitRoot = await getGitRoot();
          const result = await $`git remote get-url origin`.cwd(gitRoot).text();
          repoUrl = result.trim();
        } catch (err) {
          error('Could not determine repository URL. Please specify --repo');
          process.exit(1);
        }
      }

      await WorkspaceAutoSelector.listWorkspacesWithStatus(repoUrl, trackingFilePath);
    } catch (err) {
      error('Failed to list workspaces:', err);
      process.exit(1);
    }
  });

// Add the 'add' subcommand to workspace
workspaceCommand
  .command('add [planIdentifier]')
  .description('Create a new workspace, optionally linked to a plan')
  .option('--id <workspaceId>', 'Specify a custom workspace ID')
  .action(async (planIdentifier, options) => {
    const globalOpts = program.opts();

    try {
      // Load configuration
      const config = await loadEffectiveConfig(globalOpts.config);
      const gitRoot = (await getGitRoot()) || process.cwd();

      // Check if workspace creation is enabled
      if (!config.workspaceCreation) {
        error('Workspace creation is not enabled in configuration.');
        error('Add "workspaceCreation" section to your rmplan config file.');
        process.exit(1);
      }

      // Determine workspace ID
      let workspaceId: string;
      if (options.id) {
        workspaceId = options.id;
      } else if (planIdentifier) {
        // Generate ID based on plan
        workspaceId = generateAlphanumericPlanId();
      } else {
        // Generate a random ID for standalone workspace
        workspaceId = generateAlphanumericPlanId();
      }

      // Resolve plan file if provided
      let resolvedPlanFilePath: string | undefined;
      let planData: PlanSchema | undefined;

      if (planIdentifier) {
        try {
          resolvedPlanFilePath = await resolvePlanFile(planIdentifier, globalOpts.config);

          // Read and parse the plan file
          planData = await readPlanFile(resolvedPlanFilePath);

          // If no custom ID was provided, use the plan's ID if available
          if (!options.id && planData.id) {
            workspaceId = planData.id;
          }

          log(`Using plan: ${planData.title || planData.goal || resolvedPlanFilePath}`);
        } catch (err) {
          error(`Failed to resolve plan: ${err as Error}`);
          process.exit(1);
        }
      }

      log(`Creating workspace with ID: ${workspaceId}`);

      // Update plan status BEFORE creating workspace if a plan was provided
      if (resolvedPlanFilePath && planData) {
        try {
          await setPlanStatus(resolvedPlanFilePath, 'in_progress');
          log('Plan status updated to in_progress in original location');
        } catch (err) {
          warn(`Failed to update plan status: ${err as Error}`);
        }
      }

      // Create the workspace
      const workspace = await createWorkspace(gitRoot, workspaceId, resolvedPlanFilePath, config);

      if (!workspace) {
        error('Failed to create workspace');
        process.exit(1);
      }

      // Update plan status in the new workspace if plan was copied
      if (workspace.planFilePathInWorkspace) {
        try {
          await setPlanStatus(workspace.planFilePathInWorkspace, 'in_progress');
          log('Plan status updated to in_progress in workspace');
        } catch (err) {
          warn(`Failed to update plan status in workspace: ${err as Error}`);
        }
      }

      // Success message
      log(chalk.green('✓ Workspace created successfully!'));
      log(`  Path: ${workspace.path}`);
      log(`  ID: ${workspace.taskId}`);
      if (workspace.planFilePathInWorkspace) {
        log(`  Plan file: ${path.relative(workspace.path, workspace.planFilePathInWorkspace)}`);
      }
      log('');
      log('Next steps:');
      log(`  1. cd ${workspace.path}`);
      if (resolvedPlanFilePath) {
        log(
          `  2. rmplan next ${path.basename(workspace.planFilePathInWorkspace || resolvedPlanFilePath)}`
        );
      } else {
        log('  2. Start working on your task');
      }
    } catch (err) {
      error(`Failed to create workspace: ${err as Error}`);
      process.exit(1);
    }
  });

await program.parseAsync(process.argv);
