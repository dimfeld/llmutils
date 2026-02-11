import type { TunnelMessage } from './tunnel_protocol.js';

export interface HeadlessSessionInfo {
  command: string;
  planId?: number;
  planTitle?: string;
  workspacePath?: string;
  gitRemote?: string;
}

export interface HeadlessSessionInfoMessage {
  type: 'session_info';
  command: string;
  planId?: number;
  planTitle?: string;
  workspacePath?: string;
  gitRemote?: string;
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

/** Discriminated union of all server→client messages over the headless websocket. */
export type HeadlessServerMessage = HeadlessPromptResponseServerMessage;
