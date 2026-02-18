#!/usr/bin/env bun

/**
 * @fileoverview Main CLI entry point for tim - a command-line tool for generating and managing
 * step-by-step project plans using LLMs. This module implements a command delegation architecture
 * where each subcommand is handled by a dedicated module in src/tim/commands/, improving
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
 * - Each command uses dynamic imports to load its handler from src/tim/commands/
 * - Common functionality is abstracted into shared utilities in src/common/
 * - Error handling is centralized through handleCommandError utility
 * - Configuration is managed through the configLoader system
 *
 * @example
 * ```bash
 * # Generate a new plan
 * tim generate --plan "Add user authentication" src/auth
 *
 * # Execute the plan with automated agent
 * tim agent my-plan.yml --rmfilter
 *
 * # Mark steps as completed
 * tim done my-plan.yml --commit
 * ```
 */

import { Command, Option } from 'commander';
import { z } from 'zod/v4';
import { loadEnv } from '../common/env.js';
import { setDebug } from '../common/process.js';
import { installStdinDebugTracing } from '../common/stdin_debug.js';
import { executors } from './executors/index.js';
import { handleCommandError } from './utils/commands.js';
import { prioritySchema, statusSchema } from './planSchema.js';
import { CleanupRegistry } from '../common/cleanup_registry.js';
import { startMcpServer } from './mcp/server.js';
import { enableAutoClaim } from './assignments/auto_claim.js';
import { runWithLogger } from '../logging.js';
import { createTunnelAdapter } from '../logging/tunnel_client.js';
import { TIM_OUTPUT_SOCKET } from '../logging/tunnel_protocol.js';
import {
  getPlanParameters,
  createPlanParameters,
  generateTasksParameters,
  updatePlanDetailsParameters,
  managePlanTaskParameters,
  listReadyPlansParameters,
} from './tools/schemas.js';

function intArg(value: string | undefined): number | undefined;
function intArg(value: string[] | undefined): number[] | undefined;
function intArg<T extends string | string[] | undefined>(
  value: T | undefined
): number | number[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (Array.isArray(value)) {
    const out = value.map((s) => intArg(s));
    return out as number[] | undefined;
  }

  let n = Number(value);
  if (Number.isNaN(n)) {
    throw new Error(`Argument must be an integer, saw ${value.toString()}`);
  }
  return n;
}

function formatSchemaHelp(schema: z.ZodTypeAny): string {
  const jsonSchema = z.toJSONSchema(schema, {
    target: 'draft-7',
    io: 'input',
  });
  return `\nInput JSON Schema:\n${JSON.stringify(jsonSchema, null, 2)}\n`;
}

const program = new Command();
program.name('tim').description('Generate and execute task plans using LLMs');
program.option(
  '-c, --config <path>',
  'Specify path to the tim configuration file (default: .rmfilter/tim.yml)'
);

program.option('--debug', 'Enable debug logging', () => setDebug(true));

// Surface commonly used options that live on subcommands
program.addHelpText(
  'after',
  `\nExecution summaries:\n  'agent' and 'run' support '--no-summary' to disable end-of-run summaries\n  and '--summary-file <path>' to write a summary to a file.\n  Set 'TIM_SUMMARY_ENABLED=0/false' to disable summaries by default. When enabled by env,\n  '--no-summary' takes precedence. When disabled by env, '--summary-file' does not force-enable.\n`
);

program
  .command('mcp-server')
  .description('Start tim as an MCP server for interactive workflows')
  .option('--transport <transport>', 'Transport to use: stdio or http', 'stdio')
  .option('--port <port>', 'Port to listen on when using HTTP transport', (value) => {
    const parsed = Number(value);
    if (Number.isNaN(parsed)) {
      throw new Error(`Invalid port: ${value}`);
    }
    return parsed;
  })
  .option('--no-tools', 'Run server without tools (prompts and resources only)')
  .option(
    '--has-claude-plugin',
    'Omit generate-plan prompt and tools (assumes Claude Code plugin provides them)'
  )
  .action(async (options, command) => {
    const globalOpts = command.parent.opts();
    const transport = options.transport === 'http' ? 'http' : 'stdio';
    await startMcpServer({
      configPath: globalOpts.config,
      transport,
      port: options.port,
      noTools: options.tools === false,
      hasClaudePlugin: options.hasClaudePlugin,
    }).catch(handleCommandError);
  });

program
  .command('prompts [prompt] [plan]')
  .description('Print an MCP prompt to stdout for use in CLI workflows')
  .option('--plan <plan>', 'Plan ID or file path to use')
  .option('--latest', 'Use the most recently updated plan')
  .option(
    '--next-ready <planIdOrPath>',
    'Find and use the next ready dependency of the specified parent plan (accepts plan ID or file path)'
  )
  .option(
    '--no-allow-multiple-plans',
    'Disable allowing the prompt to recommend creating multiple plans (default is enabled)'
  )
  .option(
    '--task-index <indexes...>',
    'Review specific task indexes (1-based). For review prompt only.'
  )
  .option(
    '--task-title <titles...>',
    'Review specific task titles (exact match). For review prompt only.'
  )
  .option('--instructions <text>', 'Inline custom instructions. For review prompt only.')
  .option('--instructions-file <path>', 'File with custom instructions. For review prompt only.')
  .option('--focus <areas>', 'Comma-separated focus areas. For review prompt only.')
  .option('--base <branch>', 'Base branch for diff comparison. For review prompt only.')
  .action(async (promptName, planArg, options, command) => {
    const { handlePromptsCommand } = await import('./commands/prompts.js');
    await handlePromptsCommand(promptName, planArg, options, command).catch(handleCommandError);
  });

const toolsCommand = program
  .command('tools')
  .description('Run MCP tool equivalents via CLI using JSON over stdin')
  .addHelpText(
    'after',
    `
Each subcommand accepts JSON input on stdin and supports:
  --json          Output structured JSON instead of text
  --help          Show help including the input JSON schema
  --print-schema  Print only the input JSON schema
`
  );

toolsCommand
  .command('get-plan')
  .description('Retrieve plan details (reads JSON from stdin)')
  .option('--json', 'Output as structured JSON')
  .option('--print-schema', 'Print the input JSON schema and exit')
  .addHelpText('after', formatSchemaHelp(getPlanParameters))
  .action(async (options, command) => {
    const { handleToolCommand } = await import('./commands/tools.js');
    await handleToolCommand('get-plan', options, command).catch(handleCommandError);
  });

toolsCommand
  .command('create-plan')
  .description('Create a new plan (reads JSON from stdin)')
  .option('--json', 'Output as structured JSON')
  .option('--print-schema', 'Print the input JSON schema and exit')
  .addHelpText('after', formatSchemaHelp(createPlanParameters))
  .action(async (options, command) => {
    const { handleToolCommand } = await import('./commands/tools.js');
    await handleToolCommand('create-plan', options, command).catch(handleCommandError);
  });

toolsCommand
  .command('update-plan-tasks [planId]')
  .description('Update plan tasks and details (reads JSON from stdin unless --tasks is provided)')
  .option('--json', 'Output as structured JSON')
  .option('--print-schema', 'Print the input JSON schema and exit')
  .option('--tasks <json>', 'JSON array of tasks (alternative to stdin)')
  .addHelpText('after', formatSchemaHelp(generateTasksParameters))
  .action(async (planId, options, command) => {
    const { handleToolCommand } = await import('./commands/tools.js');

    // If planId and --tasks are provided, construct the input data
    if (planId && options.tasks) {
      let tasksArray;
      try {
        tasksArray = JSON.parse(options.tasks);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error: Invalid JSON in --tasks option: ${message}`);
        process.exit(1);
      }

      if (!Array.isArray(tasksArray)) {
        console.error('Error: --tasks must be a JSON array');
        process.exit(1);
      }

      options.inputData = {
        plan: planId,
        tasks: tasksArray,
      };
    } else if (planId || options.tasks) {
      // If only one is provided, show an error
      console.error('Error: Both planId and --tasks must be provided together, or use stdin');
      process.exit(1);
    }

    await handleToolCommand('update-plan-tasks', options, command).catch(handleCommandError);
  });

toolsCommand
  .command('update-plan-details')
  .description('Update plan details within generated section (reads JSON from stdin)')
  .option('--json', 'Output as structured JSON')
  .option('--print-schema', 'Print the input JSON schema and exit')
  .addHelpText('after', formatSchemaHelp(updatePlanDetailsParameters))
  .action(async (options, command) => {
    const { handleToolCommand } = await import('./commands/tools.js');
    await handleToolCommand('update-plan-details', options, command).catch(handleCommandError);
  });

toolsCommand
  .command('manage-plan-task')
  .description('Add, update, or remove a plan task (reads JSON from stdin)')
  .option('--json', 'Output as structured JSON')
  .option('--print-schema', 'Print the input JSON schema and exit')
  .addHelpText('after', formatSchemaHelp(managePlanTaskParameters))
  .action(async (options, command) => {
    const { handleToolCommand } = await import('./commands/tools.js');
    await handleToolCommand('manage-plan-task', options, command).catch(handleCommandError);
  });

toolsCommand
  .command('list-ready-plans')
  .description('List ready plans (reads JSON from stdin)')
  .option('--json', 'Output as structured JSON')
  .option('--print-schema', 'Print the input JSON schema and exit')
  .addHelpText('after', formatSchemaHelp(listReadyPlansParameters))
  .action(async (options, command) => {
    const { handleToolCommand } = await import('./commands/tools.js');
    await handleToolCommand('list-ready-plans', options, command).catch(handleCommandError);
  });

program
  .command('init')
  .description('Initialize a repository with a sample tim configuration file')
  .option('--force', 'Overwrite existing configuration file if it exists')
  .option('--minimal', 'Create a minimal configuration with only essential settings')
  .option('-y, --yes', 'Use default values without prompting')
  .action(async (options, command) => {
    const { handleInitCommand } = await import('./commands/init.js');
    await handleInitCommand(options, command).catch(handleCommandError);
  });

program
  .command('generate [plan]')
  .description('Generate a plan using interactive Claude Code executor')
  .option('--plan <plan>', 'Plan to use')
  .option('--latest', 'Use the most recently updated plan')
  .option(
    '--simple',
    'For simpler tasks, generate a single-phase plan that already includes the prompts'
  )
  .option('--commit', 'Commit changes to jj/git after successful plan generation')
  .option('-x, --executor <name>', 'The executor to use for generation (e.g., claude_code, codex)')
  .option(
    '--next-ready <planIdOrPath>',
    'Find and operate on the next ready dependency of the specified parent plan (accepts plan ID or file path)'
  )
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
  .option(
    '--no-terminal-input',
    'Disable terminal input forwarding to Claude Code during plan generation'
  )
  .option('--require-workspace', 'Fail if workspace creation is requested but fails', false)
  .action(async (planArg, options, command) => {
    const { handleGenerateCommand } = await import('./commands/generate.js');
    await handleGenerateCommand(planArg, options, command).catch(handleCommandError);
  });

program
  .command('extract [inputFile]')
  .description('Convert a Markdown project plan into YAML')
  .option('-o, --output <outputFile>', 'Write result to a file instead of stdout')
  .option(
    '--plan <planFile>',
    'The path of the original Markdown project description file. If set, tim will write the output to the same path, but with a .yml extension.'
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
  .command('compact [plans...]')
  .description('Compact completed plans for archival by summarizing verbose sections')
  .option('--executor <name>', 'Executor to use for compaction (default: claude-code)')
  .option('--model <model>', 'Model to use for the executor')
  .option('--age <days>', 'Minimum age in days before compaction', (value) => {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed) || parsed < 0) {
      throw new Error(`Invalid age: ${value}`);
    }
    return parsed;
  })
  .option('--dry-run', 'Preview compacted content without writing changes')
  .option('--yes', 'Skip confirmation prompt and write changes immediately')
  .action(async (planArgs, options, command) => {
    const { handleCompactCommand } = await import('./commands/compact.js');
    await handleCompactCommand(planArgs, options, command).catch(handleCommandError);
  });

program
  .command('add [title...]')
  .description('Create a new plan stub file that can be filled with tasks using generate')
  .option('--edit', 'Open the newly created plan file in your editor')
  .option('--details <text>', 'Plan details (markdown text)')
  .option('--editor-details', 'Open editor to write plan details')
  .option('--details-file <path>', 'Read details from file (use "-" for stdin)')
  .option('-d, --depends-on <ids...>', 'Specify plan IDs that this plan depends on')
  .option('-p, --priority <level>', 'Set the priority level (low, medium, high, urgent)')
  .option('--parent <planId>', 'Set the parent plan ID')
  .option(
    '-s, --status <status>',
    'Set the initial status (pending, in_progress, done, cancelled, deferred)'
  )
  .option(
    '--rmfilter <files...>',
    'Set rmfilter files (comma-separated list or multiple arguments)'
  )
  .option('-i, --issue <urls...>', 'Add GitHub issue URLs to the plan')
  .option('--doc <paths...>', 'Add documentation file paths to the plan')
  .option('--tag <tags...>', 'Add tags to the plan (repeatable)')
  .option('--assign <username>', 'Assign the plan to a user')
  .option('--discovered-from <planId>', 'Set the plan this was discovered from', (value) => {
    const n = Number(value);
    if (Number.isNaN(n) || !Number.isInteger(n) || n <= 0) {
      throw new Error(`discovered-from must be a positive integer, saw ${value}`);
    }
    return n;
  })
  .option('--cleanup <planId>', 'Create a cleanup plan for the specified plan ID')
  .option('--temp', 'Mark this plan as temporary (can be deleted with cleanup-temp command)')
  .option('--simple', 'Mark this plan as simple (skips research phase in generation)')
  .option('--epic', 'Mark this plan as an epic')
  .action(async (title, options, command) => {
    const { handleAddCommand } = await import('./commands/add.js');
    options.dependsOn = intArg(options.dependsOn);
    options.parent = intArg(options.parent);
    options.cleanup = intArg(options.cleanup);
    options.discoveredFrom = intArg(options.discoveredFrom);
    await handleAddCommand(title, options, command).catch(handleCommandError);
  });

program
  .command('import [issue]')
  .description('Import GitHub issues and create corresponding local plan files')
  .option('--issue <url|number>', 'Issue URL or number to import')
  .option('--with-subissues', 'Include subissues when importing (Linear only)')
  .option('-p, --priority <level>', 'Set the priority level (low, medium, high, urgent)')
  .option('--parent <planId>', 'Set the parent plan ID')
  .option(
    '-s, --status <status>',
    'Set the initial status (pending, in_progress, done, cancelled, deferred)'
  )
  .option('-d, --depends-on <ids...>', 'Specify plan IDs that this plan depends on')
  .option('--assign <username>', 'Assign the plan to a user')
  .option('--temp', 'Mark this plan as temporary (can be deleted with cleanup-temp command)')
  .option(
    '--clipboard',
    'Copy issue title, body, and selected comments to clipboard instead of creating a plan'
  )
  .option('--edit', 'Open the plan file in your editor after import')
  .action(async (issue, options, command) => {
    const { handleImportCommand } = await import('./commands/import/import.js');
    await handleImportCommand(issue, options, command).catch(handleCommandError);
  });

program
  .command('promote <taskIds...>')
  .description('Promote tasks from a plan to new top-level plans')
  .action(async (taskIds, options, command) => {
    const { handlePromoteCommand } = await import('./commands/promote.js');
    await handlePromoteCommand(taskIds, options).catch(handleCommandError);
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
  .command('update-docs [planFile]')
  .description('Update documentation based on completed plan work. Can be a file path or plan ID.')
  .option('-x, --executor <name>', 'The executor to use for documentation updates')
  .option('-m, --model <model>', 'Model to use for the executor')
  .action(async (planFile, options, command) => {
    const { handleUpdateDocsCommand } = await import('./commands/update-docs.js');
    await handleUpdateDocsCommand(planFile, options, command).catch(handleCommandError);
  });

program
  .command('update-lessons [planFile]')
  .description(
    'Update documentation based on lessons learned from a completed plan. Can be a file path or plan ID.'
  )
  .option('-x, --executor <name>', 'The executor to use for lessons learned documentation updates')
  .option('-m, --model <model>', 'Model to use for the executor')
  .action(async (planFile, options, command) => {
    const { handleUpdateLessonsCommand } = await import('./commands/update-lessons.js');
    await handleUpdateLessonsCommand(planFile, options, command).catch(handleCommandError);
  });

program
  .command('set-task-done <planFile>')
  .description('Mark a specific task as done by title or index. Can be a file path or plan ID.')
  .option('--title <title>', 'Task title to mark as done')
  .option('--index <index>', 'Task index to mark as done (1-based)', (value: string) => {
    const n = Number(value);
    if (Number.isNaN(n) || !Number.isInteger(n) || n < 1) {
      throw new Error(`Task index must be a positive integer (1-based), saw ${value}`);
    }
    return n - 1; // Convert to 0-based for internal use
  })
  .option('--commit', 'Commit changes to jj/git')
  .action(async (planFile, options, command) => {
    const { handleSetTaskDoneCommand } = await import('./commands/set-task-done.js');
    await handleSetTaskDoneCommand(planFile, options, command).catch(handleCommandError);
  });

program
  .command('merge <planFile>')
  .description('Merge child plans into their parent plan. Can be a file path or plan ID.')
  .option(
    '--children <children...>',
    'Specific child plan IDs or files to merge (defaults to all direct children)'
  )
  .option('--all', 'Merge all direct children (default behavior)')
  .action(async (planFile, options, command) => {
    const { handleMergeCommand } = await import('./commands/merge.js');
    await handleMergeCommand(planFile, options, command).catch(handleCommandError);
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

program
  .command('cleanup-temp')
  .description('Delete all temporary plan files marked with temp: true')
  .action(async (options, command) => {
    const { handleCleanupTempCommand } = await import('./commands/cleanup-temp.js');
    await handleCleanupTempCommand(options, command).catch(handleCommandError);
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
    .option('--orchestrator <name>', 'The orchestrator executor to use for the main agent loop')
    .addOption(
      new Option(
        '-x, --executor <name>',
        'Executor for subagents: codex-cli, claude-code, or dynamic (default: dynamic)'
      ).choices(['codex-cli', 'claude-code', 'dynamic'])
    )
    .option(
      '--review-executor <name>',
      'Executor to use for review steps: claude-code, codex-cli, or both'
    )
    .option(
      '--dynamic-instructions <text>',
      'Instructions for dynamic executor selection when choosing between claude-code and codex-cli for subagents'
    )
    .addHelpText(
      'after',
      `Available orchestrators: ${executorNames}\nSubagent executors: codex-cli, claude-code, dynamic`
    )
    .option('--steps <steps>', 'Number of steps to execute')
    .option('--no-log', 'Do not log to file')
    .option('--no-summary', 'Disable execution summary display at the end')
    .option('--no-final-review', 'Disable automatic final review after plan completion')
    .option(
      '--summary-file <path>',
      'Write execution summary to the specified file instead of stdout (creates parent directories)'
    )
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
    .option(
      '--no-terminal-input',
      'Disable terminal input forwarding to Claude Code during tim agent execution'
    )
    .option('--require-workspace', 'Fail if workspace creation is requested but fails', false)
    .option('--next', 'Execute the next plan that is ready to be implemented')
    .option('--current', 'Execute the current plan (in_progress or next ready plan)')
    .option(
      '--next-ready <planIdOrPath>',
      'Find and operate on the next ready dependency of the specified parent plan (accepts plan ID or file path)'
    )
    .option('--latest', 'Execute the most recently updated plan')
    .option('--with-dependencies', 'Also execute all dependencies first in the correct order')
    .option(
      '--direct',
      'Call LLM directly instead of copying prompt to clipboard during preparation'
    )
    .option('--dry-run', 'Print the generated prompt but do not execute it')
    .option(
      '--serial-tasks',
      'Disable batch task execution mode and process tasks one at a time (default is batch mode)'
    )
    .option('--simple', 'Use streamlined two-phase execution mode (implement then verify)')
    .option('--tdd', 'Use TDD mode: write tests first, then implement to make them pass')
    .option(
      '--update-docs <mode>',
      'Override when to update documentation: never, after-iteration, after-completion'
    )
    .option('--apply-lessons', 'Apply lessons learned to documentation after plan completion')
    .allowExcessArguments(true)
    .allowUnknownOption(true)
    .action(async (planFile, options, command) => {
      const { handleAgentCommand } = await import('./commands/agent/agent.js');
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
  .command('chat [prompt]')
  .description('Start an interactive LLM session without a plan')
  .option('-x, --executor <name>', 'Executor to use (claude-code or codex-cli)')
  .option('-m, --model <model>', 'Model to use')
  .option('--prompt-file <path>', 'Read initial prompt from a file')
  .option('--non-interactive', 'Disable interactive terminal input')
  .option('--no-terminal-input', 'Disable terminal input forwarding')
  .option(
    '--headless-adapter',
    'Wrap chat output in a headless adapter even when tunnel forwarding is active'
  )
  .action(async (prompt, options, command) => {
    const { handleChatCommand } = await import('./commands/chat.js');
    await handleChatCommand(prompt, options, command.parent.opts()).catch(handleCommandError);
  });

program
  .command('run-prompt [prompt]')
  .description(
    'Run a one-shot prompt through Claude Code or Codex CLI. Result is printed to stdout.'
  )
  .option(
    '-x, --executor <name>',
    'Executor to use: claude/claude-code (default) or codex/codex-cli',
    'claude'
  )
  .option('-m, --model <model>', 'Model to use for Claude')
  .option(
    '--reasoning-level <level>',
    'Reasoning effort level for Codex (low, medium, high, xhigh)'
  )
  .option(
    '--json-schema <schema>',
    'JSON schema for structured output (prefix with @ to load from file)'
  )
  .option('--prompt-file <path>', 'Read the prompt from a file')
  .option('-q, --quiet', 'Suppress execution log output on stderr')
  .action(async (promptText, options, command) => {
    const { handleRunPromptCommand } = await import('./commands/run_prompt.js');
    await handleRunPromptCommand(promptText, options, command.parent.opts()).catch(
      handleCommandError
    );
  });

program
  .command('list [searchTerms...]')
  .description(
    'List all plan files in the tasks directory. Optionally filter by title search terms.'
  )
  .option(
    '--dir <directory>',
    'Directory to search for plan files (defaults to configured tasks directory)'
  )
  .option(
    '--sort <field>',
    'Sort by: id, title, status, priority, created, updated (default: created)',
    'created'
  )
  .option('--reverse', 'Reverse sort order')
  .option(
    '--status <status...>',
    'Filter by status (can specify multiple). Valid values: pending, in_progress, done, cancelled, deferred, ready'
  )
  .option('--all', 'Show all plans regardless of status (overrides default filter)')
  .option('--files', 'Show file paths column')
  .option('-u, --user <username>', 'Filter by assignedTo username')
  .option('--mine', 'Show only plans assigned to current user')
  .option('--assigned', 'Show only plans that are claimed in shared assignments')
  .option('--unassigned', 'Show only plans that are not claimed in shared assignments')
  .option('--here', 'Show only plans assigned to the current workspace')
  .option('--tag <tags...>', 'Filter by tag (repeatable)')
  .option(
    '--epic <id>',
    'Filter plans belonging to this epic (directly or indirectly)',
    (value) => {
      const parsed = Number(value);
      if (Number.isNaN(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
        throw new Error(`Epic ID must be a positive integer, saw ${value}`);
      }
      return parsed;
    }
  )
  .option('-n, --number <count>', 'Limit the number of results shown', (value: string) => {
    const n = Number(value);
    if (Number.isNaN(n) || n <= 0) {
      throw new Error(`Count must be a positive integer, saw ${value}`);
    }
    return n;
  })
  .action(async (searchTerms, options, command) => {
    const { handleListCommand } = await import('./commands/list.js');
    await handleListCommand(options, command, searchTerms).catch(handleCommandError);
  });

program
  .command('ready')
  .description(
    'List all plans that are ready to execute (pending/in_progress with dependencies done)'
  )
  .option('--format <format>', 'Output format: list (default), table, json', 'list')
  .option('--sort <field>', 'Sort by: priority (default), id, title, created, updated', 'priority')
  .option('--reverse', 'Reverse sort order')
  .option('--pending-only', 'Show only pending plans (exclude in_progress)')
  .option('--priority <priority>', 'Filter by priority: low, medium, high, urgent, maybe')
  .option('--all', 'Show ready plans regardless of assignment ownership')
  .option('--unassigned', 'Show only ready plans that are not currently claimed')
  .option('--user <username>', 'Show ready plans claimed by the specified user')
  .option('--here', 'Show only ready plans assigned to the current workspace')
  .option('--has-tasks', 'Show only ready plans that have tasks defined')
  .option('--tag <tags...>', 'Filter ready plans by tag (repeatable)')
  .option(
    '--epic <id>',
    'Filter ready plans belonging to this epic (directly or indirectly)',
    (value) => {
      const parsed = Number(value);
      if (Number.isNaN(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
        throw new Error(`Epic ID must be a positive integer, saw ${value}`);
      }
      return parsed;
    }
  )
  .option('-v, --verbose', 'Show additional details like file paths')
  .action(async (options, command) => {
    const { handleReadyCommand } = await import('./commands/ready.js');
    await handleReadyCommand(options, command).catch(handleCommandError);
  });

program
  .command('show [planFile]')
  .description('Display detailed information about a plan. Can be a file path or plan ID.')
  .option('--next', 'Show the next plan that is ready to be implemented')
  .option('--current', 'Show the current plan (in_progress or next ready plan)')
  .option(
    '--next-ready <planIdOrPath>',
    'Find and show the next ready dependency of the specified parent plan (accepts plan ID or file path)'
  )
  .option('--latest', 'Show the most recently updated plan')
  .option('--copy-details', 'Copy the plan details to the clipboard')
  .option('--full', 'Display full details without truncation')
  .option('-s, --short', 'Display a condensed summary view')
  .option('-w, --watch', 'Watch mode: re-print short output every 5 seconds')
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
  .command('claim <plan>')
  .description('Assign a plan to the current workspace (and optionally user)')
  .action(async (plan, options, command) => {
    const { handleClaimCommand } = await import('./commands/claim.js');
    await handleClaimCommand(plan, options, command).catch(handleCommandError);
  });

program
  .command('release <plan>')
  .description('Release a plan assignment from the current workspace')
  .option('--reset-status', 'Reset plan status to pending')
  .action(async (plan, options, command) => {
    const { handleReleaseCommand } = await import('./commands/release.js');
    await handleReleaseCommand(plan, options, command).catch(handleCommandError);
  });

const assignmentsCommand = program
  .command('assignments')
  .description('Inspect and manage shared plan assignments');

assignmentsCommand
  .command('list')
  .description('Show all shared assignments for the current repository')
  .action(async (options, command) => {
    const { handleAssignmentsListCommand } = await import('./commands/assignments.js');
    await handleAssignmentsListCommand(options, command).catch(handleCommandError);
  });

assignmentsCommand
  .command('clean-stale')
  .description('Remove stale assignments that have not been updated recently')
  .option('--yes', 'Skip the confirmation prompt')
  .action(async (options, command) => {
    const { handleAssignmentsCleanStaleCommand } = await import('./commands/assignments.js');
    await handleAssignmentsCleanStaleCommand(options, command).catch(handleCommandError);
  });

assignmentsCommand
  .command('show-conflicts')
  .description('Explain assignment conflict behavior in the single-workspace model')
  .action(async (options, command) => {
    const { handleAssignmentsShowConflictsCommand } = await import('./commands/assignments.js');
    await handleAssignmentsShowConflictsCommand(options, command).catch(handleCommandError);
  });

program
  .command('renumber')
  .description('Renumber plans with alphanumeric IDs or ID conflicts to sequential numeric IDs')
  .option('--dry-run', 'Show what would be renumbered without making changes')
  .option(
    '--keep <files...>',
    `Do not change IDs for these plan file paths when resolving conflicts`
  )
  .option('--conflicts-only', 'Only resolve ID conflicts, skip hierarchical ordering violations')
  .option('--from <id>', 'Plan ID to renumber (use with --to)', (value) => {
    const n = Number(value);
    if (Number.isNaN(n) || !Number.isInteger(n) || n <= 0) {
      throw new Error('--from must be a positive integer');
    }
    return n;
  })
  .option('--to <id>', 'Target ID to renumber to (use with --from)', (value) => {
    const n = Number(value);
    if (Number.isNaN(n) || !Number.isInteger(n) || n <= 0) {
      throw new Error('--to must be a positive integer');
    }
    return n;
  })
  .action(async (options, command) => {
    const { handleRenumber } = await import('./commands/renumber.js');
    await handleRenumber(options, command).catch(handleCommandError);
  });

program
  .command('validate')
  .description('Validate all plan files for Zod schema errors and unknown keys')
  .option('--dir <directory>', 'Directory to validate (defaults to configured task directory)')
  .option('-v, --verbose', 'Show valid files as well as invalid ones')
  .option('--no-fix', 'Report validation issues without auto-fixing them')
  .action(async (options, command) => {
    const { handleValidateCommand } = await import('./commands/validate.js');
    await handleValidateCommand(options, command).catch(handleCommandError);
  });

program
  .command('split <planArg>')
  .description(
    'Split a plan into smaller plans. Use --auto for LLM-based split, or --tasks/--select for manual modes.'
  )
  .option('--auto', 'Use LLM to split into phases (existing behavior)')
  .option(
    '--tasks <specifier>',
    'Manually select tasks by index (1-based). Supports ranges and comma lists, e.g. 1-3,5'
  )
  .option('--select', 'Interactively choose tasks to split via a checkbox prompt')
  .action(async (planArg, options, command) => {
    const { handleSplitCommand } = await import('./commands/split.js');
    await handleSplitCommand(planArg, options, command).catch(handleCommandError);
  });

program
  .command('add-task <plan>')
  .description('Add a task to an existing plan (file path or plan ID)')
  .option('--title <title>', 'Task title')
  .option('--description <desc>', 'Task description')
  .option('--editor', 'Open editor for description')
  .option('--files <files...>', 'Related files')
  .option('--docs <docs...>', 'Documentation paths')
  .option('--interactive', 'Prompt for all fields interactively')
  .action(async (plan, options, command) => {
    const { handleAddTaskCommand } = await import('./commands/add-task.js');
    await handleAddTaskCommand(plan, options, command).catch(handleCommandError);
  });

program
  .command('remove <planFiles...>')
  .description('Remove one or more plan files and clean up references')
  .option('-f, --force', 'Force removal even if other plans depend on this one')
  .action(async (planFiles, options, command) => {
    const { handleRemoveCommand } = await import('./commands/remove.js');
    await handleRemoveCommand(planFiles, options, command).catch(handleCommandError);
  });

program
  .command('remove-task <plan>')
  .description('Remove a task from a plan (file path or plan ID)')
  .option('--index <index>', 'Task index (1-based)', (val: string) => {
    const n = parseInt(val, 10);
    if (Number.isNaN(n) || n < 1) {
      throw new Error(`Task index must be a positive integer (1-based), saw ${val}`);
    }
    return n - 1; // Convert to 0-based for internal use
  })
  .option('--title <title>', 'Find task by title (partial match)')
  .option('--interactive', 'Select task interactively')
  .action(async (plan, options, command) => {
    const { handleRemoveTaskCommand } = await import('./commands/remove-task.js');
    await handleRemoveTaskCommand(plan, options, command).catch(handleCommandError);
  });

program
  .command('set <planFile>')
  .description(
    'Update plan properties like priority, status, dependencies, and rmfilter. Can be a file path or plan ID.'
  )
  .option('-p, --priority <level>', 'Set the priority level', (value) => {
    if (!prioritySchema.options.includes(value as any)) {
      throw new Error(`Priority must be one of: ${prioritySchema.options.join(', ')}`);
    }
    return value;
  })
  .option('-s, --status <status>', 'Set the status', (value) => {
    if (!statusSchema.options.includes(value as any)) {
      throw new Error(`Status must be one of: ${statusSchema.options.join(', ')}`);
    }
    return value;
  })
  .option('-d, --depends-on <planIds...>', 'Add plan IDs as dependencies')
  .option('--no-d, --no-depends-on <planIds...>', 'Remove plan IDs from dependencies')
  .option('--parent <planId>', 'Set the parent plan ID')
  .option('--no-parent', 'Remove the parent plan association')
  .option('--discovered-from <planId>', 'Set the plan this was discovered from', (value) => {
    const n = Number(value);
    if (Number.isNaN(n) || n <= 0 || !Number.isInteger(n)) {
      throw new Error(`discovered-from must be a positive integer, saw ${value}`);
    }
    return n;
  })
  .option('--no-discovered-from', 'Remove the discoveredFrom association')
  .option(
    '--rmfilter <files...>',
    'Set rmfilter files (comma-separated list or multiple arguments)'
  )
  .option('-i, --issue <urls...>', 'Add GitHub issue URLs to the plan')
  .option('--no-i, --no-issue <urls...>', 'Remove GitHub issue URLs from the plan')
  .option('--doc <paths...>', 'Add documentation file paths to the plan')
  .option('--no-doc <paths...>', 'Remove documentation file paths from the plan')
  .option('--tag <tags...>', 'Add tags to the plan (repeatable)')
  .option('--no-tag <tags...>', 'Remove tags from the plan')
  .option('--assign <username>', 'Assign the plan to a user')
  .option('--no-assign', 'Remove the plan assignment')
  .option('--epic', 'Mark the plan as an epic')
  .option('--no-epic', 'Mark the plan as not an epic')
  .option('--sd, --status-description <description>', 'Set a description for the current status')
  .option('--no-sd, --no-status-description', 'Remove the status description')
  .action(async (planFile, options, command) => {
    const { handleSetCommand } = await import('./commands/set.js');
    options.dependsOn = intArg(options.dependsOn);
    options.noDependsOn = intArg(options.noDependsOn);
    options.parent = intArg(options.parent);
    await handleSetCommand(planFile, options, command.parent.opts()).catch(handleCommandError);
  });

program
  .command('review [planFile]')
  .description(
    'Analyze code changes on current branch against plan requirements using reviewer agent. If no plan is specified, automatically selects the oldest plan that exists only on this branch.'
  )
  .option(`-x, --executor <name>`, 'The executor to use for review execution')
  .addHelpText('after', `Available executors: ${executorNames}`)
  .option(
    '-m, --model <model>',
    'Specify the LLM model to use for the review. Overrides model from tim config.'
  )
  .option('--dry-run', 'Generate and print the review prompt but do not execute it', false)
  .option('-p, --print', 'Output JSON review results without interactive prompts')
  .option(
    '--task-index <indexes...>',
    'Review only specific task indexes (1-based). Repeatable or comma-separated.'
  )
  .option(
    '--task-title <titles...>',
    'Review only specific task titles (exact match, case-insensitive). Repeatable or comma-separated.'
  )
  .option(
    '--instructions <text>',
    'Inline custom instructions for the review. Overrides config file instructions.'
  )
  .option(
    '--instructions-file <path>',
    'Path to file containing custom review instructions. Overrides config file instructions.'
  )
  .option(
    '--previous-response <path>',
    'Path to a file containing the previous review response to include in this review prompt.'
  )
  .option(
    '--focus <areas>',
    'Comma-separated list of focus areas (e.g., security,performance,testing). Overrides config focus areas.'
  )
  .option(
    '--format <format>',
    'Output format for review results: json, markdown, or terminal. Overrides config setting.',
    'terminal'
  )
  .option(
    '--serial-both',
    'When using --executor both, run Claude first and only run Codex if Claude reports no blocking issues.'
  )
  .option('--verbosity <level>', 'Output verbosity level: minimal, normal, or detailed.', 'normal')
  .option(
    '--output-file <path>',
    'Save review results to the specified file path. Format determined by --format option.'
  )
  .option('--save', 'Save review results to .rmfilter/reviews/ directory with metadata tracking.')
  .option('--no-save', 'Disable automatic saving of review results (overrides config settings).')
  .option('--git-note', 'Create a Git note with review summary attached to the current commit.')
  .option('--no-color', 'Disable colored output in terminal format.')
  .option(
    '--show-files',
    'Include changed files list in output (enabled by default except in minimal verbosity).'
  )
  .option('--no-suggestions', 'Hide suggestions in the formatted output.')
  .option('--incremental', 'Only review changes since the last review for this plan.')
  .option(
    '--since-last-review',
    'Alias for --incremental. Only review changes since the last review.'
  )
  .option('--since <commit>', 'Review changes since the specified commit hash.')
  .option(
    '--base <branch>',
    'Base branch to compare against (defaults to auto-detected main/master/trunk)'
  )
  .option('--autofix', 'Automatically fix issues found during review without prompting.')
  .option('--autofix-all', 'Automatically fix all issues without prompting for selection.')
  .option('--no-autofix', 'Disable automatic fixing of issues, even if configured elsewhere.')
  .option(
    '--create-cleanup-plan',
    'Create a cleanup plan for selected issues instead of fixing immediately.'
  )
  .option(
    '--cleanup-priority <level>',
    'Set the priority level for cleanup plan (low, medium, high, urgent)',
    'medium'
  )
  .option('--cleanup-assign <username>', 'Assign the cleanup plan to a user')
  .option(
    '-v, --verbose',
    'When used with --print, show progress output to stderr. Otherwise only JSON output is shown.'
  )
  .action(async (planFile, options, command) => {
    const { handleReviewCommand } = await import('./commands/review.js');
    await handleReviewCommand(planFile, options, command).catch(handleCommandError);
  });

program
  .command('pr-description <planFile>')
  .description(
    'Generate a comprehensive pull request description from plan context and code changes'
  )
  .option(`-x, --executor <name>`, 'The executor to use for description generation')
  .addHelpText('after', `Available executors: ${executorNames}`)
  .option(
    '-m, --model <model>',
    'Specify the LLM model to use for description generation. Overrides model from tim config.'
  )
  .option('--dry-run', 'Generate and print the description prompt but do not execute it', false)
  .option(
    '--instructions <text>',
    'Inline custom instructions for the PR description. Overrides config file instructions.'
  )
  .option(
    '--instructions-file <path>',
    'Path to file containing custom description instructions. Overrides config file instructions.'
  )
  .option(
    '--base <branch>',
    'Base branch to compare against (defaults to auto-detected main/master/trunk)'
  )
  .option('--output-file <path>', 'Save the generated description to the specified file')
  .option('--copy', 'Copy the generated description to the clipboard')
  .option('--create-pr', 'Create a GitHub PR using the generated description with gh CLI')
  .action(async (planFile, options, command) => {
    const { handleDescriptionCommand } = await import('./commands/description.js');
    await handleDescriptionCommand(planFile, options, command).catch(handleCommandError);
  });

program
  .command('answer-pr [prIdentifier]')
  .description(
    'Address Pull Request (PR) review comments using an LLM. If no PR identifier is provided, it will try to detect the PR from the current branch.'
  )
  .option(
    '--mode <mode>',
    "Specify the editing mode. 'inline-comments' (default) inserts comments into code. 'separate-context' adds them to the prompt. 'hybrid' combines both approaches."
  )
  .option(`-x, --executor <name>`, 'The executor to use for execution')
  .addHelpText('after', `Available executors: ${executorNames}`)
  .option(
    '--yes',
    'Automatically proceed without interactive prompts (e.g., for reviewing AI comments in files).',
    false
  )
  .option('-m, --model <model>', 'Specify the LLM model to use. Overrides model from tim config.')
  .option(
    '--dry-run',
    'Prepare and print the LLM prompt, but do not call the LLM or apply edits.',
    false
  )
  .option('--commit', 'Commit changes to jj/git')
  .option('--comment', 'Post replies to review threads after committing changes')
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
  .option('--repo <id>', 'Filter by repository ID (defaults to current repo)')
  .option('--format <format>', 'Output format: table (default), tsv, json', 'table')
  .option('--no-header', 'Omit header row (for tsv/table formats)')
  .option('--all', 'List workspaces across all repositories')
  .action(async (options, command) => {
    const { handleWorkspaceListCommand } = await import('./commands/workspace.js');
    await handleWorkspaceListCommand(options, command).catch(handleCommandError);
  });

// Add the 'add' subcommand to workspace
workspaceCommand
  .command('add [planIdentifier]')
  .description('Create a new workspace, optionally linked to a plan or issue')
  .option('--id <workspaceId>', 'Specify a custom workspace ID')
  .option('--issue <issueId>', 'Import a GitHub/Linear issue as a new plan in the workspace')
  .option('--clone-method <method>', 'Clone method: git, cp, or mac-cow (overrides config)')
  .option('--source-dir <path>', 'Source directory for cp/mac-cow methods (overrides config)')
  .option('--repo-url <url>', 'Repository URL for git method (overrides config)')
  .option('--create-branch', 'Create a new branch for the workspace')
  .option('--no-create-branch', 'Do not create a new branch (default)')
  .option('--reuse', 'Reuse an existing unlocked workspace (fails if none available)')
  .option('--try-reuse', 'Try to reuse an existing workspace, create new if unavailable')
  .option('--from-branch <branch>', 'Create new branch from this base instead of main/master')
  .option(
    '--target-dir <path>',
    'Target directory name or path (relative to cloneLocation or absolute)'
  )
  .action(async (planIdentifier, options, command) => {
    if (options.reuse && options.tryReuse) {
      console.error('Error: Cannot use both --reuse and --try-reuse');
      process.exit(1);
    }
    const { handleWorkspaceAddCommand } = await import('./commands/workspace.js');
    await handleWorkspaceAddCommand(planIdentifier, options, command).catch(handleCommandError);
  });

workspaceCommand
  .command('lock [workspaceIdentifier]')
  .description('Lock a workspace by task ID, directory, or current directory')
  .option('-a, --available', 'Lock the first available workspace for this repository')
  .option('-c, --create', 'Create a new workspace if none are available')
  .action(async (workspaceIdentifier, options, command) => {
    const { handleWorkspaceLockCommand } = await import('./commands/workspace.js');
    await handleWorkspaceLockCommand(workspaceIdentifier, options, command).catch(
      handleCommandError
    );
  });

workspaceCommand
  .command('unlock [workspaceIdentifier]')
  .description('Unlock a workspace by task ID, directory, or current directory')
  .action(async (workspaceIdentifier, options, command) => {
    const { handleWorkspaceUnlockCommand } = await import('./commands/workspace.js');
    await handleWorkspaceUnlockCommand(workspaceIdentifier, options, command).catch(
      handleCommandError
    );
  });

workspaceCommand
  .command('update [workspaceIdentifier]')
  .description('Update workspace name and description metadata')
  .option('--name <name>', 'Set the workspace name (use empty string to clear)')
  .option(
    '--description <description>',
    'Set the workspace description (use empty string to clear)'
  )
  .option(
    '--from-plan <planId>',
    'Seed description from plan (plan ID or file path). Only sets description, not name.'
  )
  .option('--primary', 'Mark this workspace as primary (excluded from auto-selection)')
  .option('--no-primary', 'Remove primary designation from this workspace')
  .action(async (workspaceIdentifier, options, command) => {
    const { handleWorkspaceUpdateCommand } = await import('./commands/workspace.js');
    await handleWorkspaceUpdateCommand(workspaceIdentifier, options, command).catch(
      handleCommandError
    );
  });

workspaceCommand
  .command('push [workspaceIdentifier]')
  .description('Push current branch/bookmark to the primary workspace')
  .action(async (workspaceIdentifier, options, command) => {
    const { handleWorkspacePushCommand } = await import('./commands/workspace.js');
    await handleWorkspacePushCommand(workspaceIdentifier, options, command).catch(
      handleCommandError
    );
  });

program
  .command('shell-integration')
  .description('Print a shell function for interactive workspace switching using fzf')
  .option('--shell <shell>', 'Shell type: bash or zsh (default: zsh)', 'zsh')
  .action(async (options) => {
    const { handleShellIntegrationCommand } = await import('./commands/shell-integration.js');
    handleShellIntegrationCommand(options);
  });

const storageCommand = program
  .command('storage')
  .description('Manage external tim storage directories');

storageCommand
  .command('list')
  .description('List external tim storage directories')
  .option('--json', 'Output directory information as JSON')
  .option('--size', 'Include directory size information (may be slow on large trees)')
  .action(async (options) => {
    const { handleStorageListCommand } = await import('./commands/storage.js');
    await handleStorageListCommand(options).catch(handleCommandError);
  });

storageCommand
  .command('clean [names...]')
  .description('Remove external storage directories when they are no longer needed')
  .option('--all', 'Remove all external storage directories without prompting')
  .option('--force', 'Remove directories even if plan files are present')
  .option('--dry-run', 'Print the directories that would be removed without deleting them')
  .action(async (names, options) => {
    const { handleStorageCleanCommand } = await import('./commands/storage.js');
    await handleStorageCleanCommand(names, options).catch(handleCommandError);
  });

// Register the subagent command with implementer, tester, tdd-tests, and verifier subcommands
const subagentCommand = program
  .command('subagent')
  .description('Run a subagent for the orchestrator');

for (const agentType of ['implementer', 'tester', 'tdd-tests', 'verifier'] as const) {
  subagentCommand
    .command(`${agentType} <planFile>`)
    .description(`Run the ${agentType} subagent`)
    .addOption(
      new Option('-x, --executor <name>', 'Executor to use: codex-cli or claude-code')
        .choices(['codex-cli', 'claude-code'])
        .default('claude-code')
    )
    .option('-m, --model <model>', 'Model to use')
    .option('--input <text>', 'Additional instructions from orchestrator')
    .option(
      '--input-file <path>',
      'Read additional instructions from file (use "-" to read from stdin)'
    )
    .action(async (planFile: string, options: any, command: any) => {
      const { handleSubagentCommand } = await import('./commands/subagent.js');
      await handleSubagentCommand(agentType, planFile, options, command.parent.parent.opts()).catch(
        handleCommandError
      );
    });
}

async function run() {
  installStdinDebugTracing();
  await loadEnv();
  enableAutoClaim();

  // Set up signal handlers for cleanup
  const cleanupRegistry = CleanupRegistry.getInstance();

  process.on('exit', () => {
    cleanupRegistry.executeAll();
  });

  process.on('SIGINT', () => {
    cleanupRegistry.executeAll();
    process.exit(130); // Unix convention for SIGINT
  });

  process.on('SIGTERM', () => {
    cleanupRegistry.executeAll();
    process.exit();
  });

  process.on('SIGHUP', () => {
    cleanupRegistry.executeAll();
    process.exit();
  });

  // If TIM_OUTPUT_SOCKET is set, install the tunnel adapter to forward all
  // logging output to the parent tim process via Unix socket.
  const tunnelSocketPath = process.env[TIM_OUTPUT_SOCKET];
  if (tunnelSocketPath) {
    try {
      const tunnelAdapter = await createTunnelAdapter(tunnelSocketPath);
      cleanupRegistry.register(() => tunnelAdapter.destroySync());
      await runWithLogger(tunnelAdapter, () => program.parseAsync(process.argv));
      await tunnelAdapter.destroy();
    } catch {
      // If tunnel connection fails, fall back to normal console output.
      // Clear the env var so isTunnelActive() returns false — otherwise
      // the review command would skip installing its quiet/verbose logger
      // even though no tunnel adapter is actually installed.
      delete process.env[TIM_OUTPUT_SOCKET];
      await program.parseAsync(process.argv);
    }
  } else {
    await program.parseAsync(process.argv);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
