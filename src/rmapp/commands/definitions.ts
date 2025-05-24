import type { CommandDefinition } from './types.js';

export const WORKFLOW_COMMANDS: Record<string, CommandDefinition> = {
  implement: {
    name: 'implement',
    type: 'workflow',
    description: 'Implement an issue end-to-end',
    args: [
      {
        name: 'issue',
        type: 'number | string',
        description: 'Issue number or URL',
        required: true,
      },
    ],
    options: {
      plan: {
        type: 'string',
        description: 'Path to existing plan (optional)',
      },
      branch: {
        type: 'string',
        description: 'Branch name (auto-generated if not provided)',
      },
      'no-pr': {
        type: 'boolean',
        description: 'Skip PR creation',
      },
      model: {
        type: 'string',
        description: 'Model to use for implementation',
        default: 'claude-3-5-sonnet-20241022',
      },
    },
    examples: [
      '@bot implement #123',
      '@bot implement #456 --branch feature/new-api',
      '@bot implement https://github.com/owner/repo/issues/789',
    ],
    requiresWorkspace: true,
  },

  'apply-review': {
    name: 'apply-review',
    type: 'workflow',
    description: 'Apply changes from a review comment',
    args: [
      {
        name: 'comment',
        type: 'number | string',
        description: 'Comment ID or URL',
        required: true,
      },
    ],
    options: {
      'auto-commit': {
        type: 'boolean',
        description: 'Commit immediately',
        default: true,
      },
      batch: {
        type: 'boolean',
        description: 'Batch with other review comments',
      },
    },
    aliases: ['apply', 'fix-review'],
    examples: ['@bot apply-review 123456789', '@bot apply-review --no-auto-commit'],
    requiresWorkspace: true,
  },

  status: {
    name: 'status',
    type: 'query',
    description: 'Show status of active workflows',
    options: {
      verbose: {
        type: 'boolean',
        description: 'Show detailed status',
        short: 'v',
      },
      json: {
        type: 'boolean',
        description: 'Output as JSON',
      },
      'workflow-id': {
        type: 'string',
        description: 'Show status of specific workflow',
      },
    },
    examples: ['@bot status', '@bot status --verbose', '@bot status --workflow-id abc123'],
  },

  cancel: {
    name: 'cancel',
    type: 'workflow',
    description: 'Cancel an active workflow',
    args: [
      {
        name: 'workflow-id',
        type: 'string',
        description: 'Workflow ID to cancel',
        required: true,
      },
    ],
    options: {
      reason: {
        type: 'string',
        description: 'Reason for cancellation',
      },
    },
    examples: ['@bot cancel abc123', '@bot cancel abc123 --reason "No longer needed"'],
  },

  retry: {
    name: 'retry',
    type: 'workflow',
    description: 'Retry a failed workflow',
    args: [
      {
        name: 'workflow-id',
        type: 'string',
        description: 'Workflow ID to retry',
        required: true,
      },
    ],
    options: {
      'from-step': {
        type: 'string',
        description: 'Step to retry from',
      },
    },
    examples: ['@bot retry abc123', '@bot retry abc123 --from-step implementing'],
  },
};

export const TOOL_COMMANDS: Record<string, CommandDefinition> = {
  rmfilter: {
    name: 'rmfilter',
    type: 'tool',
    description: 'Run rmfilter to prepare context',
    args: [
      {
        name: 'files',
        type: 'string[]',
        description: 'Files to filter',
        required: false,
      },
    ],
    options: {
      instructions: {
        type: 'string',
        description: 'Instructions for the LLM',
        short: 'i',
      },
      'with-imports': {
        type: 'boolean',
        description: 'Include imported files',
      },
      'with-all-imports': {
        type: 'boolean',
        description: 'Include all transitive imports',
      },
    },
    examples: [
      '@bot rmfilter src/**/*.ts --instructions "Fix the bug"',
      '@bot rmfilter --with-imports -- src/main.ts',
    ],
  },

  rmplan: {
    name: 'rmplan',
    type: 'tool',
    description: 'Run rmplan commands',
    args: [
      {
        name: 'subcommand',
        type: 'string',
        description: 'Rmplan subcommand (generate, next, done, etc.)',
        required: true,
      },
    ],
    examples: ['@bot rmplan generate', '@bot rmplan next', '@bot rmplan done'],
  },

  rmrun: {
    name: 'rmrun',
    type: 'tool',
    description: 'Run rmfilter and pipe output to LLM',
    args: [
      {
        name: 'files',
        type: 'string[]',
        description: 'Files to filter and process',
        required: false,
      },
    ],
    options: {
      model: {
        type: 'string',
        description: 'Model to use for processing',
        default: 'claude-3-5-sonnet-20241022',
      },
      instructions: {
        type: 'string',
        description: 'Instructions for the LLM',
        short: 'i',
      },
      'with-imports': {
        type: 'boolean',
        description: 'Include imported files',
      },
      'with-all-imports': {
        type: 'boolean',
        description: 'Include all transitive imports',
      },
    },
    examples: [
      '@bot rmrun src/**/*.ts --instructions "Fix the bug"',
      '@bot rmrun --model gpt-4 -- src/main.ts',
    ],
  },
};

export const HELP_COMMAND: CommandDefinition = {
  name: 'help',
  type: 'help',
  description: 'Show help information',
  args: [
    {
      name: 'command',
      type: 'string',
      description: 'Command to get help for',
      required: false,
    },
  ],
  options: {
    examples: {
      type: 'boolean',
      description: 'Show usage examples',
    },
    all: {
      type: 'boolean',
      description: 'Show all commands including aliases',
    },
  },
  examples: ['@bot help', '@bot help implement', '@bot help --examples'],
};

export const ALL_COMMANDS: Record<string, CommandDefinition> = {
  ...WORKFLOW_COMMANDS,
  ...TOOL_COMMANDS,
  help: HELP_COMMAND,
};

// Build command aliases map
export const COMMAND_ALIASES: Map<string, string> = new Map();
for (const [name, def] of Object.entries(ALL_COMMANDS)) {
  if (def.aliases) {
    for (const alias of def.aliases) {
      COMMAND_ALIASES.set(alias, name);
    }
  }
}
