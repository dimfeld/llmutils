import chalk from 'chalk';

export type TodoStatus =
  | 'completed'
  | 'in_progress'
  | 'pending'
  | 'blocked'
  | 'not_started'
  | string;

export interface TodoLikeItem {
  label: string;
  status?: TodoStatus | null;
  priority?: string | null;
}

export interface FormatTodoLikeOptions {
  /**
   * Number of spaces or explicit prefix string prepended to each formatted line.
   * Defaults to two spaces for consistency with existing CLI output.
   */
  indent?: number | string;
  /**
   * Control whether priority annotations should be included in the formatted output.
   * Defaults to true so existing call sites retain their behaviour.
   */
  includePriority?: boolean;
  /**
   * Control whether ANSI colors are applied to each line.
   * Defaults to true to preserve current console output.
   */
  colorize?: boolean;
}

const statusIconMap: Record<string, string> = {
  completed: '✓',
  in_progress: '→',
  pending: '•',
  not_started: '•',
  blocked: '✗',
};

const defaultIndent = '  ';

function resolveIndent(indent?: number | string): string {
  if (typeof indent === 'number') {
    return indent > 0 ? ' '.repeat(indent) : '';
  }
  if (typeof indent === 'string') {
    return indent;
  }
  return defaultIndent;
}

function iconForStatus(status?: TodoStatus | null): string {
  if (!status) return statusIconMap.pending;
  return statusIconMap[status] ?? statusIconMap.pending;
}

function colorForStatus(status?: TodoStatus | null) {
  switch (status) {
    case 'completed':
      return chalk.green;
    case 'in_progress':
      return chalk.cyan;
    case 'blocked':
      return chalk.red;
    default:
      return chalk.gray;
  }
}

function colorForPriority(priority?: string | null) {
  if (!priority) return chalk.gray;
  const normalized = priority.toLowerCase();
  if (normalized === 'high') return chalk.red;
  if (normalized === 'medium') return chalk.yellow;
  return chalk.gray;
}

export function formatTodoLikeLines(
  items: TodoLikeItem[],
  options: FormatTodoLikeOptions = {}
): string[] {
  const indent = resolveIndent(options.indent);
  const includePriority = options.includePriority ?? true;
  const colorize = options.colorize ?? true;

  return items.map((item) => {
    const icon = iconForStatus(item.status);
    const textColor = colorForStatus(item.status);
    const label = colorize ? textColor(item.label) : item.label;

    let priorityPart = '';
    if (includePriority && item.priority) {
      const priorityColor = colorForPriority(item.priority);
      priorityPart = colorize ? `[${priorityColor(item.priority)}] ` : `[${item.priority}] `;
    }

    return `${indent}${icon} ${priorityPart}${label}`;
  });
}
