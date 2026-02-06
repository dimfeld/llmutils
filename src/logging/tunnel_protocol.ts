import { inspect } from 'node:util';

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

/**
 * Union type for all messages sent over the tunnel socket as JSONL.
 */
export type TunnelMessage = TunnelArgsMessage | TunnelDataMessage;

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
