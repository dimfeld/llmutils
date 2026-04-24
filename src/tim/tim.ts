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
import * as z from 'zod/v4';
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
import { type TunnelAdapter, createTunnelAdapter } from '../logging/tunnel_client.js';
import { TIM_OUTPUT_SOCKET } from '../logging/tunnel_protocol.js';
import { isDeferSignalExit, isShuttingDown, setShuttingDown } from './shutdown_state.js';
import {
  getPlanParameters,
  createPlanParameters,
  generateTasksParameters,
  updatePlanDetailsParameters,
  managePlanTaskParameters,
  listReadyPlansParameters,
} from './tools/schemas.js';
import { parseOptionalPlanIdFromCliArg, parsePlanIdFromCliArg } from './plans.js';

function parsePlanIdOption(value: string | undefined): number | undefined;
function parsePlanIdOption(value: string[] | undefined): number[] | undefined;
function parsePlanIdOption<T extends string | string[] | undefined>(
  value: T | undefined
): number | number[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (Array.isArray(value)) {
    const out = value.map((s) => parsePlanIdOption(s));
    return out as number[] | undefined;
  }

  return parsePlanIdFromCliArg(value);
}

function formatSchemaHelp(schema: z.ZodTypeAny): string {
  const jsonSchema = z.toJSONSchema(schema, {
    target: 'draft-7',
    io: 'input',
  });
  return `\nInput JSON Schema:\n${JSON.stringify(jsonSchema, null, 2)}\n`;
}

async function runWithCommandTunnelAdapter<T>(callback: () => Promise<T> | T): Promise<T> {
  const tunnelSocketPath = process.env[TIM_OUTPUT_SOCKET];
  if (!tunnelSocketPath) {
    return callback();
  }

  let tunnelAdapter: TunnelAdapter;
  try {
    tunnelAdapter = await createTunnelAdapter(tunnelSocketPath);
  } catch {
    // If tunnel connection fails, fall back to normal console output.
    // Clear the env var so isTunnelActive() returns false so print-mode logging
    // behavior is correct when the command starts.
    delete process.env[TIM_OUTPUT_SOCKET];
    return callback();
  }

  const cleanupRegistry = CleanupRegistry.getInstance();
  const unregisterCleanup = cleanupRegistry.register(() => tunnelAdapter.destroySync());
  try {
    return await runWithLogger(tunnelAdapter, async () => await callback());
  } finally {
    unregisterCleanup();
    try {
      await tunnelAdapter.destroy();
    } catch {
      // Ignore tunnel cleanup failures.
    }
  }
}

export const program = new Command();

type SignalHandlerProcess = Pick<NodeJS.Process, 'on'>;

export function registerShutdownSignalHandlers(
  cleanupRegistry: Pick<CleanupRegistry, 'executeAll'> = CleanupRegistry.getInstance(),
  proc: SignalHandlerProcess = process
): void {
  proc.on('exit', () => {
    cleanupRegistry.executeAll();
  });

  const handleSignal = (exitCode: number) => {
    if (isShuttingDown()) {
      // Second signal — force exit immediately.
      // process.exit() triggers the 'exit' handler which runs cleanupRegistry.executeAll(),
      // so killDaemons() still fires as an emergency fallback.
      process.exit(exitCode);
      return;
    }
    setShuttingDown(exitCode);
    if (!isDeferSignalExit()) {
      // No async cleanup registered — run sync cleanup and exit immediately
      // (preserves behavior for non-agent commands)
      cleanupRegistry.executeAll();
      process.exit(exitCode);
    }
    // When deferSignalExit is set, the agent's finally block handles async lifecycle
    // shutdown (explicit shutdown commands, then daemon kills) before calling process.exit().
    // The cleanupRegistry is NOT run here so killDaemons() doesn't preempt explicit
    // shutdown commands. It remains registered for the force-exit path (second signal →
    // process.exit → 'exit' event → cleanupRegistry.executeAll).
  };

  proc.on('SIGINT', () => handleSignal(130));
  proc.on('SIGTERM', () => handleSignal(143));
  proc.on('SIGHUP', () => handleSignal(129));
}
program.name('tim').description('Generate and execute task plans using LLMs');

const statusSchemaHelpText = `(${statusSchema.options.join(', ')})`;
program.option(
  '-c, --config <path>',
  'Specify path to the tim configuration file (default: .tim/config/tim.yml)'
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
  .command('prompts [prompt] [planId]')
  .description('Print an MCP prompt to stdout for use in CLI workflows')
  .option('--plan <planId>', 'Plan ID to use')
  .option('--latest', 'Use the most recently updated plan')
  .option(
    '--next-ready <planId>',
    'Find and use the next ready dependency of the specified parent plan'
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
    const parsedPlanId = parseOptionalPlanIdFromCliArg(planArg);
    if (options.plan !== undefined) {
      options.plan = parsePlanIdFromCliArg(options.plan);
    }
    if (options.nextReady !== undefined) {
      options.nextReady = parsePlanIdFromCliArg(options.nextReady);
    }
    await handlePromptsCommand(promptName, parsedPlanId, options, command).catch(
      handleCommandError
    );
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
  .action(async (planIdArg, options, command) => {
    const { handleToolCommand } = await import('./commands/tools.js');

    const planId = parseOptionalPlanIdFromCliArg(planIdArg);

    if (planId !== undefined && options.tasks) {
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
    } else if (options.tasks && planId === undefined) {
      console.error('Error: --tasks requires a plan ID positional argument or stdin input');
      process.exit(1);
    } else if (planId !== undefined) {
      options.planIdOverride = planId;
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
  .command('generate [planId]')
  .description('Generate a plan using an interactive executor')
  .option('--plan <planId>', 'Plan to use')
  .option('--latest', 'Use the most recently updated plan')
  .option(
    '--simple',
    'For simpler tasks, generate a single-phase plan that already includes the prompts'
  )
  .option('--commit', 'Commit changes to jj/git after successful plan generation')
  .option('-x, --executor <name>', 'The executor to use for generation (e.g., claude_code, codex)')
  .option(
    '--next-ready <planId>',
    'Find and operate on the next ready dependency of the specified parent plan'
  )
  .option(
    '-w, --workspace <id>',
    'ID for the task, used for workspace naming and tracking. If provided, a new workspace will be created.'
  )
  .option(
    '--aw, --auto-workspace',
    'Automatically select an available workspace or create a new one'
  )
  .option(
    '--nw, --new-workspace',
    'Allow creating a new workspace. When used with --workspace, creates a new workspace with the specified ID. When used with --auto-workspace, always creates a new workspace instead of reusing existing ones.'
  )
  .option('--no-workspace-sync', 'Disable automatic workspace round-trip sync')
  .option('--non-interactive', 'Do not prompt for user input (e.g., when clearing stale locks)')
  .option(
    '--no-terminal-input',
    'Disable terminal input forwarding to Claude Code during plan generation'
  )
  .option(
    '--require-workspace',
    'Fail if workspace creation is requested but fails (default: true)',
    true
  )
  .action(async (planArg, options, command) => {
    const { handleGenerateCommand } = await import('./commands/generate.js');
    const planId = parseOptionalPlanIdFromCliArg(planArg);
    if (options.plan !== undefined) {
      options.plan = parsePlanIdFromCliArg(options.plan);
    }
    if (options.nextReady !== undefined) {
      options.nextReady = parsePlanIdFromCliArg(options.nextReady);
    }
    await handleGenerateCommand(planId, options, command).catch(handleCommandError);
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
  .option('-s, --status <status>', `Set the initial status ${statusSchemaHelpText}`)
  .option(
    '--rmfilter <files...>',
    'Set rmfilter files (comma-separated list or multiple arguments)'
  )
  .option('-i, --issue <urls...>', 'Add GitHub issue URLs to the plan')
  .option('--doc <paths...>', 'Add documentation file paths to the plan')
  .option('--tag <tags...>', 'Add tags to the plan (repeatable)')
  .option('--assign <username>', 'Assign the plan to a user')
  .option('--discovered-from <planId>', 'Set the plan this was discovered from')
  .option('--cleanup <planId>', 'Create a cleanup plan for the specified plan ID')
  .option('--temp', 'Mark this plan as temporary (can be deleted with cleanup-temp command)')
  .option('--simple', 'Mark this plan as simple (skips research phase in generation)')
  .option('--epic', 'Mark this plan as an epic')
  .action(async (title, options, command) => {
    const { handleAddCommand } = await import('./commands/add.js');
    options.dependsOn = parsePlanIdOption(options.dependsOn);
    options.parent = parsePlanIdOption(options.parent);
    options.cleanup = parsePlanIdOption(options.cleanup);
    options.discoveredFrom = parsePlanIdOption(options.discoveredFrom);
    await handleAddCommand(title, options, command).catch(handleCommandError);
  });

program
  .command('import <url|issue_id>')
  .description('Import GitHub or Linear issues and create corresponding local plan files')
  .option('--with-subissues', 'Include subissues when importing (Linear only)')
  .option(
    '--with-merged-subissues',
    'Include subissues when importing but merge everything into one plan file (Linear only)'
  )
  .option('-p, --priority <level>', 'Set the priority level (low, medium, high, urgent)')
  .option('--parent <planId>', 'Set the parent plan ID')
  .option('-s, --status <status>', `Set the initial status ${statusSchemaHelpText}`)
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
    options.parent = parsePlanIdOption(options.parent);
    options.dependsOn = parsePlanIdOption(options.dependsOn);
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
  .command('update-docs <planId>')
  .description(
    'Run any remaining documentation and lessons finalization steps in a workspace-aware flow.'
  )
  .option('-x, --executor <name>', 'The executor to use for finalization steps')
  .option('-m, --model <model>', 'Model to use for the executor')
  .option(
    '-w, --workspace <id>',
    'ID for the task, used for workspace naming and tracking. If provided, a new workspace will be created.'
  )
  .option(
    '--aw, --auto-workspace',
    'Automatically select an available workspace or create a new one'
  )
  .option(
    '--nw, --new-workspace',
    'Allow creating a new workspace. When used with --workspace, creates a new workspace with the specified ID. When used with --auto-workspace, always creates a new workspace instead of reusing existing ones.'
  )
  .option('--no-workspace-sync', 'Disable automatic workspace round-trip sync')
  .option('--non-interactive', 'Do not prompt for user input (e.g., when clearing stale locks)')
  .option('--no-terminal-input', 'Disable terminal input forwarding during finalization')
  .option(
    '--require-workspace',
    'Fail if workspace creation is requested but fails (default: true)',
    true
  )
  .option('--apply-lessons', 'Apply lessons learned to documentation after plan completion')
  .action(async (planArg, options, command) => {
    const { handleFinishCommand } = await import('./commands/finish.js');
    const planId = parsePlanIdFromCliArg(planArg);
    await handleFinishCommand(planId, options, command).catch(handleCommandError);
  });

program
  .command('set-task-done <planId>')
  .description('Mark a specific task as done by title or index.')
  .option('--title <title>', 'Task title to mark as done')
  .option('--index <index>', 'Task index to mark as done (1-based)', (value: string) => {
    const n = Number(value);
    if (Number.isNaN(n) || !Number.isInteger(n) || n < 1) {
      throw new Error(`Task index must be a positive integer (1-based), saw ${value}`);
    }
    return n - 1; // Convert to 0-based for internal use
  })
  .option('--commit', 'Commit changes to jj/git')
  .action(async (planIdArg, options, command) => {
    const { handleSetTaskDoneCommand } = await import('./commands/set-task-done.js');
    const planId = parsePlanIdFromCliArg(planIdArg);
    await handleSetTaskDoneCommand(planId, options, command).catch(handleCommandError);
  });

program
  .command('cleanup-temp')
  .description('Delete all temporary plan files marked with temp: true')
  .action(async (options, command) => {
    const { handleCleanupTempCommand } = await import('./commands/cleanup-temp.js');
    await handleCleanupTempCommand(options, command).catch(handleCommandError);
  });

program
  .command('cleanup-materialized')
  .description('Delete stale materialized plan files from .tim/plans/')
  .action(async (options, command) => {
    const { handleCleanupMaterializedCommand } = await import('./commands/cleanup-materialized.js');
    await handleCleanupMaterializedCommand(options, command).catch(handleCommandError);
  });

program
  .command('sync [planId]')
  .description('Sync materialized plans in .tim/plans/ back to the database')
  .option('--force', 'Sync even when the materialized file looks stale')
  .option('--verbose', 'Reserved for additional sync diagnostics')
  .action(async (planIdArg, options, command) => {
    const { handleSyncCommand } = await import('./commands/sync.js');
    const planId = parseOptionalPlanIdFromCliArg(planIdArg);
    await handleSyncCommand(planId, options, command).catch(handleCommandError);
  });

program
  .command('materialize <planId>')
  .description('Materialize a plan from the database to .tim/plans/ for editing')
  .action(async (planIdArg, options, command) => {
    const { handleMaterializeCommand } = await import('./commands/materialize.js');
    const planId = parsePlanIdFromCliArg(planIdArg);
    await handleMaterializeCommand(planId, options, command).catch(handleCommandError);
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
      '-w, --workspace <id>',
      'ID for the task, used for workspace naming and tracking. If provided, a new workspace will be created.'
    )
    .option(
      '--aw, --auto-workspace',
      'Automatically select an available workspace or create a new one'
    )
    .option(
      '--nw, --new-workspace',
      'Allow creating a new workspace. When used with --workspace, creates a new workspace with the specified ID. When used with --auto-workspace, always creates a new workspace instead of reusing existing ones.'
    )
    .option('--no-workspace-sync', 'Disable automatic workspace round-trip sync')
    .option('--non-interactive', 'Do not prompt for user input (e.g., when clearing stale locks)')
    .option(
      '--no-terminal-input',
      'Disable terminal input forwarding to Claude Code during tim agent execution'
    )
    .option(
      '--require-workspace',
      'Fail if workspace creation is requested but fails (default: true)',
      true
    )
    .option('--next', 'Execute the next plan that is ready to be implemented')
    .option('--current', 'Execute the current plan (in_progress or next ready plan)')
    .option(
      '--next-ready <planId>',
      'Find and operate on the next ready dependency of the specified parent plan'
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
      'Override when to update documentation: never, after-iteration, after-completion, after-review'
    )
    .option('--apply-lessons', 'Apply lessons learned to documentation after plan completion')
    .allowExcessArguments(true)
    .allowUnknownOption(true)
    .action(async (planIdArg, options, command) => {
      const { handleAgentCommand } = await import('./commands/agent/agent.js');
      const planId = parseOptionalPlanIdFromCliArg(planIdArg);
      if (options.nextReady !== undefined) {
        options.nextReady = parsePlanIdFromCliArg(options.nextReady);
      }
      await handleAgentCommand(planId, options, command.parent.opts()).catch(handleCommandError);
    });
}

// Create the agent command
createAgentCommand(
  program.command('agent [planId]'),
  'Automatically execute steps in a plan. Accepts a numeric plan ID.'
);

// Create the run command as an alias
createAgentCommand(
  program.command('run [planId]'),
  'Alias for "agent". Automatically execute steps in a plan. Accepts a numeric plan ID.'
);

program
  .command('chat [prompt]')
  .description('Start an interactive LLM session without a plan')
  .option(
    '-x, --executor <name>',
    'Executor to use: claude/claude-code (default) or codex/codex-cli'
  )
  .option('-m, --model <model>', 'Model to use')
  .option('--prompt-file <path>', 'Read initial prompt from a file')
  .option(
    '-w, --workspace <id>',
    'ID for the task, used for workspace naming and tracking. If provided, a new workspace will be created.'
  )
  .option(
    '--aw, --auto-workspace',
    'Automatically select an available workspace or create a new one'
  )
  .option(
    '--nw, --new-workspace',
    'Allow creating a new workspace. When used with --workspace, creates a new workspace with the specified ID. When used with --auto-workspace, always creates a new workspace instead of reusing existing ones.'
  )
  .option('--no-workspace-sync', 'Disable automatic workspace round-trip sync')
  .option('--commit', 'Commit changes to jj/git after successful chat execution')
  .option('--plan <planId>', 'Associate chat with a plan for branch/workspace assignment')
  .option('--non-interactive', 'Disable interactive terminal input')
  .option('--no-terminal-input', 'Disable terminal input forwarding')
  .option(
    '--headless-adapter',
    'Wrap chat output in a headless adapter even when tunnel forwarding is active'
  )
  .action(async (prompt, options, command) => {
    const { handleChatCommand } = await import('./commands/chat.js');
    if (options.plan !== undefined) {
      options.plan = parsePlanIdFromCliArg(options.plan);
    }
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
  .description('List plans from the database. Optionally filter by title search terms.')
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
    `Filter by status (can specify multiple). Valid values: ${statusSchema.options.join(', ')}, ready`
  )
  .option('--all', 'Show all plans regardless of status (overrides default filter)')
  .option('--show-files', 'Show file paths column')
  .option('-u, --user <username>', 'Filter by assignedTo username')
  .option('--mine', 'Show only plans assigned to current user')
  .option('--assigned', 'Show only plans that are claimed in shared assignments')
  .option('--unassigned', 'Show only plans that are not claimed in shared assignments')
  .option('--here', 'Show only plans assigned to the current workspace')
  .option('--tag <tags...>', 'Filter by tag (repeatable)')
  .option(
    '--epic <id>',
    'Filter plans belonging to this epic (directly or indirectly)',
    parsePlanIdFromCliArg
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
    parsePlanIdFromCliArg
  )
  .option('-v, --verbose', 'Show additional details like file paths')
  .action(async (options, command) => {
    const { handleReadyCommand } = await import('./commands/ready.js');
    await handleReadyCommand(options, command).catch(handleCommandError);
  });

program
  .command('show [planId]')
  .description('Display detailed information about a plan.')
  .option('--next', 'Show the next plan that is ready to be implemented')
  .option('--current', 'Show the current plan (in_progress or next ready plan)')
  .option(
    '--next-ready <planId>',
    'Find and show the next ready dependency of the specified parent plan'
  )
  .option('--latest', 'Show the most recently updated plan')
  .option('--copy-details', 'Copy the plan details to the clipboard')
  .option('--full', 'Display full details without truncation')
  .option('-s, --short', 'Display a condensed summary view')
  .option('-w, --watch', 'Watch mode: re-print short output every 5 seconds')
  .action(async (planIdArg, options, command) => {
    const { handleShowCommand } = await import('./commands/show.js');
    const planId = parseOptionalPlanIdFromCliArg(planIdArg);
    if (options.nextReady !== undefined) {
      options.nextReady = parsePlanIdFromCliArg(options.nextReady);
    }
    await handleShowCommand(planId, options, command).catch(handleCommandError);
  });

program
  .command('show-config')
  .description('Print the effective configuration for the current directory as YAML')
  .action(async (options, command) => {
    const { handleShowConfigCommand } = await import('./commands/show-config.js');
    await handleShowConfigCommand(options, command).catch(handleCommandError);
  });

program
  .command('branch-name [planId]')
  .description('Generate a branch name from a plan.')
  .option('--next', 'Use the next plan that is ready to be implemented')
  .option('--current', 'Use the current plan (in_progress or next ready plan)')
  .option(
    '--next-ready <planId>',
    'Find and use the next ready dependency of the specified parent plan'
  )
  .option('--latest', 'Use the most recently updated plan')
  .action(async (planIdArg, options, command) => {
    const { handleBranchCommand } = await import('./commands/branch.js');
    const planId = parseOptionalPlanIdFromCliArg(planIdArg);
    if (options.nextReady !== undefined) {
      options.nextReady = parsePlanIdFromCliArg(options.nextReady);
    }
    await handleBranchCommand(planId, options, command).catch(handleCommandError);
  });

program
  .command('rebase [planId]')
  .description('Rebase a plan branch onto the latest main/trunk branch')
  .option('--current', 'Use the current plan')
  .option('--next', 'Use the next ready plan')
  .option('--base <branch>', 'Base branch to rebase onto instead of trunk')
  .option('-x, --executor <name>', 'Executor to use for conflict resolution')
  .option('-m, --model <model>', 'Model to use for conflict resolution')
  .option('--no-push', 'Skip pushing after rebase')
  .option('--no-terminal-input', 'Disable terminal input forwarding')
  .option('-w, --workspace <workspace>', 'Workspace to use')
  .option(
    '--aw, --auto-workspace',
    'Automatically select an available workspace or create a new one'
  )
  .option(
    '--nw, --new-workspace',
    'Allow creating a new workspace. When used with --workspace, creates a new workspace with the specified ID. When used with --auto-workspace, always creates a new workspace instead of reusing existing ones.'
  )
  .action(async (planIdArg, options, command) => {
    const { handleRebaseCommand } = await import('./commands/rebase.js');
    const planId = parseOptionalPlanIdFromCliArg(planIdArg);
    await handleRebaseCommand(planId, options, command).catch(handleCommandError);
  });

program
  .command('edit <planId>')
  .description('Open a plan in your editor.')
  .option('--editor <editor>', 'Editor to use (defaults to $EDITOR or nano)')
  .action(async (planIdArg, options, command) => {
    const { handleEditCommand } = await import('./commands/edit.js');
    const planId = parsePlanIdFromCliArg(planIdArg);
    await handleEditCommand(planId, options, command).catch(handleCommandError);
  });

const assignmentsCommand = program
  .command('assignments')
  .description('Inspect and manage shared plan assignments');

assignmentsCommand
  .command('claim <planId>')
  .description('Assign a plan to the current workspace (and optionally user)')
  .action(async (planIdArg, options, command) => {
    const { handleClaimCommand } = await import('./commands/claim.js');
    const planId = parsePlanIdFromCliArg(planIdArg);
    await handleClaimCommand(planId, options, command).catch(handleCommandError);
  });

assignmentsCommand
  .command('release <planId>')
  .description('Release a plan assignment from the current workspace')
  .option('--reset-status', 'Reset plan status to pending')
  .action(async (planIdArg, options, command) => {
    const { handleReleaseCommand } = await import('./commands/release.js');
    const planId = parsePlanIdFromCliArg(planIdArg);
    await handleReleaseCommand(planId, options, command).catch(handleCommandError);
  });

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
  .option('--from <id>', 'Plan ID to renumber (use with --to)', parsePlanIdFromCliArg)
  .option('--to <id>', 'Target ID to renumber to (use with --from)', parsePlanIdFromCliArg)
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
  .command('add-task <planId>')
  .description('Add a task to an existing plan')
  .option('--title <title>', 'Task title')
  .option('--description <desc>', 'Task description')
  .option('--editor', 'Open editor for description')
  .option('--files <files...>', 'Related files')
  .option('--docs <docs...>', 'Documentation paths')
  .option('--interactive', 'Prompt for all fields interactively')
  .action(async (planIdArg, options, command) => {
    const { handleAddTaskCommand } = await import('./commands/add-task.js');
    const planId = parsePlanIdFromCliArg(planIdArg);
    await handleAddTaskCommand(planId, options, command).catch(handleCommandError);
  });

program
  .command('remove <planIds...>')
  .description('Remove one or more plans and clean up references')
  .option('-f, --force', 'Force removal even if other plans depend on this one')
  .action(async (planIdArgs, options, command) => {
    const { handleRemoveCommand } = await import('./commands/remove.js');
    const planIds = planIdArgs.map((planIdArg: string) => parsePlanIdFromCliArg(planIdArg));
    await handleRemoveCommand(planIds, options, command).catch(handleCommandError);
  });

program
  .command('remove-task <planId>')
  .description('Remove a task from a plan')
  .option('--index <index>', 'Task index (1-based)', (val: string) => {
    const n = parseInt(val, 10);
    if (Number.isNaN(n) || n < 1) {
      throw new Error(`Task index must be a positive integer (1-based), saw ${val}`);
    }
    return n - 1; // Convert to 0-based for internal use
  })
  .option('--title <title>', 'Find task by title (partial match)')
  .option('--interactive', 'Select task interactively')
  .action(async (planIdArg, options, command) => {
    const { handleRemoveTaskCommand } = await import('./commands/remove-task.js');
    const planId = parsePlanIdFromCliArg(planIdArg);
    await handleRemoveTaskCommand(planId, options, command).catch(handleCommandError);
  });

program
  .command('set <planId>')
  .description('Update plan properties like priority, status, note, dependencies, and rmfilter.')
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
  .option('--discovered-from <planId>', 'Set the plan this was discovered from')
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
  .option('--simple', 'Mark the plan as simple')
  .option('--no-simple', 'Mark the plan as not simple')
  .option('--note <text>', 'Replace the note field with the given text')
  .option('--base-branch <branch>', 'Set the base branch for stacked PRs')
  .option('--no-base-branch', 'Remove the base branch and all base tracking fields')
  .option('--base-commit <hash>', 'Set the base commit hash')
  .option('--no-base-commit', 'Remove the base commit')
  .option('--base-change-id <id>', 'Set the JJ base change ID')
  .option('--no-base-change-id', 'Remove the JJ base change ID')
  .option('--details <text>', 'Replace the entire details field with the given text')
  .action(async (planIdArg, options, command) => {
    const { handleSetCommand } = await import('./commands/set.js');
    const planId = parsePlanIdFromCliArg(planIdArg);
    const rawArgs = command.rawArgs ?? [];
    const sourceArgs =
      command.parent?.rawArgs && command.parent.rawArgs.length > 0
        ? command.parent.rawArgs
        : rawArgs;
    const hasFlag = (flag: string, alias?: string) =>
      sourceArgs.some(
        (arg: string) =>
          arg === flag || (alias !== undefined && arg === alias) || arg.startsWith(`${flag}=`)
      ) ||
      (alias !== undefined && sourceArgs.some((arg: string) => arg.startsWith(`${alias}=`)));
    const parsedDependsOn = parsePlanIdOption(options.dependsOn);
    const parsedNoDependsOn = parsePlanIdOption(options.noDependsOn);
    const parsedIssue = options.issue;
    const parsedNoIssue = options.noIssue;
    const parsedDoc = options.doc;
    const parsedNoDoc = options.noDoc;
    const parsedTag = options.tag;
    const parsedNoTag = options.noTag;
    const isRemovingDependsOn = hasFlag('--no-depends-on', '--no-d');
    const isRemovingIssue = hasFlag('--no-issue', '--no-i');
    const isRemovingDoc = hasFlag('--no-doc');
    const isRemovingTag = hasFlag('--no-tag');

    if (isRemovingDependsOn) {
      options.noDependsOn = parsedDependsOn ?? parsedNoDependsOn;
      options.dependsOn = undefined;
    } else {
      options.dependsOn = parsedDependsOn;
    }

    if (isRemovingIssue) {
      options.noIssue = parsedIssue ?? parsedNoIssue;
      options.issue = undefined;
    } else {
      options.noIssue = parsedNoIssue;
    }

    if (isRemovingDoc) {
      options.noDoc = parsedDoc ?? parsedNoDoc;
      options.doc = undefined;
    } else {
      options.noDoc = parsedNoDoc;
    }

    if (isRemovingTag) {
      options.noTag = parsedTag ?? parsedNoTag;
      options.tag = undefined;
    } else {
      options.noTag = parsedNoTag;
    }

    options.parent = parsePlanIdOption(options.parent);
    options.discoveredFrom = parsePlanIdOption(options.discoveredFrom);
    if (options.baseBranch === false) {
      options.noBaseBranch = true;
      options.baseBranch = undefined;
    }
    if (options.baseCommit === false) {
      options.noBaseCommit = true;
      options.baseCommit = undefined;
    }
    if (options.baseChangeId === false) {
      options.noBaseChangeId = true;
      options.baseChangeId = undefined;
    }
    await handleSetCommand(planId, options, command.parent.opts()).catch(handleCommandError);
  });

program
  .command('review [planId]')
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
  .option('--input <text>', 'Additional context from the orchestrator (appended to instructions)')
  .option(
    '--input-file <paths...>',
    'Read additional context from file(s) (use "-" to read from stdin). Appended to instructions.'
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
  .option(
    '--issues',
    'Act on previously saved unresolved review issues instead of running a new review.'
  )
  .option(
    '--save-issues',
    'Save review issues to the plan file in non-interactive mode (e.g. with --print).'
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
  .action(async (planIdArg, options, command) => {
    const { handleReviewCommand } = await import('./commands/review.js');
    const planId = parseOptionalPlanIdFromCliArg(planIdArg);
    await runWithCommandTunnelAdapter(async () => {
      await handleReviewCommand(planId, options, command);
    }).catch(handleCommandError);
  });

const prCommand = program.command('pr').description('GitHub PR commands');

prCommand
  .command('status [planId]')
  .description('Fetch and display GitHub PR status for a plan')
  .option('--force-refresh', 'Bypass webhooks and fetch directly from GitHub API')
  .action(async (planIdArg, options, command) => {
    const { handlePrStatusCommand } = await import('./commands/pr.js');
    const planId = parseOptionalPlanIdFromCliArg(planIdArg);
    await handlePrStatusCommand(planId, options, command).catch(handleCommandError);
  });

prCommand
  .command('link <planId> [prUrlOrBranch]')
  .description('Link a GitHub PR to a plan (accepts PR URL, branch name, or auto-detects)')
  .action(async (planIdArg, prUrl, options, command) => {
    const { handlePrLinkCommand } = await import('./commands/pr.js');
    const planId = parsePlanIdFromCliArg(planIdArg);
    await handlePrLinkCommand(planId, prUrl, options, command).catch(handleCommandError);
  });

prCommand
  .command('unlink <planId> <prUrl>')
  .description('Unlink a GitHub PR from a plan ')
  .action(async (planIdArg, prUrl, options, command) => {
    const { handlePrUnlinkCommand } = await import('./commands/pr.js');
    const planId = parsePlanIdFromCliArg(planIdArg);
    await handlePrUnlinkCommand(planId, prUrl, options, command).catch(handleCommandError);
  });

prCommand
  .command('reply <threadId> <body...>')
  .description('Reply to a GitHub PR review thread')
  .action(async (threadId, body) => {
    const { handlePrReplyCommand } = await import('./commands/pr.js');
    await handlePrReplyCommand(threadId, body.join(' ')).catch(handleCommandError);
  });

prCommand
  .command('resolve <threadId>')
  .description('Resolve a GitHub PR review thread')
  .action(async (threadId) => {
    const { handlePrResolveCommand } = await import('./commands/pr.js');
    await handlePrResolveCommand(threadId).catch(handleCommandError);
  });

prCommand
  .command('create <planId>')
  .description('Create or update a draft PR for a plan using an AI agent')
  .option('-x, --executor <name>', 'The executor to use')
  .option('-m, --model <model>', 'Model override (default: haiku)')
  .option('--aw, --auto-workspace', 'Auto-select or create a workspace')
  .option('-w, --workspace <name>', 'Use a specific workspace')
  .option('--no-terminal-input', 'Disable terminal input')
  .option('--non-interactive', 'No user prompts')
  .action(async (planIdArg, options, command) => {
    const { handleCreatePrCommand } = await import('./commands/create_pr.js');
    const planId = parsePlanIdFromCliArg(planIdArg);
    await handleCreatePrCommand(planId, options, command).catch(handleCommandError);
  });

prCommand
  .command('fix <planId>')
  .description('Fix unresolved PR review threads using an AI agent')
  .option('-x, --executor <name>', 'The executor to use')
  .option('-m, --model <model>', 'Model override')
  .option('--all', 'Fix all unresolved threads without prompting')
  .option('--aw, --auto-workspace', 'Auto-select or create a workspace')
  .option('--non-interactive', 'No user prompts')
  .option('--no-terminal-input', 'Disable terminal input')
  .action(async (planIdArg, options, command) => {
    const { handlePrFixCommand } = await import('./commands/pr.js');
    const planId = parsePlanIdFromCliArg(planIdArg);
    await handlePrFixCommand(planId, options, command).catch(handleCommandError);
  });

const prReviewGuideCommand = prCommand
  .command('review-guide [pr-url-or-number]')
  .description('Run standalone AI review on any PR')
  .option('--plan <id>', 'Resolve PR from a plan-linked pull request')
  .option('-x, --executor <name>', 'Run with a single executor (claude-code or codex-cli)')
  .option('--aw, --auto-workspace', 'Auto-select or create a workspace')
  .option('-m, --model <model>', 'Model override for executors')
  .option('--no-terminal-input', 'Disable terminal input')
  .option('--non-interactive', 'No user prompts')
  .option('--verbose', 'Verbose output')
  .action(async (prUrlOrNumber, options, command) => {
    if (options.plan !== undefined) {
      options.plan = parsePlanIdFromCliArg(options.plan);
    }
    await runWithCommandTunnelAdapter(async () => {
      const { handleReviewGuideCommand } = await import('./commands/review_pr.js');
      await handleReviewGuideCommand(prUrlOrNumber, options, command);
    }).catch(handleCommandError);
  });

prReviewGuideCommand
  .command('materialize <pr-url-or-number>')
  .description('Materialize the latest stored standalone PR review into .tim/reviews/')
  .action(async (prUrlOrNumber, options, command) => {
    await runWithCommandTunnelAdapter(async () => {
      const { handleMaterializeCommand } = await import('./commands/review_pr.js');
      await handleMaterializeCommand(prUrlOrNumber, options, command);
    }).catch(handleCommandError);
  });

function registerPrDescriptionCommand(
  targetCommand: Command,
  signature: string,
  hidden = false
): void {
  const descriptionCommand = hidden
    ? targetCommand.command(signature, { hidden: true })
    : targetCommand.command(signature);

  descriptionCommand
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
    .action(async (planIdArg, options, command) => {
      const { handleDescriptionCommand } = await import('./commands/description.js');
      const planId = parsePlanIdFromCliArg(planIdArg);
      const rootParent = command.parent?.parent ?? command.parent;
      await handleDescriptionCommand(planId, options, {
        ...command,
        parent: rootParent,
      }).catch(handleCommandError);
    });
}

registerPrDescriptionCommand(prCommand, 'description <planId>');
registerPrDescriptionCommand(program, 'pr-description <planId>', true);

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
  .command('add [planId]')
  .description('Create a new workspace, optionally linked to a plan or issue')
  .option('--id <workspaceId>', 'Specify a custom workspace ID')
  .option('--issue <issueId>', 'Import a GitHub/Linear issue as a new plan in the workspace')
  .option('--clone-method <method>', 'Clone method: git, cp, or mac-cow (overrides config)')
  .option('--source-dir <path>', 'Source directory for cp/mac-cow methods (overrides config)')
  .option('--repo-url <url>', 'Repository URL for git method (overrides config)')
  .option('--create-branch', 'Create a new branch for the workspace')
  .option('--no-create-branch', 'Do not create a new branch (default)')
  .option('--primary', 'Mark the new workspace as primary')
  .option('--auto', 'Mark the new workspace as auto-selectable')
  .option('--reuse', 'Reuse an existing unlocked workspace (fails if none available)')
  .option('--try-reuse', 'Try to reuse an existing workspace, create new if unavailable')
  .option('--from-branch <branch>', 'Create new branch from this base instead of main/master')
  .option(
    '--target-dir <path>',
    'Target directory name or path (relative to cloneLocation or absolute)'
  )
  .action(async (planIdArg, options, command) => {
    if (options.reuse && options.tryReuse) {
      console.error('Error: Cannot use both --reuse and --try-reuse');
      process.exit(1);
    }
    const { handleWorkspaceAddCommand } = await import('./commands/workspace.js');
    const planId = parseOptionalPlanIdFromCliArg(planIdArg);
    await handleWorkspaceAddCommand(planId, options, command).catch(handleCommandError);
  });

workspaceCommand
  .command('register [path]')
  .description('Register an existing directory as a workspace')
  .option('--name <name>', 'Set a name for the workspace (also used as task ID)')
  .option('--primary', 'Mark the workspace as primary')
  .option('--auto', 'Mark the workspace as auto-selectable')
  .action(async (target, options, command) => {
    const { handleWorkspaceRegisterCommand } = await import('./commands/workspace.js');
    await handleWorkspaceRegisterCommand(target, options, command).catch(handleCommandError);
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
  .option('--from-plan <planId>', 'Seed description from plan. Only sets description, not name.')
  .option(
    '--primary',
    'Mark this workspace as primary (used as the primary sync/push target and excluded from auto-selection)'
  )
  .option('--no-primary', 'Set this workspace type back to standard')
  .option('--auto', 'Mark this workspace as auto-selectable')
  .option('--no-auto', 'Set this workspace type back to standard')
  .action(async (workspaceIdentifier, options, command) => {
    const { handleWorkspaceUpdateCommand } = await import('./commands/workspace.js');
    if (options.fromPlan !== undefined) {
      options.fromPlan = parsePlanIdFromCliArg(options.fromPlan);
    }
    await handleWorkspaceUpdateCommand(workspaceIdentifier, options, command).catch(
      handleCommandError
    );
  });

workspaceCommand
  .command('push [workspaceIdentifier]')
  .description('Push a branch/bookmark between workspaces')
  .option('--from <workspace>', 'Source workspace task ID or path (defaults to current)')
  .option(
    '--to <workspace>',
    'Destination workspace task ID or path (defaults to positional/primary)'
  )
  .option('--branch <branch>', 'Branch/bookmark to push (defaults to current source branch)')
  .action(async (workspaceIdentifier, options, command) => {
    const { handleWorkspacePushCommand } = await import('./commands/workspace.js');
    await handleWorkspacePushCommand(workspaceIdentifier, options, command).catch(
      handleCommandError
    );
  });

workspaceCommand
  .command('pull-plan <planId>')
  .description('Fetch and check out a plan branch/bookmark if it exists')
  .option('--workspace <workspace>', 'Workspace task ID or path (defaults to current workspace)')
  .option('--branch <branch>', 'Branch/bookmark override (defaults to plan branch)')
  .option('--remote <remote>', 'Remote name to fetch from (default: origin)')
  .action(async (planIdArg, options, command) => {
    const { handleWorkspacePullPlanCommand } = await import('./commands/workspace.js');
    const planId = parsePlanIdFromCliArg(planIdArg);
    await handleWorkspacePullPlanCommand(planId, options, command).catch(handleCommandError);
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
    .command(`${agentType} <planId>`)
    .description(`Run the ${agentType} subagent`)
    .addOption(
      new Option('-x, --executor <name>', 'Executor to use: codex-cli or claude-code')
        .choices(['codex-cli', 'claude-code'])
        .default('claude-code')
    )
    .option('-m, --model <model>', 'Model to use')
    .option('--input <text>', 'Additional instructions from orchestrator')
    .option(
      '--input-file <paths...>',
      'Read additional instructions from file (use "-" to read from stdin)'
    )
    .option('--output-file <path>', 'Write the final subagent message to a file')
    .action(async (planIdArg: string, options: any, command: any) => {
      const { handleSubagentCommand } = await import('./commands/subagent.js');
      const planId = parsePlanIdFromCliArg(planIdArg);
      await runWithCommandTunnelAdapter(async () => {
        await handleSubagentCommand(agentType, planId, options, command.parent.parent.opts());
      }).catch(handleCommandError);
    });
}

async function run() {
  installStdinDebugTracing();
  await loadEnv();
  enableAutoClaim();

  // Set up signal handlers for cleanup
  registerShutdownSignalHandlers();

  await program.parseAsync(process.argv);
}

if (import.meta.main) {
  run().catch(handleCommandError);
}
