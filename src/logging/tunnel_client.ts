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
    const serialized = serializeArgs(args);
    this.send({ type: 'log', args: serialized });
    writeToLogFile(serialized.join(' ') + '\n');
  }

  error(...args: any[]): void {
    const serialized = serializeArgs(args);
    this.send({ type: 'error', args: serialized });
    writeToLogFile(serialized.join(' ') + '\n');
  }

  warn(...args: any[]): void {
    const serialized = serializeArgs(args);
    this.send({ type: 'warn', args: serialized });
    writeToLogFile(serialized.join(' ') + '\n');
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
      const serialized = serializeArgs(args);
      this.send({ type: 'debug', args: serialized });
      writeToLogFile('[DEBUG] ' + serialized.join(' ') + '\n');
    }
  }

  /**
   * Synchronously initiates socket shutdown by calling end() (which starts the
   * flush) and then destroy(). This is suitable for use in synchronous cleanup
   * handlers (e.g. CleanupRegistry) where awaiting is not possible.
   *
   * The tunnel is a visibility aid, so losing the last few buffered bytes during
   * signal-triggered exit is acceptable. Critical output (like --print review
   * results) is written directly to process.stdout.write() and does not depend
   * on this flush.
   */
  destroySync(): void {
    this.connected = false;
    if (!this.socket.destroyed) {
      this.socket.end();
      this.socket.destroy();
    }
  }

  /**
   * Gracefully closes the socket connection, flushing any pending writes before
   * tearing down the connection. Uses socket.end() to signal the write side is
   * done, then waits for the 'finish' event (indicating all data has been flushed
   * to the kernel) before calling socket.destroy(). A timeout ensures this doesn't
   * hang forever if the server is gone.
   *
   * Should be called during cleanup when an async context is available.
   *
   * @param timeoutMs - Maximum time to wait for flush before forcing destroy (default: 2000ms)
   */
  destroy(timeoutMs: number = 2000): Promise<void> {
    this.connected = false;

    return new Promise<void>((resolve) => {
      // If the socket is already destroyed/closed, resolve immediately
      if (this.socket.destroyed) {
        resolve();
        return;
      }

      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        if (!this.socket.destroyed) {
          this.socket.destroy();
        }
        resolve();
      };

      // Timeout fallback: force destroy if flush doesn't complete in time
      const timer = setTimeout(done, timeoutMs);

      // socket.end() flushes pending writes and signals the write side is done.
      // The 'finish' event fires when all data has been flushed to the underlying
      // system (kernel buffer). The 'close' event fires when the socket is fully closed.
      this.socket.on('finish', done);
      this.socket.on('close', done);
      this.socket.on('error', done);

      this.socket.end();
    });
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
    const socket = new net.Socket();

    // Register error handler immediately before initiating the connection
    // to ensure no error events are missed.
    socket.once('error', (err) => {
      reject(err);
    });

    socket.connect(socketPath, () => {
      resolve(new TunnelAdapter(socket));
    });
  });
}
