import { z } from 'zod';
import type { RmplanConfig } from '../configSchema.ts';
import type { Executor, AgentCommandSharedOptions } from './types.ts';
import type { PrepareNextStepOptions } from '../actions.ts';
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

  constructor(
    public options: ClaudeCodeExecutorOptions,
    public sharedOptions: AgentCommandSharedOptions,
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
interface Message {
  id: string;
  type: string;
  role: 'user' | 'assistant';
  model: string;
  content: Content[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: Usage;
}

interface SystemMessage {
  role: 'system';
  cost_usd: number;
  duration_ms: number;
}

// Represents the content array items
interface Content {
  type: 'thinking' | 'text' | 'tool_use' | 'tool_result';
  thinking?: string;
  signature?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Input;
  tool_use_id?: string;
  content?: string;
}

// Represents the input object within tool_use content
interface Input {
  file_path: string;
}

// Represents the usage object
interface Usage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}

function formatJsonMessage(input: string) {
  const message = JSON.parse(input) as Message | SystemMessage;

  const outputLines: string[] = [];

  if (message.role === 'system') {
    let result = `Cost: $${message.cost_usd.toFixed(2)} (${Math.round(message.duration_ms / 1000)} s)`;
    outputLines.push(chalk.bold.green('### Done'), result);
    return outputLines.join('\n\n');
  }

  for (const content of message.content) {
    if (content.type === 'thinking') {
      outputLines.push(chalk.blue('### Thinking'), content.thinking!);
    } else if (content.type === 'text') {
      if (message.role === 'assistant') {
        outputLines.push(chalk.bold.green('### Model Response'));
      } else {
        outputLines.push(chalk.bold.blue('### Agent Request'));
      }

      outputLines.push(content.text!);
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
  }

  return outputLines.join('\n\n');
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
