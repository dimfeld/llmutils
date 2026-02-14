import net from 'node:net';
import type { LoggerAdapter } from './adapter.js';
import { writeToLogFile } from './common.js';
import { debug } from '../common/process.js';
import { TIM_OUTPUT_SOCKET, serializeArgs } from './tunnel_protocol.js';
import type { TunnelMessage, ServerTunnelMessage } from './tunnel_protocol.js';
import type { StructuredMessage, PromptRequestMessage } from './structured_messages.js';
import { formatStructuredMessage } from './console_formatter.js';

/** Pending prompt request entry tracked by the TunnelAdapter. */
interface PendingPromptRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Creates a line splitter function that handles message framing across TCP chunks.
 * Buffers partial lines and returns complete newline-terminated lines.
 */
function createLineSplitter(): (input: string) => string[] {
  let fragment: string = '';

  return function splitLines(input: string): string[] {
    const fullInput = fragment + input;
    const lines = fullInput.split('\n');
    // Last element is the new fragment (empty if input ends with newline)
    fragment = lines.pop() || '';
    return lines;
  };
}

/**
 * Validates that a parsed JSON object is a valid ServerTunnelMessage.
 */
function isValidServerTunnelMessage(message: unknown): message is ServerTunnelMessage {
  if (typeof message !== 'object' || message === null) {
    return false;
  }

  const msg = message as Record<string, unknown>;

  switch (msg.type) {
    case 'prompt_response':
      return (
        typeof msg.requestId === 'string' &&
        (msg.error === undefined || typeof msg.error === 'string')
      );
    case 'user_input':
      return typeof msg.content === 'string';
    default:
      return false;
  }
}

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
  private pendingPrompts: Map<string, PendingPromptRequest> = new Map();
  private userInputHandler?: (content: string) => void;

  constructor(socket: net.Socket) {
    this.socket = socket;

    // Set up incoming data handler for server->client messages (prompt responses)
    const splitLines = createLineSplitter();
    this.socket.on('data', (data) => {
      const lines = splitLines(data.toString());
      for (const line of lines) {
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (isValidServerTunnelMessage(parsed)) {
            this.handleServerMessage(parsed);
          }
        } catch {
          // Malformed JSON from server - silently ignore
        }
      }
    });

    this.socket.on('error', () => {
      this.connected = false;
      this.rejectAllPending(new Error('Tunnel connection error'));
    });

    this.socket.on('close', () => {
      this.connected = false;
      this.rejectAllPending(new Error('Tunnel connection closed'));
    });
  }

  /**
   * Handles an incoming server->client message.
   */
  private handleServerMessage(message: ServerTunnelMessage): void {
    switch (message.type) {
      case 'prompt_response': {
        const pending = this.pendingPrompts.get(message.requestId);
        if (!pending) {
          // Unknown requestId - silently ignore (may have already timed out)
          return;
        }
        this.pendingPrompts.delete(message.requestId);
        if (pending.timer) {
          clearTimeout(pending.timer);
        }
        if (message.error) {
          pending.reject(new Error(message.error));
        } else {
          pending.resolve(message.value);
        }
        break;
      }
      case 'user_input':
        try {
          this.userInputHandler?.(message.content);
        } catch (err) {
          writeToLogFile(`[tunnel] User input handler error: ${err as Error}\n`);
        }
        break;
    }
  }

  /**
   * Registers the single active user-input handler.
   * Calling this again replaces the previous handler.
   */
  setUserInputHandler(callback: ((content: string) => void) | undefined): void {
    this.userInputHandler = callback;
  }

  /**
   * Rejects all pending prompt requests with the given error.
   * Called when the socket connection is lost.
   */
  private rejectAllPending(error: Error): void {
    for (const [requestId, pending] of this.pendingPrompts) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(error);
      this.pendingPrompts.delete(requestId);
    }
  }

  /**
   * Sends a prompt request over the tunnel and returns a promise that resolves
   * when the server sends back the prompt response.
   *
   * @param message - The PromptRequestMessage to send
   * @param timeoutMs - Optional timeout in milliseconds. If the server doesn't respond within
   *   this time, the promise rejects with a timeout error.
   * @returns The prompt result value from the server
   */
  sendPromptRequest(message: PromptRequestMessage, timeoutMs?: number): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (!this.connected) {
        reject(new Error('Tunnel is not connected'));
        return;
      }

      const entry: PendingPromptRequest = { resolve, reject };

      if (timeoutMs != null && timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pendingPrompts.delete(message.requestId);
          reject(new Error(`Prompt request timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      this.pendingPrompts.set(message.requestId, entry);

      // Send the message as a structured tunnel message.
      // If send() fails (serialization error or write failure), clean up
      // the pending entry immediately so the promise doesn't hang forever.
      const sent = this.send({ type: 'structured', message });
      if (!sent) {
        this.pendingPrompts.delete(message.requestId);
        if (entry.timer) {
          clearTimeout(entry.timer);
        }
        reject(new Error('Failed to send prompt request over tunnel'));
      }
    });
  }

  /**
   * Writes a JSONL-encoded tunnel message to the socket.
   * Silently drops the message if the socket is no longer connected.
   *
   * @returns `true` if the message was successfully written, `false` if it was
   *   dropped due to disconnection, serialization failure, or write error.
   *   Callers that need to detect failures (e.g. sendPromptRequest) can check
   *   the return value; fire-and-forget callers (log, error, etc.) ignore it.
   */
  private send(message: TunnelMessage): boolean {
    if (!this.connected) {
      return false;
    }

    let serialized: string;
    try {
      serialized = JSON.stringify(message) + '\n';
    } catch (err) {
      // Serialization errors can happen with non-JSON-safe payloads (e.g. circular refs).
      // Drop only this message and keep the tunnel connection alive.
      writeToLogFile(`[tunnel] Failed to serialize message: ${err as Error}\n`);
      return false;
    }

    try {
      this.socket.write(serialized);
      return true;
    } catch {
      // If write fails, mark as disconnected and fall back to no-op
      this.connected = false;
      return false;
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

  sendStructured(message: StructuredMessage): void {
    this.send({ type: 'structured', message });
    const formatted = formatStructuredMessage(message);
    if (formatted.length > 0) {
      writeToLogFile(formatted + '\n');
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
    this.rejectAllPending(new Error('Tunnel adapter destroyed'));
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
    this.rejectAllPending(new Error('Tunnel adapter destroyed'));

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
