import type {
  DisplayMessage,
  DisplayMessageBody,
  SessionData,
  StructuredMessagePayload,
} from '$lib/types/session.js';
import { formatStructuredMessage } from './message_formatting.js';

/** Resolve the renderable body from a DisplayMessage, same logic as SessionMessage.svelte */
function resolveBody(message: DisplayMessage): DisplayMessageBody | null {
  if (message.body.type !== 'structured') return message.body;
  try {
    return formatStructuredMessage(message.body.message);
  } catch {
    return { type: 'text' as const, text: `[render error: ${message.rawType}]` };
  }
}

/** Format a single DisplayMessage as markdown */
export function formatMessageAsMarkdown(message: DisplayMessage): string {
  const time = formatTimestamp(message.timestamp);
  const prefix = `**[${time} UTC]**`;

  // Handle review_result specially since formatStructuredMessage returns null for it.
  // Guard the type access so malformed structured payloads still export via the
  // existing render-error fallback instead of throwing during export.
  if (message.body.type === 'structured') {
    try {
      if (message.body.message.type === 'review_result') {
        return `${prefix}\n${formatReviewResult(message.body.message)}`;
      }
    } catch {
      return `${prefix} [render error: ${message.rawType}]`;
    }
  }

  const body = resolveBody(message);
  if (!body) return `${prefix} [unsupported: ${message.rawType}]`;

  switch (body.type) {
    case 'text':
      return `${prefix} ${body.text}`;

    case 'monospaced': {
      const fence = computeFence(body.text);
      return `${prefix}\n${fence}\n${body.text}\n${fence}`;
    }

    case 'todoList': {
      const lines = body.items.map((item) => {
        const checkbox = todoStatusToCheckbox(item.status);
        return `${checkbox} ${item.label}`;
      });
      const explanation = body.explanation ? `\n${body.explanation}` : '';
      return `${prefix}${explanation}\n${lines.join('\n')}`;
    }

    case 'fileChanges': {
      const statusLine = body.status ? ` ${body.status}` : '';
      const lines = body.changes.map((change) => {
        const marker = change.kind === 'added' ? '+' : change.kind === 'removed' ? '-' : '~';
        return `- \`${marker} ${change.path}\``;
      });
      return `${prefix}${statusLine}\n${lines.join('\n')}`;
    }

    case 'keyValuePairs': {
      const lines = body.entries.map((entry) => {
        if (entry.value.includes('\n')) {
          const fence = computeFence(entry.value);
          return `- **${entry.key}**:\n${fence}\n${entry.value}\n${fence}`;
        }
        return `- **${entry.key}**: ${entry.value}`;
      });
      return `${prefix}\n${lines.join('\n')}`;
    }

    case 'structured':
      // Shouldn't happen after resolveBody, but fallback
      return `${prefix} [structured: ${message.rawType}]`;
  }
}

function todoStatusToCheckbox(status: string): string {
  switch (status) {
    case 'completed':
      return '- [x]';
    case 'in_progress':
      return '- [>]';
    case 'blocked':
      return '- [-]';
    default:
      return '- [ ]';
  }
}

function formatReviewResult(
  message: Extract<StructuredMessagePayload, { type: 'review_result' }>
): string {
  const lines: string[] = [];

  const verdictMap: Record<string, string> = {
    ACCEPTABLE: 'ACCEPTABLE',
    NEEDS_FIXES: 'NEEDS FIXES',
    UNKNOWN: 'UNKNOWN',
  };
  lines.push(`**Review: ${verdictMap[message.verdict] ?? message.verdict}**`);

  if (message.fixInstructions) {
    lines.push('', message.fixInstructions);
  }

  const issues = Array.isArray(message.issues)
    ? message.issues.filter(
        (i): i is (typeof message.issues)[number] =>
          i != null && typeof i === 'object' && typeof i.severity === 'string'
      )
    : [];

  if (issues.length > 0) {
    const severityOrder = ['critical', 'major', 'minor', 'info'] as const;
    const severityEmoji: Record<string, string> = {
      critical: '\u{1F534}',
      major: '\u{1F7E1}',
      minor: '\u{1F7E0}',
      info: '\u{2139}\u{FE0F}',
    };

    const grouped = new Map<string, typeof issues>();
    for (const issue of issues) {
      const list = grouped.get(issue.severity);
      if (list) {
        list.push(issue);
      } else {
        grouped.set(issue.severity, [issue]);
      }
    }

    for (const severity of severityOrder) {
      const severityIssues = grouped.get(severity);
      if (!severityIssues || severityIssues.length === 0) continue;
      const emoji = severityEmoji[severity] ?? '';
      lines.push(
        '',
        `${emoji} **${severity.charAt(0).toUpperCase() + severity.slice(1)}** (${severityIssues.length})`
      );
      for (const issue of severityIssues) {
        const location = issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ''}` : '';
        const loc = location ? ` \`${location}\`` : '';
        lines.push(`- [${issue.category}]${loc} ${issue.content}`);
        if (issue.suggestion) {
          lines.push(`  - Suggestion: ${issue.suggestion}`);
        }
      }
    }
  }

  const recommendations = Array.isArray(message.recommendations) ? message.recommendations : [];
  if (recommendations.length > 0) {
    lines.push('', '**Recommendations**');
    for (const rec of recommendations) {
      lines.push(`- ${rec}`);
    }
  }

  const actionItems = Array.isArray(message.actionItems) ? message.actionItems : [];
  if (actionItems.length > 0) {
    lines.push('', '**Action Items**');
    for (const item of actionItems) {
      lines.push(`- ${item}`);
    }
  }

  return lines.join('\n');
}

/** Format session metadata as a markdown header */
export function formatSessionHeader(session: SessionData): string {
  const lines: string[] = [];
  lines.push(`# Session: ${session.sessionInfo.command}`);
  lines.push('');

  if (session.sessionInfo.planId != null || session.sessionInfo.planTitle) {
    const parts: string[] = [];
    if (session.sessionInfo.planId != null) parts.push(`#${session.sessionInfo.planId}`);
    if (session.sessionInfo.planTitle) parts.push(session.sessionInfo.planTitle);
    lines.push(`- **Plan**: ${parts.join(' — ')}`);
  }

  if (session.sessionInfo.workspacePath) {
    lines.push(`- **Workspace**: ${session.sessionInfo.workspacePath}`);
  }

  if (session.sessionInfo.gitRemote) {
    lines.push(`- **Git Remote**: ${session.sessionInfo.gitRemote}`);
  }

  lines.push(`- **Started**: ${formatDateTime(session.connectedAt)}`);
  if (session.disconnectedAt) {
    lines.push(`- **Ended**: ${formatDateTime(session.disconnectedAt)}`);
  }

  return lines.join('\n');
}

/** Export a full session as markdown */
export function exportSessionAsMarkdown(session: SessionData): string {
  const header = formatSessionHeader(session);
  if (session.messages.length === 0) {
    return header + '\n\n*No messages*\n';
  }

  const messages = session.messages.map((m) => formatMessageAsMarkdown(m)).join('\n\n');
  return header + '\n\n---\n\n' + messages + '\n';
}

/** Generate a filesystem-safe export filename */
export function generateExportFilename(session: SessionData): string {
  const command = sanitizeFilename(session.sessionInfo.command);
  const commandPart = command ? `-${command}` : '';
  const planPart = session.sessionInfo.planId != null ? `-${session.sessionInfo.planId}` : '';
  const datePart = formatFilenameDate(session.connectedAt);
  return `session${commandPart}${planPart}-${datePart}.md`;
}

function sanitizeFilename(input: string): string {
  return input
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

/** Compute a backtick fence long enough that it won't collide with content */
function computeFence(text: string): string {
  let maxRun = 0;
  let current = 0;
  for (const ch of text) {
    if (ch === '`') {
      current++;
      if (current > maxRun) maxRun = current;
    } else {
      current = 0;
    }
  }
  return '`'.repeat(Math.max(3, maxRun + 1));
}

function formatTimestamp(isoString: string): string {
  try {
    const d = new Date(isoString);
    const h = String(d.getUTCHours()).padStart(2, '0');
    const m = String(d.getUTCMinutes()).padStart(2, '0');
    const s = String(d.getUTCSeconds()).padStart(2, '0');
    return `${h}:${m}:${s}`;
  } catch {
    return isoString;
  }
}

function formatDateTime(isoString: string): string {
  try {
    const d = new Date(isoString);
    return d
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d+Z$/, ' UTC');
  } catch {
    return isoString;
  }
}

function formatFilenameDate(isoString: string): string {
  try {
    const d = new Date(isoString);
    return d
      .toISOString()
      .replace(/:\d{2}\.\d+Z$/, '')
      .replace(':', '');
  } catch {
    return 'unknown';
  }
}
