import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import type { TimConfig } from '../../configSchema';
import { debugLog, error, log, sendStructured, warn } from '../../../logging';
import { getLoggerAdapter } from '../../../logging/adapter.js';
import { HeadlessAdapter } from '../../../logging/headless_adapter.js';
import { isTunnelActive, TunnelAdapter } from '../../../logging/tunnel_client.js';
import { createTunnelServer, type TunnelServer } from '../../../logging/tunnel_server.js';
import { createPromptRequestHandler } from '../../../logging/tunnel_prompt_handler.js';
import { TIM_OUTPUT_SOCKET } from '../../../logging/tunnel_protocol.js';
import { CodexAppServerConnection } from './app_server_connection';
import { createApprovalHandler } from './app_server_approval';
import { createAppServerFormatter } from './app_server_format';
import type { CodexStepOptions } from './codex_runner';
import { TerminalInputReader } from '../claude_code/terminal_input.ts';

function getInactivityTimeoutMs(options?: CodexStepOptions): number {
  const inactivityOverride = Number.parseInt(process.env.CODEX_OUTPUT_TIMEOUT_MS || '', 10);
  return (
    options?.inactivityTimeoutMs ??
    (Number.isFinite(inactivityOverride) && inactivityOverride > 0
      ? inactivityOverride
      : 10 * 60 * 1000)
  );
}

function extractTurnStatus(params: unknown): string {
  const payload = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
  const turn =
    payload.turn && typeof payload.turn === 'object'
      ? (payload.turn as Record<string, unknown>)
      : payload;
  return typeof turn.status === 'string' ? turn.status : 'completed';
}

function extractTurnId(params: unknown): string | undefined {
  const payload = params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
  const turn =
    payload.turn && typeof payload.turn === 'object'
      ? (payload.turn as Record<string, unknown>)
      : payload;
  return typeof turn.id === 'string' ? turn.id : undefined;
}

class UserInputQueue {
  private items: string[] = [];
  private waiters: Array<(value: string | undefined) => void> = [];
  private closed = false;

  push(value: string): void {
    if (this.closed) {
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(value);
      return;
    }

    this.items.push(value);
  }

  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    for (const waiter of this.waiters) {
      waiter(undefined);
    }
    this.waiters = [];
  }

  async next(): Promise<string | undefined> {
    const nextValue = this.items.shift();
    if (nextValue != null) {
      return nextValue;
    }

    if (this.closed) {
      return undefined;
    }

    return new Promise<string | undefined>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}

/**
 * Runs a single-step Codex execution via app-server JSON-RPC and returns the final agent message.
 */
export async function executeCodexStepViaAppServer(
  prompt: string,
  cwd: string,
  timConfig: TimConfig,
  options?: CodexStepOptions
): Promise<string> {
  const maxAttempts = 3;
  const initialInactivityTimeoutMs = 60 * 1000; // 1 minute before first output
  const inactivityTimeoutMs = getInactivityTimeoutMs(options);
  const allowAllTools = ['true', '1'].includes(process.env.ALLOW_ALL_TOOLS || '');

  const writableRoots = [cwd];
  if (
    timConfig?.isUsingExternalStorage &&
    timConfig.externalRepositoryConfigDir &&
    !writableRoots.includes(timConfig.externalRepositoryConfigDir)
  ) {
    writableRoots.push(timConfig.externalRepositoryConfigDir);
  }

  const approvalPolicy = allowAllTools ? 'never' : undefined;
  const sandbox = allowAllTools ? 'danger-full-access' : 'workspace-write';

  const reasoningLevel = options?.reasoningLevel ?? 'medium';
  const model = options?.model;
  const loggerAdapter = getLoggerAdapter();
  const terminalInputEnabled = options?.terminalInput === true;
  const appServerMode = options?.appServerMode ?? 'single-turn';
  const tunnelForwardingEnabled = loggerAdapter instanceof TunnelAdapter;
  const headlessForwardingEnabled = loggerAdapter instanceof HeadlessAdapter;
  const hasInteractiveInputSource =
    terminalInputEnabled || tunnelForwardingEnabled || headlessForwardingEnabled;
  const keepSessionOpen = appServerMode === 'chat-session' && hasInteractiveInputSource;
  const singleTurnSteeringEnabled =
    appServerMode === 'single-turn-with-steering' && hasInteractiveInputSource;

  // Create tunnel server for output forwarding from child processes
  let tunnelServer: TunnelServer | undefined;
  let tunnelTempDir: string | undefined;
  let tunnelSocketPath: string | undefined;
  if (!isTunnelActive()) {
    try {
      tunnelTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-tunnel-'));
      tunnelSocketPath = path.join(tunnelTempDir, 'output.sock');
      const promptHandler = createPromptRequestHandler();
      tunnelServer = await createTunnelServer(tunnelSocketPath, { onPromptRequest: promptHandler });
    } catch (err) {
      debugLog('Could not create tunnel server for output forwarding:', err);
    }
  }

  const tunnelEnv: Record<string, string> =
    tunnelServer && tunnelSocketPath ? { [TIM_OUTPUT_SOCKET]: tunnelSocketPath } : {};

  const formatter = createAppServerFormatter();
  // TODO: Pass configured allowed tools from timConfig when available.
  const approvalHandler = createApprovalHandler({
    sandboxAllowsFileWrites: !allowAllTools,
  });

  let connection: CodexAppServerConnection | undefined;
  let threadId: string | undefined;
  let currentTurnId: string | undefined;
  let currentAttemptActive = false;
  let sawFirstNotification = false;
  let interruptedByInactivity = false;
  let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveTurnCompleted: ((status: string) => void) | undefined;
  let turnCompletedPromise: Promise<string> | undefined;
  let successfulTurns = 0;
  let chatTurnId: string | undefined;
  let chatTurnCompleted = true;

  const clearInactivityTimer = () => {
    if (inactivityTimer) {
      clearTimeout(inactivityTimer);
      inactivityTimer = undefined;
    }
  };

  const resolveCurrentTurnStatus = (status: string) => {
    if (!resolveTurnCompleted) {
      return;
    }
    const resolve = resolveTurnCompleted;
    resolveTurnCompleted = undefined;
    resolve(status);
  };

  const resetTurnTracking = () => {
    turnCompletedPromise = new Promise<string>((resolve) => {
      resolveTurnCompleted = resolve;
    });
  };

  const resetInactivityTimer = () => {
    if (!currentAttemptActive) {
      return;
    }

    clearInactivityTimer();
    const timeout = sawFirstNotification ? inactivityTimeoutMs : initialInactivityTimeoutMs;
    sawFirstNotification = true;

    inactivityTimer = setTimeout(() => {
      if (!currentAttemptActive || !connection?.isAlive || !threadId || !currentTurnId) {
        return;
      }

      interruptedByInactivity = true;
      const minutes = Math.round(timeout / 60000);
      warn(
        `Codex produced no output for ${minutes} minute${minutes === 1 ? '' : 's'}; interrupting attempt.`
      );

      connection.turnInterrupt({ threadId, turnId: currentTurnId }).catch((err) => {
        debugLog('Failed to interrupt inactive app-server turn:', err);
      });
    }, timeout);
  };

  try {
    connection = await CodexAppServerConnection.create({
      cwd,
      env: {
        ...process.env,
        TIM_EXECUTOR: 'codex',
        AGENT: process.env.AGENT || '1',
        TIM_NOTIFY_SUPPRESS: '1',
        ...tunnelEnv,
      },
      onNotification: (method, params) => {
        const message = formatter.handleNotification(method, params);
        if (message.structured) {
          if (Array.isArray(message.structured)) {
            for (const structured of message.structured) {
              sendStructured(structured);
            }
          } else {
            sendStructured(message.structured);
          }
        }

        if (!threadId) {
          threadId = formatter.getThreadId();
        }

        if (!currentAttemptActive) {
          return;
        }

        resetInactivityTimer();

        if (method === 'turn/completed') {
          chatTurnCompleted = true;
          chatTurnId = extractTurnId(params) ?? chatTurnId;
          resolveCurrentTurnStatus(extractTurnStatus(params));
          currentAttemptActive = false;
          clearInactivityTimer();
        } else if (method === 'turn/started') {
          chatTurnCompleted = false;
          chatTurnId = extractTurnId(params) ?? chatTurnId;
        }
      },
      onServerRequest: approvalHandler,
    });

    const threadResult = await connection.threadStart({
      cwd,
      approvalPolicy,
      sandbox,
      model,
    });
    threadId = threadResult.threadId;
    const activeConnection = connection;
    const activeThreadId = threadId;

    const executeTurnWithRetry = async (initialInput: string): Promise<void> => {
      let promptForAttempt = initialInput;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          currentTurnId = undefined;
          sawFirstNotification = false;
          interruptedByInactivity = false;
          currentAttemptActive = true;
          resetTurnTracking();
          resetInactivityTimer();

          const turnResult = await activeConnection.turnStart({
            threadId: activeThreadId,
            input: [{ type: 'text', text: promptForAttempt }],
            model,
            effort: reasoningLevel,
            ...(options?.outputSchema ? { outputSchema: options.outputSchema } : {}),
          });
          currentTurnId = turnResult.turnId;
          resetInactivityTimer();

          if (!turnCompletedPromise) {
            throw new Error('Codex app-server turn tracking was not initialized.');
          }
          const status = (await turnCompletedPromise) || 'completed';
          currentAttemptActive = false;
          clearInactivityTimer();

          if (status.toLowerCase() === 'completed') {
            successfulTurns += 1;
            return;
          }

          const inactivitySuffix = interruptedByInactivity ? ' (after inactivity timeout)' : '';
          if (attempt >= maxAttempts) {
            throw new Error(
              `codex failed after ${maxAttempts} attempts (turn status: ${status}${inactivitySuffix}).`
            );
          }
          warn(
            `Codex attempt ${attempt}/${maxAttempts} ended with turn status "${status}"${inactivitySuffix}; retrying...`
          );
          promptForAttempt = 'continue';
        } catch (err) {
          currentAttemptActive = false;
          clearInactivityTimer();

          if (attempt >= maxAttempts) {
            throw err;
          }
          warn(`Codex attempt ${attempt}/${maxAttempts} failed; retrying...`);
          debugLog('Codex app-server attempt failure details:', err);
          promptForAttempt = 'continue';
        }
      }
    };

    if (!keepSessionOpen && !singleTurnSteeringEnabled) {
      await executeTurnWithRetry(prompt);
    } else if (singleTurnSteeringEnabled) {
      const inputQueue = new UserInputQueue();
      let terminalInputReader: TerminalInputReader | undefined;
      let clearTunnelUserInputHandler: () => void = () => {};
      let clearHeadlessUserInputHandler: () => void = () => {};

      if (terminalInputEnabled) {
        terminalInputReader = new TerminalInputReader({
          onLine: (line) => {
            inputQueue.push(line);
            sendStructured({
              type: 'user_terminal_input',
              content: line,
              source: 'terminal',
              timestamp: new Date().toISOString(),
            });

            try {
              tunnelServer?.sendUserInput(line);
            } catch (err) {
              debugLog('Failed to forward terminal input through tunnel:', err);
            }
          },
          onCloseWhileActive: () => {
            inputQueue.close();
          },
          onError: (err) => {
            debugLog('Terminal input reader error during Codex subagent turn:', err);
            inputQueue.close();
          },
        });

        if (terminalInputReader.start()) {
          log('Type a message and press Enter to steer the active Codex turn');
        }
      }

      if (tunnelForwardingEnabled) {
        loggerAdapter.setUserInputHandler((content) => {
          inputQueue.push(content);
        });
        clearTunnelUserInputHandler = () => {
          loggerAdapter.setUserInputHandler(undefined);
        };
      }

      if (headlessForwardingEnabled) {
        loggerAdapter.setUserInputHandler((content) => {
          inputQueue.push(content);

          try {
            sendStructured({
              type: 'user_terminal_input',
              content,
              source: 'gui',
              timestamp: new Date().toISOString(),
            });
          } catch (err) {
            debugLog('Failed to send structured headless user input:', err);
          }

          try {
            tunnelServer?.sendUserInput(content);
          } catch (err) {
            debugLog('Failed to forward headless input through tunnel:', err);
          }
        });
        clearHeadlessUserInputHandler = () => {
          loggerAdapter.setUserInputHandler(undefined);
        };
      }

      const normalizedPrompt = prompt.trim();
      if (!normalizedPrompt) {
        throw new Error('Prompt is required when appServerMode is single-turn-with-steering.');
      }

      currentTurnId = undefined;
      sawFirstNotification = false;
      interruptedByInactivity = false;
      currentAttemptActive = true;
      resetTurnTracking();
      resetInactivityTimer();

      const startResult = await activeConnection.turnStart({
        threadId: activeThreadId,
        input: [{ type: 'text', text: normalizedPrompt }],
        model,
        effort: reasoningLevel,
        ...(options?.outputSchema ? { outputSchema: options.outputSchema } : {}),
      });
      currentTurnId = startResult.turnId;
      resetInactivityTimer();

      const steeringPump = (async () => {
        while (true) {
          const nextInput = await inputQueue.next();
          if (nextInput == null) {
            break;
          }

          const content = nextInput.trim();
          if (!content || !currentTurnId || !currentAttemptActive) {
            continue;
          }

          try {
            await activeConnection.turnSteer({
              threadId: activeThreadId,
              input: [{ type: 'text', text: content }],
              expectedTurnId: currentTurnId,
            });
          } catch (err) {
            debugLog('Failed to send turn/steer input:', err);
          }
        }
      })();

      try {
        if (!turnCompletedPromise) {
          throw new Error('Codex app-server turn tracking was not initialized.');
        }

        const status = (await turnCompletedPromise) || 'completed';
        currentAttemptActive = false;
        clearInactivityTimer();

        if (status.toLowerCase() !== 'completed') {
          throw new Error(`codex single-turn session ended with status "${status}".`);
        }
        successfulTurns += 1;
      } finally {
        inputQueue.close();
        await steeringPump;
        terminalInputReader?.stop();
        clearTunnelUserInputHandler();
        clearHeadlessUserInputHandler();
      }
    } else {
      const inputQueue = new UserInputQueue();
      let terminalInputReader: TerminalInputReader | undefined;
      let clearTunnelUserInputHandler: () => void = () => {};
      let clearHeadlessUserInputHandler: () => void = () => {};

      if (prompt.trim().length > 0) {
        inputQueue.push(prompt);
      }

      if (terminalInputEnabled) {
        terminalInputReader = new TerminalInputReader({
          onLine: (line) => {
            inputQueue.push(line);
            sendStructured({
              type: 'user_terminal_input',
              content: line,
              source: 'terminal',
              timestamp: new Date().toISOString(),
            });

            try {
              tunnelServer?.sendUserInput(line);
            } catch (err) {
              debugLog('Failed to forward terminal input through tunnel:', err);
            }
          },
          onCloseWhileActive: () => {
            inputQueue.close();
          },
          onError: (err) => {
            debugLog('Terminal input reader error during Codex chat:', err);
            inputQueue.close();
          },
        });

        if (terminalInputReader.start()) {
          log('Type a message and press Enter to send input to Codex');
        }
      }

      if (tunnelForwardingEnabled) {
        loggerAdapter.setUserInputHandler((content) => {
          inputQueue.push(content);
        });
        clearTunnelUserInputHandler = () => {
          loggerAdapter.setUserInputHandler(undefined);
        };
      }

      if (headlessForwardingEnabled) {
        loggerAdapter.setUserInputHandler((content) => {
          inputQueue.push(content);

          try {
            sendStructured({
              type: 'user_terminal_input',
              content,
              source: 'gui',
              timestamp: new Date().toISOString(),
            });
          } catch (err) {
            debugLog('Failed to send structured headless user input:', err);
          }

          try {
            tunnelServer?.sendUserInput(content);
          } catch (err) {
            debugLog('Failed to forward headless input through tunnel:', err);
          }
        });
        clearHeadlessUserInputHandler = () => {
          loggerAdapter.setUserInputHandler(undefined);
        };
      }

      try {
        const sendChatInput = async (inputText: string): Promise<void> => {
          const trimmed = inputText.trim();
          if (trimmed.length === 0) {
            return;
          }

          currentAttemptActive = true;
          sawFirstNotification = false;
          interruptedByInactivity = false;
          resetInactivityTimer();

          if (!chatTurnCompleted && chatTurnId) {
            const steerResult = await activeConnection.turnSteer({
              threadId: activeThreadId,
              input: [{ type: 'text', text: trimmed }],
              expectedTurnId: chatTurnId,
            });
            chatTurnId = steerResult.turnId || chatTurnId;
            return;
          }

          chatTurnCompleted = false;
          const startResult = await activeConnection.turnStart({
            threadId: activeThreadId,
            input: [{ type: 'text', text: trimmed }],
            model,
            effort: reasoningLevel,
            ...(options?.outputSchema ? { outputSchema: options.outputSchema } : {}),
          });
          chatTurnId = startResult.turnId;
        };

        while (true) {
          const nextInput = await inputQueue.next();
          if (nextInput == null) {
            break;
          }

          await sendChatInput(nextInput);
          successfulTurns += 1;
        }
      } finally {
        terminalInputReader?.stop();
        clearTunnelUserInputHandler();
        clearHeadlessUserInputHandler();
        inputQueue.close();
      }
    }

    const failedMsg = formatter.getFailedAgentMessage();
    const final = failedMsg || formatter.getFinalAgentMessage();
    if (!final) {
      if (appServerMode === 'chat-session' && successfulTurns === 0) {
        return '';
      }
      error('Codex returned no final agent message. Enable debug logs for details.');
      throw new Error('No final agent message found in Codex output.');
    }

    return final;
  } finally {
    clearInactivityTimer();

    if (connection) {
      try {
        await connection.close();
      } catch (err) {
        debugLog('Error while closing codex app-server connection:', err);
      }
    }

    tunnelServer?.close();
    if (tunnelTempDir) {
      try {
        await fs.rm(tunnelTempDir, { recursive: true, force: true });
      } catch (err) {
        debugLog('Error cleaning up tunnel temp directory:', err);
      }
    }
  }
}
