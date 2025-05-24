import type { EnhancedCommand, CommandValidationResult } from './types.js';
import { ALL_COMMANDS } from './definitions.js';

export class CommandValidator {
  validate(command: EnhancedCommand): CommandValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check if command exists
    const definition = ALL_COMMANDS[command.command];
    if (!definition) {
      errors.push(`Unknown command: ${command.command}`);
      return { valid: false, errors, warnings };
    }

    // Validate required arguments
    if (definition.args) {
      let providedArgCount = command.args.length;

      // Count required arguments
      const requiredArgs = definition.args.filter((arg) => arg.required);
      const optionalArgs = definition.args.filter((arg) => !arg.required);

      if (providedArgCount < requiredArgs.length) {
        errors.push(
          `Missing required arguments. Expected at least ${requiredArgs.length}, got ${providedArgCount}`
        );
        requiredArgs.slice(providedArgCount).forEach((arg) => {
          errors.push(`  Missing: ${arg.name} - ${arg.description}`);
        });
      }

      if (providedArgCount > definition.args.length) {
        warnings.push(
          `Too many arguments. Expected at most ${definition.args.length}, got ${providedArgCount}`
        );
      }
    }

    // Validate options
    for (const [key, value] of Object.entries(command.options)) {
      const optionDef = definition.options?.[key];
      if (!optionDef) {
        warnings.push(`Unknown option: --${key}`);
        continue;
      }

      // Type validation
      if (optionDef.type === 'boolean' && typeof value !== 'boolean') {
        warnings.push(`Option --${key} should be a boolean flag`);
      } else if (optionDef.type === 'number' && typeof value === 'string') {
        const num = parseInt(value, 10);
        if (isNaN(num)) {
          errors.push(`Option --${key} should be a number, got: ${value}`);
        }
      }
    }

    // Validate specific command requirements
    this.validateSpecificCommand(command, definition, errors, warnings);

    // Validate subcommands recursively
    if (command.subcommands) {
      for (const subcommand of command.subcommands) {
        const subResult = this.validate(subcommand);
        errors.push(...subResult.errors.map((e) => `In subcommand: ${e}`));
        warnings.push(...subResult.warnings.map((w) => `In subcommand: ${w}`));
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  private validateSpecificCommand(
    command: EnhancedCommand,
    definition: any,
    errors: string[],
    warnings: string[]
  ): void {
    switch (command.command) {
      case 'implement':
        if (!command.issueNumber && !command.args[0]) {
          errors.push('Issue number or reference required');
        }
        break;

      case 'apply-review':
        if (!command.args[0]) {
          errors.push('Review comment ID or URL required');
        }
        break;

      case 'cancel':
      case 'retry':
        if (!command.args[0]) {
          errors.push('Workflow ID required');
        }
        break;

      case 'rmplan':
        const validSubcommands = ['generate', 'next', 'done', 'extract', 'status'];
        if (command.args[0] && !validSubcommands.includes(command.args[0])) {
          warnings.push(
            `Unknown rmplan subcommand: ${command.args[0]}. Valid: ${validSubcommands.join(', ')}`
          );
        }
        break;
    }

    // Validate branch conflicts
    if (command.branch && command.type === 'workflow') {
      // This will be checked by the queue system
    }
  }
}
