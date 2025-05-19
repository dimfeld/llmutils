import { z } from 'zod';
import type { RmplanConfig } from '../configSchema.ts';
import type { Executor, ExecutorCommonOptions } from './types.ts';
import type { PrepareNextStepOptions } from '../actions.ts';
import type Anthropic from '@anthropic-ai/sdk';
import {
  createLineSplitter,
  debug,
  getGitRoot,
  logSpawn,
  spawnAndLogOutput,
} from '../../rmfilter/utils.ts';
import { debugLog } from '../../logging.ts';
import chalk from 'chalk';

const claudeCodeOptionsSchema = z.object({
  allowedTools: z.array(z.string()).optional(),
  includeDefaultTools: z.boolean().default(true),
  disallowedTools: z.array(z.string()).optional(),
  mcpConfigFile: z.string().optional(),
});

export type ClaudeCodeExecutorOptions = z.infer<typeof claudeCodeOptionsSchema>;

export class ClaudeCodeExecutor implements Executor {
  static name = 'claude-code';
  static description = 'Executes the plan using Claude Code';
  static optionsSchema = claudeCodeOptionsSchema;

  readonly forceReviewCommentsMode = 'separate-context';

  constructor(
    public options: ClaudeCodeExecutorOptions,
    public sharedOptions: ExecutorCommonOptions,
    public rmplanConfig: RmplanConfig
  ) {}

  prepareStepOptions(): Partial<PrepareNextStepOptions> {
    return {
      rmfilter: false,
      model: 'claude',
    };
  }

  async execute(contextContent: string) {
    const { disallowedTools, mcpConfigFile } = this.options;

    const jsTaskRunners = ['npm', 'pnpm', 'yarn', 'bun'];

    const defaultAllowedTools = this.options.includeDefaultTools
      ? [
          `Edit`,
          'MultliEdit',
          `Write`,
          'WebFetch',
          ...jsTaskRunners.flatMap((name) => [
            `Bash(${name} test:*)`,
            `Bash(${name} run build:*)`,
            `Bash(${name} install)`,
            `Bash(${name} add)`,
          ]),
          'Bash(cargo add)',
          'Bash(cargo build)',
          'Bash(cargo test)',
        ]
      : [];

    let allowedTools = [...defaultAllowedTools, ...(this.options.allowedTools ?? [])];
    if (disallowedTools) {
      allowedTools = allowedTools.filter((t) => !disallowedTools?.includes(t));
    }

    const args = [
      'claude',
      '--verbose',
      '--output-format',
      'stream-json',
      debug ? '--debug' : '',
      '--allowedTools',
      allowedTools.join(','),
    ].filter(Boolean);

    if (disallowedTools) {
      args.push('--disallowedTools', disallowedTools.join(','));
    }
    if (mcpConfigFile) {
      args.push('--mcp-config', mcpConfigFile);
    }

    args.push('-p', contextContent);

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

// Represents the top-level message object
type Message =
  // An assistant message
  | {
      type: 'assistant';
      message: Anthropic.Message; // from Anthropic SDK
      session_id: string;
    }

  // A user message
  | {
      type: 'user';
      message: Anthropic.MessageParam; // from Anthropic SDK
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

function formatJsonMessage(input: string) {
  const message = JSON.parse(input) as Message;
  debugLog(input);

  const outputLines: string[] = [];

  if (message.type === 'result') {
    if (message.subtype === 'success' || message.subtype === 'error_max_turns') {
      let result = `Cost: $${message.cost_usd.toFixed(2)}, ${Math.round(message.duration_ms / 1000)}s for ${message.num_turns} turns`;
      if (message.subtype === 'error_max_turns') {
        result += ' (max turns reached)';
      }
      outputLines.push(chalk.bold.green('### Done\n'), `Session ID: ${message.session_id}`, result);
      return outputLines.join('\n');
    }
  } else if (message.type === 'system' && message.subtype === 'init') {
    outputLines.push(
      chalk.bold.green('### Starting\n'),
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
        outputLines.push(chalk.blue('### Thinking'), content.thinking);
      } else if (content.type === 'text') {
        if (message.type === 'assistant') {
          outputLines.push(chalk.bold.green('### Model Response'));
        } else {
          outputLines.push(chalk.bold.blue('### Agent Request'));
        }

        outputLines.push(content.text);
      } else if (content.type === 'tool_use') {
        outputLines.push(
          chalk.cyan(`### Invoke Tool: ${content.name}`),
          formatObject(content.input ?? {})
        );
      } else if (content.type === 'tool_result') {
        outputLines.push(chalk.magenta(`### Tool Result`), formatValue(content.content));
      } else {
        debugLog('Unknown message type:', content.type);
        outputLines.push(`### ${content.type as string}`, formatValue(content));
      }
      return outputLines.join('\n\n');
    }
  }

  return `Unknown message: ${JSON.stringify(message)}`;
}

function formatObject(value: Record<string, any>, indent = 0) {
  return Object.entries(value ?? {})
    .map(([key, value]) => {
      return `${key}=${formatValue(value, indent)}`;
    })
    .join('\n');
}

function formatValue(value: unknown, indent = 0): string {
  let indentStr = ''.padStart(indent, ' ');
  if (Array.isArray(value)) {
    let list = value
      .map((v) => {
        v = formatValue(v, indent + 2);
        return `${indentStr}- ${v}`;
      })
      .join('\n');
    value = '\n' + list;
  } else if (value && typeof value === 'object') {
    return indentStr + formatObject(value);
  }
  return indentStr + String(value);
}
