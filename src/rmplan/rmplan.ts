#!/usr/bin/env bun

/**
 * @fileoverview Main CLI entry point for rmplan - a command-line tool for generating and managing
 * step-by-step project plans using LLMs. This module implements a command delegation architecture
 * where each subcommand is handled by a dedicated module in src/rmplan/commands/, improving
 * modularity and maintainability.
 *
 * The CLI supports commands for:
 * - Generating plans from natural language descriptions
 * - Converting markdown plans to YAML format
 * - Managing plan execution lifecycle (next, done, list, show)
 * - Automated plan execution with various executor strategies
 * - Workspace management for plan isolation
 * - Plan dependencies and multi-phase projects
 *
 * Architecture:
 * - Each command uses dynamic imports to load its handler from src/rmplan/commands/
 * - Common functionality is abstracted into shared utilities in src/common/
 * - Error handling is centralized through handleCommandError utility
 * - Configuration is managed through the configLoader system
 *
 * @example
 * ```bash
 * # Generate a new plan
 * rmplan generate --plan "Add user authentication" src/auth
 *
 * # Execute next steps
 * rmplan next my-plan.yml --rmfilter
 *
 * # Mark steps as completed
 * rmplan done my-plan.yml --commit
 * ```
 */

import { Command } from 'commander';
import { loadEnv } from './utils/env.js';
import { setDebug } from '../common/process.js';
import { executors } from './executors/index.js';
import { handleCommandError } from './utils/commands.js';

await loadEnv();

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
    const { handleGenerateCommand } = await import('./commands/generate.js');
    await handleGenerateCommand(options, command).catch(handleCommandError);
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
    const { handleExtractCommand } = await import('./commands/extract.js');
    await handleExtractCommand(inputFile, options).catch(handleCommandError);
  });

program
  .command('add <title...>')
  .description('Create a new plan stub file that can be filled with tasks using generate')
  .option('--edit', 'Open the newly created plan file in your editor')
  .option('--depends-on <ids...>', 'Specify plan IDs that this plan depends on')
  .option('--priority <level>', 'Set the priority level (low, medium, high, urgent)')
  .action(async (title, options, command) => {
    const { handleAddCommand } = await import('./commands/add.js');
    await handleAddCommand(title, options, command).catch(handleCommandError);
  });

program
  .command('done <planFile>')
  .description('Mark the next step/task in a plan YAML as done. Can be a file path or plan ID.')
  .option('--steps <steps>', 'Number of steps to mark as done', '1')
  .option('--task', 'Mark all steps in the current task as done')
  .option('--commit', 'Commit changes to jj/git')
  .action(async (planFile, options, command) => {
    const { handleDoneCommand } = await import('./commands/done.js');
    await handleDoneCommand(planFile, options, command).catch(handleCommandError);
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
  .action(async (planFile, options, command) => {
    const { handleNextCommand } = await import('./commands/next.js');
    await handleNextCommand(planFile, options, command).catch(handleCommandError);
  });

program
  .command('cleanup [files...]')
  .description('Remove end-of-line comments from changed files or specified files')
  .option(
    '--diff-from <branch>',
    'Compare to this branch/revision when no files provided. Default is current diff'
  )
  .action(async (files, options) => {
    const { handleCleanupCommand } = await import('./commands/cleanup.js');
    await handleCleanupCommand(files, options).catch(handleCommandError);
  });

const executorNames = executors
  .values()
  .map((e) => e.name)
  .toArray()
  .join(', ');

/**
 * Creates a shared command configuration for agent and run commands with common options.
 * This function encapsulates the complex option setup needed for automated plan execution,
 * including workspace management, executor selection, and execution control.
 *
 * @param command - The Commander.js command instance to configure
 * @param description - Human-readable description for the command
 * @returns The configured command with all agent/run options applied
 */
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
    .action(async (planFile, options, command) => {
      const { handleAgentCommand } = await import('./commands/agent.js');
      await handleAgentCommand(planFile, options, command.parent.opts()).catch(handleCommandError);
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
  .action(async (options, command) => {
    const { handleListCommand } = await import('./commands/list.js');
    await handleListCommand(options, command).catch(handleCommandError);
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
  .action(async (yamlFile, options, command) => {
    const { handlePrepareCommand } = await import('./commands/prepare.js');
    await handlePrepareCommand(yamlFile, options, command).catch(handleCommandError);
  });

program
  .command('show [planFile]')
  .description('Display detailed information about a plan. Can be a file path or plan ID.')
  .option('--next', 'Show the next plan that is ready to be implemented')
  .option('--current', 'Show the current plan (in_progress or next ready plan)')
  .action(async (planFile, options, command) => {
    const { handleShowCommand } = await import('./commands/show.js');
    await handleShowCommand(planFile, options, command).catch(handleCommandError);
  });

program
  .command('edit <planArg>')
  .description('Open a plan file in your editor. Can be a file path or plan ID.')
  .option('--editor <editor>', 'Editor to use (defaults to $EDITOR or nano)')
  .action(async (planArg, options, command) => {
    const { handleEditCommand } = await import('./commands/edit.js');
    await handleEditCommand(planArg, options, command).catch(handleCommandError);
  });

program
  .command('renumber')
  .description('Renumber plans with alphanumeric IDs or ID conflicts to sequential numeric IDs')
  .option('--dry-run', 'Show what would be renumbered without making changes')
  .action(async (options, command) => {
    const { handleRenumber } = await import('./commands/renumber.js');
    await handleRenumber(options, command).catch(handleCommandError);
  });

program
  .command('split <planArg>')
  .description(
    'Use LLM to intelligently split a large plan into smaller, phase-based plans with dependencies'
  )
  .action(async (planArg, options, command) => {
    const { handleSplitCommand } = await import('./commands/split.js');
    await handleSplitCommand(planArg, options, command).catch(handleCommandError);
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
  .action(async (prIdentifier, options, command) => {
    const { handleAnswerPrCommand } = await import('./commands/answerPr.js');
    await handleAnswerPrCommand(prIdentifier, options, command).catch(handleCommandError);
  });

// Create the workspace command
const workspaceCommand = program.command('workspace').description('Manage workspaces for plans');

// Add the 'list' subcommand to workspace
workspaceCommand
  .command('list')
  .description('List all workspaces and their lock status')
  .option('--repo <url>', 'Filter by repository URL (defaults to current repo)')
  .action(async (options, command) => {
    const { handleWorkspaceListCommand } = await import('./commands/workspace.js');
    await handleWorkspaceListCommand(options, command).catch(handleCommandError);
  });

// Add the 'add' subcommand to workspace
workspaceCommand
  .command('add [planIdentifier]')
  .description('Create a new workspace, optionally linked to a plan')
  .option('--id <workspaceId>', 'Specify a custom workspace ID')
  .action(async (planIdentifier, options, command) => {
    const { handleWorkspaceAddCommand } = await import('./commands/workspace.js');
    await handleWorkspaceAddCommand(planIdentifier, options, command).catch(handleCommandError);
  });

await program.parseAsync(process.argv);
