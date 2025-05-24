import { MentionParser } from '../mention_parser.js';
import type { ParsedCommand } from '../types.js';
import type { EnhancedCommand, CommandType } from './types.js';
import { ALL_COMMANDS, COMMAND_ALIASES } from './definitions.js';
import { parseGitHubUrl } from '../../common/github/identifiers.js';

export class EnhancedCommandParser {
  private mentionParser: MentionParser;

  constructor(botName: string) {
    this.mentionParser = new MentionParser(botName);
  }

  parse(
    commentBody: string,
    context?: { issueNumber?: number; prNumber?: number }
  ): EnhancedCommand | null {
    // First use the basic parser
    const basicCommand = this.mentionParser.parse(commentBody);
    if (!basicCommand) {
      return null;
    }

    // Enhance the command
    return this.enhance(basicCommand, context);
  }

  private enhance(
    command: ParsedCommand,
    context?: { issueNumber?: number; prNumber?: number }
  ): EnhancedCommand {
    // Resolve aliases
    const resolvedCommand = COMMAND_ALIASES.get(command.command) || command.command;

    // Look up command definition
    const definition = ALL_COMMANDS[resolvedCommand];
    const type: CommandType = definition?.type || 'tool';

    // Extract branch from options or generate
    const branch = this.extractBranch(command, context);

    // Parse issue/PR references from arguments
    const { issueNumber, prNumber } = this.extractReferences(command, context);

    const enhanced: EnhancedCommand = {
      ...command,
      command: resolvedCommand,
      type,
      branch,
      issueNumber,
      prNumber,
    };

    // Parse subcommands if this is a compound command
    if (command.command === 'then' || command.command === 'and') {
      enhanced.subcommands = this.parseSubcommands(command.args.join(' '));
    }

    return enhanced;
  }

  private extractBranch(
    command: ParsedCommand,
    context?: { issueNumber?: number; prNumber?: number }
  ): string | undefined {
    // Check if branch is explicitly specified
    if (command.options.branch && typeof command.options.branch === 'string') {
      return command.options.branch;
    }

    // Generate branch name based on command and context
    if (command.command === 'implement' && command.args[0]) {
      const issueRef = this.parseIssueReference(command.args[0]);
      if (issueRef) {
        return `issue-${issueRef.number}`;
      }
    }

    if (context?.issueNumber) {
      return `issue-${context.issueNumber}`;
    }

    if (context?.prNumber) {
      return `pr-${context.prNumber}`;
    }

    return undefined;
  }

  private extractReferences(
    command: ParsedCommand,
    context?: { issueNumber?: number; prNumber?: number }
  ): { issueNumber?: number; prNumber?: number } {
    let issueNumber = context?.issueNumber;
    let prNumber = context?.prNumber;

    // Try to extract from command arguments
    if (command.args.length > 0) {
      const ref = command.args[0];

      // Check for issue reference
      const issueRef = this.parseIssueReference(ref);
      if (issueRef) {
        issueNumber = issueRef.number;
      }

      // Check for PR reference
      const prRef = this.parsePRReference(ref);
      if (prRef) {
        prNumber = prRef.number;
      }
    }

    return { issueNumber, prNumber };
  }

  private parseIssueReference(ref: string): { number: number } | null {
    // Handle #123 format
    const hashMatch = ref.match(/^#(\d+)$/);
    if (hashMatch) {
      return { number: parseInt(hashMatch[1], 10) };
    }

    // Handle GitHub URL
    try {
      const parsed = parseGitHubUrl(ref);
      if (parsed && parsed.type === 'issue') {
        return { number: parsed.number };
      }
    } catch {
      // Not a valid URL
    }

    // Handle plain number
    const num = parseInt(ref, 10);
    if (!isNaN(num)) {
      return { number: num };
    }

    return null;
  }

  private parsePRReference(ref: string): { number: number } | null {
    // Similar to issue reference parsing
    return this.parseIssueReference(ref);
  }

  private parseSubcommands(args: string): EnhancedCommand[] {
    // Split by command separators (then, and, ;)
    const parts = args.split(/\s+(then|and|;)\s+/);
    const subcommands: EnhancedCommand[] = [];

    for (let i = 0; i < parts.length; i += 2) {
      const part = parts[i].trim();
      if (part) {
        // Parse each part as a command
        const tokens = part.split(/\s+/);
        const basicCommand: ParsedCommand = {
          command: tokens[0],
          args: tokens.slice(1),
          options: {},
        };
        subcommands.push(this.enhance(basicCommand));
      }
    }

    return subcommands;
  }
}
