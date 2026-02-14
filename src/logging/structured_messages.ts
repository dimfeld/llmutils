import type { ReviewOutput } from '../tim/formatters/review_output_schema.js';
import type { ExecutionSummary } from '../tim/summary/types.js';

export interface StructuredMessageBase {
  timestamp: string;
}

/**
 * Plan ID representation note for GUI/headless consumers:
 * - Top-level structured message fields named `planId` are numeric when present.
 * - `execution_summary.summary.planId` comes from `ExecutionSummary` and remains a string.
 * Consumers should handle both numeric and string representations depending on
 * message family until a dedicated normalization cleanup is completed.
 * This mismatch is intentional for backward compatibility with summary formatting/types.
 */
export interface AgentSessionStartMessage extends StructuredMessageBase {
  type: 'agent_session_start';
  executor?: string;
  mode?: string;
  planId?: number;
  sessionId?: string;
  threadId?: string;
  tools?: string[];
  mcpServers?: string[];
}

export interface AgentSessionEndMessage extends StructuredMessageBase {
  type: 'agent_session_end';
  success: boolean;
  sessionId?: string;
  threadId?: string;
  durationMs?: number;
  costUsd?: number;
  turns?: number;
  summary?: string;
}

export interface AgentIterationStartMessage extends StructuredMessageBase {
  type: 'agent_iteration_start';
  iterationNumber: number;
  taskTitle?: string;
  taskDescription?: string;
}

export interface AgentStepStartMessage extends StructuredMessageBase {
  type: 'agent_step_start';
  phase: string;
  executor?: string;
  stepNumber?: number;
  attempt?: number;
  message?: string;
}

export interface AgentStepEndMessage extends StructuredMessageBase {
  type: 'agent_step_end';
  phase: string;
  success: boolean;
  summary?: string;
}

export interface LlmThinkingMessage extends StructuredMessageBase {
  type: 'llm_thinking';
  text: string;
}

export interface LlmResponseMessage extends StructuredMessageBase {
  type: 'llm_response';
  text: string;
  isUserRequest?: boolean;
}

export interface LlmToolUseMessage extends StructuredMessageBase {
  type: 'llm_tool_use';
  toolName: string;
  inputSummary?: string;
  /** Optional raw tool input payload. Must be JSON-serializable for transport. */
  input?: unknown;
}

export interface LlmToolResultMessage extends StructuredMessageBase {
  type: 'llm_tool_result';
  toolName: string;
  resultSummary?: string;
  /** Optional raw tool result payload. Must be JSON-serializable for transport. */
  result?: unknown;
}

export interface LlmStatusMessage extends StructuredMessageBase {
  type: 'llm_status';
  status: string;
  detail?: string;
  source?: 'codex' | 'claude';
}

export type TodoUpdateStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'unknown';

export interface TodoUpdateItem {
  label: string;
  status: TodoUpdateStatus;
}

export interface TodoUpdateMessage extends StructuredMessageBase {
  type: 'todo_update';
  items: TodoUpdateItem[];
  source?: 'codex' | 'claude';
}

export interface FileWriteMessage extends StructuredMessageBase {
  type: 'file_write';
  path: string;
  lineCount: number;
}

export interface FileEditMessage extends StructuredMessageBase {
  type: 'file_edit';
  path: string;
  diff: string;
}

export type FileChangeKind = 'added' | 'updated' | 'removed';

export interface FileChangeItem {
  path: string;
  kind: FileChangeKind;
}

export interface FileChangeSummaryMessage extends StructuredMessageBase {
  type: 'file_change_summary';
  changes: FileChangeItem[];
}

export interface CommandExecMessage extends StructuredMessageBase {
  type: 'command_exec';
  command: string;
  cwd?: string;
}

export interface CommandResultMessage extends StructuredMessageBase {
  type: 'command_result';
  command?: string;
  cwd?: string;
  exitCode: number;
  stdout?: string;
  stderr?: string;
}

export interface ReviewStartMessage extends StructuredMessageBase {
  type: 'review_start';
  executor?: string;
  planId?: number;
}

export interface ReviewResultMessage extends StructuredMessageBase {
  type: 'review_result';
  issues: ReviewOutput['issues'];
  recommendations: string[];
  actionItems: string[];
}

export type ReviewVerdict = 'ACCEPTABLE' | 'NEEDS_FIXES' | 'UNKNOWN';

export interface ReviewVerdictMessage extends StructuredMessageBase {
  type: 'review_verdict';
  verdict: ReviewVerdict;
  fixInstructions?: string;
}

export interface WorkflowProgressMessage extends StructuredMessageBase {
  type: 'workflow_progress';
  message: string;
  phase?: string;
}

export interface FailureReportMessage extends StructuredMessageBase {
  type: 'failure_report';
  summary: string;
  requirements?: string;
  problems?: string;
  solutions?: string;
  sourceAgent?: string;
}

export interface TaskCompletionMessage extends StructuredMessageBase {
  type: 'task_completion';
  taskTitle?: string;
  planComplete: boolean;
}

export interface ExecutionSummaryMessage extends StructuredMessageBase {
  type: 'execution_summary';
  summary: ExecutionSummary;
}

export interface TokenUsageMessage extends StructuredMessageBase {
  type: 'token_usage';
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  rateLimits?: Record<string, unknown>;
}

export interface InputRequiredMessage extends StructuredMessageBase {
  type: 'input_required';
  prompt?: string;
}

export interface UserTerminalInputMessage extends StructuredMessageBase {
  type: 'user_terminal_input';
  content: string;
}

export type PromptType = 'input' | 'confirm' | 'select' | 'checkbox';

export interface PromptChoiceConfig {
  name: string;
  value: string | number | boolean;
  description?: string;
  checked?: boolean;
}

export interface PromptConfig {
  message: string;
  default?: string | number | boolean;
  choices?: PromptChoiceConfig[];
  pageSize?: number;
  /** Human-readable description of validation rules (validation runs on the receiving end) */
  validationHint?: string;
}

export interface PromptRequestMessage extends StructuredMessageBase {
  type: 'prompt_request';
  requestId: string;
  promptType: PromptType;
  promptConfig: PromptConfig;
  timeoutMs?: number;
}

export interface PromptAnsweredMessage extends StructuredMessageBase {
  type: 'prompt_answered';
  requestId: string;
  promptType: PromptType;
  value?: unknown;
  source: 'terminal' | 'websocket';
}

export interface PlanDiscoveryMessage extends StructuredMessageBase {
  type: 'plan_discovery';
  planId: number;
  title: string;
}

export interface WorkspaceInfoMessage extends StructuredMessageBase {
  type: 'workspace_info';
  workspaceId?: string;
  path: string;
  planFile?: string;
}

export type StructuredMessage =
  | AgentSessionStartMessage
  | AgentSessionEndMessage
  | AgentIterationStartMessage
  | AgentStepStartMessage
  | AgentStepEndMessage
  | LlmThinkingMessage
  | LlmResponseMessage
  | LlmToolUseMessage
  | LlmToolResultMessage
  | LlmStatusMessage
  | TodoUpdateMessage
  | FileWriteMessage
  | FileEditMessage
  | FileChangeSummaryMessage
  | CommandExecMessage
  | CommandResultMessage
  | ReviewStartMessage
  | ReviewResultMessage
  | ReviewVerdictMessage
  | WorkflowProgressMessage
  | FailureReportMessage
  | TaskCompletionMessage
  | ExecutionSummaryMessage
  | TokenUsageMessage
  | InputRequiredMessage
  | UserTerminalInputMessage
  | PromptRequestMessage
  | PromptAnsweredMessage
  | PlanDiscoveryMessage
  | WorkspaceInfoMessage;

export const structuredMessageTypeList = [
  'agent_session_start',
  'agent_session_end',
  'agent_iteration_start',
  'agent_step_start',
  'agent_step_end',
  'llm_thinking',
  'llm_response',
  'llm_tool_use',
  'llm_tool_result',
  'llm_status',
  'todo_update',
  'file_write',
  'file_edit',
  'file_change_summary',
  'command_exec',
  'command_result',
  'review_start',
  'review_result',
  'review_verdict',
  'workflow_progress',
  'failure_report',
  'task_completion',
  'execution_summary',
  'token_usage',
  'input_required',
  'user_terminal_input',
  'prompt_request',
  'prompt_answered',
  'plan_discovery',
  'workspace_info',
] as const satisfies readonly StructuredMessage['type'][];
