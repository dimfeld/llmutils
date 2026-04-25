import type { TunnelMessage } from './tunnel_protocol.js';

export interface HeadlessSessionInfo {
  sessionId?: string;
  command: string;
  interactive?: boolean;
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

export interface HeadlessReplayStartMessage {
  type: 'replay_start';
}

export interface HeadlessReplayEndMessage {
  type: 'replay_end';
}

export interface HeadlessPlanContentMessage {
  type: 'plan_content';
  content: string;
}

export interface HeadlessSessionEndedMessage {
  type: 'session_ended';
}

export type HeadlessMessage =
  | HeadlessSessionInfoMessage
  | HeadlessOutputMessage
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

/** Server→client message: request that the running session end gracefully. */
export interface HeadlessEndSessionServerMessage {
  type: 'end_session';
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
  | HeadlessEndSessionServerMessage
  | HeadlessNotificationSubscribersMessage;
