import type Anthropic from '@anthropic-ai/sdk';
import chalk from 'chalk';
import yaml from 'yaml';
import { formatTodoLikeLines } from '../shared/todo_format.ts';
import { debugLog } from '../../../logging.ts';
import { createTwoFilesPatch } from 'diff';
import { detectFailedLineAnywhere } from '../failure_detection.ts';

// Represents the top-level message object
export type Message =
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
      total_cost_usd: number;
      duration_ms: number;
      duration_api_ms: number;
      is_error: boolean;
      num_turns: number;
      result: string;
      session_id: string;
      structured_output?: unknown;
    }

  // Emitted as the last message, when we've reached the maximum number of turns
  | {
      type: 'result';
      subtype: 'error_max_turns';
      total_cost_usd: number;
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
    }

  // Notification about a background task completing
  | {
      type: 'system';
      subtype: 'task_notification';
      task_id: string;
      status: string;
      output_file: string;
      summary: string;
      session_id: string;
    }

  // Status update (e.g., compacting)
  | {
      type: 'system';
      subtype: 'status';
      status: string | null;
      session_id: string;
    }

  // Compact boundary marker
  | {
      type: 'system';
      subtype: 'compact_boundary';
      session_id: string;
      compact_metadata: {
        trigger: string;
        pre_tokens: number;
      };
    };

// Cache for tool use IDs mapped to their names
const toolUseCache = new Map<string, string>();

function truncateString(result: string, maxLines = 15): string {
  let lines = result.split('\n');
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    lines.push('(truncated long output...)');
  }

  return lines.join('\n');
}

export function formatJsonMessage(input: string): {
  message?: string;
  rawMessage?: string;
  structuredOutput?: unknown;
  type: string;
  filePaths?: string[];
  // Failure detection for assistant messages
  failed?: boolean;
  failedSummary?: string;
} {
  // TODOS implemented:
  // - Cache tool use IDs across calls so that we can print the tool names with the results
  // - When reading and writing files, just show number of lines read and written
  // - Add timestamps at each header

  debugLog(input);

  if (input.startsWith('[DEBUG]')) {
    return { type: '' };
  }

  const filePaths: string[] = [];
  const message = JSON.parse(input) as Message;

  // Get the current timestamp in HH:MM:SS format
  const timestamp = new Date().toTimeString().split(' ')[0];

  const outputLines: string[] = [];
  let rawMessage: string[] = [];

  if (message.type === 'result') {
    if (message.subtype === 'success' || message.subtype === 'error_max_turns') {
      let result = `Cost: $${message.total_cost_usd.toFixed(2)}, ${Math.round(message.duration_ms / 1000)}s for ${message.num_turns} turns`;
      if (message.subtype === 'error_max_turns') {
        result += ' (max turns reached)';
      }
      outputLines.push(
        chalk.bold.green(`### Done [${timestamp}]\n`),
        `Session ID: ${message.session_id}`,
        result
      );
      return {
        message: outputLines.join('\n'),
        type: message.type,
        structuredOutput: 'structured_output' in message ? message.structured_output : undefined,
      };
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

    return { message: outputLines.join('\n'), type: message.type };
  } else if (message.type === 'system' && message.subtype === 'task_notification') {
    outputLines.push(
      chalk.bold.yellow(`### Task Notification [${timestamp}]`),
      `Task ${message.task_id}: ${message.status}`,
      message.summary
    );
    return { message: outputLines.join('\n'), type: message.type };
  } else if (message.type === 'system' && message.subtype === 'status') {
    // Ignore status messages with null status
    if (message.status === null) {
      return { type: '' };
    }
    outputLines.push(chalk.dim(`### Status: ${message.status} [${timestamp}]`));
    return { message: outputLines.join('\n'), type: message.type };
  } else if (message.type === 'system' && message.subtype === 'compact_boundary') {
    outputLines.push(
      chalk.dim(
        `### Compacting (${message.compact_metadata.trigger}, ${message.compact_metadata.pre_tokens} tokens) [${timestamp}]`
      )
    );
    return { message: outputLines.join('\n'), type: message.type };
  } else if (message.type === 'assistant' || message.type === 'user') {
    const m = message.message;

    for (const content of m.content) {
      if (typeof content === 'string') {
        outputLines.push(content);
        rawMessage.push(content);
      } else if (content.type === 'thinking') {
        outputLines.push(chalk.blue(`### Thinking [${timestamp}]`), content.thinking);
      } else if (content.type === 'text') {
        if (message.type === 'assistant') {
          outputLines.push(chalk.bold.green(`### Model Response [${timestamp}]`));
        } else {
          outputLines.push(chalk.bold.blue(`### Agent Request [${timestamp}]`));
        }

        outputLines.push(content.text);
        rawMessage.push(content.text);
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
          filePaths.push(filePath);
          const fileContent = content.input.content as string;
          const lineCount = fileContent.split('\n').length;
          outputLines.push(
            chalk.cyan(`### Invoke Tool: ${content.name} [${timestamp}]`),
            `File path: ${filePath}\nNumber of lines: ${lineCount}`
          );
        } else if (
          content.name === 'Edit' &&
          content.input &&
          typeof content.input === 'object' &&
          'file_path' in content.input &&
          'old_string' in content.input &&
          'new_string' in content.input
        ) {
          const { old_string, new_string, file_path } = content.input as {
            old_string: string;
            new_string: string;
            file_path: string;
          };

          filePaths.push(file_path);

          // Create a diff between the old and new strings
          const diff = createTwoFilesPatch('old', 'new', old_string, new_string);

          // Colorize diff lines: green for additions (+), red for deletions (-)
          const colorizedDiff = diff
            .split('\n')
            .map((line) => {
              if (line.startsWith('+') && !line.startsWith('+++')) {
                return chalk.green(line);
              } else if (line.startsWith('-') && !line.startsWith('---')) {
                return chalk.red(line);
              }
              return line;
            })
            .join('\n');

          outputLines.push(
            chalk.cyan(`### Invoke Tool: ${content.name} [${timestamp}]`),
            `File path: ${file_path}\n`,
            colorizedDiff
          );
        } else if (
          content.name === 'MultiEdit' &&
          content.input &&
          typeof content.input === 'object' &&
          'file_path' in content.input
        ) {
          const filePath = content.input.file_path as string;
          filePaths.push(filePath);
          outputLines.push(
            chalk.cyan(`### Invoke Tool: ${content.name} [${timestamp}]`),
            yaml.stringify(content.input ?? {})
          );
        } else if (
          content.name === 'TodoWrite' &&
          content.input &&
          typeof content.input === 'object' &&
          'todos' in content.input
        ) {
          const todos = (content.input as any).todos as Array<{
            id: string;
            content: string;
            status?: string;
            priority?: string;
          }>;
          outputLines.push(chalk.cyan(`### Invoke Tool: ${content.name} [${timestamp}]`));

          const todoLines = formatTodoLikeLines(
            todos.map((todo) => ({
              label: todo.content,
              status: todo.status,
              priority: todo.priority,
            }))
          );
          outputLines.push(todoLines.join('\n'));
        } else {
          const color = content.name === 'Task' ? chalk.red : chalk.cyan;
          outputLines.push(
            color(`### Invoke Tool: ${content.name} [${timestamp}]`),
            yaml.stringify(content.input ?? {}).trim()
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
          toolName === 'Edit' &&
          typeof result === 'string' &&
          result.includes('has been updated.')
        ) {
          formattedResult = truncateString(result);
        } else if ((toolName === 'LS' || toolName === 'Glob') && typeof result === 'string') {
          // This tends to have a lot of files listed and isn't useful
          // to the user
          formattedResult = truncateString(result, 10);
        } else if (
          toolName === 'Bash' &&
          typeof result === 'object' &&
          ('stdout' in result || 'stderr' in result)
        ) {
          let stdout = (result as any).stdout?.trim();
          let stderr = (result as any).stderr?.trim();

          let lines: string[] = [];

          if (stderr) {
            lines.push(chalk.red('Stderr:\n') + stderr);
          }

          if (stdout) {
            lines.push(chalk.green('Stdout:\n') + stdout);
          }

          formattedResult = lines.join('\n\n');
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

        const color = toolName === 'Task' ? chalk.red : chalk.magenta;
        outputLines.push(color(`### Tool Result: ${toolName} [${timestamp}]`), formattedResult);
      } else {
        debugLog('Unknown message type:', content.type);
        outputLines.push(`### ${content.type as string} [${timestamp}]`, formatValue(content));
      }
    }
    const rawCombined = rawMessage.filter(Boolean).join('\n');
    // Detect FAILED anywhere in the assistant message (not only first non-empty line)
    const failure =
      message.type === 'assistant' ? detectFailedLineAnywhere(rawCombined) : { failed: false };
    return {
      message: outputLines.join('\n\n'),
      rawMessage: rawCombined,
      type: message.type,
      structuredOutput: 'structured_output' in message ? message.structured_output : undefined,
      filePaths: filePaths.length > 0 ? filePaths : undefined,
      failed: failure.failed || undefined,
      failedSummary: failure.failed ? failure.summary : undefined,
    };
  }

  return {
    message: `Unknown message: ${JSON.stringify(message)}`,
    type: (message as Record<string, unknown>)?.type as string,
  };
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  return yaml.stringify(value).trim();
}
