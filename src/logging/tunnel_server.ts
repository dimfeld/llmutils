import net from 'node:net';
import fs from 'node:fs';
import { log, error, warn, writeStdout, writeStderr, debugLog } from '../logging.js';
import { CleanupRegistry } from '../common/cleanup_registry.js';
import type { TunnelMessage } from './tunnel_protocol.js';

/**
 * Creates a line splitter function that handles message framing across TCP chunks.
 * Buffers partial lines and returns complete newline-terminated lines.
 * Matches the pattern from createLineSplitter in src/common/process.ts.
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
 * Validates that a parsed JSON object has the expected structure for a TunnelMessage.
 * Returns true if the message is valid, false otherwise.
 */
function isValidTunnelMessage(message: unknown): message is TunnelMessage {
  if (typeof message !== 'object' || message === null) {
    return false;
  }

  const msg = message as Record<string, unknown>;

  switch (msg.type) {
    case 'log':
    case 'error':
    case 'warn':
    case 'debug':
      return Array.isArray(msg.args) && msg.args.every((a: unknown) => typeof a === 'string');
    case 'stdout':
    case 'stderr':
      return typeof msg.data === 'string';
    default:
      return false;
  }
}

/**
 * Dispatches a parsed tunnel message to the appropriate logging function.
 * Malformed or unrecognized messages are silently dropped.
 */
function dispatchMessage(message: TunnelMessage): void {
  switch (message.type) {
    case 'log':
      log(...message.args);
      break;
    case 'error':
      error(...message.args);
      break;
    case 'warn':
      warn(...message.args);
      break;
    case 'debug':
      debugLog(...message.args);
      break;
    case 'stdout':
      writeStdout(message.data);
      break;
    case 'stderr':
      writeStderr(message.data);
      break;
  }
}

/**
 * Result of createTunnelServer, providing access to the server and a close method.
 */
export interface TunnelServer {
  /** The underlying net.Server instance */
  server: net.Server;
  /** Closes the server and removes the socket file */
  close: () => void;
}

/**
 * Creates a Unix domain socket server that receives JSONL-encoded tunnel messages
 * from child tim processes and re-emits them through the local logging system.
 *
 * The server handles:
 * - Multiple concurrent client connections
 * - Message framing across TCP chunks (via line splitting)
 * - Malformed JSON messages (silently dropped)
 * - Cleanup on process exit (via CleanupRegistry)
 *
 * @param socketPath - Path where the Unix domain socket will be created
 * @returns A promise that resolves with a TunnelServer once the server is listening
 */
export function createTunnelServer(socketPath: string): Promise<TunnelServer> {
  return new Promise<TunnelServer>((resolve, reject) => {
    // Remove any stale socket file from a previous run
    try {
      fs.unlinkSync(socketPath);
    } catch {
      // File doesn't exist, that's fine
    }

    const server = net.createServer((socket) => {
      const splitLines = createLineSplitter();

      socket.on('data', (data) => {
        const lines = splitLines(data.toString());
        for (const line of lines) {
          if (!line) {
            continue;
          }
          try {
            const parsed = JSON.parse(line);
            if (isValidTunnelMessage(parsed)) {
              dispatchMessage(parsed);
            }
            // Invalid structure - silently drop
          } catch {
            // Malformed JSON - silently drop
          }
        }
      });

      socket.on('error', () => {
        // Client disconnected or errored - nothing to do
      });
    });

    // Register cleanup to ensure socket is removed on process exit.
    // The unregister variable is assigned after the close function is defined,
    // but always before close can be called (since close is only callable after
    // the server is listening or on error).
    let unregister: (() => void) | undefined;
    let closed = false;

    const close = () => {
      if (closed) return;
      closed = true;
      unregister?.();
      server.close();
      try {
        fs.unlinkSync(socketPath);
      } catch {
        // Socket file already removed
      }
    };

    unregister = CleanupRegistry.getInstance().register(close);

    let listening = false;

    server.on('error', (err) => {
      if (!listening) {
        // Pre-listen error: the server never started, so reject the promise
        // and clean up the registry entry.
        unregister();
        reject(err);
      } else {
        // Post-listen error: log but don't remove cleanup handler since the
        // server may still need cleanup on process exit.
        error('Tunnel server error:', `${err as Error}`);
      }
    });

    server.listen(socketPath, () => {
      listening = true;
      resolve({ server, close });
    });
  });
}
