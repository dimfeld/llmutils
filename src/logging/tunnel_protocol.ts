import { inspect } from 'node:util';
import type { StructuredMessage } from './structured_messages.js';

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
}

/**
 * A tunnel message carrying raw stdout or stderr data.
 */
export interface TunnelDataMessage {
  type: 'stdout' | 'stderr';
  data: string;
}

export interface StructuredTunnelMessage {
  type: 'structured';
  message: StructuredMessage;
}

/**
 * Union type for all messages sent from client to server over the tunnel socket as JSONL.
 */
export type TunnelMessage = TunnelArgsMessage | TunnelDataMessage | StructuredTunnelMessage;

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

/**
 * Union type for all messages sent from server to client over the tunnel socket as JSONL.
 * Separate from TunnelMessage (client->server) to maintain clear protocol directionality.
 */
export type ServerTunnelMessage = TunnelPromptResponseMessage | TunnelUserInputMessage;

export function isStructuredTunnelMessage(
  message: TunnelMessage
): message is StructuredTunnelMessage {
  return message.type === 'structured';
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
