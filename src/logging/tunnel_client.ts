import net from 'node:net';
import type { LoggerAdapter } from './adapter.js';
import { writeToLogFile } from './common.js';
import { debug } from '../common/process.js';
import { TIM_OUTPUT_SOCKET, serializeArgs } from './tunnel_protocol.js';
import type { TunnelMessage } from './tunnel_protocol.js';

/**
 * Returns true when the TIM_OUTPUT_SOCKET environment variable is set,
 * indicating that a tunnel server is available for output forwarding.
 */
export function isTunnelActive(): boolean {
  return !!process.env[TIM_OUTPUT_SOCKET];
}

/**
 * A LoggerAdapter that sends all log output as JSONL messages over a Unix socket
 * to a parent tim process's tunnel server. Also writes to the log file locally.
 *
 * If the socket disconnects after initial connection, the adapter falls back to
 * no-op behavior for socket writes (log file writes continue).
 */
export class TunnelAdapter implements LoggerAdapter {
  private socket: net.Socket;
  private connected: boolean = true;

  constructor(socket: net.Socket) {
    this.socket = socket;

    this.socket.on('error', () => {
      this.connected = false;
    });

    this.socket.on('close', () => {
      this.connected = false;
    });
  }

  /**
   * Writes a JSONL-encoded tunnel message to the socket.
   * Silently drops the message if the socket is no longer connected.
   */
  private send(message: TunnelMessage): void {
    if (!this.connected) {
      return;
    }

    try {
      this.socket.write(JSON.stringify(message) + '\n');
    } catch {
      // If write fails, mark as disconnected and fall back to no-op
      this.connected = false;
    }
  }

  log(...args: any[]): void {
    this.send({ type: 'log', args: serializeArgs(args) });
    writeToLogFile(serializeArgs(args).join(' ') + '\n');
  }

  error(...args: any[]): void {
    this.send({ type: 'error', args: serializeArgs(args) });
    writeToLogFile(serializeArgs(args).join(' ') + '\n');
  }

  warn(...args: any[]): void {
    this.send({ type: 'warn', args: serializeArgs(args) });
    writeToLogFile(serializeArgs(args).join(' ') + '\n');
  }

  writeStdout(data: string): void {
    this.send({ type: 'stdout', data });
    writeToLogFile(data);
  }

  writeStderr(data: string): void {
    this.send({ type: 'stderr', data });
    writeToLogFile(data);
  }

  debugLog(...args: any[]): void {
    if (debug) {
      this.log('[DEBUG]', ...args);
    }
  }

  /**
   * Closes the socket connection. Should be called during cleanup.
   */
  destroy(): void {
    this.connected = false;
    this.socket.destroy();
  }
}

/**
 * Creates a TunnelAdapter by connecting to the given Unix domain socket path.
 * Awaits the connection before returning so that the adapter is ready for use.
 *
 * @param socketPath - Path to the Unix domain socket created by the parent process
 * @returns A connected TunnelAdapter instance
 * @throws If the connection fails (caller should handle this gracefully)
 */
export function createTunnelAdapter(socketPath: string): Promise<TunnelAdapter> {
  return new Promise<TunnelAdapter>((resolve, reject) => {
    const socket = net.connect(socketPath, () => {
      resolve(new TunnelAdapter(socket));
    });

    socket.on('error', (err) => {
      reject(err);
    });
  });
}
