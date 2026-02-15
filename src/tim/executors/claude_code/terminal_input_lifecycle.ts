import type { SpawnAndLogOutputResult, StreamingProcess } from '../../../common/process.ts';
import type {
  UserTerminalInputMessage,
  WorkflowProgressMessage,
} from '../../../logging/structured_messages.ts';
import type { TunnelServer } from '../../../logging/tunnel_server.ts';
import { getLoggerAdapter } from '../../../logging/adapter.js';
import { TunnelAdapter } from '../../../logging/tunnel_client.js';
import {
  safeEndStdin,
  sendFollowUpMessage,
  sendInitialPrompt,
  sendSinglePromptAndWait,
} from './streaming_input.ts';
import { TerminalInputReader } from './terminal_input.ts';

/** Shared guard for stdin lifecycle management. Ensures stdin is only closed once. */
export interface StdinGuard {
  get isClosed(): boolean;
  close(): void;
}

export function createStdinGuard(
  stdin: StreamingProcess['stdin'],
  debugLog: (...args: unknown[]) => void
): StdinGuard {
  let closed = false;
  return {
    get isClosed() {
      return closed;
    },
    close() {
      if (closed) return;
      closed = true;
      safeEndStdin(stdin, debugLog);
    },
  };
}

export interface TerminalInputLifecycleOptions {
  streaming: StreamingProcess;
  prompt: string;
  sendStructured: (message: UserTerminalInputMessage) => void;
  debugLog: (...args: unknown[]) => void;
  onReaderError: (error: unknown) => void;
  tunnelServer?: TunnelServer;
  /** Optional shared stdin guard. If not provided, one is created internally. */
  stdinGuard?: StdinGuard;
}

export interface TerminalInputController {
  started: boolean;
  onResultMessage: () => void;
  awaitAndCleanup: () => Promise<SpawnAndLogOutputResult>;
}

export function setupTerminalInput(
  options: TerminalInputLifecycleOptions
): TerminalInputController {
  const { streaming, prompt, sendStructured, debugLog, onReaderError, tunnelServer } = options;
  const stdinGuard = options.stdinGuard ?? createStdinGuard(streaming.stdin, debugLog);

  sendInitialPrompt(streaming, prompt);

  const reader = new TerminalInputReader({
    onLine: (line) => {
      if (stdinGuard.isClosed) {
        return;
      }

      sendStructured({
        type: 'user_terminal_input',
        content: line,
        timestamp: new Date().toISOString(),
      });

      try {
        sendFollowUpMessage(streaming.stdin, line);
      } catch (err) {
        debugLog('Failed to send terminal input to subprocess: %s', err as Error);
        reader.stop();
        stdinGuard.close();
        onReaderError(err);
        return;
      }

      try {
        tunnelServer?.sendUserInput(line);
      } catch (err) {
        debugLog('Failed to forward terminal input through tunnel: %s', err as Error);
      }
    },
    onCloseWhileActive: () => {
      stdinGuard.close();
    },
    onError: onReaderError,
  });

  const started = reader.start();

  return {
    started,
    onResultMessage: () => {
      reader.stop();
      stdinGuard.close();
    },
    awaitAndCleanup: async () => {
      try {
        return await streaming.result;
      } finally {
        reader.stop();
        stdinGuard.close();
        if (process.stdin.isTTY && typeof process.stdin.unref === 'function') {
          process.stdin.unref();
        }
      }
    },
  };
}

export interface ExecuteWithTerminalInputOptions {
  streaming: StreamingProcess;
  prompt: string;
  sendStructured: (message: UserTerminalInputMessage | WorkflowProgressMessage) => void;
  debugLog: (...args: unknown[]) => void;
  errorLog: (...args: unknown[]) => void;
  log: (...args: unknown[]) => void;
  label: string;
  tunnelServer?: TunnelServer;
  terminalInputEnabled: boolean;
  tunnelForwardingEnabled: boolean;
  /** When false, ignore result messages for stdin closing behavior. */
  closeOnResultMessage?: boolean;
}

export interface ExecuteWithTerminalInputResult {
  resultPromise: Promise<SpawnAndLogOutputResult>;
  onResultMessage: () => void;
  cleanup: () => void;
}

/**
 * Encapsulates the common terminal input wiring pattern shared by both
 * the main executor (`claude_code.ts`) and `run_claude_subprocess.ts`.
 *
 * Handles:
 * - `closeStdin` with guard
 * - Tunnel user input handler wiring (setUserInputHandler)
 * - Three-path branching: terminal input / tunnel forwarding / single prompt
 * - "Type a message..." log hint
 */
export function executeWithTerminalInput(
  options: ExecuteWithTerminalInputOptions
): ExecuteWithTerminalInputResult {
  const {
    streaming,
    prompt,
    sendStructured,
    debugLog,
    errorLog,
    log,
    label,
    tunnelServer,
    terminalInputEnabled,
    tunnelForwardingEnabled,
    closeOnResultMessage = true,
  } = options;

  // Single shared guard for stdin lifecycle, used across all three paths
  // (terminal input, tunnel forwarding, single prompt) and the tunnel handler.
  const stdinGuard = createStdinGuard(streaming.stdin, debugLog);

  // Wire tunnel user input handler if running as a tunnel client
  let clearTunnelUserInputHandler = (): void => {};
  const loggerAdapter = getLoggerAdapter();
  if (tunnelForwardingEnabled && loggerAdapter instanceof TunnelAdapter) {
    let tunnelHandlerActive = true;
    loggerAdapter.setUserInputHandler((content) => {
      if (!tunnelHandlerActive || stdinGuard.isClosed) {
        return;
      }
      try {
        sendFollowUpMessage(streaming.stdin, content);
      } catch (err) {
        debugLog('Failed to forward tunnel user input to subprocess: %s', err as Error);
      }
    });
    clearTunnelUserInputHandler = () => {
      tunnelHandlerActive = false;
      loggerAdapter.setUserInputHandler(undefined);
    };
  }

  // onResultMessage is called by the formatStdout callback when a result message is detected
  let terminalInputController: TerminalInputController | undefined;
  const onResultMessage = (): void => {
    if (!closeOnResultMessage) {
      return;
    }
    clearTunnelUserInputHandler();
    if (terminalInputController) {
      terminalInputController.onResultMessage();
    } else if (tunnelForwardingEnabled) {
      stdinGuard.close();
    }
  };

  // Three-path branching: terminal input / tunnel forwarding / single prompt
  let resultPromise: Promise<SpawnAndLogOutputResult>;
  if (terminalInputEnabled) {
    terminalInputController = setupTerminalInput({
      streaming,
      prompt,
      sendStructured,
      debugLog,
      tunnelServer,
      stdinGuard,
      onReaderError: (err) => {
        sendStructured({
          type: 'workflow_progress',
          timestamp: new Date().toISOString(),
          phase: 'terminal-input',
          message: `Terminal input reader error: ${String(err instanceof Error ? err.message : err)}`,
        });
        errorLog(`Terminal input reader error during Claude ${label}:`, err);
      },
    });
    if (terminalInputController.started) {
      log('Type a message and press Enter to send input to the agent');
    }
    resultPromise = terminalInputController.awaitAndCleanup();
  } else if (tunnelForwardingEnabled) {
    sendInitialPrompt(streaming, prompt);
    resultPromise = streaming.result.finally(() => {
      stdinGuard.close();
    });
  } else {
    resultPromise = sendSinglePromptAndWait(streaming, prompt);
  }

  return {
    resultPromise,
    onResultMessage,
    cleanup: () => {
      clearTunnelUserInputHandler();
    },
  };
}
