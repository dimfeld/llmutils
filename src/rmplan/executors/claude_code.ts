import type Anthropic from '@anthropic-ai/sdk';
import chalk from 'chalk';
import yaml from 'yaml';
import { z } from 'zod';
import { debugLog, log } from '../../logging.ts';
import { createLineSplitter, debug, spawnAndLogOutput } from '../../rmfilter/utils.ts';
import { getGitRoot } from '../../common/git.ts';
import type { PrepareNextStepOptions } from '../actions.ts';
import type { RmplanConfig } from '../configSchema.ts';
import type { Executor, ExecutorCommonOptions } from './types.ts';

const claudeCodeOptionsSchema = z.object({
  allowedTools: z.array(z.string()).optional(),
  allowAllTools: z.boolean().optional(),
  includeDefaultTools: z.boolean().default(true),
  disallowedTools: z.array(z.string()).optional(),
  mcpConfigFile: z.string().optional(),
  interactive: z.boolean().optional(),
});

export type ClaudeCodeExecutorOptions = z.infer<typeof claudeCodeOptionsSchema>;

export const ClaudeCodeExecutorName = 'claude-code';

export class ClaudeCodeExecutor implements Executor {
  static name = ClaudeCodeExecutorName;
  static description = 'Executes the plan using Claude Code';
  static optionsSchema = claudeCodeOptionsSchema;
  static defaultModel = {
    execution: 'auto',
    answerPr: 'auto',
  };

  // readonly forceReviewCommentsMode = 'separate-context';
  readonly filePathPrefix = '@';

  constructor(
    public options: ClaudeCodeExecutorOptions,
    public sharedOptions: ExecutorCommonOptions,
    public rmplanConfig: RmplanConfig
  ) {}

  prepareStepOptions(): Partial<PrepareNextStepOptions> {
    return {
      rmfilter: false,
      model: 'claude',
      // run all steps in a task since Claude code has its own TODO lists for these things and can more efficiently
      // handle them together.
      selectSteps: 'all',
    };
  }

  async execute(contextContent: string) {
    let { disallowedTools, allowAllTools, mcpConfigFile, interactive } = this.options;

    allowAllTools ??= (process.env.ALLOW_ALL_TOOLS ?? 'false') === 'true';
    // TODO Interactive mode needs some work. It's not taking the prompt right away
    // Also it isn't integrated with the logging
    interactive ??= (process.env.CLAUDE_INTERACTIVE ?? 'false') === 'true';

    const jsTaskRunners = ['npm', 'pnpm', 'yarn', 'bun'];

    const defaultAllowedTools = this.options.includeDefaultTools
      ? [
          `Edit`,
          'MultiEdit',
          `Write`,
          'WebFetch',
          `Bash(cat:*)`,
          `Bash(cd:*)`,
          'Bash(cp:*)',
          'Bash(find:*)',
          'Bash(grep:*)',
          'Bash(ls:*)',
          'Bash(mkdir:*)',
          'Bash(mv:*)',
          'Bash(pwd)',
          'Bash(rg:*)',
          'Bash(sed:*)',
          // Allow Claude to delete its own test scripts
          'Bash(rm test-:*)',
          'Bash(rm -f test-:*)',
          'Bash(jj status)',
          'Bash(jj log:*)',
          'Bash(jj commit:*)',
          ...jsTaskRunners.flatMap((name) => [
            `Bash(${name} test:*)`,
            `Bash(${name} run build:*)`,
            `Bash(${name} run check:*)`,
            `Bash(${name} run typecheck:*)`,
            `Bash(${name} run lint:*)`,
            `Bash(${name} install)`,
            `Bash(${name} add:*)`,
          ]),
          'Bash(cargo add:*)',
          'Bash(cargo build)',
          'Bash(cargo test:*)',
        ]
      : [];

    let allowedTools = [...defaultAllowedTools, ...(this.options.allowedTools ?? [])];
    if (disallowedTools) {
      allowedTools = allowedTools.filter((t) => !disallowedTools?.includes(t));
    }

    const args = ['claude'];

    if (!interactive) {
      args.push('--verbose', '--output-format', 'stream-json');
    }

    if (debug && !interactive) {
      args.push('--debug');
    }

    args.push('--allowedTools', allowedTools.join(','));

    if (allowAllTools) {
      args.push('--dangerously-skip-permissions');
    }

    if (disallowedTools) {
      args.push('--disallowedTools', disallowedTools.join(','));
    }

    if (mcpConfigFile) {
      args.push('--mcp-config', mcpConfigFile);
    }

    if (
      this.sharedOptions.model?.includes('haiku') ||
      this.sharedOptions.model?.includes('sonnet') ||
      this.sharedOptions.model?.includes('opus')
    ) {
      log(`Using model: ${this.sharedOptions.model}\n`);
      args.push('--model', this.sharedOptions.model);
    }

    if (!interactive) {
      args.push('-p');
    }

    args.push(contextContent);

    if (interactive) {
      // In interactive mode, use Bun.spawn directly with inherited stdio
      debugLog(args);
      const proc = Bun.spawn(args, {
        cwd: await getGitRoot(),
        stdio: ['inherit', 'inherit', 'inherit'],
      });

      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        throw new Error(`Claude exited with non-zero exit code: ${exitCode}`);
      }
    } else {
      let splitter = createLineSplitter();

      const result = await spawnAndLogOutput(args, {
        cwd: await getGitRoot(),
        formatStdout: (output) => {
          let lines = splitter(output);
          return lines.map(formatJsonMessage).join('\n\n') + '\n\n';
        },
      });

      if (result.exitCode !== 0) {
        throw new Error(`Claude exited with non-zero exit code: ${result.exitCode}`);
      }
    }
  }
}

// Represents the top-level message object
type Message =
  // An assistant message
  | {
      type: 'assistant';
      message: Anthropic.Message;
      session_id: string;
    }

  // A user message
  | {
      type: 'user';
      message: Anthropic.MessageParam;
      session_id: string;
    }

  // Emitted as the last message
  | {
      type: 'result';
      subtype: 'success';
      cost_usd: number;
      duration_ms: number;
      duration_api_ms: number;
      is_error: boolean;
      num_turns: number;
      result: string;
      session_id: string;
    }

  // Emitted as the last message, when we've reached the maximum number of turns
  | {
      type: 'result';
      subtype: 'error_max_turns';
      cost_usd: number;
      duration_ms: number;
      duration_api_ms: number;
      is_error: boolean;
      num_turns: number;
      session_id: string;
    }

  // Emitted as the first message at the start of a conversation
  | {
      type: 'system';
      subtype: 'init';
      session_id: string;
      tools: string[];
      mcp_servers: {
        name: string;
        status: string;
      }[];
    };

// Cache for tool use IDs mapped to their names
const toolUseCache = new Map<string, string>();

function formatJsonMessage(input: string) {
  // TODOS implemented:
  // - Cache tool use IDs across calls so that we can print the tool names with the results
  // - When reading and writing files, just show number of lines read and written
  // - Add timestamps at each header

  const message = JSON.parse(input) as Message;
  debugLog(input);

  // Get the current timestamp in HH:MM:SS format
  const timestamp = new Date().toTimeString().split(' ')[0];

  const outputLines: string[] = [];

  if (message.type === 'result') {
    if (message.subtype === 'success' || message.subtype === 'error_max_turns') {
      let result = `Cost: $${message.cost_usd.toFixed(2)}, ${Math.round(message.duration_ms / 1000)}s for ${message.num_turns} turns`;
      if (message.subtype === 'error_max_turns') {
        result += ' (max turns reached)';
      }
      outputLines.push(
        chalk.bold.green(`### Done [${timestamp}]\n`),
        `Session ID: ${message.session_id}`,
        result
      );
      return outputLines.join('\n');
    }
  } else if (message.type === 'system' && message.subtype === 'init') {
    outputLines.push(
      chalk.bold.green(`### Starting [${timestamp}]\n`),
      `Session ID: ${message.session_id}`,
      `Tools: ${message.tools.join(', ')}`
    );

    if (message.mcp_servers.length > 0) {
      outputLines.push(
        `MCP Servers: ${message.mcp_servers.map((s) => `${s.name} (${s.status})`).join(', ')}`
      );
    }

    return outputLines.join('\n');
  } else if (message.type === 'assistant' || message.type === 'user') {
    const m = message.message;

    for (const content of m.content) {
      if (typeof content === 'string') {
        outputLines.push(content);
      } else if (content.type === 'thinking') {
        outputLines.push(chalk.blue(`### Thinking [${timestamp}]`), content.thinking);
      } else if (content.type === 'text') {
        if (message.type === 'assistant') {
          outputLines.push(chalk.bold.green(`### Model Response [${timestamp}]`));
        } else {
          outputLines.push(chalk.bold.blue(`### Agent Request [${timestamp}]`));
        }

        outputLines.push(content.text);
      } else if (content.type === 'tool_use') {
        // Store tool use ID mapping
        if ('id' in content) {
          toolUseCache.set(content.id, content.name);
        }

        // Special handling for Write tool to show file_path and line count
        if (
          content.name === 'Write' &&
          content.input &&
          typeof content.input === 'object' &&
          'file_path' in content.input &&
          'content' in content.input
        ) {
          const filePath = content.input.file_path as string;
          const fileContent = content.input.content as string;
          const lineCount = fileContent.split('\n').length;
          outputLines.push(
            chalk.cyan(`### Invoke Tool: ${content.name} [${timestamp}]`),
            `File path: ${filePath}\nNumber of lines: ${lineCount}`
          );
        } else if (
          content.name === 'TodoWrite' &&
          content.input &&
          typeof content.input === 'object' &&
          'todos' in content.input
        ) {
          // Special formatting for TodoWrite tool
          const todos = (content.input as any).todos as Array<{
            id: string;
            content: string;
            status: string;
            priority: string;
          }>;
          outputLines.push(chalk.cyan(`### Invoke Tool: ${content.name} [${timestamp}]`));

          const todoLines = todos.map((todo) => {
            const statusIcon =
              todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '→' : '•';
            const priorityColor =
              todo.priority === 'high'
                ? chalk.red
                : todo.priority === 'medium'
                  ? chalk.yellow
                  : chalk.gray;

            return `  ${statusIcon} [${priorityColor(todo.priority)}] ${todo.content}`;
          });
          outputLines.push(todoLines.join('\n'));
        } else {
          outputLines.push(
            chalk.cyan(`### Invoke Tool: ${content.name} [${timestamp}]`),
            yaml.stringify(content.input ?? {})
          );
        }
      } else if (content.type === 'tool_result') {
        // Get the tool name if we have it cached
        let toolName = '';
        if ('tool_use_id' in content && toolUseCache.has(content.tool_use_id)) {
          toolName = toolUseCache.get(content.tool_use_id) ?? '';
        }

        // Check if this is a file operation (read/write) and simplify output
        const result = content.content;

        let formattedResult: string;
        if (toolName === 'Read' && typeof result === 'string') {
          formattedResult = `Lines: ${result.split('\n').length}`;
        } else if (
          typeof result === 'object' &&
          result !== null &&
          'file_path' in result &&
          'content' in result
        ) {
          // Handle file read/write operations by showing only summary
          // This is likely a file read or write operation
          const filePath = (result as any).file_path;
          const fileContent = (result as any).content as string;
          const lineCount = fileContent.split('\n').length;
          formattedResult = `File: ${filePath}\nLines: ${lineCount}`;
        } else {
          formattedResult = formatValue(result);
        }

        outputLines.push(
          chalk.magenta(`### Tool Result: ${toolName} [${timestamp}]`),
          formattedResult
        );
      } else {
        debugLog('Unknown message type:', content.type);
        outputLines.push(`### ${content.type as string} [${timestamp}]`, formatValue(content));
      }
      return outputLines.join('\n\n');
    }
  }

  return `Unknown message: ${JSON.stringify(message)}`;
}

function formatValue(value: unknown): string {
  return yaml.stringify(value).trim();
}
