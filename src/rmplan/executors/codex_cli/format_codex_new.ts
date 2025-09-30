// Initial support for the new Codex CLI JSON stream format which will soon replace the existing one
import chalk from 'chalk';
import { createLineSplitter } from '../../../common/process.ts';
import { formatTodoLikeLines } from '../shared/todo_format.ts';
import { debugLog } from '../../../logging.ts';
import type { FormattedCodexMessage } from './format.ts';

export type CodexOutItemType =
  | 'reasoning'
  | 'todo_list'
  | 'command_execution'
  | string
  | null
  | undefined;

export interface CodexOutTodoItem {
  text?: string | null;
  completed?: boolean | null;
  status?: string | null;
  priority?: string | null;
}

export interface CodexOutItem {
  id?: string;
  item_type?: CodexOutItemType;
  text?: string | null;
  items?: CodexOutTodoItem[] | null;
  command?: string | null;
  aggregated_output?: string | null;
  exit_code?: number | null;
  status?: string | null;
  cwd?: string | null;
  [key: string]: unknown;
}

type ItemEventType = 'item.started' | 'item.updated' | 'item.completed';

interface CodexOutItemEventMessage {
  type: ItemEventType;
  item?: CodexOutItem | null;
  [key: string]: unknown;
}

export type CodexOutMessage =
  | { type: 'session.created'; session_id?: string; sessionId?: string }
  | CodexOutItemEventMessage
  | { type?: string; [key: string]: unknown };

const DEFAULT_MAX_LINES = 20;

type HeaderColor = (text: string) => string;

function timestamp(): string {
  return new Date().toTimeString().split(' ')[0];
}

function truncateToLines(input: unknown, maxLines = DEFAULT_MAX_LINES): string {
  if (typeof input !== 'string' || input.length === 0) {
    return '';
  }

  const lines = input.split('\n');
  if (lines.length <= maxLines) {
    return input;
  }

  return [...lines.slice(0, maxLines), '(truncated output...)'].join('\n');
}

function detectFailure(text: string | null | undefined): boolean {
  if (!text) return false;
  const firstContentLine = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .find((line) => line.trim().length > 0);
  if (!firstContentLine) {
    return false;
  }

  return /^\s*FAILED:\s*/.test(firstContentLine);
}

function formatHeader(
  label: string,
  ts: string,
  color: HeaderColor,
  item?: CodexOutItem | null
): string {
  const idTag = item?.id ? ` ${chalk.gray(`[${item.id}]`)}` : '';
  return color(`### ${label} [${ts}]${idTag}`);
}

function ensureTodoItems(items: CodexOutTodoItem[] | null | undefined): CodexOutTodoItem[] {
  return Array.isArray(items) ? items : [];
}

function formatReasoningEvent(
  eventType: ItemEventType,
  item: CodexOutItem | null | undefined,
  ts: string
): FormattedCodexMessage {
  const text = (item?.text ?? '') || '';
  const baseLabel =
    eventType === 'item.started'
      ? 'Thinking'
      : eventType === 'item.updated'
        ? 'Thinking Update'
        : 'Agent Message';
  const color = eventType === 'item.completed' ? chalk.bold.green : chalk.blue;
  const header = formatHeader(baseLabel, ts, color, item);
  const message = text ? `${header}\n\n${text}` : header;

  const formatted: FormattedCodexMessage = {
    type: eventType,
    message,
  };

  if (eventType === 'item.completed' && text) {
    formatted.agentMessage = text;
    if (detectFailure(text)) {
      formatted.failed = true;
    }
  }

  return formatted;
}

function formatTodoListEvent(
  eventType: ItemEventType,
  item: CodexOutItem | null | undefined,
  ts: string
): FormattedCodexMessage {
  const label =
    eventType === 'item.started'
      ? 'Task List'
      : eventType === 'item.updated'
        ? 'Task List Update'
        : 'Task List Summary';
  const header = formatHeader(label, ts, chalk.bold.blue, item);

  const todoItems = ensureTodoItems(item?.items).map((todo) => ({
    label: (todo.text ?? '').trim() || '(missing item text)',
    status: todo.status ?? (todo.completed ? 'completed' : 'pending'),
  }));

  const todoLines = formatTodoLikeLines(todoItems, { includePriority: false });
  const body = todoLines.length > 0 ? todoLines.join('\n') : chalk.gray('No todo items provided.');

  return {
    type: eventType,
    message: `${header}\n\n${body}`,
  };
}

function formatCommandEvent(
  eventType: ItemEventType,
  item: CodexOutItem | null | undefined,
  ts: string
): FormattedCodexMessage {
  const status = (item?.status ?? '').toLowerCase();
  const exitCode = typeof item?.exit_code === 'number' ? item.exit_code : undefined;
  const output = item?.aggregated_output ?? '';
  const command = item?.command ?? '';
  let label: string;
  let color: HeaderColor = chalk.cyan;

  if (eventType === 'item.started') {
    label = 'Command Start';
  } else if (eventType === 'item.updated') {
    label = 'Command Update';
  } else {
    const failed = status === 'failed' || (typeof exitCode === 'number' && exitCode !== 0);
    label = failed ? 'Command Failed' : 'Command End';
    color = failed ? chalk.red : chalk.cyan;
  }

  const header = formatHeader(label, ts, color, item);

  const segments: string[] = [];
  if (command) {
    segments.push(command);
  }
  if (item?.cwd) {
    segments.push(`CWD: ${item.cwd}`);
  }
  const meta: string[] = [];
  if (status) {
    meta.push(`Status: ${status}`);
  }
  if (typeof exitCode === 'number') {
    meta.push(`Exit Code: ${exitCode}`);
  }
  if (meta.length > 0) {
    segments.push(meta.join(' • '));
  }

  const truncatedOutput = truncateToLines(output, DEFAULT_MAX_LINES);
  if (truncatedOutput) {
    segments.push(truncatedOutput);
  }

  const message = [header, ...segments].join('\n\n');
  return {
    type: eventType,
    message,
  };
}

function formatUnknownItem(
  eventType: ItemEventType,
  item: CodexOutItem | null | undefined,
  ts: string
): FormattedCodexMessage {
  const itemType = item?.item_type ? String(item.item_type) : 'unknown';
  const header = formatHeader(`Item ${itemType}`, ts, chalk.gray, item);
  const serialized = item ? JSON.stringify(item, null, 2) : 'No item payload provided.';
  return {
    type: eventType,
    message: `${header}\n\n${serialized}`,
  };
}

function formatItemEvent(
  eventType: ItemEventType,
  item: CodexOutItem | null | undefined,
  ts: string
): FormattedCodexMessage {
  const itemType = typeof item?.item_type === 'string' ? item.item_type : null;
  switch (itemType) {
    case 'reasoning':
      return formatReasoningEvent(eventType, item, ts);
    case 'todo_list':
      return formatTodoListEvent(eventType, item, ts);
    case 'command_execution':
      return formatCommandEvent(eventType, item, ts);
    default:
      return formatUnknownItem(eventType, item, ts);
  }
}

export function formatCodexOutJsonMessage(jsonLine: string): FormattedCodexMessage {
  try {
    if (!jsonLine || jsonLine.trim() === '') {
      return { type: '' };
    }
    debugLog('codex-out:', jsonLine);
    const parsed = JSON.parse(jsonLine) as CodexOutMessage;
    const ts = timestamp();

    switch (parsed.type) {
      case 'session.created': {
        const sessionId = parsed.session_id ?? parsed.sessionId;
        const header = formatHeader('Session Created', ts, chalk.bold.green);
        const details = sessionId ? `Session ID: ${sessionId}` : undefined;
        return {
          type: parsed.type,
          message: details ? `${header}\n\n${details}` : header,
        };
      }
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const itemMessage = parsed as CodexOutItemEventMessage;
        return formatItemEvent(itemMessage.type, itemMessage.item ?? undefined, ts);
      }
      default: {
        return {
          type: typeof parsed.type === 'string' ? parsed.type : 'unknown',
          message: JSON.stringify(parsed),
        };
      }
    }
  } catch (error) {
    debugLog('Failed to parse codex-out line:', jsonLine, error);
    return { type: 'parse_error', message: jsonLine };
  }
}

export function createCodexOutStdoutFormatter() {
  const split = createLineSplitter();
  let finalAgentMessage: string | undefined;
  let lastFailedAgentMessage: string | undefined;

  function formatChunk(chunk: string): string {
    const lines = split(chunk);
    const output: string[] = [];
    for (const line of lines) {
      const formatted = formatCodexOutJsonMessage(line);
      if (formatted.agentMessage) {
        finalAgentMessage = formatted.agentMessage;
        if (formatted.failed) {
          lastFailedAgentMessage = formatted.agentMessage;
        }
      }
      if (formatted.message) {
        output.push(formatted.message);
      }
    }

    return output.length > 0 ? `${output.join('\n\n')}\n\n` : '';
  }

  function getFinalAgentMessage(): string | undefined {
    return finalAgentMessage;
  }

  function getFailedAgentMessage(): string | undefined {
    return lastFailedAgentMessage;
  }

  return { formatChunk, getFinalAgentMessage, getFailedAgentMessage };
}
