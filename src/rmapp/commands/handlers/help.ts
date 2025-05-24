import { CommandHandler, type EnhancedCommand, type CommandDefinition } from '../types.js';
import type { ExecutionContext } from '../../types.js';
import { HELP_COMMAND, ALL_COMMANDS, WORKFLOW_COMMANDS, TOOL_COMMANDS } from '../definitions.js';

export class HelpHandler extends CommandHandler {
  readonly definition: CommandDefinition = HELP_COMMAND;

  async execute(command: EnhancedCommand, context: ExecutionContext): Promise<void> {
    const specificCommand = command.args[0];
    const showExamples = command.options.examples === true;
    const showAll = command.options.all === true;

    let helpText: string;

    if (specificCommand) {
      // Show help for specific command
      const definition = ALL_COMMANDS[specificCommand];
      if (!definition) {
        helpText = `❌ Unknown command: \`${specificCommand}\`\n\nUse \`@${context.event.comment?.body.match(/@(\w+)/)?.[1] || 'bot'} help\` to see all available commands.`;
      } else {
        helpText = this.formatCommandHelp(definition, showExamples);
      }
    } else {
      // Show general help
      helpText = this.formatGeneralHelp(showAll, showExamples);
    }

    await this.postComment(context, helpText);
  }

  private formatGeneralHelp(showAll: boolean, showExamples: boolean): string {
    const lines: string[] = ['## 🤖 GitHub Agent Commands\n'];

    lines.push('I can help you implement issues, apply review feedback, and manage workflows.\n');

    lines.push('### Workflow Commands');
    for (const [name, def] of Object.entries(WORKFLOW_COMMANDS)) {
      lines.push(`- **${name}** - ${def.description}`);
      if (def.aliases && showAll) {
        lines.push(`  Aliases: ${def.aliases.join(', ')}`);
      }
    }

    lines.push('\n### Tool Commands');
    for (const [name, def] of Object.entries(TOOL_COMMANDS)) {
      lines.push(`- **${name}** - ${def.description}`);
    }

    lines.push('\n### Other Commands');
    lines.push(`- **help** - ${HELP_COMMAND.description}`);

    if (showExamples) {
      lines.push('\n### Examples');
      lines.push('```');
      lines.push('@bot implement #123');
      lines.push('@bot status --verbose');
      lines.push('@bot help implement');
      lines.push('```');
    }

    lines.push('\nUse `@bot help <command>` for detailed information about a specific command.');

    return lines.join('\n');
  }

  private formatCommandHelp(definition: CommandDefinition, showExamples: boolean): string {
    const lines: string[] = [`## Command: ${definition.name}\n`];

    lines.push(definition.description + '\n');

    if (definition.aliases && definition.aliases.length > 0) {
      lines.push(`**Aliases**: ${definition.aliases.join(', ')}\n`);
    }

    if (definition.args && definition.args.length > 0) {
      lines.push('### Arguments');
      for (const arg of definition.args) {
        const required = arg.required ? ' *(required)*' : ' *(optional)*';
        lines.push(`- **${arg.name}** (${arg.type})${required} - ${arg.description}`);
        if (arg.default !== undefined) {
          lines.push(`  Default: \`${arg.default}\``);
        }
      }
      lines.push('');
    }

    if (definition.options && Object.keys(definition.options).length > 0) {
      lines.push('### Options');
      for (const [key, option] of Object.entries(definition.options)) {
        const shortFlag = option.short ? `-${option.short}, ` : '';
        const type = option.type ? ` (${option.type})` : '';
        lines.push(`- ${shortFlag}**--${key}**${type} - ${option.description}`);
        if (option.default !== undefined) {
          lines.push(`  Default: \`${option.default}\``);
        }
      }
      lines.push('');
    }

    if ((definition.examples && definition.examples.length > 0) || showExamples) {
      lines.push('### Examples');
      lines.push('```');
      if (definition.examples) {
        lines.push(...definition.examples);
      }
      lines.push('```');
    }

    if (definition.requiresAuth) {
      lines.push('\n*Note: This command requires authentication.*');
    }

    if (definition.requiresWorkspace) {
      lines.push('\n*Note: This command requires a workspace and will clone the repository.*');
    }

    return lines.join('\n');
  }

  private async postComment(context: ExecutionContext, body: string): Promise<void> {
    if (context.event.issue) {
      await context.octokit.rest.issues.createComment({
        owner: context.event.repository.owner.login,
        repo: context.event.repository.name,
        issue_number: context.event.issue.number,
        body,
      });
    } else if (context.event.pull_request) {
      await context.octokit.rest.issues.createComment({
        owner: context.event.repository.owner.login,
        repo: context.event.repository.name,
        issue_number: context.event.pull_request.number,
        body,
      });
    }
  }
}
