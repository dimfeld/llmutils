import { EventEmitter } from 'node:events';

import type { Database } from 'bun:sqlite';

import type {
  HeadlessMessage,
  HeadlessServerMessage,
  HeadlessSessionInfo,
} from '../../logging/headless_protocol.js';
import type {
  FileChangeItem,
  PromptConfig,
  PromptType,
  StructuredMessage,
  TodoUpdateItem,
} from '../../logging/structured_messages.js';
import type { TunnelMessage } from '../../logging/tunnel_protocol.js';
import { listProjects } from '$tim/db/project.js';

export type SessionStatus = 'active' | 'offline' | 'notification';
export type MessageCategory =
  | 'lifecycle'
  | 'llmOutput'
  | 'toolUse'
  | 'fileChange'
  | 'command'
  | 'progress'
  | 'error'
  | 'log'
  | 'userInput';
export type MessageBodyType = 'text' | 'monospaced' | 'todoList' | 'fileChanges' | 'keyValuePairs';

export interface TextMessageBody {
  type: 'text';
  text: string;
}

export interface MonospacedMessageBody {
  type: 'monospaced';
  text: string;
}

export interface TodoListMessageBody {
  type: 'todoList';
  items: TodoUpdateItem[];
  explanation?: string;
}

export interface FileChangesMessageBody {
  type: 'fileChanges';
  changes: FileChangeItem[];
  status?: string;
}

export interface KeyValuePairEntry {
  key: string;
  value: string;
}

export interface KeyValuePairsMessageBody {
  type: 'keyValuePairs';
  entries: KeyValuePairEntry[];
}

export type DisplayMessageBody =
  | TextMessageBody
  | MonospacedMessageBody
  | TodoListMessageBody
  | FileChangesMessageBody
  | KeyValuePairsMessageBody;

export interface DisplayMessage {
  id: string;
  seq: number;
  timestamp: string;
  category: MessageCategory;
  bodyType: MessageBodyType;
  body: DisplayMessageBody;
  rawType: StructuredMessage['type'] | TunnelMessage['type'] | string;
}

export interface ActivePrompt {
  requestId: string;
  promptType: PromptType;
  promptConfig: PromptConfig;
  timeoutMs?: number;
}

export interface SessionData {
  connectionId: string;
  sessionInfo: HeadlessSessionInfo;
  status: SessionStatus;
  projectId: number | null;
  messages: DisplayMessage[];
  activePrompt: ActivePrompt | null;
  isReplaying: boolean;
  groupKey: string;
  connectedAt: string;
  disconnectedAt: string | null;
}

export interface MessagePayload {
  message: string;
  workspacePath: string;
  gitRemote: string | null;
  terminal?: {
    type: string;
    pane_id: string;
  };
}

export interface SessionSnapshot {
  sessions: SessionData[];
}

export interface SessionManagerEvents {
  'session:new': { session: SessionData };
  'session:update': { session: SessionData };
  'session:disconnect': { session: SessionData };
  'session:message': { connectionId: string; message: DisplayMessage };
  'session:prompt': { connectionId: string; prompt: ActivePrompt };
  'session:prompt-cleared': { connectionId: string; requestId: string };
  'session:dismissed': { connectionId: string };
}

type SessionEventName = keyof SessionManagerEvents;
type SessionEventListener<T extends SessionEventName> = (payload: SessionManagerEvents[T]) => void;
type AgentSender = (message: HeadlessServerMessage) => void;

interface MessageFormattingResult {
  category: MessageCategory;
  body: DisplayMessageBody;
}

interface SessionInternals {
  deferredPromptEvent: ActivePrompt | null;
  nextNotificationId: number;
}

const SESSION_EVENT_NAMES: SessionEventName[] = [
  'session:new',
  'session:update',
  'session:disconnect',
  'session:message',
  'session:prompt',
  'session:prompt-cleared',
  'session:dismissed',
];

const NOTIFICATION_SEQ = 0;
const MAX_NOTIFICATION_MESSAGES = 200;
const MAX_SESSION_MESSAGES = 5000;
const MAX_SNAPSHOT_MESSAGES = 500;

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
  message: Extract<StructuredMessage, { type: 'command_result' }>
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

function summarizeStructuredMessage(message: StructuredMessage): MessageFormattingResult {
  switch (message.type) {
    case 'agent_session_start':
      return {
        category: 'lifecycle',
        body: {
          type: 'text',
          text: [
            'Agent session started',
            message.executor ? `executor=${message.executor}` : null,
            message.mode ? `mode=${message.mode}` : null,
            message.planId != null ? `plan=${message.planId}` : null,
          ]
            .filter(Boolean)
            .join(' | '),
        },
      };
    case 'agent_session_end':
      return {
        category: 'lifecycle',
        body: {
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
        },
      };
    case 'agent_iteration_start':
      return {
        category: 'lifecycle',
        body: {
          type: 'text',
          text: [
            `Iteration ${message.iterationNumber}`,
            message.taskTitle ?? null,
            message.taskDescription ?? null,
          ]
            .filter(Boolean)
            .join(' | '),
        },
      };
    case 'agent_step_start':
      return {
        category: 'lifecycle',
        body: {
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
        },
      };
    case 'agent_step_end':
      return {
        category: 'lifecycle',
        body: {
          type: 'text',
          text: [
            `Step ${message.success ? 'completed' : 'failed'}: ${message.phase}`,
            message.summary ?? null,
          ]
            .filter(Boolean)
            .join(' | '),
        },
      };
    case 'llm_thinking':
      return {
        category: 'llmOutput',
        body: {
          type: 'monospaced',
          text: message.text,
        },
      };
    case 'llm_response':
      return {
        category: 'llmOutput',
        body: {
          type: 'text',
          text: message.text,
        },
      };
    case 'llm_tool_use':
      return {
        category: 'toolUse',
        body: {
          type: 'keyValuePairs',
          entries: keyValueEntries([
            ['Tool', message.toolName],
            ['Summary', message.inputSummary],
            ['Input', message.input],
          ]),
        },
      };
    case 'llm_tool_result':
      return {
        category: 'toolUse',
        body: {
          type: 'text',
          text: [
            message.toolName,
            message.resultSummary ??
              (message.result != null ? formatJsonValue(message.result) : null),
          ]
            .filter(Boolean)
            .join(': '),
        },
      };
    case 'llm_status':
      return {
        category: 'progress',
        body: {
          type: 'text',
          text: [message.source ?? null, message.status, message.detail ?? null]
            .filter(Boolean)
            .join(' | '),
        },
      };
    case 'todo_update':
      return {
        category: 'progress',
        body: {
          type: 'todoList',
          items: message.items,
          explanation: message.explanation,
        },
      };
    case 'task_completion':
      return {
        category: 'progress',
        body: {
          type: 'text',
          text: message.planComplete
            ? `Plan completed${message.taskTitle ? ` after ${message.taskTitle}` : ''}`
            : `Task completed${message.taskTitle ? `: ${message.taskTitle}` : ''}`,
        },
      };
    case 'file_write':
      return {
        category: 'fileChange',
        body: {
          type: 'text',
          text: `Wrote ${message.path} (${message.lineCount} lines)`,
        },
      };
    case 'file_edit':
      return {
        category: 'fileChange',
        body: {
          type: 'monospaced',
          text: `${message.path}\n${message.diff}`,
        },
      };
    case 'file_change_summary':
      return {
        category: 'fileChange',
        body: {
          type: 'fileChanges',
          changes: message.changes,
          status: message.status,
        },
      };
    case 'command_exec':
      return {
        category: 'command',
        body: {
          type: 'monospaced',
          text: [message.cwd ? `# cwd: ${message.cwd}` : null, `$ ${message.command}`]
            .filter(Boolean)
            .join('\n'),
        },
      };
    case 'command_result':
      return {
        category: 'command',
        body: {
          type: 'monospaced',
          text: summarizeCommandResult(message),
        },
      };
    case 'review_start':
      return {
        category: 'lifecycle',
        body: {
          type: 'text',
          text: [
            'Review started',
            message.executor ? `executor=${message.executor}` : null,
            message.planId != null ? `plan=${message.planId}` : null,
          ]
            .filter(Boolean)
            .join(' | '),
        },
      };
    case 'review_result':
      return {
        category: message.verdict === 'NEEDS_FIXES' ? 'error' : 'lifecycle',
        body: {
          type: 'text',
          text: [
            `Review verdict: ${message.verdict}`,
            message.fixInstructions ?? null,
            message.issues.length ? `issues=${message.issues.length}` : null,
            message.actionItems.length ? `actions=${message.actionItems.length}` : null,
          ]
            .filter(Boolean)
            .join(' | '),
        },
      };
    case 'workflow_progress':
      return {
        category: 'progress',
        body: {
          type: 'text',
          text: [message.phase ?? null, message.message].filter(Boolean).join(' | '),
        },
      };
    case 'failure_report':
      return {
        category: 'error',
        body: {
          type: 'text',
          text: [
            message.summary,
            message.requirements ?? null,
            message.problems ?? null,
            message.solutions ?? null,
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
      };
    case 'execution_summary':
      return {
        category: 'lifecycle',
        body: {
          type: 'keyValuePairs',
          entries: keyValueEntries([
            ['Plan ID', message.summary.planId],
            ['Plan Title', message.summary.planTitle],
            ['Mode', message.summary.mode],
            ['Duration', message.summary.durationMs],
            ['Changed Files', message.summary.changedFiles.join('\n')],
            ['Errors', message.summary.errors.join('\n')],
          ]),
        },
      };
    case 'token_usage':
      return {
        category: 'progress',
        body: {
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
        },
      };
    case 'input_required':
      return {
        category: 'lifecycle',
        body: {
          type: 'text',
          text: message.prompt ?? 'Input required',
        },
      };
    case 'user_terminal_input':
      return {
        category: 'userInput',
        body: {
          type: 'text',
          text: message.content,
        },
      };
    case 'prompt_request':
      return {
        category: 'lifecycle',
        body: {
          type: 'text',
          text: [
            `Prompt requested: ${message.promptType}`,
            message.promptConfig.header ?? null,
            message.promptConfig.question ?? null,
            message.promptConfig.message,
          ]
            .filter(Boolean)
            .join(' | '),
        },
      };
    case 'prompt_answered':
      return {
        category: 'lifecycle',
        body: {
          type: 'text',
          text: [
            `Prompt answered: ${message.promptType}`,
            message.source,
            message.value !== undefined ? formatJsonValue(message.value) : null,
          ]
            .filter(Boolean)
            .join(' | '),
        },
      };
    case 'plan_discovery':
      return {
        category: 'lifecycle',
        body: {
          type: 'text',
          text: `Discovered plan ${message.planId}: ${message.title}`,
        },
      };
    case 'workspace_info':
      return {
        category: 'lifecycle',
        body: {
          type: 'text',
          text: [
            `Workspace: ${message.path}`,
            message.workspaceId ? `id=${message.workspaceId}` : null,
            message.planFile ? `plan=${message.planFile}` : null,
          ]
            .filter(Boolean)
            .join(' | '),
        },
      };
    default:
      return {
        category: 'log',
        body: {
          type: 'text',
          text: `Unsupported structured message type: ${(message as { type?: string }).type ?? 'unknown'}`,
        },
      };
  }
}

export function categorizeMessage(message: StructuredMessage): {
  category: MessageCategory;
  bodyType: MessageBodyType;
} {
  const formatted = summarizeStructuredMessage(message);
  return { category: formatted.category, bodyType: formatted.body.type };
}

export function sessionGroupKey(gitRemote?: string | null, workspacePath?: string | null): string {
  return `${gitRemote ?? ''}|${workspacePath ?? ''}`;
}

function terminalIdentityKey(
  terminalType?: string | null,
  terminalPaneId?: string | null
): string | null {
  if (!terminalType || !terminalPaneId) {
    return null;
  }

  return `${encodeURIComponent(terminalType)}:${encodeURIComponent(terminalPaneId)}`;
}

function getSessionTerminalIdentity(session: SessionData): string | null {
  return terminalIdentityKey(session.sessionInfo.terminalType, session.sessionInfo.terminalPaneId);
}

function getPayloadTerminalIdentity(payload: MessagePayload): string | null {
  return terminalIdentityKey(payload.terminal?.type, payload.terminal?.pane_id);
}

function notificationConnectionId(groupKey: string, terminalIdentity: string | null): string {
  return terminalIdentity
    ? `notification:${groupKey}:${terminalIdentity}`
    : `notification:${groupKey}`;
}

function selectSessionCandidate(
  candidates: SessionData[],
  terminalIdentity: string | null
): SessionData | undefined {
  if (terminalIdentity) {
    const exactMatch = candidates.find(
      (candidate) => getSessionTerminalIdentity(candidate) === terminalIdentity
    );
    if (exactMatch) {
      return exactMatch;
    }
  }

  return candidates.length === 1 ? candidates[0] : undefined;
}

export function formatTunnelMessage(
  connectionId: string,
  seq: number,
  message: TunnelMessage
): DisplayMessage | null {
  switch (message.type) {
    case 'debug':
      return null;
    case 'structured': {
      let formatted: MessageFormattingResult;
      try {
        formatted = summarizeStructuredMessage(message.message);
      } catch {
        // Unknown or malformed structured message type — render as generic log
        return {
          id: `${connectionId}:${seq}`,
          seq,
          timestamp: message.message?.timestamp ?? new Date().toISOString(),
          category: 'log',
          bodyType: 'text',
          body: {
            type: 'text',
            text: `[unknown: ${(message.message as { type?: string })?.type ?? 'no type'}]`,
          },
          rawType:
            (message.message as { type?: string })?.type ??
            ('unknown' as StructuredMessage['type']),
        };
      }
      return {
        id: `${connectionId}:${seq}`,
        seq,
        timestamp: message.message.timestamp,
        category: formatted.category,
        bodyType: formatted.body.type,
        body: formatted.body,
        rawType: message.message.type,
      };
    }
    case 'stdout':
    case 'stderr':
      return {
        id: `${connectionId}:${seq}`,
        seq,
        timestamp: new Date().toISOString(),
        category: 'log',
        bodyType: 'monospaced',
        body: {
          type: 'monospaced',
          text: message.data,
        },
        rawType: message.type,
      };
    case 'log':
    case 'error':
    case 'warn':
      return {
        id: `${connectionId}:${seq}`,
        seq,
        timestamp: new Date().toISOString(),
        category: message.type === 'error' || message.type === 'warn' ? 'error' : 'log',
        bodyType: 'text',
        body: {
          type: 'text',
          text: message.args.join(' '),
        },
        rawType: message.type,
      };
  }
}

export class SessionManager {
  private readonly eventEmitter = new EventEmitter({ captureRejections: false });
  private readonly sessions = new Map<string, SessionData>();
  private readonly senders = new Map<string, AgentSender>();
  private readonly internals = new Map<string, SessionInternals>();
  private projectIdByRemote: Map<string, number> | null = null;

  constructor(private readonly db: Database) {
    this.eventEmitter.setMaxListeners(0);
  }

  handleWebSocketConnect(connectionId: string, sendToAgent: AgentSender): SessionData {
    const connectedAt = new Date().toISOString();
    const session: SessionData = {
      connectionId,
      sessionInfo: { command: 'unknown' },
      status: 'active',
      projectId: null,
      messages: [],
      activePrompt: null,
      isReplaying: false,
      groupKey: sessionGroupKey(),
      connectedAt,
      disconnectedAt: null,
    };

    this.sessions.set(connectionId, session);
    this.senders.set(connectionId, sendToAgent);
    this.internals.set(connectionId, { deferredPromptEvent: null, nextNotificationId: 0 });
    this.emit('session:new', { session: this.cloneSessionMetadata(session) });

    return this.cloneSession(session);
  }

  handleWebSocketDisconnect(connectionId: string): SessionData | null {
    this.senders.delete(connectionId);
    const session = this.sessions.get(connectionId);
    if (!session) {
      return null;
    }

    const hadPrompt = session.activePrompt != null;
    const clearedRequestId = session.activePrompt?.requestId;

    session.status = 'offline';
    session.disconnectedAt = new Date().toISOString();
    session.isReplaying = false;
    session.activePrompt = null;

    const internals = this.internals.get(connectionId);
    if (internals) {
      internals.deferredPromptEvent = null;
    }

    this.emit('session:disconnect', { session: this.cloneSessionMetadata(session) });

    if (hadPrompt && clearedRequestId) {
      this.emit('session:prompt-cleared', { connectionId, requestId: clearedRequestId });
    }

    return this.cloneSession(session);
  }

  handleWebSocketMessage(connectionId: string, message: HeadlessMessage): void {
    const session = this.sessions.get(connectionId);
    if (!session) {
      return;
    }

    switch (message.type) {
      case 'session_info': {
        session.sessionInfo = {
          command: message.command,
          interactive: message.interactive,
          planId: message.planId,
          planTitle: message.planTitle,
          workspacePath: message.workspacePath,
          gitRemote: message.gitRemote,
          terminalPaneId: message.terminalPaneId,
          terminalType: message.terminalType,
        };
        session.groupKey = sessionGroupKey(message.gitRemote, message.workspacePath);
        session.projectId = this.resolveProjectId(message.gitRemote);

        // Reconcile with any existing notification session for the same group
        this.reconcileNotificationSession(session);

        this.emit('session:update', { session: this.cloneSessionMetadata(session) });
        return;
      }
      case 'replay_start':
        session.isReplaying = true;
        this.internals.get(connectionId)!.deferredPromptEvent = null;
        this.emit('session:update', { session: this.cloneSessionMetadata(session) });
        return;
      case 'replay_end': {
        session.isReplaying = false;
        this.emit('session:update', { session: this.cloneSessionMetadata(session) });
        const deferredPrompt = this.internals.get(connectionId)?.deferredPromptEvent;
        if (deferredPrompt) {
          session.activePrompt = { ...deferredPrompt };
          this.emit('session:prompt', {
            connectionId,
            prompt: { ...deferredPrompt },
          });
          this.internals.get(connectionId)!.deferredPromptEvent = null;
        }
        return;
      }
      case 'output': {
        const displayMessage = formatTunnelMessage(connectionId, message.seq, message.message);
        if (displayMessage) {
          session.messages.push(displayMessage);
          this.trimSessionMessages(session, MAX_SESSION_MESSAGES);
        }

        if (message.message.type === 'structured' && message.message.message != null) {
          this.handleStructuredSideEffects(connectionId, session, message.message.message);
        }

        if (displayMessage && !session.isReplaying) {
          this.emit('session:message', { connectionId, message: { ...displayMessage } });
        }

        return;
      }
    }
  }

  handleHttpNotification(payload: MessagePayload): SessionData {
    const now = new Date().toISOString();
    const groupKey = sessionGroupKey(payload.gitRemote, payload.workspacePath);
    const terminalIdentity = getPayloadTerminalIdentity(payload);
    const activeCandidates = [...this.sessions.values()].filter(
      (session) => session.status === 'active' && session.groupKey === groupKey
    );
    // Only merge notifications into active WS sessions, not offline ones.
    // Offline sessions should not receive new notifications — create a notification session instead.
    const websocketSession = selectSessionCandidate(activeCandidates, terminalIdentity);

    if (websocketSession) {
      const displayMessage: DisplayMessage = {
        id: this.nextNotificationMessageId(websocketSession.connectionId),
        seq: NOTIFICATION_SEQ,
        timestamp: now,
        category: 'log',
        bodyType: 'text',
        body: {
          type: 'text',
          text: payload.message,
        },
        rawType: 'log',
      };

      websocketSession.messages.push(displayMessage);
      this.trimSessionMessages(websocketSession, MAX_SESSION_MESSAGES);

      this.emit('session:message', {
        connectionId: websocketSession.connectionId,
        message: { ...displayMessage },
      });
      return this.cloneSession(websocketSession);
    }

    const notificationCandidates = [...this.sessions.values()].filter(
      (session) => session.status === 'notification' && session.groupKey === groupKey
    );
    const existing =
      selectSessionCandidate(notificationCandidates, terminalIdentity) ??
      this.sessions.get(notificationConnectionId(groupKey, terminalIdentity));
    const connectionId =
      existing?.connectionId ?? notificationConnectionId(groupKey, terminalIdentity);
    const sessionInfo: HeadlessSessionInfo = {
      command: 'notification',
      interactive: false,
      workspacePath: payload.workspacePath,
      gitRemote: payload.gitRemote ?? undefined,
      terminalPaneId: payload.terminal?.pane_id,
      terminalType: payload.terminal?.type,
    };

    const session =
      existing ??
      ({
        connectionId,
        sessionInfo,
        status: 'notification',
        projectId: this.resolveProjectId(payload.gitRemote),
        messages: [],
        activePrompt: null,
        isReplaying: false,
        groupKey,
        connectedAt: now,
        disconnectedAt: now,
      } satisfies SessionData);

    session.sessionInfo = sessionInfo;
    session.status = 'notification';
    session.projectId = this.resolveProjectId(payload.gitRemote);
    session.groupKey = groupKey;
    const existingInternals = this.internals.get(connectionId);
    if (!existingInternals) {
      this.internals.set(connectionId, { deferredPromptEvent: null, nextNotificationId: 0 });
    }

    const displayMessage: DisplayMessage = {
      id: this.nextNotificationMessageId(connectionId),
      seq: NOTIFICATION_SEQ,
      timestamp: now,
      category: 'log',
      bodyType: 'text',
      body: {
        type: 'text',
        text: payload.message,
      },
      rawType: 'log',
    };
    session.messages.push(displayMessage);
    this.trimSessionMessages(session, MAX_NOTIFICATION_MESSAGES);

    this.sessions.set(connectionId, session);
    // Use metadata-only clone to avoid duplicating the message that session:message also sends
    this.emit(existing ? 'session:update' : 'session:new', {
      session: this.cloneSessionMetadata(session),
    });
    this.emit('session:message', { connectionId, message: { ...displayMessage } });
    return this.cloneSession(session);
  }

  sendPromptResponse(
    connectionId: string,
    requestId: string,
    value: unknown
  ): 'sent' | 'no_session' | 'no_prompt' {
    const session = this.sessions.get(connectionId);
    if (!session) {
      return 'no_session';
    }

    if (!session.activePrompt || session.activePrompt.requestId !== requestId) {
      return 'no_prompt';
    }

    const sent = this.trySend(connectionId, {
      type: 'prompt_response',
      requestId,
      value,
    });

    if (sent) {
      session.activePrompt = null;
      this.emit('session:prompt-cleared', { connectionId, requestId });
      return 'sent';
    }

    return 'no_session';
  }

  sendUserInput(connectionId: string, content: string): boolean {
    return this.trySend(connectionId, {
      type: 'user_input',
      content,
    });
  }

  private trySend(connectionId: string, message: HeadlessServerMessage): boolean {
    const sender = this.senders.get(connectionId);
    if (!sender) {
      return false;
    }

    try {
      sender(message);
      return true;
    } catch {
      // Socket may have closed between the check and the send
      this.senders.delete(connectionId);
      return false;
    }
  }

  dismissSession(connectionId: string): boolean {
    const session = this.sessions.get(connectionId);
    if (!session || session.status === 'active') {
      return false;
    }

    this.sessions.delete(connectionId);
    this.senders.delete(connectionId);
    this.internals.delete(connectionId);
    this.emit('session:dismissed', { connectionId });
    return true;
  }

  // Clones sessions with messages capped at MAX_SNAPSHOT_MESSAGES per session.
  getSessionSnapshot(): SessionSnapshot {
    return {
      sessions: [...this.sessions.values()]
        .map((session) => this.cloneSession(session, MAX_SNAPSHOT_MESSAGES))
        .sort((a, b) => a.connectedAt.localeCompare(b.connectedAt)),
    };
  }

  subscribe<T extends SessionEventName>(
    eventName: T,
    listener: SessionEventListener<T>
  ): () => void {
    this.eventEmitter.on(eventName, listener);
    return () => this.unsubscribe(eventName, listener);
  }

  unsubscribe<T extends SessionEventName>(eventName: T, listener: SessionEventListener<T>): void {
    this.eventEmitter.off(eventName, listener);
  }

  private emit<T extends SessionEventName>(eventName: T, payload: SessionManagerEvents[T]): void {
    this.eventEmitter.emit(eventName, payload);
  }

  private resolveProjectId(gitRemote?: string | null): number | null {
    if (!gitRemote) {
      return null;
    }

    const cached = this.getProjectIdByRemote();
    const projectId = cached.get(gitRemote);
    if (projectId != null) {
      return projectId;
    }

    this.projectIdByRemote = null;
    return this.getProjectIdByRemote().get(gitRemote) ?? null;
  }

  private getProjectIdByRemote(): Map<string, number> {
    if (this.projectIdByRemote) {
      return this.projectIdByRemote;
    }

    this.projectIdByRemote = new Map(
      listProjects(this.db)
        .filter((project) => project.remote_url != null)
        .map((project) => [project.remote_url as string, project.id] satisfies [string, number])
    );

    return this.projectIdByRemote;
  }

  private reconcileNotificationSession(session: SessionData): void {
    const terminalIdentity = getSessionTerminalIdentity(session);
    const notificationCandidates = [...this.sessions.values()].filter(
      (candidate) => candidate.status === 'notification' && candidate.groupKey === session.groupKey
    );
    const notificationSession = selectSessionCandidate(notificationCandidates, terminalIdentity);

    if (!notificationSession) {
      return;
    }

    // Merge notification messages into the active session
    session.messages.unshift(...notificationSession.messages);
    this.trimSessionMessages(session, MAX_SESSION_MESSAGES);

    // Emit session:message events for each merged message so SSE clients receive them
    // (the session:update event uses metadata-only clone with empty messages array)
    for (const message of notificationSession.messages) {
      this.emit('session:message', {
        connectionId: session.connectionId,
        message: { ...message },
      });
    }

    // Remove the notification session
    this.sessions.delete(notificationSession.connectionId);
    this.internals.delete(notificationSession.connectionId);
    this.emit('session:dismissed', { connectionId: notificationSession.connectionId });
  }

  private handleStructuredSideEffects(
    connectionId: string,
    session: SessionData,
    message: StructuredMessage
  ): void {
    if (message.type === 'prompt_request') {
      // Clear previous prompt if one was still active
      if (session.activePrompt && !session.isReplaying) {
        this.emit('session:prompt-cleared', {
          connectionId,
          requestId: session.activePrompt.requestId,
        });
      }

      const prompt: ActivePrompt = {
        requestId: message.requestId,
        promptType: message.promptType,
        promptConfig: message.promptConfig,
        timeoutMs: message.timeoutMs,
      };

      if (session.isReplaying) {
        const internals = this.internals.get(connectionId);
        if (internals) {
          internals.deferredPromptEvent = prompt;
        }
      } else {
        session.activePrompt = prompt;
        this.emit('session:prompt', { connectionId, prompt: { ...prompt } });
      }
      return;
    }

    if (message.type === 'prompt_answered') {
      const requestId = message.requestId;
      let cleared = false;

      // Only clear prompt state if the answered requestId matches the active prompt
      // A stale answer for a previous prompt should not clear a newer prompt
      if (session.activePrompt?.requestId === requestId) {
        session.activePrompt = null;
        cleared = true;
      }
      const internals = this.internals.get(connectionId);
      if (internals?.deferredPromptEvent?.requestId === requestId) {
        internals.deferredPromptEvent = null;
        cleared = true;
      }

      if (cleared && !session.isReplaying) {
        this.emit('session:prompt-cleared', { connectionId, requestId });
      }
    }
  }

  private nextNotificationMessageId(connectionId: string): string {
    const internals = this.internals.get(connectionId);
    if (!internals) {
      return `${connectionId}:notif-fallback-${crypto.randomUUID()}`;
    }

    const notificationId = internals.nextNotificationId;
    internals.nextNotificationId += 1;
    return `${connectionId}:notif-${notificationId}`;
  }

  private trimSessionMessages(session: SessionData, limit: number): void {
    if (session.messages.length > limit) {
      session.messages = session.messages.slice(-limit);
    }
  }

  private cloneSession(session: SessionData, messageLimit?: number): SessionData {
    const messages =
      messageLimit == null ? session.messages : session.messages.slice(-messageLimit);

    return {
      ...session,
      sessionInfo: { ...session.sessionInfo },
      messages: messages.map((message) => ({ ...message, body: cloneBody(message.body) })),
      activePrompt:
        !session.isReplaying && session.activePrompt
          ? {
              ...session.activePrompt,
              promptConfig: {
                ...session.activePrompt.promptConfig,
                choices: session.activePrompt.promptConfig.choices?.map((choice) => ({
                  ...choice,
                })),
              },
            }
          : null,
    };
  }

  /** Clone session metadata without messages — used for events where messages aren't needed. */
  private cloneSessionMetadata(session: SessionData): SessionData {
    return {
      ...session,
      sessionInfo: { ...session.sessionInfo },
      messages: [],
      activePrompt:
        !session.isReplaying && session.activePrompt
          ? {
              ...session.activePrompt,
              promptConfig: {
                ...session.activePrompt.promptConfig,
                choices: session.activePrompt.promptConfig.choices?.map((choice) => ({
                  ...choice,
                })),
              },
            }
          : null,
    };
  }
}

function cloneBody(body: DisplayMessageBody): DisplayMessageBody {
  switch (body.type) {
    case 'text':
    case 'monospaced':
      return { ...body };
    case 'todoList':
      return {
        ...body,
        items: body.items.map((item) => ({ ...item })),
      };
    case 'fileChanges':
      return {
        ...body,
        changes: body.changes.map((change) => ({ ...change })),
      };
    case 'keyValuePairs':
      return {
        ...body,
        entries: body.entries.map((entry) => ({ ...entry })),
      };
  }
}

export function subscribeToAllSessionEvents(
  manager: SessionManager,
  listener: <T extends SessionEventName>(eventName: T, payload: SessionManagerEvents[T]) => void
): () => void {
  const unsubscribers = SESSION_EVENT_NAMES.map((eventName) =>
    manager.subscribe(eventName, (payload) => listener(eventName, payload))
  );

  return () => {
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
  };
}
