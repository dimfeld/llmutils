import type { ParsedCommand } from './types';
import { log } from '../logging';

export class MentionParser {
  constructor(private botName: string) {}

  parse(commentBody: string): ParsedCommand | null {
    // Find the bot mention
    const mentionPattern = new RegExp(`@${this.botName}\\s+(.+)`, 'i');
    const match = commentBody.match(mentionPattern);

    if (!match) {
      return null;
    }

    const commandLine = match[1].trim();
    log(`Parsing command: ${commandLine}`);

    // Parse the command line
    const tokens = this.tokenize(commandLine);
    if (tokens.length === 0) {
      return null;
    }

    const command = tokens[0];
    const args: string[] = [];
    const options: Record<string, string | boolean> = {};
    const contextFiles: string[] = [];

    let i = 1;
    let afterDoubleDash = false;

    while (i < tokens.length) {
      const token = tokens[i];

      if (token === '--') {
        afterDoubleDash = true;
        i++;
        continue;
      }

      if (afterDoubleDash) {
        // Everything after -- is considered a context file
        contextFiles.push(token);
      } else if (token.startsWith('--')) {
        // Long option
        const equalIndex = token.indexOf('=');
        if (equalIndex !== -1) {
          const key = token.slice(2, equalIndex);
          const value = token.slice(equalIndex + 1);
          options[key] = value;
        } else {
          const key = token.slice(2);
          // Check if next token is a value or another option/arg
          if (i + 1 < tokens.length && !tokens[i + 1].startsWith('-')) {
            // Special case: if the option is a boolean flag (like --dry-run),
            // and the next token doesn't look like a value, treat it as a boolean
            if (key === 'dry-run' || key === 'verbose' || key === 'debug' || key === 'quiet') {
              options[key] = true;
            } else {
              options[key] = tokens[i + 1];
              i++;
            }
          } else {
            options[key] = true;
          }
        }
      } else if (token.startsWith('-') && token.length > 1) {
        // Short option(s)
        for (let j = 1; j < token.length; j++) {
          options[token[j]] = true;
        }
      } else {
        // Regular argument
        args.push(token);
      }

      i++;
    }

    return {
      command,
      args,
      options,
      contextFiles: contextFiles.length > 0 ? contextFiles : undefined,
    };
  }

  private tokenize(input: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inQuotes = false;
    let quoteChar = '';
    let escaped = false;

    for (let i = 0; i < input.length; i++) {
      const char = input[i];

      if (escaped) {
        current += char;
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        continue;
      }

      if ((char === '"' || char === "'") && (!inQuotes || char === quoteChar)) {
        if (inQuotes) {
          inQuotes = false;
          quoteChar = '';
        } else {
          inQuotes = true;
          quoteChar = char;
        }
        continue;
      }

      if (char === ' ' && !inQuotes) {
        if (current) {
          tokens.push(current);
          current = '';
        }
        continue;
      }

      current += char;
    }

    if (current) {
      tokens.push(current);
    }

    return tokens;
  }
}
