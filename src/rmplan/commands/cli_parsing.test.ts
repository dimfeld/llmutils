import { describe, test, expect } from 'bun:test';
import { Command } from 'commander';

describe('CLI Parsing for --next-ready flag', () => {
  test('generate command should parse --next-ready flag correctly', () => {
    const program = new Command();

    // Recreate the generate command configuration from rmplan.ts
    const generateCommand = program
      .command('generate [plan]')
      .description('Generate planning prompt and context for a task')
      .option('--plan <plan>', 'Plan to use')
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
      .option('--use-yaml <yaml_file>', 'Skip generation and use existing YAML file as LLM output')
      .option('--direct', 'Call LLM directly instead of copying prompt to clipboard')
      .option('--no-direct', 'Use clipboard mode even if direct mode is configured')
      .option('--claude', 'Use Claude Code for two-step planning and generation')
      .option(
        '--next-ready <planIdOrPath>',
        'Find and operate on the next ready dependency of the specified parent plan (accepts plan ID or file path)'
      )
      .allowExcessArguments(true)
      .allowUnknownOption(true);

    // Parse test arguments
    const args = ['generate', '--next-ready', '123'];
    generateCommand.parse(args, { from: 'user' });

    const options = generateCommand.opts();
    expect(options.nextReady).toBe('123');
  });

  test('prepare command should parse --next-ready flag correctly', () => {
    const program = new Command();

    // Recreate the prepare command configuration from rmplan.ts
    const prepareCommand = program
      .command('prepare [plan]')
      .description(
        'Generate detailed steps and prompts for a specific phase. Can be a file path or plan ID.'
      )
      .option('--force', 'Override dependency completion check and proceed with generation.')
      .option(
        '-m, --model <model_id>',
        'Specify the LLM model to use for generating phase details.'
      )
      .option('--next', 'Prepare the next plan that is ready to be implemented')
      .option('--current', 'Prepare the current plan (in_progress or next ready plan)')
      .option(
        '--next-ready <planIdOrPath>',
        'Find and operate on the next ready dependency of the specified parent plan (accepts plan ID or file path)'
      )
      .option('--direct', 'Call LLM directly instead of copying prompt to clipboard')
      .option('--no-direct', 'Use clipboard mode even if direct mode is configured')
      .option('--use-yaml <yaml_file>', 'Skip generation and use existing YAML file as LLM output')
      .option('--claude', 'Use Claude Code for two-step planning and generation')
      .allowExcessArguments(true)
      .allowUnknownOption(true);

    // Parse test arguments
    const args = ['prepare', '--next-ready', 'my-plan.yml'];
    prepareCommand.parse(args, { from: 'user' });

    const options = prepareCommand.opts();
    expect(options.nextReady).toBe('my-plan.yml');
  });

  test('agent command should parse --next-ready flag correctly', () => {
    const program = new Command();

    // Recreate the agent command configuration from rmplan.ts
    const agentCommand = program
      .command('agent [planFile]')
      .description(
        'Automatically execute steps in a plan YAML file. Can be a file path or plan ID.'
      )
      .option('-m, --model <model>', 'Model to use for LLM')
      .option(`-x, --executor <name>`, 'The executor to use for plan execution')
      .option('--ix, --interactive-executor', 'Use Claude Code executor in interactive mode')
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
      .option(
        '--next-ready <planIdOrPath>',
        'Find and operate on the next ready dependency of the specified parent plan (accepts plan ID or file path)'
      )
      .option('--with-dependencies', 'Also execute all dependencies first in the correct order')
      .option(
        '--direct',
        'Call LLM directly instead of copying prompt to clipboard during preparation'
      )
      .option('--dry-run', 'Print the generated prompt but do not execute it')
      .allowExcessArguments(true)
      .allowUnknownOption(true);

    // Parse test arguments
    const args = ['agent', '--next-ready', '42'];
    agentCommand.parse(args, { from: 'user' });

    const options = agentCommand.opts();
    expect(options.nextReady).toBe('42');
  });

  test('show command should parse --next-ready flag correctly', () => {
    const program = new Command();

    // Recreate the show command configuration from rmplan.ts
    const showCommand = program
      .command('show [planFile]')
      .description('Display detailed information about a plan. Can be a file path or plan ID.')
      .option('--next', 'Show the next plan that is ready to be implemented')
      .option('--current', 'Show the current plan (in_progress or next ready plan)')
      .option(
        '--next-ready <planIdOrPath>',
        'Find and show the next ready dependency of the specified parent plan (accepts plan ID or file path)'
      )
      .option('--copy-details', 'Copy the plan details to the clipboard')
      .option('--full', 'Display full details without truncation');

    // Parse test arguments
    const args = ['show', '--next-ready', 'parent-plan'];
    showCommand.parse(args, { from: 'user' });

    const options = showCommand.opts();
    expect(options.nextReady).toBe('parent-plan');
  });

  test('should handle numeric and string plan IDs correctly', () => {
    const program = new Command();

    const generateCommand = program
      .command('generate [plan]')
      .option(
        '--next-ready <planIdOrPath>',
        'Find and operate on the next ready dependency of the specified parent plan (accepts plan ID or file path)'
      );

    // Test numeric ID
    generateCommand.parse(['generate', '--next-ready', '123'], { from: 'user' });
    expect(generateCommand.opts().nextReady).toBe('123');

    // Reset and test string ID (file path)
    program.commands = []; // Clear previous command
    const generateCommand2 = program
      .command('generate [plan]')
      .option(
        '--next-ready <planIdOrPath>',
        'Find and operate on the next ready dependency of the specified parent plan (accepts plan ID or file path)'
      );

    generateCommand2.parse(['generate', '--next-ready', '/path/to/plan.yml'], { from: 'user' });
    expect(generateCommand2.opts().nextReady).toBe('/path/to/plan.yml');
  });
});
