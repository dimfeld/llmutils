import type { TunnelMessage } from './tunnel_protocol.js';

export interface HeadlessSessionInfo {
  command: string;
  planId?: number;
  planTitle?: string;
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

export type HeadlessMessage =
  | HeadlessSessionInfoMessage
  | HeadlessOutputMessage
  | HeadlessReplayStartMessage
  | HeadlessReplayEndMessage;

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

/** Discriminated union of all server→client messages over the headless websocket. */
export type HeadlessServerMessage =
  | HeadlessPromptResponseServerMessage
  | HeadlessUserInputServerMessage;
