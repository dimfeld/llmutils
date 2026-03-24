import type {
  DisplayMessageBody,
  KeyValuePairEntry,
  StructuredMessagePayload,
} from '$lib/types/session.js';

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
        items: message.items,
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
    case 'token_usage':
      return {
        type: 'text',
        text: [
          `tokens=${message.totalTokens ?? '?'}`,
          message.inputTokens != null ? `input=${message.inputTokens}` : null,
          message.cachedInputTokens != null ? `cached=${message.cachedInputTokens}` : null,
          message.outputTokens != null ? `output=${message.outputTokens}` : null,
          message.reasoningTokens != null ? `reasoning=${message.reasoningTokens}` : null,
        ]
          .filter(Boolean)
          .join(' | '),
      };
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

function keyValueEntries(entries: Array<[string, unknown]>): KeyValuePairEntry[] {
  return entries
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => [key, formatJsonValue(value)] satisfies [string, string])
    .map(([key, value]) => ({ key, value }));
}

function summarizeCommandResult(
  message: Omit<
    Extract<StructuredMessagePayload, { type: 'command_result' }>,
    'timestamp' | 'transportSource'
  >
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
