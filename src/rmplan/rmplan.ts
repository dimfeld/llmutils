#!/usr/bin/env bun
import { input } from '@inquirer/prompts';
import chalk from 'chalk';
import { Command } from 'commander';
import os from 'os';
import path from 'path';
import * as clipboard from '../common/clipboard.ts';
import { loadEnv } from '../common/env.js';
import { getInstructionsFromGithubIssue } from '../common/github/issues.js';
import { waitForEnter } from '../common/terminal.js';
import { error, log, warn } from '../logging.js';
import { getInstructionsFromEditor } from '../rmfilter/instructions.js';
import { getGitRoot, logSpawn, setDebug, setQuiet } from '../rmfilter/utils.js';
import { findFilesCore, type RmfindOptions } from '../rmfind/core.js';
import { handleRmprCommand } from '../rmpr/main.js';
import { argsFromRmprOptions, type RmprOptions } from '../rmpr/comment_options.js';
import { extractMarkdownToYaml, markStepDone, prepareNextStep } from './actions.js';
import { rmplanAgent } from './agent.js';
import { cleanupEolComments } from './cleanup.js';
import { loadEffectiveConfig } from './configLoader.js';
import { planPrompt } from './prompt.js';
import { executors } from './executors/index.js';
import { DEFAULT_EXECUTOR } from './constants.js';
import { sshAwarePasteAction } from '../common/ssh_detection.ts';
import { WorkspaceAutoSelector } from './workspace_auto_selector.js';
import { WorkspaceLock } from './workspace_lock.js';
import { generateText } from 'ai';
import { createModel } from '../common/model_factory.ts';

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
      let issueResult = await getInstructionsFromGithubIssue(options.issue);
      planText = issueResult.plan;
      // Extract combinedRmprOptions from the result if it exists
      combinedRmprOptions = issueResult.rmprOptions ?? null;

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

    // planText now contains the loaded plan
    const promptString = planPrompt(planText!);
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
        const query = planText!;

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

        let outputFilename: string | undefined;
        if (planFile) {
          outputFilename = path.join(
            path.dirname(planFile),
            path.basename(planFile, '.md') + '.yml'
          );
        }
        const outputYaml = await extractMarkdownToYaml(input, config, options.quiet ?? false);
        if (outputFilename) {
          // no need to print otherwise, extractMarkdownToYaml already did
          await Bun.write(outputFilename, outputYaml);
          if (!options.quiet) {
            log(`Wrote result to ${outputFilename}`);
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

    if (options.plan && !options.output) {
      let name = options.plan.endsWith('.yml')
        ? options.plan
        : path.basename(options.plan, '.md') + '.yml';
      options.output = path.join(path.dirname(options.plan), name);
    }

    try {
      const config = await loadEffectiveConfig(options.config);
      const outputYaml = await extractMarkdownToYaml(inputText, config, options.quiet ?? false);
      if (options.output) {
        let outputFilename = options.output;
        if (outputFilename.endsWith('.md')) {
          outputFilename = outputFilename.slice(0, -3);
          outputFilename += '.yml';
        }
        await Bun.write(outputFilename, outputYaml);
        if (!options.quiet) {
          log(`Wrote result to ${outputFilename}`);
        }
      } else {
        console.log(outputYaml);
      }
    } catch (e) {
      process.exit(1);
    }
  });

program
  .command('done <planFile>')
  .description('Mark the next step/task in a plan YAML as done')
  .option('--steps <steps>', 'Number of steps to mark as done', '1')
  .option('--task', 'Mark all steps in the current task as done')
  .option('--commit', 'Commit changes to jj/git')
  .action(async (planFile, options) => {
    const gitRoot = (await getGitRoot()) || process.cwd();
    const result = await markStepDone(
      planFile,
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
  });

program
  .command('next <planFile>')
  .description('Prepare the next step(s) from a plan YAML for execution')
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
    // Find '--' in process.argv to get extra args for rmfilter
    const doubleDashIdx = process.argv.indexOf('--');
    const cmdLineRmfilterArgs = doubleDashIdx !== -1 ? process.argv.slice(doubleDashIdx + 1) : [];
    const config = await loadEffectiveConfig(options.config);
    const gitRoot = (await getGitRoot()) || process.cwd();

    try {
      const result = await prepareNextStep(
        config,
        planFile,
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
  .description('Automatically execute steps in a plan YAML file')
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
  .action((planFile, options) => rmplanAgent(planFile, options, program.opts()));

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
