import type { EnhancedCommand, CommandHandler } from './types.js';
import type { ExecutionContext } from '../types.js';
import { CommandError } from './types.js';
import { CommandValidator } from './validator.js';
import { log } from '../../logging.js';

export class CommandRouter {
  private handlers = new Map<string, CommandHandler>();
  private validator = new CommandValidator();

  register(command: string, handler: CommandHandler): void {
    this.handlers.set(command, handler);
    log(`Registered handler for command: ${command}`);
  }

  async route(command: EnhancedCommand, context: ExecutionContext): Promise<void> {
    // Validate command first
    const validation = this.validator.validate(command);

    if (!validation.valid) {
      const errorMessage = `Command validation failed:\n${validation.errors.join('\n')}`;
      throw new CommandError(errorMessage, 'VALIDATION_ERROR', { validation });
    }

    if (validation.warnings.length > 0) {
      log(`Command warnings:\n${validation.warnings.join('\n')}`);
    }

    // Find handler
    const handler = this.handlers.get(command.command);
    if (!handler) {
      throw new CommandError(
        `No handler registered for command: ${command.command}`,
        'HANDLER_NOT_FOUND'
      );
    }

    // Execute handler
    try {
      await handler.execute(command, context);
    } catch (error) {
      if (error instanceof CommandError) {
        throw error;
      }
      throw new CommandError(
        `Command execution failed: ${error instanceof Error ? error.message : String(error)}`,
        'EXECUTION_ERROR',
        { originalError: error }
      );
    }
  }

  async routeWithSubcommands(command: EnhancedCommand, context: ExecutionContext): Promise<void> {
    // Execute main command
    await this.route(command, context);

    // Execute subcommands if any
    if (command.subcommands && command.subcommands.length > 0) {
      for (const subcommand of command.subcommands) {
        log(`Executing subcommand: ${subcommand.command}`);
        await this.routeWithSubcommands(subcommand, context);
      }
    }
  }

  getHandler(command: string): CommandHandler | undefined {
    return this.handlers.get(command);
  }

  getRegisteredCommands(): string[] {
    return Array.from(this.handlers.keys());
  }
}
