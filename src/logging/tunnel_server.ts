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
            const message = JSON.parse(line) as TunnelMessage;
            dispatchMessage(message);
          } catch {
            // Malformed JSON - silently drop
          }
        }
      });

      socket.on('error', () => {
        // Client disconnected or errored - nothing to do
      });
    });

    const close = () => {
      server.close();
      try {
        fs.unlinkSync(socketPath);
      } catch {
        // Socket file already removed
      }
    };

    // Register cleanup to ensure socket is removed on process exit
    const unregister = CleanupRegistry.getInstance().register(close);

    server.on('error', (err) => {
      unregister();
      reject(err);
    });

    server.listen(socketPath, () => {
      resolve({ server, close });
    });
  });
}
