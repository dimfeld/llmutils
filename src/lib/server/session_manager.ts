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
import { parseGitRemoteUrl } from '$common/git_url_parser.js';

export type SessionStatus = 'active' | 'offline' | 'notification';
export type MessageCategory = 'log' | 'error' | 'structured';
export type MessageBodyType =
  | 'text'
  | 'monospaced'
  | 'todoList'
  | 'fileChanges'
  | 'keyValuePairs'
  | 'structured';

export type StructuredMessagePayload = StructuredMessage extends infer T
  ? T extends StructuredMessage
    ? Omit<T, 'timestamp' | 'transportSource'>
    : never
  : never;

export interface StructuredMessageBody {
  type: 'structured';
  message: StructuredMessagePayload;
}

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
  | KeyValuePairsMessageBody
  | StructuredMessageBody;

export interface DisplayMessage {
  id: string;
  seq: number;
  timestamp: string;
  category: MessageCategory;
  bodyType: MessageBodyType;
  body: DisplayMessageBody;
  rawType: StructuredMessage['type'] | TunnelMessage['type'] | string;
  triggersNotification?: boolean;
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

function stripStructuredMessage(message: StructuredMessage): StructuredMessagePayload {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { timestamp, transportSource, ...payload } = message;
  return payload as StructuredMessagePayload;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

export function sessionGroupKey(gitRemote?: string | null, workspacePath?: string | null): string {
  const normalizedRemote = normalizeSessionRemote(gitRemote);
  if (normalizedRemote) {
    return normalizedRemote;
  }

  return `|${workspacePath ?? ''}`;
}

function normalizeSessionRemote(gitRemote?: string | null): string {
  if (!gitRemote) {
    return '';
  }

  const trimmedRemote = gitRemote.trim();
  if (!trimmedRemote) {
    return '';
  }

  const parsed = parseGitRemoteUrl(trimmedRemote);
  if (!parsed?.host || !parsed.fullName) {
    return trimmedRemote;
  }

  return `${parsed.host.toLowerCase()}/${parsed.fullName.toLowerCase()}`;
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
      try {
        const structured = message.message;
        // Validate that the payload is a plain object with a string type
        if (
          structured == null ||
          typeof structured !== 'object' ||
          Array.isArray(structured) ||
          typeof structured.type !== 'string'
        ) {
          return {
            id: `${connectionId}:${seq}`,
            seq,
            timestamp: new Date().toISOString(),
            category: 'log',
            bodyType: 'text',
            body: {
              type: 'text',
              text: `[malformed structured message]`,
            },
            rawType: 'unknown' as StructuredMessage['type'],
          };
        }
        const triggersNotification =
          structured.type === 'agent_session_end' && structured.transportSource !== 'tunnel';
        const stripped = stripStructuredMessage(structured);
        return {
          id: `${connectionId}:${seq}`,
          seq,
          timestamp: structured.timestamp ?? new Date().toISOString(),
          category: 'structured',
          bodyType: 'structured',
          body: {
            type: 'structured',
            message: stripped,
          },
          rawType: structured.type,
          triggersNotification,
        };
      } catch {
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
          sessionId: message.sessionId,
          planId: message.planId,
          planUuid: message.planUuid,
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
      case 'session_ended':
        // The agent is shutting down gracefully. This message confirms all prior
        // messages have been sent. The actual disconnect event will follow shortly.
        return;
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
        id: this.nextSyntheticMessageId(websocketSession.connectionId, 'notif'),
        seq: NOTIFICATION_SEQ,
        timestamp: now,
        category: 'log',
        bodyType: 'text',
        body: {
          type: 'text',
          text: payload.message,
        },
        rawType: 'log',
        triggersNotification: true,
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
      id: this.nextSyntheticMessageId(connectionId, 'notif'),
      seq: NOTIFICATION_SEQ,
      timestamp: now,
      category: 'log',
      bodyType: 'text',
      body: {
        type: 'text',
        text: payload.message,
      },
      rawType: 'log',
      triggersNotification: true,
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

  endSession(connectionId: string): boolean {
    return this.trySend(connectionId, { type: 'end_session' });
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

  dismissInactiveSessions(): number {
    let dismissed = 0;
    for (const [connectionId, session] of this.sessions) {
      if (session.status !== 'active') {
        this.sessions.delete(connectionId);
        this.senders.delete(connectionId);
        this.internals.delete(connectionId);
        this.emit('session:dismissed', { connectionId });
        dismissed++;
      }
    }
    return dismissed;
  }

  hasActiveSessionForPlan(
    planUuid: string,
    command?: string | string[]
  ): { active: boolean; connectionId?: string } {
    for (const session of this.sessions.values()) {
      if (
        session.status === 'active' &&
        session.sessionInfo.planUuid === planUuid &&
        (command == null ||
          (Array.isArray(command)
            ? command.includes(session.sessionInfo.command)
            : session.sessionInfo.command === command))
      ) {
        return { active: true, connectionId: session.connectionId };
      }
    }

    return { active: false };
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
    const normalizedRemote = normalizeSessionRemote(gitRemote);
    if (!normalizedRemote) {
      return null;
    }

    const cached = this.getProjectIdByRemote();
    const projectId = cached.get(normalizedRemote);
    if (projectId != null) {
      return projectId;
    }

    this.projectIdByRemote = null;
    return this.getProjectIdByRemote().get(normalizedRemote) ?? null;
  }

  private getProjectIdByRemote(): Map<string, number> {
    if (this.projectIdByRemote) {
      return this.projectIdByRemote;
    }

    const projectEntries = new Map<string, number>();
    for (const project of listProjects(this.db).filter((project) => project.remote_url != null)) {
      const remoteUrl = project.remote_url as string;
      projectEntries.set(remoteUrl, project.id);
      const normalizedRemote = normalizeSessionRemote(remoteUrl);
      if (normalizedRemote && normalizedRemote !== remoteUrl) {
        projectEntries.set(normalizedRemote, project.id);
      }
    }

    this.projectIdByRemote = projectEntries;

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
      if (typeof message.requestId !== 'string' || !isObjectRecord(message.promptConfig)) {
        return;
      }
      // Validate choices is an array (or absent) so cloneSession/PromptRenderer don't crash
      if (message.promptConfig.choices != null && !Array.isArray(message.promptConfig.choices)) {
        return;
      }

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
      if (typeof message.requestId !== 'string') {
        return;
      }

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
      return;
    }

    if (message.type === 'prompt_cancelled') {
      const requestId = message.requestId;
      let cleared = false;

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
      return;
    }
  }

  private nextSyntheticMessageId(connectionId: string, prefix: string): string {
    const internals = this.internals.get(connectionId);
    if (!internals) {
      return `${connectionId}:${prefix}-fallback-${crypto.randomUUID()}`;
    }

    const notificationId = internals.nextNotificationId;
    internals.nextNotificationId += 1;
    return `${connectionId}:${prefix}-${notificationId}`;
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
    case 'structured':
      return {
        type: 'structured',
        message: structuredClone(body.message),
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
