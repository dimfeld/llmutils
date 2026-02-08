import chalk from 'chalk';
import { createLineSplitter } from '../../../common/process.ts';
import { debugLog } from '../../../logging.ts';
import type { StructuredMessage } from '../../../logging/structured_messages.ts';
import {
  buildCommandResult,
  buildParseErrorStatus,
  buildSessionStart,
  buildTodoUpdate,
  buildUnknownStatus,
} from '../shared/structured_message_builders.ts';

interface RateLimitInfo {
  used_percent: number;
  window_minutes: number;
  resets_in_seconds: number;
}

interface CodexOutUsage {
  input_tokens?: number | null;
  cached_input_tokens?: number | null;
  output_tokens?: number | null;
  reasoning_tokens?: number | null;
  total_tokens?: number | null;
  [key: string]: unknown;
}

interface CodexOutTodoItem {
  text?: string | null;
  completed?: boolean | null;
  status?: string | null;
  priority?: string | null;
  [key: string]: unknown;
}

interface CodexOutFileChange {
  path?: string | null;
  kind?: 'add' | 'update' | 'remove' | string | null;
  [key: string]: unknown;
}

interface CodexOutItem {
  id?: string | number | null;
  item_type?: string | null;
  type?: string | null;
  text?: string | null;
  items?: CodexOutTodoItem[] | null;
  command?: string | string[] | null;
  aggregated_output?: string | null;
  formatted_output?: string | null;
  stdout?: string | null;
  stderr?: string | null;
  chunk?: string | null;
  encoding?: 'base64' | 'utf8' | string | null;
  exit_code?: number | null;
  status?: string | null;
  cwd?: string | null;
  unified_diff?: string | null;
  diff?: string | null;
  changes?: Record<string, unknown> | CodexOutFileChange[] | null;
  auto_approved?: boolean | null;
  [key: string]: unknown;
}

type CodexOutEventType =
  | 'thread.started'
  | 'turn.started'
  | 'turn.completed'
  | 'item.started'
  | 'item.updated'
  | 'item.completed'
  | 'item.delta'
  | string;

interface CodexOutMessage {
  type?: CodexOutEventType;
  item?: CodexOutItem | null;
  usage?: CodexOutUsage | null;
  rate_limits?: {
    primary?: RateLimitInfo | null;
    secondary?: RateLimitInfo | null;
    [key: string]: unknown;
  } | null;
  thread_id?: string | null;
  session_id?: string | null;
  sessionId?: string | null;
  [key: string]: unknown;
}

function formatResetsInSeconds(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  seconds -= days * 86400;
  const hours = Math.floor(seconds / 3600);
  seconds -= hours * 3600;
  if (days > 1) {
    return [`${days}d`, hours ? `${hours}h` : ''].filter(Boolean).join(' ');
  }

  if (hours > 1) {
    // if hours is 2 or more just ignore minutes
    return `${hours}h`;
  }

  const minutes = Math.floor(seconds / 60);
  return `${hours}h ${minutes}m`;
}

function formatMinutes(minutes: number): string {
  const days = Math.floor(minutes / 1440);
  minutes -= days * 1440;
  const hours = Math.floor(minutes / 60);
  minutes -= hours * 60;

  const parts: string[] = [
    days ? `${days}d` : '',
    hours ? `${hours}h` : '',
    minutes ? `${minutes}m` : '',
  ];

  return parts.filter(Boolean).join(', ');
}

function shouldWarnRateLimit(rateLimit: RateLimitInfo): boolean {
  const windowSeconds = rateLimit.window_minutes * 60;
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
    return false;
  }

  if (rateLimit.used_percent >= 100) {
    return true;
  }

  const resetsInSeconds = Number.isFinite(rateLimit.resets_in_seconds)
    ? rateLimit.resets_in_seconds
    : windowSeconds;
  const remainingSeconds = Math.min(windowSeconds, Math.max(0, resetsInSeconds));
  const elapsedSeconds = windowSeconds - remainingSeconds;
  if (elapsedSeconds <= 0) {
    return false;
  }

  const usageFraction = Math.max(0, rateLimit.used_percent) / 100;
  const projectedFraction = usageFraction * (windowSeconds / elapsedSeconds);
  return projectedFraction >= 1;
}

function formatRateLimit(rateLimit: RateLimitInfo): string {
  // We get values like 299 and 10079 instead of 300 and 10080. Hack to work around that.
  let window_minutes = rateLimit.window_minutes;
  if (window_minutes % 10 === 9) {
    window_minutes += 1;
  }
  const warning = shouldWarnRateLimit(rateLimit) ? ' ⚠️' : '';
  return `${Math.round(rateLimit.used_percent)}% of ${formatMinutes(window_minutes)} (New in ${formatResetsInSeconds(
    rateLimit.resets_in_seconds
  )})${warning}`;
}

export interface FormattedCodexMessage {
  // Structured message payload(s) for headless consumers
  structured?: StructuredMessage | StructuredMessage[];
  // A simplified type label for routing/logic
  type: string;
  // If this line carries or finalizes the agent message, include it here
  agentMessage?: string;
  // Codex thread/session identifiers surfaced in the stream
  threadId?: string;
  sessionId?: string;
  // The "last token count" from a `token_count` message
  lastTokenCount?: number;
  // Failure detection info for agent messages
  failed?: boolean;
}

function truncateToLines(input: string | undefined, maxLines = 20): string {
  if (!input) return '';
  const lines = input.split('\n');
  if (lines.length <= maxLines) return input;
  return [...lines.slice(0, maxLines), '(truncated long output...)'].join('\n');
}

function isCodexOutMessage(value: unknown): value is CodexOutMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const maybeMessage = value as Record<string, unknown>;
  if ('msg' in maybeMessage) {
    return false;
  }

  if (typeof maybeMessage.type !== 'string') {
    return false;
  }

  return true;
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

function ensureTodoItems(items: CodexOutTodoItem[] | null | undefined): CodexOutTodoItem[] {
  return Array.isArray(items) ? items : [];
}

function resolveItemType(item: CodexOutItem | null | undefined): string {
  if (!item) return 'unknown';
  const type = item.item_type ?? item.type;
  return typeof type === 'string' && type.length > 0 ? type : 'unknown';
}

function normalizeCommand(command: string | string[] | null | undefined): string | undefined {
  if (typeof command === 'string') {
    return command;
  }
  if (Array.isArray(command)) {
    return command.map((part) => String(part)).join(' ');
  }
  return undefined;
}

function formatReasoningItem(
  eventType: 'item.started' | 'item.updated' | 'item.completed',
  item: CodexOutItem | null | undefined,
  ts: string
): FormattedCodexMessage {
  const text = item?.text || '';
  const formatted: FormattedCodexMessage = {
    type: eventType,
    structured: {
      type: 'llm_thinking',
      timestamp: ts,
      text,
    },
  };

  if (eventType === 'item.completed' && text) {
    formatted.agentMessage = text;
    if (detectFailure(text)) {
      formatted.failed = true;
    }
  }

  return formatted;
}

function formatAgentMessageItem(
  _eventType: 'item.started' | 'item.updated' | 'item.completed',
  item: CodexOutItem | null | undefined,
  ts: string
): FormattedCodexMessage {
  const text = item?.text || '';
  return {
    type: 'agent_message',
    structured: {
      type: 'llm_response',
      timestamp: ts,
      text,
    },
    agentMessage: text || undefined,
    failed: detectFailure(text) || undefined,
  };
}

function formatTodoListItem(
  _eventType: 'item.started' | 'item.updated' | 'item.completed',
  item: CodexOutItem | null | undefined,
  ts: string
): FormattedCodexMessage {
  const todoItems = ensureTodoItems(item?.items).map((todo) => ({
    label: (todo.text ?? '').trim() || '(missing item text)',
    status: todo.status ?? (todo.completed ? 'completed' : 'pending'),
  }));

  return {
    type: 'plan_update',
    structured: buildTodoUpdate('codex', ts, todoItems),
  };
}

function formatCommandItem(
  eventType: 'item.started' | 'item.updated' | 'item.completed',
  item: CodexOutItem | null | undefined,
  ts: string
): FormattedCodexMessage {
  const status = (item?.status ?? '').toString().toLowerCase();
  const exitCode = typeof item?.exit_code === 'number' ? item.exit_code : undefined;
  const command = normalizeCommand(item?.command ?? null);
  const cwd = item?.cwd ? `CWD: ${item.cwd}` : undefined;
  const outputSource =
    item?.aggregated_output ?? item?.formatted_output ?? item?.stdout ?? item?.text ?? '';
  const output = truncateToLines(outputSource, 20);

  const details: string[] = [];
  if (command) details.push(command);
  if (cwd) details.push(cwd);

  const meta: string[] = [];
  if (typeof exitCode === 'number' && exitCode !== 0) meta.push(`Exit Code: ${exitCode}`);
  if (meta.length > 0) details.push(meta.join(' • '));
  if (output) details.push(output);

  return {
    type: 'command_execution',
    structured:
      eventType === 'item.completed'
        ? buildCommandResult(ts, {
            command,
            exitCode: typeof exitCode === 'number' ? exitCode : status === 'failed' ? 1 : 0,
            stdout: item?.stdout ?? item?.aggregated_output ?? '',
            stderr: item?.stderr ?? '',
          })
        : {
            type: 'command_exec',
            timestamp: ts,
            command: command ?? '',
            cwd: item?.cwd ?? undefined,
          },
  };
}

function formatDiffItem(
  eventType: 'item.started' | 'item.updated' | 'item.completed',
  item: CodexOutItem | null | undefined,
  ts: string
): FormattedCodexMessage {
  const diffText = item?.unified_diff ?? item?.diff ?? item?.aggregated_output ?? item?.text ?? '';
  const diff = typeof diffText === 'string' ? diffText : '';

  const fileMatches = diff.match(/^(?:\+\+\+|---) (.+)$/gm) || [];
  const filenames = fileMatches
    .map((match) => match.replace(/^(?:\+\+\+|---) /, '').replace(/\t.*$/, ''))
    .filter((filename) => filename !== '/dev/null')
    .map((filename) => {
      if (filename.startsWith('a/') || filename.startsWith('b/')) {
        return filename.substring(2);
      }
      return filename;
    });
  const uniqueFiles = [...new Set(filenames)];

  const diffLines = diff.split('\n');
  let addedLines = 0;
  let removedLines = 0;
  for (const line of diffLines) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      addedLines++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      removedLines++;
    }
  }

  const fileCount = uniqueFiles.length;
  const fileText = fileCount === 1 ? '1 file' : `${fileCount} files`;
  const fileList =
    fileCount <= 3
      ? uniqueFiles.join(', ')
      : `${uniqueFiles.slice(0, 3).join(', ')} and ${fileCount - 3} more`;
  const changeStats: string[] = [];
  if (addedLines > 0) changeStats.push(chalk.green(`+${addedLines}`));
  if (removedLines > 0) changeStats.push(chalk.red(`-${removedLines}`));
  const statsText = changeStats.length > 0 ? ` (${changeStats.join(', ')})` : '';

  const summary =
    uniqueFiles.length > 0
      ? `Changes to ${fileText}: ${fileList}${statsText}`
      : `Changes detected${statsText}`;

  return {
    type: 'turn_diff',
    structured: (() => {
      if (uniqueFiles.length === 0) {
        return {
          type: 'llm_status' as const,
          timestamp: ts,
          status: 'codex.diff.no_files',
          detail: summary,
        };
      }

      const changesByPath = new Map<string, 'added' | 'updated' | 'removed'>();
      const diffHeaderLines = diff.split('\n');
      let oldPath: string | undefined;

      const normalizeDiffPath = (path: string): string | undefined => {
        if (path === '/dev/null') return undefined;
        if (path.startsWith('a/') || path.startsWith('b/')) {
          return path.substring(2);
        }
        return path;
      };

      const addChange = (path: string, kind: 'added' | 'updated' | 'removed') => {
        const existing = changesByPath.get(path);
        if (!existing || existing === kind) {
          changesByPath.set(path, kind);
          return;
        }

        if (existing === 'updated' || kind === 'updated') {
          changesByPath.set(path, 'updated');
          return;
        }

        changesByPath.set(path, 'updated');
      };

      for (const line of diffHeaderLines) {
        const oldMatch = /^--- (.+?)(?:\t.*)?$/.exec(line);
        if (oldMatch) {
          oldPath = oldMatch[1];
          continue;
        }

        const newMatch = /^\+\+\+ (.+?)(?:\t.*)?$/.exec(line);
        if (!newMatch) {
          continue;
        }

        const newPath = newMatch[1];
        const normalizedOldPath = oldPath ? normalizeDiffPath(oldPath) : undefined;
        const normalizedNewPath = normalizeDiffPath(newPath);

        if (oldPath === '/dev/null' && normalizedNewPath) {
          addChange(normalizedNewPath, 'added');
        } else if (newPath === '/dev/null' && normalizedOldPath) {
          addChange(normalizedOldPath, 'removed');
        } else {
          const updatedPath = normalizedNewPath ?? normalizedOldPath;
          if (updatedPath) {
            addChange(updatedPath, 'updated');
          }
        }

        oldPath = undefined;
      }

      if (changesByPath.size === 0) {
        for (const path of uniqueFiles) {
          addChange(path, 'updated');
        }
      }

      return {
        type: 'file_change_summary' as const,
        timestamp: ts,
        changes: [...changesByPath.entries()].map(([path, kind]) => ({ path, kind })),
      };
    })(),
  };
}

function formatPatchApplyItem(
  eventType: 'item.started' | 'item.updated' | 'item.completed',
  item: CodexOutItem | null | undefined,
  ts: string
): FormattedCodexMessage {
  const changes = item?.changes && typeof item.changes === 'object' ? item.changes : {};
  const entries = Object.entries(changes as Record<string, any>);
  if (entries.length === 0) {
    return {
      type: 'patch_apply',
      structured: {
        type: 'llm_status',
        timestamp: ts,
        status: 'codex.patch_apply.no_changes',
        detail: 'No change details provided.',
      },
    };
  }

  return {
    type: 'patch_apply',
    structured: {
      type: 'file_change_summary',
      timestamp: ts,
      changes: entries.map(([filePath, change]) => {
        if (change && typeof change === 'object') {
          if ('add' in change) {
            return { path: filePath, kind: 'added' as const };
          }
          if ('update' in change) {
            return { path: filePath, kind: 'updated' as const };
          }
          if ('remove' in change) {
            return { path: filePath, kind: 'removed' as const };
          }
        }

        return { path: filePath, kind: 'updated' as const };
      }),
    },
  };
}

function formatUnknownItem(
  eventType: 'item.started' | 'item.updated' | 'item.completed',
  item: CodexOutItem | null | undefined,
  ts: string
): FormattedCodexMessage {
  const itemType = resolveItemType(item);
  const serialized = item ? JSON.stringify(item, null, 2) : 'No item payload provided.';
  return {
    type: eventType,
    structured: {
      type: 'llm_status',
      timestamp: ts,
      status: `item.${itemType}`,
      detail: serialized,
    },
  };
}

function formatFileChangeItem(
  eventType: 'item.started' | 'item.updated' | 'item.completed',
  item: CodexOutItem | null | undefined,
  ts: string
): FormattedCodexMessage {
  const changes = Array.isArray(item?.changes) ? item.changes : [];

  if (changes.length === 0) {
    return {
      type: 'file_change',
      structured: {
        type: 'llm_status',
        timestamp: ts,
        status: 'codex.file_change.no_changes',
        detail: 'No file changes provided.',
      },
    };
  }

  const changesByKind: Record<string, string[]> = {};
  for (const change of changes) {
    const kind = (change.kind ?? 'unknown').toString();
    const path = change.path ?? '(unknown path)';
    if (!changesByKind[kind]) {
      changesByKind[kind] = [];
    }
    changesByKind[kind].push(path.toString());
  }

  const summary: string[] = [];
  if (changesByKind.add) {
    summary.push(`${chalk.green('Added')}: ${changesByKind.add.join(', ')}`);
  }
  if (changesByKind.update) {
    summary.push(`${chalk.cyan('Updated')}: ${changesByKind.update.join(', ')}`);
  }
  if (changesByKind.remove) {
    summary.push(`${chalk.red('Removed')}: ${changesByKind.remove.join(', ')}`);
  }
  if (changesByKind.unknown) {
    summary.push(`${chalk.gray('Unknown')}: ${changesByKind.unknown.join(', ')}`);
  }

  return {
    type: 'file_change',
    structured: {
      type: 'file_change_summary',
      timestamp: ts,
      changes: changes.map((change) => ({
        path: String(change.path ?? '(unknown path)'),
        kind:
          change.kind === 'add'
            ? ('added' as const)
            : change.kind === 'remove'
              ? ('removed' as const)
              : ('updated' as const),
      })),
    },
  };
}

function formatCodexOutItemEvent(
  eventType: 'item.started' | 'item.updated' | 'item.completed',
  item: CodexOutItem | null | undefined,
  ts: string
): FormattedCodexMessage {
  const itemType = resolveItemType(item);
  switch (itemType) {
    case 'reasoning':
      return formatReasoningItem(eventType, item, ts);
    case 'agent_message':
      return formatAgentMessageItem(eventType, item, ts);
    case 'todo_list':
      return formatTodoListItem(eventType, item, ts);
    case 'command_execution':
      return formatCommandItem(eventType, item, ts);
    case 'diff':
    case 'turn_diff':
      return formatDiffItem(eventType, item, ts);
    case 'patch_apply':
    case 'patch_application':
      return formatPatchApplyItem(eventType, item, ts);
    case 'file_change':
      return formatFileChangeItem(eventType, item, ts);
    default:
      return formatUnknownItem(eventType, item, ts);
  }
}

function formatCodexOutUsageMessage(message: CodexOutMessage, ts: string): FormattedCodexMessage {
  const usage = message.usage ?? {};
  const inputTokens = Number(usage.input_tokens ?? 0);
  const cachedTokens = Number(usage.cached_input_tokens ?? 0);
  const outputTokens = Number(usage.output_tokens ?? 0);
  const reasoningTokens = Number(usage.reasoning_tokens ?? 0);
  const totalTokensExplicit = Number(usage.total_tokens ?? 0);

  const effectiveInputTokens = Math.max(0, inputTokens - cachedTokens);
  const computedTotal = effectiveInputTokens + outputTokens + reasoningTokens;
  const totalTokens = totalTokensExplicit > 0 ? totalTokensExplicit : computedTotal;

  const parts: string[] = [];
  if (inputTokens > 0) {
    parts.push(`Input: ${inputTokens.toLocaleString()} tokens`);
  }
  if (cachedTokens > 0) {
    parts.push(`  Cached: ${cachedTokens.toLocaleString()} tokens`);
  }
  if (effectiveInputTokens > 0 && cachedTokens > 0) {
    parts.push(`  Effective Input: ${effectiveInputTokens.toLocaleString()} tokens`);
  }
  if (outputTokens > 0) {
    parts.push(`Output: ${outputTokens.toLocaleString()} tokens`);
  }
  if (reasoningTokens > 0) {
    parts.push(`Reasoning: ${reasoningTokens.toLocaleString()} tokens`);
  }
  if (totalTokens > 0) {
    parts.push(`Total: ${totalTokens.toLocaleString()} tokens`);
  }

  const rateLimits = message.rate_limits;
  if (rateLimits) {
    const rateLimitInfo: string[] = [];
    if (rateLimits.primary) {
      rateLimitInfo.push(formatRateLimit(rateLimits.primary));
    }
    if (rateLimits.secondary) {
      rateLimitInfo.push(formatRateLimit(rateLimits.secondary));
    }
    if (rateLimitInfo.length > 0) {
      parts.push(`Rate Limits: ${rateLimitInfo.join('\t\t')}`);
    }
  }

  return {
    type: 'turn.completed',
    lastTokenCount: totalTokens > 0 ? totalTokens : undefined,
    structured: {
      type: 'token_usage',
      timestamp: ts,
      inputTokens: inputTokens > 0 ? inputTokens : undefined,
      cachedInputTokens: cachedTokens > 0 ? cachedTokens : undefined,
      outputTokens: outputTokens > 0 ? outputTokens : undefined,
      reasoningTokens: reasoningTokens > 0 ? reasoningTokens : undefined,
      totalTokens: totalTokens > 0 ? totalTokens : undefined,
      rateLimits: rateLimits ?? undefined,
    },
  };
}

function formatCodexOutMessage(message: CodexOutMessage, ts: string): FormattedCodexMessage {
  switch (message.type) {
    case 'thread.started': {
      return {
        type: 'thread.started',
        threadId: message.thread_id ?? undefined,
        structured: buildSessionStart(ts, 'codex', { threadId: message.thread_id ?? undefined }),
      };
    }
    case 'turn.started': {
      return {
        type: 'task_started',
        structured: {
          type: 'agent_step_start',
          timestamp: ts,
          phase: 'turn',
          message: 'Turn started',
        },
      };
    }
    case 'turn.completed': {
      return formatCodexOutUsageMessage(message, ts);
    }
    case 'item.started':
    case 'item.updated':
    case 'item.completed': {
      return formatCodexOutItemEvent(message.type, message.item ?? undefined, ts);
    }
    case 'item.delta': {
      // Streamed deltas can be noisy; skip detailed printing.
      return { type: 'item.delta' };
    }
    case 'session.created': {
      const sessionId = message.session_id ?? message.sessionId;
      return {
        type: 'session.created',
        sessionId: sessionId ?? undefined,
        structured: buildSessionStart(ts, 'codex', { sessionId: sessionId ?? undefined }),
      };
    }
    default: {
      const typeLabel =
        typeof message.type === 'string' && message.type.length > 0 ? message.type : 'unknown';
      return {
        type: typeLabel,
        threadId: message.thread_id ?? undefined,
        sessionId: (message as any).session_id ?? (message as any).sessionId ?? undefined,
        structured: buildUnknownStatus('codex', ts, JSON.stringify(message), typeLabel),
      };
    }
  }
}

export function formatCodexJsonMessage(jsonLine: string): FormattedCodexMessage {
  try {
    if (!jsonLine || jsonLine.trim() === '') return { type: '' };
    debugLog(`codex: `, jsonLine);
    const ts = new Date().toISOString();
    const parsed = JSON.parse(jsonLine) as unknown;

    if (!parsed || typeof parsed !== 'object') {
      return {
        type: 'unknown',
        structured: buildUnknownStatus('codex', ts, jsonLine),
      };
    }

    if (isCodexOutMessage(parsed)) {
      return formatCodexOutMessage(parsed, ts);
    }

    return {
      type: 'unknown',
      structured: buildUnknownStatus('codex', ts, JSON.stringify(parsed)),
    };
  } catch (err) {
    debugLog('Failed to parse Codex JSON line:', jsonLine, err);
    const ts = new Date().toISOString();
    return {
      type: 'parse_error',
      structured: buildParseErrorStatus('codex', ts, jsonLine),
    };
  }
}

/**
 * Utility to integrate with spawnAndLogOutput.formatStdout. Handles chunk splitting,
 * line-by-line JSON parsing/formatting, and captures the final agent message.
 */
export function createCodexStdoutFormatter() {
  const split = createLineSplitter();
  let finalAgentMessage: string | undefined;
  let lastFailedAgentMessage: string | undefined;
  let threadId: string | undefined;
  let sessionId: string | undefined;

  let previousTokenCount = -1;

  function formatChunk(chunk: string): StructuredMessage[] | string {
    const lines = split(chunk);
    const structuredMessages: StructuredMessage[] = [];
    for (const line of lines) {
      const fm = formatCodexJsonMessage(line);

      const isUsageMessage = fm.type === 'turn.completed' && fm.lastTokenCount != null;

      if (isUsageMessage) {
        const lastTokenCount = fm.lastTokenCount as number;
        if (previousTokenCount === lastTokenCount) {
          // this one is a duplicate of the previous token count, skip to avoid being too noisy
          continue;
        }

        previousTokenCount = lastTokenCount;
      }

      if (fm.agentMessage) {
        finalAgentMessage = fm.agentMessage;
        if (fm.failed) lastFailedAgentMessage = fm.agentMessage;
      }
      if (fm.threadId && !threadId) {
        threadId = fm.threadId;
      }
      if (fm.sessionId && !sessionId) {
        sessionId = fm.sessionId;
      }
      if (fm.structured) {
        if (Array.isArray(fm.structured)) {
          structuredMessages.push(...fm.structured);
        } else {
          structuredMessages.push(fm.structured);
        }
      }
    }
    return structuredMessages.length > 0 ? structuredMessages : '';
  }

  function getFinalAgentMessage(): string | undefined {
    return finalAgentMessage;
  }

  function getFailedAgentMessage(): string | undefined {
    return lastFailedAgentMessage;
  }

  function getThreadId(): string | undefined {
    return threadId;
  }

  function getSessionId(): string | undefined {
    return sessionId;
  }

  return { formatChunk, getFinalAgentMessage, getFailedAgentMessage, getThreadId, getSessionId };
}
