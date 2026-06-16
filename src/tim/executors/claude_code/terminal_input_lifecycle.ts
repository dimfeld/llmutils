import type { SpawnAndLogOutputResult, StreamingProcess } from '../../../common/process.ts';
import type {
  UserTerminalInputMessage,
  WorkflowProgressMessage,
} from '../../../logging/structured_messages.ts';
import type { TunnelServer } from '../../../logging/tunnel_server.ts';
import { getLoggerAdapter } from '../../../logging/adapter.js';
import { HeadlessAdapter } from '../../../logging/headless_adapter.js';
import { TunnelAdapter } from '../../../logging/tunnel_client.js';
import { safeEndStdin, sendFollowUpMessage, sendInitialPrompt } from './streaming_input.ts';
import { TerminalInputReader } from './terminal_input.ts';
import { BackgroundActivityTracker } from './background_activity_tracker.ts';
import type { BackgroundActivitySignal, FormattedClaudeMessage } from './format.ts';

/** Shared guard for stdin lifecycle management. Ensures stdin is only closed once. */
export interface StdinGuard {
  get isClosed(): boolean;
  close(): void;
}

function createStdinGuard(
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
  prompt?: string;
  sendStructured: (message: UserTerminalInputMessage) => void;
  debugLog: (...args: unknown[]) => void;
  onReaderError: (error: unknown) => void;
  tunnelServer?: TunnelServer;
  onFollowUpSent?: () => void;
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
  const {
    streaming,
    prompt,
    sendStructured,
    debugLog,
    onReaderError,
    tunnelServer,
    onFollowUpSent,
  } = options;
  const stdinGuard = options.stdinGuard ?? createStdinGuard(streaming.stdin, debugLog);

  if (prompt != null) {
    sendInitialPrompt(streaming, prompt);
  }

  const reader = new TerminalInputReader({
    onLine: (line) => {
      if (stdinGuard.isClosed) {
        return;
      }

      sendStructured({
        type: 'user_terminal_input',
        content: line,
        source: 'terminal',
        timestamp: new Date().toISOString(),
      });

      try {
        sendFollowUpMessage(streaming.stdin, line);
        onFollowUpSent?.();
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
      }
    },
  };
}

export interface ExecuteWithTerminalInputOptions {
  streaming: StreamingProcess;
  prompt?: string;
  sendStructured: (message: UserTerminalInputMessage | WorkflowProgressMessage) => void;
  debugLog: (...args: unknown[]) => void;
  errorLog: (...args: unknown[]) => void;
  log: (...args: unknown[]) => void;
  label: string;
  tunnelServer?: TunnelServer;
  terminalInputEnabled: boolean;
  tunnelForwardingEnabled: boolean;
  /** Keep stdin open on result only when an interactive input source is active. */
  keepInteractiveInputOpenOnResult?: boolean;
}

export interface ExecuteWithTerminalInputResult {
  resultPromise: Promise<SpawnAndLogOutputResult>;
  onResultMessage: (resultWasSuccessful: boolean) => void;
  observeFormattedMessage: (formatted: FormattedClaudeMessage) => void;
  sendFollowUpForInterceptedResult: (content: string) => void;
  acceptedSuccessfulFinalResult: () => boolean;
  cleanup: () => void;
}

/**
 * Encapsulates the common terminal input wiring pattern shared by both
 * the main executor (`claude_code.ts`) and `run_claude_subprocess.ts`.
 *
 * Handles:
 * - stdin close behavior with a guard
 * - Tunnel/headless user input handler wiring (setUserInputHandler)
 * - Three-path branching: terminal input / tunnel or headless forwarding / non-interactive prompt
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
    keepInteractiveInputOpenOnResult = false,
  } = options;

  // Single shared guard for stdin lifecycle, used across all three paths
  // (terminal input, tunnel forwarding, single prompt) and the tunnel handler.
  const stdinGuard = createStdinGuard(streaming.stdin, debugLog);
  let terminalInputController: TerminalInputController | undefined;
  let handleProcessSigterm: (() => void) | undefined;
  let tunnelUserInputHandlerRegistered = false;
  let headlessUserInputHandlerRegistered = false;
  let clearTunnelUserInputHandler = (): void => {};
  let clearHeadlessUserInputHandler = (): void => {};

  const closeInputNow = (): void => {
    if (terminalInputController) {
      terminalInputController.onResultMessage();
    } else {
      stdinGuard.close();
    }
  };

  const closeForResult = (): void => {
    clearTunnelUserInputHandler();
    clearHeadlessUserInputHandler();
    closeInputNow();
  };

  const backgroundActivityTracker = new BackgroundActivityTracker({
    onClose: closeForResult,
  });

  const forceCloseInputNow = (): void => {
    backgroundActivityTracker.forceClose();
  };

  const stopActiveSessionForShutdown = (): void => {
    forceCloseInputNow();

    // The parent process may already be forwarding SIGTERM to the child, but
    // this keeps shutdown immediate when the active executor session is still live.
    streaming.kill('SIGTERM');
  };

  handleProcessSigterm = () => {
    stopActiveSessionForShutdown();
  };
  process.on('SIGTERM', handleProcessSigterm);

  // Wire tunnel user input handler if running as a tunnel client
  const loggerAdapter = getLoggerAdapter();
  if (tunnelForwardingEnabled && loggerAdapter instanceof TunnelAdapter) {
    let tunnelHandlerActive = true;
    tunnelUserInputHandlerRegistered = true;
    loggerAdapter.setUserInputHandler((content) => {
      if (!tunnelHandlerActive || stdinGuard.isClosed) {
        return;
      }
      try {
        sendFollowUp(content);
      } catch (err) {
        debugLog('Failed to forward tunnel user input to subprocess: %s', err as Error);
      }
    });
    clearTunnelUserInputHandler = () => {
      tunnelHandlerActive = false;
      tunnelUserInputHandlerRegistered = false;
      loggerAdapter.setUserInputHandler(undefined);
    };
  }

  // Wire headless user input handler if running via headless websocket.
  if (loggerAdapter instanceof HeadlessAdapter) {
    let headlessHandlerActive = true;
    headlessUserInputHandlerRegistered = true;
    loggerAdapter.setUserInputHandler((content) => {
      if (!headlessHandlerActive || stdinGuard.isClosed) {
        return;
      }

      try {
        sendFollowUp(content);
      } catch (err) {
        debugLog('Failed to forward headless user input to subprocess: %s', err as Error);
      }

      try {
        tunnelServer?.sendUserInput(content);
      } catch (err) {
        debugLog('Failed to forward headless user input through tunnel: %s', err as Error);
      }
    });

    clearHeadlessUserInputHandler = () => {
      headlessHandlerActive = false;
      headlessUserInputHandlerRegistered = false;
      loggerAdapter.setUserInputHandler(undefined);
    };

    loggerAdapter.setEndSessionHandler(() => {
      clearTunnelUserInputHandler();
      clearHeadlessUserInputHandler();
      forceCloseInputNow();
    });

    loggerAdapter.setForceEndSessionHandler(() => {
      clearTunnelUserInputHandler();
      clearHeadlessUserInputHandler();
      forceCloseInputNow();
      streaming.kill('SIGTERM');
    });
  }

  // When a HeadlessAdapter is present, it acts as an interactive input
  // source just like tunnel forwarding.
  const headlessForwardingEnabled = loggerAdapter instanceof HeadlessAdapter;
  const hasInteractiveInputSource = (): boolean =>
    terminalInputController?.started === true ||
    tunnelUserInputHandlerRegistered ||
    headlessUserInputHandlerRegistered;

  // onResultMessage is called by the formatStdout callback when a result message is detected
  const onResultMessage = (resultWasSuccessful: boolean): void => {
    if (keepInteractiveInputOpenOnResult && hasInteractiveInputSource()) {
      backgroundActivityTracker.acceptResultWithoutClosing(resultWasSuccessful);
      return;
    }
    backgroundActivityTracker.onResultMessage(resultWasSuccessful);
  };

  const dispatchBackgroundActivity = (signal: BackgroundActivitySignal): void => {
    switch (signal.kind) {
      case 'task_started':
        backgroundActivityTracker.taskStarted(signal.taskId, {
          taskType: signal.taskType,
          description: signal.description,
        });
        return;
      case 'task_stopped':
        backgroundActivityTracker.taskEnded(signal.taskId);
        return;
      case 'task_progress':
        backgroundActivityTracker.taskProgress(signal.taskId);
        return;
      case 'wakeup_scheduled':
        backgroundActivityTracker.wakeupScheduled();
        return;
      default: {
        const exhaustive: never = signal;
        return exhaustive;
      }
    }
  };

  // Lifecycle classification of a formatted stream message: concrete facts are
  // dispatched to the tracker, and an assistant/user message counts as turn activity.
  const observeFormattedMessage = (formatted: FormattedClaudeMessage): void => {
    if (formatted.backgroundActivity) {
      dispatchBackgroundActivity(formatted.backgroundActivity);
      return;
    }

    if (formatted.type === 'assistant' || formatted.type === 'user') {
      backgroundActivityTracker.onTurnActivity();
    }
  };

  const sendFollowUp = (content: string): void => {
    if (stdinGuard.isClosed) {
      return;
    }
    sendFollowUpMessage(streaming.stdin, content);
    backgroundActivityTracker.onContinuationStarted();
  };

  const sendFollowUpForInterceptedResult = (content: string): void => {
    sendFollowUp(content);
  };

  // Branching: terminal input vs. non-terminal input (tunnel/headless/pure non-interactive).
  let resultPromise: Promise<SpawnAndLogOutputResult>;
  if (terminalInputEnabled) {
    terminalInputController = setupTerminalInput({
      streaming,
      prompt,
      sendStructured,
      debugLog,
      tunnelServer,
      onFollowUpSent: () => {
        backgroundActivityTracker.onContinuationStarted();
      },
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
  } else {
    const promptRequired = !tunnelForwardingEnabled && !headlessForwardingEnabled;
    if (promptRequired && prompt == null) {
      throw new Error('Prompt is required when terminal input forwarding is disabled');
    }
    if (prompt != null) {
      sendInitialPrompt(streaming, prompt);
    }
    resultPromise = streaming.result.finally(() => {
      stdinGuard.close();
    });
  }

  return {
    resultPromise,
    onResultMessage,
    observeFormattedMessage,
    sendFollowUpForInterceptedResult,
    acceptedSuccessfulFinalResult: (): boolean =>
      backgroundActivityTracker.acceptedSuccessfulFinalResult(),
    cleanup: () => {
      backgroundActivityTracker.cancel();
      clearTunnelUserInputHandler();
      clearHeadlessUserInputHandler();
      if (loggerAdapter instanceof HeadlessAdapter) {
        loggerAdapter.setEndSessionHandler(undefined);
        loggerAdapter.setForceEndSessionHandler(undefined);
      }
      if (handleProcessSigterm) {
        process.off('SIGTERM', handleProcessSigterm);
        handleProcessSigterm = undefined;
      }
    },
  };
}
