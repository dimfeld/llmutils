import type { ParsedCommand, ExecutionContext } from '../types.js';

export type CommandType = 'tool' | 'workflow' | 'query' | 'config' | 'help';

export interface CommandCondition {
  type: 'if_exists' | 'if_not_exists' | 'if_success' | 'if_failure';
  target: string;
  value?: any;
}

export interface EnhancedCommand extends ParsedCommand {
  type: CommandType;
  subcommands?: EnhancedCommand[];
  conditions?: CommandCondition[];
  branch?: string;
  issueNumber?: number;
  prNumber?: number;
}

export interface CommandDefinition {
  name: string;
  type: CommandType;
  description: string;
  args?: CommandArgument[];
  options?: Record<string, CommandOption>;
  aliases?: string[];
  examples?: string[];
  requiresAuth?: boolean;
  requiresWorkspace?: boolean;
}

export interface CommandArgument {
  name: string;
  type: string;
  description: string;
  required?: boolean;
  default?: any;
}

export interface CommandOption {
  type?: string;
  description: string;
  short?: string;
  default?: any;
}

export interface CommandValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export interface CommandHistory {
  id: string;
  command: EnhancedCommand;
  executedBy: string;
  executedAt: Date;
  workflowId?: string;
  result: 'success' | 'failure' | 'cancelled';
  duration: number;
  output?: string;
  error?: string;
}

export interface CommandExecution {
  command: EnhancedCommand;
  branch: string;
  startedAt: Date;
  status: 'queued' | 'running' | 'completed' | 'failed';
  workflowId?: string;
}

export abstract class CommandHandler {
  abstract readonly definition: CommandDefinition;

  abstract execute(command: EnhancedCommand, context: ExecutionContext): Promise<void>;

  async validate(command: EnhancedCommand): Promise<CommandValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Validate required arguments
    if (this.definition.args) {
      for (const arg of this.definition.args) {
        if (arg.required && !command.args.includes(arg.name)) {
          errors.push(`Missing required argument: ${arg.name}`);
        }
      }
    }

    // Validate options
    if (this.definition.options) {
      for (const [key, value] of Object.entries(command.options)) {
        if (!this.definition.options[key]) {
          warnings.push(`Unknown option: ${key}`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  formatHelp(): string {
    const lines: string[] = [];

    lines.push(`**${this.definition.name}** - ${this.definition.description}`);
    lines.push('');

    if (this.definition.args && this.definition.args.length > 0) {
      lines.push('**Arguments:**');
      for (const arg of this.definition.args) {
        const required = arg.required ? ' (required)' : '';
        lines.push(`  ${arg.name} - ${arg.description}${required}`);
      }
      lines.push('');
    }

    if (this.definition.options && Object.keys(this.definition.options).length > 0) {
      lines.push('**Options:**');
      for (const [key, option] of Object.entries(this.definition.options)) {
        const shortFlag = option.short ? `-${option.short}, ` : '';
        lines.push(`  ${shortFlag}--${key} - ${option.description}`);
      }
      lines.push('');
    }

    if (this.definition.examples && this.definition.examples.length > 0) {
      lines.push('**Examples:**');
      for (const example of this.definition.examples) {
        lines.push(`  ${example}`);
      }
    }

    return lines.join('\n');
  }
}

export class CommandError extends Error {
  constructor(
    message: string,
    public code: string = 'COMMAND_ERROR',
    public details?: any
  ) {
    super(message);
    this.name = 'CommandError';
  }
}
