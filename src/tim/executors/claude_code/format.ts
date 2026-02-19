import type Anthropic from '@anthropic-ai/sdk';
import yaml from 'yaml';
import { debugLog } from '../../../logging.ts';
import { createTwoFilesPatch } from 'diff';
import { detectFailedLineAnywhere } from '../failure_detection.ts';
import type { StructuredMessage } from '../../../logging/structured_messages.ts';
import { formatStructuredMessage } from '../../../logging/console_formatter.ts';
import {
  buildCommandResult,
  buildParseErrorStatus,
  buildSessionStart,
  buildTodoUpdate,
  buildUnknownStatus,
} from '../shared/structured_message_builders.ts';

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

  // Notification about a background task starting
  | {
      type: 'system';
      subtype: 'task_started';
      task_id: string;
      description: string;
      task_type: string;
      uuid: string;
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
    }

  // Rate limit warning/info event
  | {
      type: 'rate_limit_event';
      rate_limit_info: {
        status: string;
        resetsAt?: number;
        rateLimitType?: string;
        utilization?: number;
        isUsingOverage?: boolean;
        surpassedThreshold?: number;
      };
      uuid: string;
      session_id: string;
    };

export interface FormattedClaudeMessage {
  structured?: StructuredMessage | StructuredMessage[];
  message?: string;
  rawMessage?: string;
  resultText?: string;
  structuredOutput?: unknown;
  type: string;
  filePaths?: string[];
  // Failure detection for assistant messages
  failed?: boolean;
  failedSummary?: string;
}

// Cache for tool use IDs mapped to their names.
const toolUseCache = new Map<string, string>();

export function resetToolUseCache(): void {
  toolUseCache.clear();
}

function timestamp(): string {
  return new Date().toISOString();
}

function truncateString(result: string, maxLines = 15): string {
  let lines = result.split('\n');
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    lines.push('(truncated long output...)');
  }

  return lines.join('\n');
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1).replace(/\.0$/, '')}%`;
}

function formatResetAtUnix(seconds: number): string | undefined {
  if (!Number.isFinite(seconds)) {
    return undefined;
  }

  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return date.toISOString();
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  return yaml.stringify(value).trim();
}

function toArray(
  message: StructuredMessage | StructuredMessage[] | undefined
): StructuredMessage[] {
  if (message == null) {
    return [];
  }
  return Array.isArray(message) ? message : [message];
}

export function extractStructuredMessages(
  formattedResults: FormattedClaudeMessage[]
): StructuredMessage[] {
  return formattedResults.flatMap((result) => toArray(result.structured));
}

export function extractStructuredMessagesFromLines(lines: string[]): StructuredMessage[] {
  return extractStructuredMessages(lines.map(formatJsonMessage));
}

function withMessage(result: Omit<FormattedClaudeMessage, 'message'>): FormattedClaudeMessage {
  const structuredMessages = toArray(result.structured);
  if (structuredMessages.length === 0) {
    return result;
  }

  return {
    ...result,
    message: structuredMessages
      .map((structuredMessage) => formatStructuredMessage(structuredMessage))
      .filter((line) => line.length > 0)
      .join('\n\n'),
  };
}

export function formatJsonMessage(input: string): FormattedClaudeMessage {
  debugLog(input);

  if (input.startsWith('[DEBUG]')) {
    return { type: '' };
  }

  const filePaths: string[] = [];
  let message: Message;
  try {
    message = JSON.parse(input) as Message;
  } catch (err) {
    debugLog('Failed to parse Claude JSON line:', input, err);
    return withMessage({
      type: 'parse_error',
      structured: buildParseErrorStatus('claude', timestamp(), input),
    });
  }

  if (message.type === 'result') {
    if (message.subtype === 'success' || message.subtype === 'error_max_turns') {
      return withMessage({
        type: message.type,
        resultText:
          message.subtype === 'success' && typeof message.result === 'string'
            ? message.result
            : undefined,
        structured: {
          type: 'agent_session_end',
          timestamp: timestamp(),
          success: message.subtype === 'success' && !message.is_error,
          sessionId: message.session_id,
          durationMs: message.duration_ms,
          costUsd: message.total_cost_usd,
          turns: message.num_turns,
          summary: message.subtype === 'error_max_turns' ? 'Maximum turns reached' : undefined,
        },
        structuredOutput: 'structured_output' in message ? message.structured_output : undefined,
      });
    }
  } else if (message.type === 'system' && message.subtype === 'init') {
    return withMessage({
      type: message.type,
      structured: buildSessionStart(timestamp(), 'claude', {
        sessionId: message.session_id,
        tools: message.tools,
        mcpServers: message.mcp_servers.map((server) => `${server.name} (${server.status})`),
      }),
    });
  } else if (message.type === 'system' && message.subtype === 'task_notification') {
    return withMessage({
      type: message.type,
      structured: {
        type: 'workflow_progress',
        timestamp: timestamp(),
        phase: 'task_notification',
        message: `Task ${message.task_id}: ${message.status}\n${message.summary}`,
      },
    });
  } else if (message.type === 'system' && message.subtype === 'task_started') {
    return withMessage({
      type: message.type,
      structured: {
        type: 'workflow_progress',
        timestamp: timestamp(),
        phase: 'task_started',
        message: `Task ${message.task_id} (${message.task_type}): ${message.description}`,
      },
    });
  } else if (message.type === 'system' && message.subtype === 'status') {
    // Ignore status messages with null status
    if (message.status === null) {
      return { type: '' };
    }

    return withMessage({
      type: message.type,
      structured: {
        type: 'llm_status',
        timestamp: timestamp(),
        status: message.status,
      },
    });
  } else if (message.type === 'system' && message.subtype === 'compact_boundary') {
    return withMessage({
      type: message.type,
      structured: {
        type: 'llm_status',
        timestamp: timestamp(),
        status: `Compacting (${message.compact_metadata.trigger})`,
        detail: `${message.compact_metadata.pre_tokens} tokens before compact`,
      },
    });
  } else if (message.type === 'rate_limit_event') {
    const info = message.rate_limit_info;
    const statusPrefix = info.status === 'allowed_warning' ? 'Rate limit warning' : 'Rate limit';
    const status = info.rateLimitType
      ? `${statusPrefix} (${info.rateLimitType})`
      : `${statusPrefix}: ${info.status}`;
    const resetAt = info.resetsAt != null ? formatResetAtUnix(info.resetsAt) : undefined;
    const detailLines = [
      info.utilization != null ? `Utilization: ${formatPercent(info.utilization)}` : undefined,
      info.surpassedThreshold != null
        ? `Threshold: ${formatPercent(info.surpassedThreshold)}`
        : undefined,
      info.isUsingOverage != null
        ? `Using overage: ${info.isUsingOverage ? 'yes' : 'no'}`
        : undefined,
      resetAt ? `Resets at: ${resetAt}` : undefined,
    ].filter((line): line is string => line !== undefined);

    return withMessage({
      type: message.type,
      structured: {
        type: 'llm_status',
        timestamp: timestamp(),
        source: 'claude',
        status,
        detail: detailLines.length > 0 ? detailLines.join('\n') : undefined,
      },
    });
  } else if (message.type === 'assistant' || message.type === 'user') {
    const m = message.message;

    const structuredMessages: StructuredMessage[] = [];
    const rawMessage: string[] = [];

    for (const content of m.content) {
      const ts = timestamp();

      if (typeof content === 'string') {
        rawMessage.push(content);
        structuredMessages.push({
          type: 'llm_response',
          timestamp: ts,
          text: content,
          isUserRequest: message.type === 'user',
        });
        continue;
      }

      if (content.type === 'thinking') {
        structuredMessages.push({
          type: 'llm_thinking',
          timestamp: ts,
          text: content.thinking,
        });
        continue;
      }

      if (content.type === 'text') {
        rawMessage.push(content.text);
        structuredMessages.push({
          type: 'llm_response',
          timestamp: ts,
          text: content.text,
          isUserRequest: message.type === 'user',
        });
        continue;
      }

      if (content.type === 'tool_use') {
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
          structuredMessages.push({
            type: 'file_write',
            timestamp: ts,
            path: filePath,
            lineCount,
          });
          continue;
        }

        if (
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

          structuredMessages.push({
            type: 'file_edit',
            timestamp: ts,
            path: file_path,
            diff,
          });
          continue;
        }

        if (
          content.name === 'MultiEdit' &&
          content.input &&
          typeof content.input === 'object' &&
          'file_path' in content.input
        ) {
          const filePath = content.input.file_path as string;
          filePaths.push(filePath);
        }

        if (
          content.name === 'TodoWrite' &&
          content.input &&
          typeof content.input === 'object' &&
          'todos' in content.input
        ) {
          const todos = content.input.todos;
          if (!Array.isArray(todos)) {
            structuredMessages.push({
              type: 'llm_tool_use',
              timestamp: ts,
              toolName: content.name,
              inputSummary: formatValue(content.input ?? {}),
              input: content.input,
            });
            continue;
          }

          structuredMessages.push(
            buildTodoUpdate(
              'claude',
              ts,
              todos.map((todo) => ({
                label:
                  todo &&
                  typeof todo === 'object' &&
                  'content' in todo &&
                  typeof todo.content === 'string'
                    ? todo.content
                    : '',
                status:
                  todo &&
                  typeof todo === 'object' &&
                  'status' in todo &&
                  typeof todo.status === 'string'
                    ? todo.status
                    : undefined,
              }))
            )
          );
          continue;
        }

        structuredMessages.push({
          type: 'llm_tool_use',
          timestamp: ts,
          toolName: content.name,
          inputSummary: formatValue(content.input ?? {}),
          input: content.input,
        });
        continue;
      }

      if (content.type === 'tool_result') {
        // Get the tool name if we have it cached
        let toolName = '';
        if ('tool_use_id' in content && toolUseCache.has(content.tool_use_id)) {
          toolName = toolUseCache.get(content.tool_use_id) ?? '';
        }

        // Check if this is a file operation (read/write) and simplify output
        const result = content.content;

        if (toolName === 'Read' && typeof result === 'string') {
          structuredMessages.push({
            type: 'llm_tool_result',
            timestamp: ts,
            toolName,
            resultSummary: `Lines: ${result.split('\n').length}`,
            result,
          });
          continue;
        }

        if (
          toolName === 'Bash' &&
          typeof result === 'object' &&
          result !== null &&
          ('stdout' in result || 'stderr' in result)
        ) {
          const stdout = typeof (result as any).stdout === 'string' ? (result as any).stdout : '';
          const stderr = typeof (result as any).stderr === 'string' ? (result as any).stderr : '';
          const exitCode =
            typeof (result as any).exit_code === 'number'
              ? (result as any).exit_code
              : typeof (result as any).exitCode === 'number'
                ? (result as any).exitCode
                : stderr
                  ? 1
                  : 0;

          structuredMessages.push(
            buildCommandResult(ts, {
              command: typeof (result as any).command === 'string' ? (result as any).command : '',
              exitCode,
              stdout,
              stderr,
            })
          );
          continue;
        }

        let formattedResult: string;
        if (
          toolName === 'Edit' &&
          typeof result === 'string' &&
          result.includes('has been updated.')
        ) {
          formattedResult = truncateString(result);
        } else if ((toolName === 'LS' || toolName === 'Glob') && typeof result === 'string') {
          // This tends to have a lot of files listed and isn't useful to the user.
          formattedResult = truncateString(result, 10);
        } else if (
          typeof result === 'object' &&
          result !== null &&
          'file_path' in result &&
          'content' in result
        ) {
          const filePath = (result as any).file_path;
          const fileContent = (result as any).content as string;
          const lineCount = fileContent.split('\n').length;
          formattedResult = `File: ${filePath}\nLines: ${lineCount}`;
        } else {
          formattedResult = formatValue(result);
        }

        structuredMessages.push({
          type: 'llm_tool_result',
          timestamp: ts,
          toolName,
          resultSummary: formattedResult,
          result,
        });
        continue;
      }

      debugLog('Unknown message type:', content.type);
      structuredMessages.push(
        buildUnknownStatus('claude', ts, formatValue(content), 'unknown_content')
      );
    }

    const rawCombined = rawMessage.filter(Boolean).join('\n');
    // Detect FAILED anywhere in the assistant message (not only first non-empty line)
    const failure =
      message.type === 'assistant' ? detectFailedLineAnywhere(rawCombined) : { failed: false };

    return withMessage({
      type: message.type,
      structured: structuredMessages,
      rawMessage: rawCombined,
      structuredOutput: 'structured_output' in message ? message.structured_output : undefined,
      filePaths: filePaths.length > 0 ? filePaths : undefined,
      failed: failure.failed || undefined,
      failedSummary: failure.failed ? failure.summary : undefined,
    });
  }

  return withMessage({
    type: (message as Record<string, unknown>)?.type as string,
    structured: buildUnknownStatus(
      'claude',
      timestamp(),
      `Unknown message: ${JSON.stringify(message)}`,
      'unknown_message'
    ),
  });
}
