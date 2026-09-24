import type {
  DisplayMessageBody,
  KeyValuePairEntry,
  StructuredMessagePayload,
} from '$lib/types/session.js';

/** Format a message timestamp into the string shown next to each message. */
export function formatMessageTimestamp(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString();
}

export type DisplayCategory =
  | 'lifecycle'
  | 'llmOutput'
  | 'toolUse'
  | 'fileChange'
  | 'command'
  | 'progress'
  | 'error'
  | 'log'
  | 'userInput';

export interface TimAgentToolPresentation {
  title: string;
  entries: KeyValuePairEntry[];
  fallback?: string;
}

/** Build a compact display for calls to the known tim agent tools. */
export function getTimAgentToolPresentation(
  message: Extract<StructuredMessagePayload, { type: 'llm_tool_use' | 'llm_tool_result' }>
): TimAgentToolPresentation | null {
  const toolName = message.toolName.replace(/^tim\./, '').replace(/^mcp__tim__/, '');
  const titles: Record<string, string> = {
    StartTimAgent: 'Start agent',
    ListTimAgents: 'List agents',
    SendTimAgentMessage: 'Send agent message',
    StopTimAgent: 'Stop agent',
    FinishTimAgent: 'Finish assignment',
  };
  const title = titles[toolName];
  if (!title) return null;

  if (message.type === 'llm_tool_use') {
    const input = asRecord(message.input);
    const fields: Record<string, Array<[string, unknown]>> = {
      StartTimAgent: [
        ['Name', input.name],
        ['Type', input.type],
        ['Executor', input.executor],
        ['Assignment', input.initialMessage],
      ],
      ListTimAgents: [],
      SendTimAgentMessage: [
        ['To', input.name],
        ['Message', input.message],
      ],
      StopTimAgent: [
        ['Agent', input.name],
        ['Force', input.force],
        ['Message', input.message],
      ],
      FinishTimAgent: [['Final status', input.message]],
    };
    const entries = keyValueEntries(fields[toolName] ?? []);
    return {
      title,
      entries: entries.length > 0 ? entries : [],
      fallback:
        entries.length === 0 && toolName !== 'ListTimAgents' ? message.inputSummary : undefined,
    };
  }

  const result = getTimAgentResult(message.result, message.resultSummary);
  if (!result) return { title, entries: [], fallback: message.resultSummary };
  if (toolName === 'ListTimAgents' && Array.isArray(result.agents)) {
    const agents = result.agents
      .map((agent) => {
        const row = asRecord(agent);
        if (typeof row.name !== 'string') return null;
        const details = [row.type, row.executor, row.state]
          .filter((value): value is string => typeof value === 'string')
          .join(' · ');
        return details ? `${row.name} · ${details}` : row.name;
      })
      .filter((agent): agent is string => agent !== null);
    return {
      title,
      entries: agents.length > 0 ? [{ key: 'Agents', value: agents.join('\n') }] : [],
      fallback: agents.length === 0 ? 'No active agents.' : undefined,
    };
  }

  const resultFields: Record<string, Array<[string, unknown]>> = {
    StartTimAgent: [
      ['Name', result.name],
      ['Type', result.type],
      ['Executor', result.executor],
      ['State', result.state],
    ],
    ListTimAgents: [],
    SendTimAgentMessage: [
      ['To', result.name],
      ['Delivery', result.delivery],
      ['Message ID', result.messageId],
    ],
    StopTimAgent: [
      ['Agent', result.name],
      ['Result', result.mode],
      ['State', result.state],
    ],
    FinishTimAgent: [['State', result.state]],
  };
  const entries = keyValueEntries(resultFields[toolName] ?? []);
  return { title, entries, fallback: entries.length === 0 ? message.resultSummary : undefined };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function getTimAgentResult(
  value: unknown,
  summary: string | undefined
): Record<string, unknown> | null {
  const record = asRecord(value);
  const contentItems = Array.isArray(value)
    ? value
    : Array.isArray(record.contentItems)
      ? record.contentItems
      : Array.isArray(record.content)
        ? record.content
        : [];
  for (const item of contentItems) {
    const text = asRecord(item).text;
    if (typeof text === 'string') {
      try {
        const parsed: unknown = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return asRecord(parsed);
      } catch {
        // Keep searching; adapters can return multiple text content items.
      }
    }
  }

  const nestedResult = asRecord(record.result);
  if (Object.keys(nestedResult).length > 0) return nestedResult;
  if (Object.keys(record).some((key) => ['name', 'state', 'delivery', 'agents'].includes(key))) {
    return record;
  }
  if (summary) {
    try {
      const parsed: unknown = JSON.parse(summary);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return asRecord(parsed);
    } catch {
      // The summary is often prose, so preserve it as the fallback display.
    }
  }
  return null;
}

export function getDisplayCategory(message: StructuredMessagePayload): DisplayCategory {
  switch (message.type) {
    case 'agent_session_start':
    case 'agent_session_end':
    case 'agent_iteration_start':
    case 'agent_step_start':
    case 'agent_step_end':
    case 'review_start':
    case 'input_required':
    case 'prompt_request':
    case 'prompt_answered':
    case 'prompt_cancelled':
    case 'plan_discovery':
    case 'workspace_info':
      return 'lifecycle';
    case 'llm_thinking':
    case 'llm_response':
      return 'llmOutput';
    case 'llm_tool_use':
    case 'llm_tool_result':
      return 'toolUse';
    case 'file_write':
    case 'file_edit':
    case 'file_change_summary':
      return 'fileChange';
    case 'command_exec':
    case 'command_result':
      return 'command';
    case 'llm_status':
    case 'todo_update':
    case 'task_completion':
    case 'workflow_progress':
    case 'token_usage':
      return 'progress';
    case 'failure_report':
      return 'error';
    case 'execution_summary':
      return 'lifecycle';
    case 'review_result':
      return message.verdict === 'NEEDS_FIXES' ? 'error' : 'lifecycle';
    case 'user_terminal_input':
      return 'userInput';
    default:
      return 'log';
  }
}

/**
 * Format a structured message into a DisplayMessageBody for default rendering.
 * Returns null for message types that have dedicated rich components (e.g. review_result).
 */
export function formatStructuredMessage(
  message: StructuredMessagePayload
): DisplayMessageBody | null {
  switch (message.type) {
    case 'agent_session_start':
      return {
        type: 'text',
        text: [
          'Agent session started',
          message.executor ? `executor=${message.executor}` : null,
          message.model ? `model=${message.model}` : null,
          message.mode ? `mode=${message.mode}` : null,
          message.planId != null ? `plan=${message.planId}` : null,
        ]
          .filter(Boolean)
          .join(' | '),
      };
    case 'agent_session_end':
      return {
        type: 'text',
        text: [
          message.success ? 'Agent session completed' : 'Agent session failed',
          message.durationMs != null ? `duration=${message.durationMs}ms` : null,
          message.turns != null ? `turns=${message.turns}` : null,
          message.costUsd != null ? `cost=$${message.costUsd}` : null,
          message.summary ?? null,
        ]
          .filter(Boolean)
          .join(' | '),
      };
    case 'agent_iteration_start':
      return {
        type: 'text',
        text: [
          `Iteration ${message.iterationNumber}`,
          message.taskTitle ?? null,
          message.taskDescription ?? null,
        ]
          .filter(Boolean)
          .join(' | '),
      };
    case 'agent_step_start':
      return {
        type: 'text',
        text: [
          `Step start: ${message.phase}`,
          message.executor ?? null,
          message.stepNumber != null ? `step=${message.stepNumber}` : null,
          message.attempt != null ? `attempt=${message.attempt}` : null,
          message.message ?? null,
        ]
          .filter(Boolean)
          .join(' | '),
      };
    case 'agent_step_end':
      return {
        type: 'text',
        text: [
          `Step ${message.success ? 'completed' : 'failed'}: ${message.phase}`,
          message.summary ?? null,
        ]
          .filter(Boolean)
          .join(' | '),
      };
    case 'llm_thinking':
      return {
        type: 'monospaced',
        text: message.text,
      };
    case 'llm_response':
      return {
        type: 'text',
        text: message.text,
      };
    case 'llm_tool_use':
      return {
        type: 'keyValuePairs',
        entries: keyValueEntries([
          ['Tool', message.toolName],
          ['Summary', message.inputSummary],
          ['Input', message.input],
        ]),
      };
    case 'llm_tool_result':
      return {
        type: 'text',
        text: [
          message.toolName,
          message.resultSummary ??
            (message.result != null ? formatJsonValue(message.result) : null),
        ]
          .filter(Boolean)
          .join(': '),
      };
    case 'llm_status':
      return {
        type: 'text',
        text: [message.source ?? null, message.status, message.detail ?? null]
          .filter(Boolean)
          .join(' | '),
      };
    case 'todo_update':
      return {
        type: 'todoList',
        items: message.items.map((item) => ({
          label: item.label,
          status: item.status,
          ...(item.detail != null ? { detail: item.detail } : {}),
        })),
        explanation: message.explanation,
      };
    case 'task_completion':
      return {
        type: 'text',
        text: message.planComplete
          ? `Plan completed${message.taskTitle ? ` after ${message.taskTitle}` : ''}`
          : `Task completed${message.taskTitle ? `: ${message.taskTitle}` : ''}`,
      };
    case 'file_write':
      return {
        type: 'text',
        text: `Wrote ${message.path} (${message.lineCount} lines)`,
      };
    case 'file_edit':
      return {
        type: 'monospaced',
        text: `${message.path}\n${message.diff}`,
      };
    case 'file_change_summary':
      return {
        type: 'fileChanges',
        changes: message.changes,
        status: message.status,
      };
    case 'command_exec':
      return {
        type: 'monospaced',
        text: [message.cwd ? `# cwd: ${message.cwd}` : null, `$ ${message.command}`]
          .filter(Boolean)
          .join('\n'),
      };
    case 'command_result':
      return {
        type: 'monospaced',
        text: summarizeCommandResult(message),
      };
    case 'review_start':
      return {
        type: 'text',
        text: [
          'Review started',
          message.executor ? `executor=${message.executor}` : null,
          message.planId != null ? `plan=${message.planId}` : null,
        ]
          .filter(Boolean)
          .join(' | '),
      };
    case 'review_result':
      // Dedicated rich component handles this
      return null;
    case 'workflow_progress':
      return {
        type: 'text',
        text: [message.phase ?? null, message.message].filter(Boolean).join(' | '),
      };
    case 'failure_report':
      return {
        type: 'text',
        text: [
          message.summary,
          message.requirements ?? null,
          message.problems ?? null,
          message.solutions ?? null,
        ]
          .filter(Boolean)
          .join('\n\n'),
      };
    case 'execution_summary':
      return {
        type: 'keyValuePairs',
        entries: keyValueEntries([
          ['Plan ID', message.summary.planId],
          ['Plan Title', message.summary.planTitle],
          ['Mode', message.summary.mode],
          ['Duration', message.summary.durationMs],
          ['Changed Files', message.summary.changedFiles.join('\n')],
          ['Errors', message.summary.errors.join('\n')],
        ]),
      };
    case 'token_usage': {
      const lines: string[] = [];
      const parts = [
        message.inputTokens != null ? `input=${message.inputTokens}` : null,
        message.cachedInputTokens != null ? `cached=${message.cachedInputTokens}` : null,
        message.outputTokens != null ? `output=${message.outputTokens}` : null,
        message.reasoningTokens != null ? `reasoning=${message.reasoningTokens}` : null,
        message.totalTokens != null ? `total=${message.totalTokens}` : null,
      ].filter(Boolean);

      if (parts.length > 0) {
        lines.push(parts.join(' '));
      }

      const rateLimitLines: string[] = [];
      const rateLimits =
        message.rateLimits && typeof message.rateLimits === 'object'
          ? message.rateLimits
          : undefined;
      if (rateLimits) {
        for (const [key, value] of Object.entries(rateLimits)) {
          if (!value || typeof value !== 'object') {
            continue;
          }
          const entry = value as Record<string, unknown>;
          const primary = formatRateLimitWindow(entry.primary);
          const secondary = formatRateLimitWindow(entry.secondary);
          const label =
            (typeof entry.limitName === 'string' && entry.limitName.length > 0
              ? entry.limitName
              : undefined) ??
            (typeof entry.limitId === 'string' && entry.limitId.length > 0
              ? entry.limitId
              : undefined) ??
            key;
          const details = [
            primary ? `primary ${primary}` : '',
            secondary ? `secondary ${secondary}` : '',
          ]
            .filter(Boolean)
            .join(', ');
          rateLimitLines.push(details.length > 0 ? `${label}: ${details}` : label);
        }
      }

      if (rateLimitLines.length > 0) {
        lines.push(`rateLimits=${rateLimitLines.join(' | ')}`);
      }

      return {
        type: 'text',
        text: lines.join('\n'),
      };
    }
    case 'input_required':
      return {
        type: 'text',
        text: message.prompt ?? 'Input required',
      };
    case 'user_terminal_input':
      return {
        type: 'text',
        text: message.content,
      };
    case 'prompt_request':
      return {
        type: 'text',
        text: [
          `Prompt requested: ${message.promptType}`,
          message.promptConfig.header ?? null,
          message.promptConfig.question ?? null,
          message.promptConfig.message,
        ]
          .filter(Boolean)
          .join(' | '),
      };
    case 'prompt_answered':
      return {
        type: 'text',
        text: [
          `Prompt answered: ${message.promptType}`,
          message.source,
          message.value !== undefined ? formatJsonValue(message.value) : null,
        ]
          .filter(Boolean)
          .join(' | '),
      };
    case 'prompt_cancelled':
      return {
        type: 'text',
        text: `Prompt cancelled: ${message.requestId}`,
      };
    case 'plan_discovery':
      return {
        type: 'text',
        text: `Discovered plan ${message.planId}: ${message.title}`,
      };
    case 'workspace_info':
      return {
        type: 'text',
        text: [
          `Workspace: ${message.path}`,
          message.workspaceId ? `id=${message.workspaceId}` : null,
          message.planFile ? `plan=${message.planFile}` : null,
        ]
          .filter(Boolean)
          .join(' | '),
      };
    default:
      return {
        type: 'text',
        text: `Unsupported structured message type: ${(message as { type?: string }).type ?? 'unknown'}`,
      };
  }
}

function formatJsonValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (value == null) {
    return String(value);
  }

  return JSON.stringify(value, null, 2);
}

function formatRateLimitWindow(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const usedPercent =
    typeof record.usedPercent === 'number'
      ? record.usedPercent
      : typeof record.used_percent === 'number'
        ? record.used_percent
        : undefined;
  const windowMins =
    typeof record.windowDurationMins === 'number'
      ? record.windowDurationMins
      : typeof record.window_minutes === 'number'
        ? record.window_minutes
        : undefined;

  if (usedPercent == null && windowMins == null) {
    return undefined;
  }

  if (usedPercent != null && windowMins != null) {
    return `${Math.round(usedPercent)}%/${windowMins}m`;
  }

  if (usedPercent != null) {
    return `${Math.round(usedPercent)}%`;
  }

  return `${windowMins}m`;
}

function keyValueEntries(entries: Array<[string, unknown]>): KeyValuePairEntry[] {
  return entries
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => [key, formatJsonValue(value)] satisfies [string, string])
    .map(([key, value]) => ({ key, value }));
}

function summarizeCommandResult(
  message: Extract<StructuredMessagePayload, { type: 'command_result' }>
): string {
  const sections: string[] = [];

  if (message.command) {
    sections.push(`$ ${message.command}`);
  }

  sections.push(`exit ${message.exitCode}`);

  if (message.cwd) {
    sections.push(`cwd: ${message.cwd}`);
  }

  if (message.stdout) {
    sections.push(`stdout:\n${message.stdout}`);
  }

  if (message.stderr) {
    sections.push(`stderr:\n${message.stderr}`);
  }

  return sections.join('\n\n');
}
