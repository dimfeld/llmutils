import type Anthropic from '@anthropic-ai/sdk';
import chalk from 'chalk';
import yaml from 'yaml';
import { debugLog } from '../../../logging.ts';
import { createTwoFilesPatch, diffLines } from 'diff';

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
    };

// Cache for tool use IDs mapped to their names
const toolUseCache = new Map<string, string>();

export function formatJsonMessage(input: string): {
  message?: string;
  rawMessage?: string;
  type: string;
  filePaths?: string[];
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
      return { message: outputLines.join('\n'), type: message.type };
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

          outputLines.push(
            chalk.cyan(`### Invoke Tool: ${content.name} [${timestamp}]`),
            `File path: ${file_path}\n`,
            diff
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

            // Color the content based on status
            const contentColor =
              todo.status === 'completed'
                ? chalk.green
                : todo.status === 'in_progress'
                  ? chalk.cyan
                  : chalk.gray;

            // Priority may have been removed in recent versions
            const priority = todo.priority ? `[${priorityColor(todo.priority)}] ` : '';

            return `  ${statusIcon} ${priority}${contentColor(todo.content)}`;
          });
          outputLines.push(todoLines.join('\n'));
        } else {
          const color = content.name === 'Task' ? chalk.red : chalk.cyan;
          outputLines.push(
            color(`### Invoke Tool: ${content.name} [${timestamp}]`),
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

        const color = toolName === 'Task' ? chalk.red : chalk.magenta;
        outputLines.push(color(`### Tool Result: ${toolName} [${timestamp}]`), formattedResult);
      } else {
        debugLog('Unknown message type:', content.type);
        outputLines.push(`### ${content.type as string} [${timestamp}]`, formatValue(content));
      }
    }
    return {
      message: outputLines.join('\n\n'),
      rawMessage: rawMessage.filter(Boolean).join('\n'),
      type: message.type,
      filePaths: filePaths.length > 0 ? filePaths : undefined,
    };
  }

  return {
    message: `Unknown message: ${JSON.stringify(message)}`,
    type: (message as Record<string, unknown>)?.type as string,
  };
}

function formatValue(value: unknown): string {
  return yaml.stringify(value).trim();
}
