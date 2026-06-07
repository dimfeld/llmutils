import type { TunnelMessage } from './tunnel_protocol.js';

export interface HeadlessSessionInfo {
  sessionId?: string;
  command: string;
  interactive?: boolean;
  pty?: boolean;
  cols?: number;
  rows?: number;
  planId?: number;
  planUuid?: string;
  planTitle?: string;
  linkedPlanId?: number;
  linkedPlanUuid?: string;
  linkedPlanTitle?: string;
  linkedPrUrl?: string;
  linkedPrNumber?: number;
  linkedPrTitle?: string;
  workspacePath?: string;
  gitRemote?: string;
  terminalPaneId?: string;
  terminalType?: string;
}

export interface HeadlessSessionInfoMessage extends HeadlessSessionInfo {
  type: 'session_info';
}

export interface HeadlessOutputMessage {
  type: 'output';
  seq: number;
  message: TunnelMessage;
}

export interface HeadlessPtyOutputMessage {
  type: 'pty_output';
  data: string;
}

export interface HeadlessReplayStartMessage {
  type: 'replay_start';
}

export interface HeadlessReplayEndMessage {
  type: 'replay_end';
}

export interface HeadlessPlanContentMessage {
  type: 'plan_content';
  content: string;
  tasks?: HeadlessPlanTask[];
}

export interface HeadlessPlanTask {
  title: string;
  description: string;
  done: boolean;
}

export interface HeadlessSessionEndedMessage {
  type: 'session_ended';
}

export type HeadlessMessage =
  | HeadlessSessionInfoMessage
  | HeadlessOutputMessage
  | HeadlessPtyOutputMessage
  | HeadlessReplayStartMessage
  | HeadlessReplayEndMessage
  | HeadlessPlanContentMessage
  | HeadlessSessionEndedMessage;

/** Server→client message: response to a prompt_request. */
export interface HeadlessPromptResponseServerMessage {
  type: 'prompt_response';
  requestId: string;
  value?: unknown;
  error?: string;
}

/** Server→client message: free-form user input from the GUI. */
export interface HeadlessUserInputServerMessage {
  type: 'user_input';
  content: string;
}

/** Server→client message: raw PTY input bytes encoded as base64. */
export interface HeadlessPtyInputServerMessage {
  type: 'pty_input';
  data: string;
}

/** Server→client message: PTY terminal resize request. */
export interface HeadlessPtyResizeServerMessage {
  type: 'pty_resize';
  cols: number;
  rows: number;
}

/** Server→client message: request that the running session end gracefully. */
export interface HeadlessEndSessionServerMessage {
  type: 'end_session';
}

/** Server→client message: request that the running session receive SIGTERM. */
export interface HeadlessForceEndSessionServerMessage {
  type: 'force_end_session';
}

/** Server→client message: browser notification subscriber status update. */
export interface HeadlessNotificationSubscribersMessage {
  type: 'notification_subscribers_changed';
  hasSubscribers: boolean;
}

/** Discriminated union of all server→client messages over the headless websocket. */
export type HeadlessServerMessage =
  | HeadlessPromptResponseServerMessage
  | HeadlessUserInputServerMessage
  | HeadlessPtyInputServerMessage
  | HeadlessPtyResizeServerMessage
  | HeadlessEndSessionServerMessage
  | HeadlessForceEndSessionServerMessage
  | HeadlessNotificationSubscribersMessage;
