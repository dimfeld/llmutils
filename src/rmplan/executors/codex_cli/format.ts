import chalk from 'chalk';
import { createLineSplitter } from '../../../common/process.ts';
import { formatTodoLikeLines } from '../shared/todo_format.ts';
import { debugLog } from '../../../logging.ts';

// Envelope for Codex CLI JSON stream lines
export interface CodexEnvelope<T = unknown> {
  id?: string | number;
  msg?: T;
  // Some initial line may not be under `msg` – accept arbitrary fields
  [key: Exclude<string, 'id' | 'msg'>]: any;
}

interface AnyMessage {
  type: string;

  [key: string]: any;
}

interface RateLimitInfo {
  used_percent: number;
  window_minutes: number;
  resets_in_seconds: number;
}

interface TokenUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
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

// Known Codex message variants (inside envelope.msg)
export type CodexMessage =
  | { type: 'task_started'; model_context_window?: number }
  | { type: 'agent_reasoning'; text?: string }
  | { type: 'agent_reasoning_section_break' }
  | {
      type: 'exec_command_begin';
      call_id: string;
      command: string[];
      cwd?: string;
      parsed_cmd?: unknown;
    }
  | {
      type: 'exec_command_output_delta';
      call_id: string;
      stream: 'stdout' | 'stderr';
      chunk: string; // often base64-encoded
      encoding?: 'base64' | 'utf8';
    }
  | {
      type: 'exec_command_end';
      call_id: string;
      stdout?: string;
      stderr?: string;
      exit_code: number;
      duration?: { secs?: number; nanos?: number };
      formatted_output?: string;
      aggregated_output?: string;
    }
  | {
      type: 'token_count';
      info: {
        total_token_usage: TokenUsage;
        last_token_usage: TokenUsage;
        model_context_window: number;
      };
      rate_limits: {
        primary: RateLimitInfo;
        secondary: RateLimitInfo;
      };
    }
  | { type: 'agent_message'; message?: string }
  | {
      type: 'plan_update';
      explanation?: string | null;
      plan?: Array<{ step: string; status?: string | null }>;
    }
  | { type: 'turn_diff'; unified_diff?: string }
  | {
      type: 'patch_apply_begin';
      call_id: string;
      auto_approved?: boolean;
      changes: Record<
        string,
        | {
            add: { content: string };
          }
        | { update: { unified_diff?: string; move_path: string | null } }
      >;
    }
  | {
      type: 'patch_apply_end';
      call_id: string;
      stdout?: string;
      stderr?: string;
      success?: boolean;
    };

export interface FormattedCodexMessage {
  // Pretty-printed message to display to the console (optional for ignored types)
  message?: string;
  // A simplified type label for routing/logic
  type: string;
  // If this line carries or finalizes the agent message, include it here
  agentMessage?: string;
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

// Some codex lines may be plain objects describing initial run config (before `task_started`).
function tryFormatInitial(lineObj: CodexEnvelope): FormattedCodexMessage | undefined {
  if (lineObj && !lineObj.msg && (lineObj.model || lineObj.provider || lineObj.sandbox)) {
    const ts = new Date().toTimeString().split(' ')[0];
    const desc = [
      lineObj.model ? `Model: ${lineObj.model}` : undefined,
      lineObj['reasoning effort'] ? `Reasoning Effort: ${lineObj['reasoning effort']}` : undefined,
      lineObj.provider ? `Provider: ${lineObj.provider}` : undefined,
      lineObj.sandbox ? `Sandbox: ${lineObj.sandbox}` : undefined,
      lineObj.workdir ? `Workdir: ${lineObj.workdir}` : undefined,
      lineObj.approval ? `Approval: ${lineObj.approval}` : undefined,
    ]
      .filter(Boolean)
      .join(', ');
    return { message: chalk.bold.green(`### Start [${ts}]\n`) + desc, type: 'init' };
  }
  return undefined;
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

type HeaderColor = (text: string) => string;

function formatHeader(
  label: string,
  ts: string,
  color: HeaderColor,
  item?: CodexOutItem | null
): string {
  const id = item?.id;
  const idTag = typeof id === 'string' || typeof id === 'number' ? ` ${chalk.gray(`[${id}]`)}` : '';
  return color(`### ${label} [${ts}]${idTag}`);
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
  const text = (item?.text ?? '') || '';
  const headerLabel =
    eventType === 'item.started'
      ? 'Thinking'
      : eventType === 'item.updated'
        ? 'Thinking Update'
        : 'Agent Message';
  const headerColor = eventType === 'item.completed' ? chalk.bold.green : chalk.blue;
  const header = formatHeader(headerLabel, ts, headerColor, item);
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

function formatAgentMessageItem(
  eventType: 'item.started' | 'item.updated' | 'item.completed',
  item: CodexOutItem | null | undefined,
  ts: string
): FormattedCodexMessage {
  const text = (item?.text ?? '') || '';
  const header = formatHeader('Agent Message', ts, chalk.bold.green, item);
  const message = text ? `${header}\n\n${text}` : header;
  return {
    type: 'agent_message',
    message,
    agentMessage: text || undefined,
    failed: detectFailure(text) || undefined,
  };
}

function formatTodoListItem(
  eventType: 'item.started' | 'item.updated' | 'item.completed',
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
    priority: todo.priority ?? undefined,
  }));

  const todoLines = formatTodoLikeLines(todoItems, { includePriority: false });
  const body = todoLines.length > 0 ? todoLines.join('\n') : chalk.gray('No todo items provided.');

  return {
    type: 'plan_update',
    message: `${header}\n\n${body}`,
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

  let label: string;
  let color: HeaderColor = chalk.cyan;
  if (eventType === 'item.started') {
    label = 'Exec Begin';
  } else if (eventType === 'item.updated') {
    label = 'Exec Update';
  } else {
    const failed = status === 'failed' || (typeof exitCode === 'number' && exitCode !== 0);
    color = failed ? chalk.red : chalk.cyan;
    label = failed ? 'Exec Failed' : 'Exec End';
  }

  const header = formatHeader(label, ts, color, item);
  const details: string[] = [];
  if (command) details.push(command);
  if (cwd) details.push(cwd);

  const meta: string[] = [];
  if (status) meta.push(`Status: ${status}`);
  if (typeof exitCode === 'number') meta.push(`Exit Code: ${exitCode}`);
  if (meta.length > 0) details.push(meta.join(' • '));
  if (output) details.push(output);

  return {
    type: 'command_execution',
    message: [header, ...details].join('\n\n'),
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

  const label = eventType === 'item.started' ? 'Diff Start' : 'Diff';
  const header = formatHeader(label, ts, chalk.magenta, item);
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
    message: `${header}\n\n${summary}`,
  };
}

function formatPatchApplyItem(
  eventType: 'item.started' | 'item.updated' | 'item.completed',
  item: CodexOutItem | null | undefined,
  ts: string
): FormattedCodexMessage {
  const autoApproved = item?.auto_approved ? ' (auto-approved)' : '';
  const headerLabel =
    eventType === 'item.started'
      ? `Patch Apply Begin${autoApproved}`
      : eventType === 'item.updated'
        ? `Patch Apply Update${autoApproved}`
        : `Patch Apply End${autoApproved}`;
  const header = formatHeader(headerLabel, ts, chalk.yellow, item);
  const changes = item?.changes && typeof item.changes === 'object' ? item.changes : {};
  const entries = Object.entries(changes as Record<string, any>);
  if (entries.length === 0) {
    return {
      type: 'patch_apply',
      message: `${header}\n\n${chalk.gray('No change details provided.')}`,
    };
  }

  const formattedChanges = entries
    .map(([filePath, change]) => {
      if (change && typeof change === 'object') {
        if ('add' in change && change.add && typeof change.add === 'object') {
          const content = truncateToLines(String((change.add as any).content ?? ''), 10);
          return `${chalk.green('ADD')} ${filePath}:\n${content}`;
        }
        if ('update' in change && change.update && typeof change.update === 'object') {
          const update = change.update as Record<string, unknown>;
          const diff = truncateToLines(String(update.unified_diff ?? ''), 10);
          const movePath =
            typeof update.move_path === 'string' && update.move_path.length > 0
              ? ` -> ${update.move_path}`
              : '';
          return `${chalk.cyan('UPDATE')} ${filePath}${movePath}:\n${diff}`;
        }
        if ('remove' in change) {
          return `${chalk.red('REMOVE')} ${filePath}`;
        }
      }
      return `${chalk.gray('UNKNOWN')} ${filePath}: ${JSON.stringify(change)}`;
    })
    .join('\n\n');

  return {
    type: 'patch_apply',
    message: `${header}\n\n${formattedChanges}`,
  };
}

function formatUnknownItem(
  eventType: 'item.started' | 'item.updated' | 'item.completed',
  item: CodexOutItem | null | undefined,
  ts: string
): FormattedCodexMessage {
  const itemType = resolveItemType(item);
  const header = formatHeader(`Item ${itemType}`, ts, chalk.gray, item);
  const serialized = item ? JSON.stringify(item, null, 2) : 'No item payload provided.';
  return {
    type: eventType,
    message: `${header}\n\n${serialized}`,
  };
}

function formatFileChangeItem(
  eventType: 'item.started' | 'item.updated' | 'item.completed',
  item: CodexOutItem | null | undefined,
  ts: string
): FormattedCodexMessage {
  const status = (item?.status ?? '').toString().toLowerCase();
  const changes = Array.isArray(item?.changes) ? item.changes : [];

  const label =
    eventType === 'item.started'
      ? 'File Change Begin'
      : eventType === 'item.updated'
        ? 'File Change Update'
        : status === 'completed'
          ? 'File Change Complete'
          : 'File Change End';

  const color =
    eventType === 'item.completed' && status === 'completed' ? chalk.bold.green : chalk.magenta;
  const header = formatHeader(label, ts, color, item);

  if (changes.length === 0) {
    return {
      type: 'file_change',
      message: `${header}\n\n${chalk.gray('No file changes provided.')}`,
    };
  }

  const fileCount = changes.length;
  const fileText = fileCount === 1 ? '1 file' : `${fileCount} files`;

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

  const body = summary.length > 0 ? summary.join('\n') : `${fileText} changed`;

  return {
    type: 'file_change',
    message: `${header}\n\n${body}`,
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

  const body = parts.length > 0 ? parts.join('\n') : chalk.gray('No usage information provided.');
  return {
    type: 'turn.completed',
    lastTokenCount: totalTokens > 0 ? totalTokens : undefined,
    message: chalk.gray(`### Usage [${ts}]\n\n`) + body,
  };
}

function formatCodexOutMessage(message: CodexOutMessage, ts: string): FormattedCodexMessage {
  switch (message.type) {
    case 'thread.started': {
      const details = message.thread_id ? `Thread: ${message.thread_id}` : undefined;
      const header = chalk.bold.green(`### Start [${ts}]`);
      return {
        type: 'thread.started',
        message: details ? `${header}\n\n${details}` : header,
      };
    }
    case 'turn.started': {
      return {
        type: 'task_started',
        message: chalk.bold.green(`### Task Started [${ts}]`),
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
      const header = chalk.bold.green(`### Session Created [${ts}]`);
      const details = sessionId ? `Session ID: ${sessionId}` : undefined;
      return {
        type: 'session.created',
        message: details ? `${header}\n\n${details}` : header,
      };
    }
    default: {
      const typeLabel =
        typeof message.type === 'string' && message.type.length > 0 ? message.type : 'unknown';
      return {
        type: typeLabel,
        message: JSON.stringify(message),
      };
    }
  }
}

function formatLegacyCodexMessage(
  obj: CodexEnvelope<CodexMessage>,
  ts: string
): FormattedCodexMessage {
  const msg = obj.msg;
  if (msg == null || typeof msg !== 'object' || !('type' in msg)) {
    return { type: 'unknown' };
  }

  switch (msg.type) {
    case 'task_started': {
      return {
        type: msg.type,
        message: chalk.bold.green(`### Task Started [${ts}]`),
      };
    }
    case 'agent_reasoning': {
      const text = msg.text ?? '';
      return {
        type: msg.type,
        message: chalk.blue(`### Thinking [${ts}]\n\n`) + text,
      };
    }
    case 'agent_reasoning_section_break': {
      return { type: msg.type }; // ignore quietly
    }
    case 'exec_command_begin': {
      const cmd = Array.isArray(msg.command) ? msg.command.join(' ') : String(msg.command);
      const cwd = msg.cwd ? `\nCWD: ${msg.cwd}` : '';
      return {
        type: msg.type,
        message: chalk.cyan(`### Exec Begin [${ts}]\n\n`) + cmd + cwd,
      };
    }
    case 'exec_command_output_delta': {
      // Streamed deltas can be noisy; skip detailed printing. We'll show final output on end.
      return { type: msg.type };
    }
    case 'exec_command_end': {
      const out = msg.formatted_output ?? msg.aggregated_output ?? msg.stdout ?? '';
      const truncated = truncateToLines(out, 20);
      const header = chalk.cyan(`### Exec End [${ts}] (exit ${msg.exit_code})`);
      return { type: msg.type, message: `${header}\n\n${truncated}` };
    }
    case 'token_count': {
      const info = msg.info ?? {};
      const total = info.total_token_usage;
      const last = info.last_token_usage;

      const parts = [];
      if (total) {
        const totalTokens = total.total_tokens || 0;
        const inputTokens = total.input_tokens || 0;
        const cachedInputTokens = total.cached_input_tokens || 0;
        const outputTokens = total.output_tokens || 0;
        const reasoningTokens = total.reasoning_output_tokens || 0;

        parts.push(`Total: ${totalTokens.toLocaleString()} tokens`);
        parts.push(
          `  Input: ${inputTokens.toLocaleString()} (${cachedInputTokens.toLocaleString()} cached)`
        );
        if (reasoningTokens > 0) {
          parts.push(
            `  Output: ${outputTokens.toLocaleString()} + ${reasoningTokens.toLocaleString()} reasoning`
          );
        } else {
          parts.push(`  Output: ${outputTokens.toLocaleString()}`);
        }
      }

      if (last && last.total_tokens) {
        parts.push(`Last: ${last.total_tokens.toLocaleString()} tokens`);
      }

      /*
        // This isn't useful to print every time.
        if (contextWindow) {
          parts.push(`Context Window: ${contextWindow.toLocaleString()}`);
        }
        */

      if (msg.rate_limits) {
        const rateLimits = msg.rate_limits;
        let rateLimitInfo: string[] = [];
        if (msg.rate_limits.primary) {
          rateLimitInfo.push(formatRateLimit(rateLimits.primary));
        }

        if (msg.rate_limits.secondary) {
          rateLimitInfo.push(formatRateLimit(rateLimits.secondary));
        }

        if (rateLimitInfo.length > 0) {
          parts.push(`Rate Limits: ${rateLimitInfo.join('\t\t')}`);
        }
      }

      return {
        type: msg.type,
        lastTokenCount: last?.total_tokens,
        message: chalk.gray(`### Usage [${ts}]\n\n`) + parts.join('\n'),
      };
    }
    case 'agent_message': {
      const text = msg.message ?? '';
      // Failure detection: recognize standardized FAILED: protocol on first non-empty line
      const failed = /^\s*FAILED:\s*/.test(
        (text || '')
          .replace(/\r\n?/g, '\n')
          .split('\n')
          .find((l) => l.trim() !== '') ?? ''
      );
      return {
        type: msg.type,
        message: chalk.bold.green(`### Agent Message [${ts}]`) + '\n\n' + text,
        agentMessage: text,
        failed: failed || undefined,
      };
    }
    case 'plan_update': {
      const rawPlan = Array.isArray(msg.plan) ? msg.plan : [];
      const planLines = formatTodoLikeLines(
        rawPlan.map((item) => ({
          label:
            typeof item?.step === 'string' && item.step.trim().length > 0
              ? item.step
              : '(missing step description)',
          status: item?.status,
        })),
        { includePriority: false }
      );
      const explanation =
        typeof msg.explanation === 'string' && msg.explanation.trim().length > 0
          ? msg.explanation.trim()
          : undefined;
      const sections: string[] = [];
      if (planLines.length > 0) {
        sections.push(planLines.join('\n'));
      } else {
        sections.push(chalk.gray('No plan steps provided.'));
      }
      if (explanation) {
        sections.push(`Explanation: ${explanation}`);
      }
      return {
        type: msg.type,
        message: `${chalk.bold.blue(`### Plan Update [${ts}]`)}\n\n${sections.join('\n\n')}`,
      };
    }
    case 'turn_diff': {
      const diff = msg.unified_diff ?? '';
      // Extract filenames from +++ and --- lines in the unified diff
      const fileMatches = diff.match(/^(?:\+\+\+|---) (.+)$/gm) || [];
      const filenames = fileMatches
        .map((match) => match.replace(/^(?:\+\+\+|---) /, '').replace(/\t.*$/, ''))
        .filter((filename) => filename !== '/dev/null') // Skip /dev/null entries
        .map((filename) => {
          // Strip a/ and b/ prefixes from git diff format
          if (filename.startsWith('a/') || filename.startsWith('b/')) {
            return filename.substring(2);
          }
          return filename;
        });
      const uniqueFiles = [...new Set(filenames)];

      // Count added and removed lines
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
        uniqueFiles.length <= 3
          ? uniqueFiles.join(', ')
          : `${uniqueFiles.slice(0, 3).join(', ')} and ${uniqueFiles.length - 3} more`;

      const changeStats = [];
      if (addedLines > 0) changeStats.push(chalk.green(`+${addedLines}`));
      if (removedLines > 0) changeStats.push(chalk.red(`-${removedLines}`));
      const statsText = changeStats.length > 0 ? ` (${changeStats.join(', ')})` : '';

      return {
        type: msg.type,
        message:
          chalk.magenta(`### Turn Diff [${ts}]\n\n`) +
          `Changes to ${fileText}${uniqueFiles.length > 0 ? `: ${fileList}` : ''}${statsText}`,
      };
    }
    case 'patch_apply_begin': {
      const autoApproved = msg.auto_approved ? ' (auto-approved)' : '';
      const changes = msg.changes;
      const changeCount = Object.keys(changes).length;
      const changeText = changeCount === 1 ? '1 file' : `${changeCount} files`;

      const header =
        chalk.yellow(`### Patch Apply Begin [${ts}]${autoApproved}\n\n`) +
        `Applying changes to ${changeText}:\n\n`;

      const fileDetails = Object.entries(changes)
        .map(([filePath, change]) => {
          if ('add' in change) {
            const content = truncateToLines(change.add.content, 10);
            return `${chalk.green('ADD')} ${filePath}:\n${content}`;
          } else if ('update' in change) {
            const diff = change.update.unified_diff || '';
            const movePath = change.update.move_path;
            const content = truncateToLines(diff, 10);
            const moveText = movePath ? ` -> ${movePath}` : '';
            return `${chalk.cyan('UPDATE')} ${filePath}${moveText}:\n${content}`;
          } else if ('remove' in change) {
            return `${chalk.red('REMOVE')} ${filePath}`;
          }

          return `${chalk.gray('UNKNOWN')} ${JSON.stringify(change)}`;
        })
        .join('\n\n');

      return {
        type: msg.type,
        message: header + fileDetails,
      };
    }
    case 'patch_apply_end': {
      const success = msg.success ? 'SUCCESS' : 'FAILED';
      const color = msg.success ? chalk.green : chalk.red;
      const output = msg.stdout || msg.stderr || '';
      const truncated = truncateToLines(output, 10);
      return {
        type: msg.type,
        message: color(`### Patch Apply End [${ts}] - ${success}\n\n`) + truncated,
      };
    }
    default: {
      // Unknown but well-formed message; print compactly for debugging
      return { type: (msg as AnyMessage).type, message: JSON.stringify(msg) };
    }
  }
}

export function formatCodexJsonMessage(jsonLine: string): FormattedCodexMessage {
  try {
    if (!jsonLine || jsonLine.trim() === '') return { type: '' };
    debugLog(`codex: `, jsonLine);
    const parsed = JSON.parse(jsonLine) as unknown;

    if (!parsed || typeof parsed !== 'object') {
      return { type: 'unknown', message: jsonLine };
    }

    const ts = new Date().toTimeString().split(' ')[0];

    const initial = tryFormatInitial(parsed as CodexEnvelope);
    if (initial) return initial;

    if ('msg' in (parsed as Record<string, unknown>)) {
      return formatLegacyCodexMessage(parsed as CodexEnvelope<CodexMessage>, ts);
    }

    if (isCodexOutMessage(parsed)) {
      return formatCodexOutMessage(parsed, ts);
    }

    return {
      type: 'unknown',
      message: JSON.stringify(parsed),
    };
  } catch (err) {
    debugLog('Failed to parse Codex JSON line:', jsonLine, err);
    return { type: 'parse_error', message: jsonLine };
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

  let previousTokenCount = -1;

  function formatChunk(chunk: string): string {
    const lines = split(chunk);
    const out: string[] = [];
    for (const line of lines) {
      const fm = formatCodexJsonMessage(line);

      const isUsageMessage =
        ((fm.type as CodexMessage['type']) === 'token_count' || fm.type === 'turn.completed') &&
        fm.lastTokenCount != null;

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
      if (fm.message) out.push(fm.message);
    }
    return out.length ? out.join('\n\n') + '\n\n' : '';
  }

  function getFinalAgentMessage(): string | undefined {
    return finalAgentMessage;
  }

  function getFailedAgentMessage(): string | undefined {
    return lastFailedAgentMessage;
  }

  return { formatChunk, getFinalAgentMessage, getFailedAgentMessage };
}
