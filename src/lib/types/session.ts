/**
 * Client-side types for session data, mirroring the server-side types from session_manager.ts.
 * These cannot be imported from $lib/server/ because bun:sqlite is not available client-side.
 */

import type { StructuredMessage } from '../../logging/structured_messages.js';

export type SessionStatus = 'active' | 'offline' | 'notification';

export type MessageCategory = 'log' | 'error' | 'structured';

export type MessageBodyType =
  | 'text'
  | 'monospaced'
  | 'todoList'
  | 'fileChanges'
  | 'keyValuePairs'
  | 'structured';

/** The structured message with transport-only fields stripped. Distributive to preserve discriminated union narrowing. */
export type StructuredMessagePayload = StructuredMessage extends infer T
  ? T extends StructuredMessage
    ? Omit<T, 'timestamp' | 'transportSource'>
    : never
  : never;

export type TodoUpdateStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'unknown';

export interface TodoUpdateItem {
  label: string;
  status: TodoUpdateStatus;
}

export type FileChangeKind = 'added' | 'updated' | 'removed';

export interface FileChangeItem {
  path: string;
  kind: FileChangeKind;
  diff?: string;
}

export interface KeyValuePairEntry {
  key: string;
  value: string;
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

export interface KeyValuePairsMessageBody {
  type: 'keyValuePairs';
  entries: KeyValuePairEntry[];
}

export interface StructuredMessageBody {
  type: 'structured';
  message: StructuredMessagePayload;
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
  rawType: string;
  triggersNotification?: boolean;
}

export type PromptType = 'input' | 'confirm' | 'select' | 'checkbox' | 'prefix_select';

export interface PromptChoiceConfig {
  name: string;
  value: string | number | boolean;
  description?: string;
  checked?: boolean;
}

export interface PromptConfig {
  message: string;
  header?: string;
  question?: string;
  default?: string | number | boolean;
  choices?: PromptChoiceConfig[];
  pageSize?: number;
  command?: string;
  validationHint?: string;
}

export interface ActivePrompt {
  requestId: string;
  promptType: PromptType;
  promptConfig: PromptConfig;
  timeoutMs?: number;
}

export interface HeadlessSessionInfo {
  command: string;
  interactive?: boolean;
  sessionId?: string;
  planId?: number;
  planUuid?: string;
  planTitle?: string;
  workspacePath?: string;
  gitRemote?: string;
  terminalPaneId?: string;
  terminalType?: string;
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

export interface SessionGroup {
  groupKey: string;
  label: string;
  projectId: number | null;
  sessions: SessionData[];
}

/** SSE event payloads */
export interface SessionListEvent {
  sessions: SessionData[];
}

export interface SessionNewEvent {
  session: SessionData;
}

export interface SessionUpdateEvent {
  session: SessionData;
}

export interface SessionDisconnectEvent {
  session: SessionData;
}

export interface SessionMessageEvent {
  connectionId: string;
  message: DisplayMessage;
}

export interface SessionPromptEvent {
  connectionId: string;
  prompt: ActivePrompt;
}

export interface SessionPromptClearedEvent {
  connectionId: string;
  requestId: string;
}

export interface SessionDismissedEvent {
  connectionId: string;
}

export interface SessionSyncCompleteEvent {}

export interface PrUpdatedEvent {
  prUrls: string[];
  projectIds: number[];
}

export interface SessionClientEventMap {
  'session:list': SessionListEvent;
  'session:sync-complete': SessionSyncCompleteEvent;
  'session:new': SessionNewEvent;
  'session:update': SessionUpdateEvent;
  'session:disconnect': SessionDisconnectEvent;
  'session:message': SessionMessageEvent;
  'session:prompt': SessionPromptEvent;
  'session:prompt-cleared': SessionPromptClearedEvent;
  'session:dismissed': SessionDismissedEvent;
  'pr:updated': PrUpdatedEvent;
}

export type SessionClientEventName = keyof SessionClientEventMap;

export type SessionClientEvent = {
  [TEventName in SessionClientEventName]: {
    eventName: TEventName;
    payload: SessionClientEventMap[TEventName];
  };
}[SessionClientEventName];
