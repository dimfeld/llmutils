#!/usr/bin/env bun
import { input } from '@inquirer/prompts';
import { generateText } from 'ai';
import chalk from 'chalk';
import { Command } from 'commander';
import os from 'os';
import path from 'path';
import yaml from 'yaml';
import * as clipboard from '../common/clipboard.ts';
import { loadEnv } from '../common/env.js';
import { getInstructionsFromGithubIssue } from '../common/github/issues.js';
import { createModel } from '../common/model_factory.ts';
import { sshAwarePasteAction } from '../common/ssh_detection.ts';
import { waitForEnter } from '../common/terminal.js';
import { error, log, warn } from '../logging.js';
import { getInstructionsFromEditor } from '../rmfilter/instructions.js';
import { getGitRoot, logSpawn, setDebug, setQuiet } from '../rmfilter/utils.js';
import { findFilesCore, type RmfindOptions } from '../rmfind/core.js';
import { argsFromRmprOptions, type RmprOptions } from '../rmpr/comment_options.js';
import { handleRmprCommand } from '../rmpr/main.js';
import { markStepDone, prepareNextStep, preparePhase } from './actions.js';
import { rmplanAgent } from './agent.js';
import { cleanupEolComments } from './cleanup.js';
import { loadEffectiveConfig } from './configLoader.js';
import { DEFAULT_EXECUTOR } from './constants.js';
import { executors } from './executors/index.js';
import { readAllPlans, resolvePlanFile } from './plans.js';
import { planPrompt, simplePlanPrompt } from './prompt.js';
import type { PlanSchema } from './planSchema.js';
import { WorkspaceAutoSelector } from './workspace/workspace_auto_selector.js';
import { WorkspaceLock } from './workspace/workspace_lock.js';
import { extractMarkdownToYaml, type ExtractMarkdownToYamlOptions } from './process_markdown.ts';

await loadEnv();

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

    let planFile = options.plan;

    if (options.plan) {
      try {
        planText = await Bun.file(options.plan).text();
        planFile = options.plan;
      } catch (err) {
        error(`Failed to read plan file: ${options.plan}`);
        process.exit(1);
      }
    } else if (options.planEditor) {
      try {
        planText = await getInstructionsFromEditor('rmplan-plan.md');
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

      let tasksDir = config.paths?.tasks;
      let suggestedFilename = tasksDir
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
      const allRmfilterOptions = [...userCliRmfilterArgs, ...issueRmfilterOptions];

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

      if (exitRes === 0 && !options.noExtract) {
        log(
          chalk.bold(
            `\nPlease paste the prompt into the chat interface. Then ${sshAwarePasteAction()} to extract the copied Markdown to a YAML plan file, or Ctrl+C to exit.`
          )
        );

        let input = await waitForEnter(true);

        let outputPath: string;
        if (planFile) {
          // Use the directory of the plan file for output
          outputPath = path.join(path.dirname(planFile), path.basename(planFile, '.md'));
        } else {
          // Default to current directory with a generated name
          outputPath = 'rmplan-output';
        }

        const extractOptions: ExtractMarkdownToYamlOptions = {
          output: outputPath,
          planRmfilterArgs: allRmfilterOptions,
          issueUrls: issueUrlsForExtract,
        };

        const message = await extractMarkdownToYaml(
          input,
          config,
          options.quiet ?? false,
          extractOptions
        );

        if (!options.quiet) {
          log(message);
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

      // Extract markdown to YAML using LLM
      const extractOptions: ExtractMarkdownToYamlOptions = {
        output: outputPath,
        projectId: options.projectId,
        issueUrls: options.issue ? [options.issue] : [],
      };

      const message = await extractMarkdownToYaml(
        inputText,
        config,
        options.quiet ?? false,
        extractOptions
      );

      if (!options.quiet) {
        log(message);
      }
    } catch (e) {
      error('Failed to extract markdown to YAML:', e);
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
      const resolvedPlanFile = await resolvePlanFile(planFile, globalOpts.config);
      const result = await markStepDone(
        resolvedPlanFile,
        {
          task: options.task,
          steps: options.steps ? parseInt(options.steps, 10) : 1,
          commit: options.commit,
        },
        undefined,
        gitRoot
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

program
  .command('agent <planFile>')
  .description('Automatically execute steps in a plan YAML file. Can be a file path or plan ID.')
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
  .allowExcessArguments(true)
  .action(async (planFile, options) => {
    const globalOpts = program.opts();
    try {
      const resolvedPlanFile = await resolvePlanFile(planFile, globalOpts.config);
      await rmplanAgent(resolvedPlanFile, options, globalOpts);
    } catch (err) {
      error(`Failed to process plan: ${err as Error}`);
      process.exit(1);
    }
  });

program
  .command('run <planFile>')
  .description(
    'Alias for "agent". Automatically execute steps in a plan YAML file. Can be a file path or plan ID.'
  )
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
  .allowExcessArguments(true)
  .action(async (planFile, options) => {
    const globalOpts = program.opts();
    try {
      const resolvedPlanFile = await resolvePlanFile(planFile, globalOpts.config);
      await rmplanAgent(resolvedPlanFile, options, globalOpts);
    } catch (err) {
      error(`Failed to process plan: ${err as Error}`);
      process.exit(1);
    }
  });

program
  .command('workspaces')
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
          const { $ } = await import('bun');
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
    'Filter by status (can specify multiple). Valid values: pending, in_progress, done'
  )
  .option('--all', 'Show all plans regardless of status (overrides default filter)')
  .action(async (options) => {
    try {
      const globalOpts = program.opts();
      const config = await loadEffectiveConfig(globalOpts.config);

      // Determine directory to search
      let searchDir = options.dir || config.paths?.tasks || process.cwd();

      // Read all plans
      const plans = await readAllPlans(searchDir);

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
          return statusesToShow.has(status);
        });
      }

      // Sort based on the specified field
      planArray.sort((a, b) => {
        let aVal: string | number;
        let bVal: string | number;
        switch (options.sort) {
          case 'title':
            aVal = (a.title || '').toLowerCase();
            bVal = (b.title || '').toLowerCase();
            break;
          case 'status':
            aVal = a.status || '';
            bVal = b.status || '';
            break;
          case 'priority': {
            // Sort priority in reverse (high first)
            const priorityOrder = { urgent: 5, high: 4, medium: 3, low: 2, unknown: 1 };
            aVal = priorityOrder[a.priority || 'unknown'];
            bVal = priorityOrder[b.priority || 'unknown'];
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

      // Header
      const header = [
        chalk.bold('ID'),
        chalk.bold('Title'),
        chalk.bold('Status'),
        chalk.bold('Priority'),
        chalk.bold('Dependencies'),
        chalk.bold('File'),
      ].join(' | ');

      log(header);
      log('-'.repeat(120));

      // Rows
      for (const plan of planArray) {
        const statusColor =
          plan.status === 'done'
            ? chalk.green
            : plan.status === 'in_progress'
              ? chalk.yellow
              : plan.status === 'pending'
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

        const row = [
          chalk.cyan((plan.id || 'no-id').padEnd(15)),
          (plan.title || 'Untitled').slice(0, 30).padEnd(30),
          statusColor((plan.status || 'pending').padEnd(12)),
          priorityColor((plan.priority || 'unknown').padEnd(8)),
          (plan.dependencies?.join(', ') || '-').slice(0, 20).padEnd(20),
          chalk.gray(path.relative(searchDir, plan.filename)),
        ].join(' | ');

        log(row);
      }

      log('');
      log(`Showing: ${planArray.length} of ${plans.size} plan(s)`);
    } catch (err) {
      error('Failed to list plans:', err);
      process.exit(1);
    }
  });

program
  .command('prepare <yamlFile>')
  .description(
    'Generate detailed steps and prompts for a specific phase. Can be a file path or plan ID.'
  )
  .option('--force', 'Override dependency completion check and proceed with generation.')
  .option('-m, --model <model_id>', 'Specify the LLM model to use for generating phase details.')
  .action(async (yamlFile, options) => {
    const globalOpts = program.opts();

    try {
      // Load RmplanConfig using loadEffectiveConfig
      const config = await loadEffectiveConfig(globalOpts.config);

      // Resolve plan file (ID or path)
      const phaseYamlFile = await resolvePlanFile(yamlFile, globalOpts.config);

      // Call the new preparePhase function
      await preparePhase(phaseYamlFile, config, {
        force: options.force,
        model: options.model,
      });
    } catch (err) {
      error('Failed to generate phase details:', err);
      process.exit(1);
    }
  });

program
  .command('show <planFile>')
  .description('Display detailed information about a plan. Can be a file path or plan ID.')
  .action(async (planFile) => {
    const globalOpts = program.opts();

    try {
      const config = await loadEffectiveConfig(globalOpts.config);
      const resolvedPlanFile = await resolvePlanFile(planFile, globalOpts.config);

      // Read the plan file
      const content = await Bun.file(resolvedPlanFile).text();
      const plan = yaml.parse(content) as PlanSchema;

      // Display basic information
      log(chalk.bold('\nPlan Information:'));
      log('─'.repeat(60));
      log(`${chalk.cyan('ID:')} ${plan.id || 'Not set'}`);
      log(`${chalk.cyan('Title:')} ${plan.title || 'Untitled'}`);
      log(`${chalk.cyan('Status:')} ${plan.status || 'pending'}`);
      log(`${chalk.cyan('Priority:')} ${plan.priority || 'unknown'}`);
      log(`${chalk.cyan('Goal:')} ${plan.goal}`);
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

        const tasksDir = config.paths?.tasks || process.cwd();
        const allPlans = await readAllPlans(tasksDir);

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
              `  ${statusIcon} ${chalk.cyan(depId)} - ${depPlan.title || 'Untitled'} ${statusColor(`[${depPlan.status || 'pending'}]`)}`
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
              const prompt = step.prompt.split('\n')[0]; // First line only
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

      log(''); // Empty line at the end
    } catch (err) {
      error(`Failed to show plan: ${err as Error}`);
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

await program.parseAsync(process.argv);
