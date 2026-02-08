import type {
  AgentSessionStartMessage,
  CommandResultMessage,
  LlmStatusMessage,
  TodoUpdateItem,
  TodoUpdateMessage,
  TodoUpdateStatus,
} from '../../../logging/structured_messages.ts';

export type StructuredMessageSource = 'codex' | 'claude';

export interface TodoLikeStructuredItem {
  label: string;
  status?: string | null;
}

function normalizeText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeTodoStatus(status: string | null | undefined): TodoUpdateStatus {
  if (!status) {
    return 'unknown';
  }

  const normalized = status.trim().toLowerCase();
  if (normalized === 'completed' || normalized === 'done') {
    return 'completed';
  }
  if (
    normalized === 'in_progress' ||
    normalized === 'in-progress' ||
    normalized === 'active' ||
    normalized === 'doing'
  ) {
    return 'in_progress';
  }
  if (normalized === 'pending' || normalized === 'not_started' || normalized === 'not-started') {
    return 'pending';
  }
  if (normalized === 'blocked') {
    return 'blocked';
  }
  if (normalized === 'unknown') {
    return 'unknown';
  }

  return 'unknown';
}

export function buildTodoUpdate(
  source: StructuredMessageSource,
  timestamp: string,
  items: TodoLikeStructuredItem[]
): TodoUpdateMessage {
  const normalizedItems: TodoUpdateItem[] = items.map((item) => ({
    label: item.label.trim() || '(missing item text)',
    status: normalizeTodoStatus(item.status),
  }));

  return {
    type: 'todo_update',
    timestamp,
    source,
    items: normalizedItems,
  };
}

export function buildCommandResult(
  timestamp: string,
  {
    command,
    exitCode,
    stdout,
    stderr,
  }: {
    command?: string;
    exitCode: number;
    stdout?: string;
    stderr?: string;
  }
): CommandResultMessage {
  return {
    type: 'command_result',
    timestamp,
    command: normalizeText(command),
    exitCode,
    stdout: normalizeText(stdout),
    stderr: normalizeText(stderr),
  };
}

export function buildSessionStart(
  timestamp: string,
  source: StructuredMessageSource,
  {
    sessionId,
    threadId,
    tools,
    mcpServers,
  }: {
    sessionId?: string;
    threadId?: string;
    tools?: string[];
    mcpServers?: string[];
  } = {}
): AgentSessionStartMessage {
  return {
    type: 'agent_session_start',
    timestamp,
    executor: source,
    sessionId,
    threadId,
    tools,
    mcpServers,
  };
}

export function buildParseErrorStatus(
  source: StructuredMessageSource,
  timestamp: string,
  detail: string
): LlmStatusMessage {
  return {
    type: 'llm_status',
    timestamp,
    source,
    status: 'llm.parse_error',
    detail,
  };
}

export function buildUnknownStatus(
  source: StructuredMessageSource,
  timestamp: string,
  detail: string,
  code = 'unknown'
): LlmStatusMessage {
  return {
    type: 'llm_status',
    timestamp,
    source,
    status: `llm.${code}`,
    detail,
  };
}
