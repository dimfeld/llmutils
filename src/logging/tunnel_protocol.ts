import { inspect } from 'node:util';
import type { StructuredMessage } from './structured_messages.js';
import type {
  ProcessId,
  SessionProcessControlOperation,
  SessionProcessExit,
  SessionProcessRegistration,
  SessionProcessTerminationResultEvent,
  SessionProcessUpdate,
} from '../common/session_process.js';

/**
 * Environment variable name for the Unix socket path used to tunnel
 * log output from nested tim processes back to the root tim process.
 */
export const TIM_OUTPUT_SOCKET = 'TIM_OUTPUT_SOCKET';

/**
 * A tunnel message carrying log/error/warn/debug output with serialized arguments.
 */
export interface TunnelArgsMessage {
  type: 'log' | 'error' | 'warn' | 'debug';
  args: string[];
  /** Agent name that produced this message. Omitted by older clients. */
  agentName?: string;
}

/**
 * Marks where a piece of raw output originated, so consumers (e.g. the web
 * session view) can render or filter it differently. When omitted, the output
 * is treated as ordinary agent/process output.
 */
export type OutputOrigin = 'lifecycle';

/**
 * Options for raw stdout/stderr writes carried through the logging adapters.
 */
export interface WriteOptions {
  /** Where this output originated (e.g. a workspace lifecycle command). */
  origin?: OutputOrigin;
}

/**
 * A tunnel message carrying raw stdout or stderr data.
 */
export interface TunnelDataMessage {
  type: 'stdout' | 'stderr';
  data: string;
  /** Where this output originated. Omitted for ordinary process output. */
  origin?: OutputOrigin;
  /** Agent name that produced this message. Omitted by older clients. */
  agentName?: string;
}

export interface StructuredTunnelMessage {
  type: 'structured';
  message: StructuredMessage;
  /** Agent name that produced this message. Omitted by older clients. */
  agentName?: string;
}

/** Registers a tim or executor node in the root session process registry. */
export type TunnelProcessRegisterMessage = {
  type: 'process_register';
} & Required<Pick<SessionProcessRegistration, 'processId'>> &
  Omit<SessionProcessRegistration, 'processId'>;

/** Updates mutable metadata for a registered process node. */
export type TunnelProcessUpdateMessage = {
  type: 'process_update';
  processId: ProcessId;
} & SessionProcessUpdate;

/** Marks a registered process as exited. */
export type TunnelProcessExitMessage = {
  type: 'process_exit';
  processId: ProcessId;
} & SessionProcessExit;

/** Removes one process node, optionally with all descendants. */
export interface TunnelProcessRemoveMessage {
  type: 'process_remove';
  processId: ProcessId;
  subtree?: boolean;
}

export type TunnelProcessMessage =
  | TunnelProcessRegisterMessage
  | TunnelProcessUpdateMessage
  | TunnelProcessExitMessage
  | TunnelProcessRemoveMessage
  | TunnelTerminateExecutorResultMessage;

/**
 * Union type for all messages sent from client to server over the tunnel socket as JSONL.
 */
export type TunnelMessage =
  | TunnelArgsMessage
  | TunnelDataMessage
  | StructuredTunnelMessage
  | TunnelProcessMessage;

/**
 * A server-to-client message carrying a prompt response.
 * Sent by the tunnel server after rendering an inquirer prompt on behalf of the client.
 *
 * When both `value` and `error` are present, `error` takes precedence and the
 * response is treated as a failure. Consumers should check `error` first.
 */
export interface TunnelPromptResponseMessage {
  type: 'prompt_response';
  requestId: string;
  /** The prompt result (present on success) */
  value?: unknown;
  /** Error message (present on failure). Takes precedence over `value` when both are set. */
  error?: string;
}

/**
 * A server-to-client message carrying user terminal input to forward
 * to a running child agent process.
 */
export interface TunnelUserInputMessage {
  type: 'user_input';
  content: string;
}

/** A targeted request to the owning tim process to terminate one executor. */
export interface TunnelTerminateExecutorMessage {
  type: 'terminate_executor';
  executorId: ProcessId;
  requestId?: string;
  /** Omitted for backwards-compatible SIGTERM termination. */
  action?: SessionProcessControlOperation;
}

/** Result returned by a nested tim owner after handling a targeted request. */
export type TunnelTerminateExecutorResultMessage = {
  type: 'terminate_executor_result';
} & SessionProcessTerminationResultEvent;

/**
 * Union type for all messages sent from server to client over the tunnel socket as JSONL.
 * Separate from TunnelMessage (client->server) to maintain clear protocol directionality.
 */
export type ServerTunnelMessage =
  | TunnelPromptResponseMessage
  | TunnelUserInputMessage
  | TunnelTerminateExecutorMessage;

export function isStructuredTunnelMessage(
  message: TunnelMessage
): message is StructuredTunnelMessage {
  return message.type === 'structured';
}

export function isTunnelProcessMessage(message: TunnelMessage): message is TunnelProcessMessage {
  return (
    message.type === 'process_register' ||
    message.type === 'process_update' ||
    message.type === 'process_exit' ||
    message.type === 'process_remove' ||
    message.type === 'terminate_executor_result'
  );
}

/**
 * Serializes a single argument to a string suitable for tunnel transport.
 * Strings are passed through as-is; all other types are formatted with util.inspect().
 * This matches the pattern used by ConsoleAdapter.
 */
export function serializeArg(arg: unknown): string {
  return typeof arg === 'string' ? arg : inspect(arg);
}

/**
 * Serializes an array of LoggerAdapter arguments to an array of strings
 * for inclusion in a TunnelArgsMessage.
 */
export function serializeArgs(args: unknown[]): string[] {
  return args.map(serializeArg);
}
