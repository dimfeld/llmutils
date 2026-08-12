import { randomUUID } from 'node:crypto';
import {
  confirm as inquirerConfirm,
  select as inquirerSelect,
  input as inquirerInput,
  checkbox as inquirerCheckbox,
} from '@inquirer/prompts';
import { getLoggerAdapter } from '../logging/adapter.js';
import { HeadlessAdapter } from '../logging/headless_adapter.js';
import { TunnelAdapter } from '../logging/tunnel_client.js';
import { sendStructured } from '../logging.js';
import { getActiveInputSource } from './input_pause_registry.js';
import { runPrefixPrompt, type PrefixPromptResult } from './prefix_prompt.js';
import type {
  PromptRequestMessage,
  PromptChoiceConfig,
  PromptType,
} from '../logging/structured_messages.js';

/**
 * Returns true if the error is a timeout/abort error from a prompt.
 *
 * This covers:
 * - AbortPromptError thrown by @inquirer/prompts when a signal aborts (non-tunneled timeout)
 * - Timeout errors from the tunnel adapter (message: "Prompt request timed out after ...")
 *
 * Callers can use this to distinguish expected timeout behavior from unexpected
 * transport failures (tunnel disconnect, serialization errors, etc.).
 */
export function isPromptTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }

  // @inquirer/core throws AbortPromptError when an AbortSignal fires
  if (err.name === 'AbortPromptError') {
    return true;
  }

  // TunnelAdapter rejects with "Prompt request timed out after ..."
  if (err.message.startsWith('Prompt request timed out')) {
    return true;
  }

  return false;
}

/** Error used when a caller cancels an interactive prompt before it is answered. */
export class PromptCancelledError extends Error {
  public constructor(message = 'Prompt cancelled') {
    super(message);
    this.name = 'PromptCancelledError';
  }
}

/**
 * Builds a PromptRequestMessage with a unique requestId.
 */
function buildPromptRequest(
  promptType: PromptType,
  promptConfig: PromptRequestMessage['promptConfig'],
  timeoutMs?: number
): PromptRequestMessage {
  return {
    type: 'prompt_request',
    timestamp: new Date().toISOString(),
    requestId: randomUUID(),
    promptType,
    promptConfig,
    ...(timeoutMs != null ? { timeoutMs } : {}),
  };
}

/**
 * Returns the TunnelAdapter if the current async context is running inside a tunnel,
 * or undefined if running normally (no tunnel).
 */
function getTunnelAdapter(): TunnelAdapter | undefined {
  const adapter = getLoggerAdapter();
  return adapter instanceof TunnelAdapter ? adapter : undefined;
}

/**
 * Creates an AbortController that aborts after `timeoutMs` milliseconds.
 * Returns the signal and a cleanup function to clear the timer.
 */
function createTimeoutSignal(timeoutMs: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
  };
}

function createPromptSignal(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number | undefined
): { signal: AbortSignal | undefined; cleanup: () => void } {
  let timeout: { signal: AbortSignal; cleanup: () => void } | undefined;
  if (timeoutMs != null && timeoutMs > 0) {
    timeout = createTimeoutSignal(timeoutMs);
  }

  const signals = [externalSignal, timeout?.signal].filter(
    (signal): signal is AbortSignal => signal !== undefined
  );
  return {
    signal:
      signals.length === 0
        ? undefined
        : signals.length === 1
          ? signals[0]
          : AbortSignal.any(signals),
    cleanup: () => timeout?.cleanup(),
  };
}

/**
 * Returns the HeadlessAdapter if the current async context is running with a
 * headless websocket connection, or undefined if not.
 */
function getHeadlessAdapter(): HeadlessAdapter | undefined {
  const adapter = getLoggerAdapter();
  return adapter instanceof HeadlessAdapter ? adapter : undefined;
}

async function withTerminalInputPaused<T>(fn: () => Promise<T>): Promise<T> {
  const inputSource = getActiveInputSource();
  inputSource?.pause();
  try {
    return await fn();
  } finally {
    inputSource?.resume();
  }
}

/**
 * Sends a prompt_answered structured message after a prompt is resolved.
 */
function sendPromptAnswered(
  promptMessage: PromptRequestMessage,
  value: unknown,
  source: 'terminal' | 'websocket'
): void {
  sendStructured({
    type: 'prompt_answered',
    timestamp: new Date().toISOString(),
    requestId: promptMessage.requestId,
    promptType: promptMessage.promptType,
    value,
    source,
  });
}

function sendPromptCancelled(promptMessage: PromptRequestMessage): void {
  sendStructured({
    type: 'prompt_cancelled',
    timestamp: new Date().toISOString(),
    requestId: promptMessage.requestId,
  });
}

function throwIfPromptWasCancelled(
  promptMessage: PromptRequestMessage,
  externalSignal: AbortSignal | undefined
): void {
  if (!externalSignal?.aborted) return;
  sendPromptCancelled(promptMessage);
  throw new PromptCancelledError();
}

async function sendTunneledPrompt<T>(
  tunnelAdapter: TunnelAdapter,
  promptMessage: PromptRequestMessage,
  timeoutMs: number | undefined,
  externalSignal: AbortSignal | undefined
): Promise<T> {
  try {
    const value = await tunnelAdapter.sendPromptRequest(promptMessage, timeoutMs, externalSignal);
    throwIfPromptWasCancelled(promptMessage, externalSignal);
    return value as T;
  } catch (error) {
    if (!externalSignal?.aborted) throw error;
    if (!(error instanceof PromptCancelledError)) {
      sendPromptCancelled(promptMessage);
    }
    throw error instanceof PromptCancelledError ? error : new PromptCancelledError();
  }
}

/**
 * Runs one prompt through the active input transport.
 *
 * Prompt wrappers only build their protocol message and provide the local
 * prompt callback. This helper owns the shared tunnel, headless, terminal,
 * cancellation, and timeout lifecycle.
 */
async function runPrompt<T>(options: {
  promptMessage: PromptRequestMessage;
  timeoutMs?: number;
  externalSignal?: AbortSignal;
  runLocalPrompt: (signal?: AbortSignal) => Promise<T>;
}): Promise<T> {
  const { promptMessage, timeoutMs, externalSignal, runLocalPrompt } = options;
  const tunnelAdapter = getTunnelAdapter();

  if (tunnelAdapter) {
    return sendTunneledPrompt<T>(tunnelAdapter, promptMessage, timeoutMs, externalSignal);
  }

  sendStructured(promptMessage);

  const headlessAdapter = getHeadlessAdapter();
  if (headlessAdapter) {
    return raceWithWebSocket(
      headlessAdapter,
      promptMessage,
      (signal) => withTerminalInputPaused(() => runLocalPrompt(signal)),
      timeoutMs,
      externalSignal
    );
  }

  const promptSignal = createPromptSignal(externalSignal, timeoutMs);

  try {
    const value = await withTerminalInputPaused(() => runLocalPrompt(promptSignal.signal));
    throwIfPromptWasCancelled(promptMessage, externalSignal);
    sendPromptAnswered(promptMessage, value, 'terminal');
    return value;
  } catch (error) {
    if (externalSignal?.aborted) {
      if (!(error instanceof PromptCancelledError)) {
        sendPromptCancelled(promptMessage);
      }
      throw error instanceof PromptCancelledError ? error : new PromptCancelledError();
    }
    throw error;
  } finally {
    promptSignal.cleanup();
  }
}

/**
 * Races a terminal inquirer prompt against a websocket prompt response.
 * Whichever channel responds first wins; the loser is cancelled.
 * After resolution, a prompt_answered structured message is broadcast.
 */
async function raceWithWebSocket<T>(
  headlessAdapter: HeadlessAdapter,
  promptMessage: PromptRequestMessage,
  runInquirer: (signal?: AbortSignal) => Promise<T>,
  timeoutMs?: number,
  externalSignal?: AbortSignal
): Promise<T> {
  const { promise: wsPromise, cancel: cancelWs } = headlessAdapter.waitForPromptResponse(
    promptMessage.requestId
  );
  // Suppress unhandled rejection (cancel() rejects the promise)
  wsPromise.catch(() => {});

  const wsAbortController = new AbortController();
  let terminalSettled = false;
  let wsErrorBeforeTerminalSettled: unknown;
  // When ws resolves or is rejected (e.g. end_session), abort the terminal prompt
  wsPromise.then(
    () => wsAbortController.abort(),
    (error: unknown) => {
      if (!terminalSettled) {
        wsErrorBeforeTerminalSettled = error;
      }
      wsAbortController.abort();
    }
  );

  // Combine ws-abort signal with optional timeout signal
  let timeoutCleanup: (() => void) | undefined;
  const signals: AbortSignal[] = [wsAbortController.signal];
  if (externalSignal !== undefined) {
    signals.push(externalSignal);
  }
  if (timeoutMs != null && timeoutMs > 0) {
    const timeout = createTimeoutSignal(timeoutMs);
    signals.push(timeout.signal);
    timeoutCleanup = timeout.cleanup;
  }
  const combinedSignal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);

  try {
    // Attempt terminal prompt -- may complete or be aborted by ws/timeout
    const value = await runInquirer(combinedSignal).finally(() => {
      terminalSettled = true;
    });
    if (externalSignal?.aborted) {
      cancelWs();
      sendPromptCancelled(promptMessage);
      throw new PromptCancelledError();
    }
    // Terminal won
    cancelWs();
    sendPromptAnswered(promptMessage, value, 'terminal');
    return value;
  } catch (err) {
    // Terminal was aborted. Was it because ws responded?
    cancelWs(); // Clean up ws regardless
    if (externalSignal?.aborted) {
      sendPromptCancelled(promptMessage);
      throw new PromptCancelledError();
    }
    try {
      const wsValue = await wsPromise;
      // WS won (promise already resolved before cancel was called)
      sendPromptAnswered(promptMessage, wsValue, 'websocket');
      return wsValue as T;
    } catch {
      // WS was also cancelled/failed -- broadcast cancellation before rethrowing.
      sendPromptCancelled(promptMessage);
      if (externalSignal?.aborted) {
        throw new PromptCancelledError();
      }
      if (wsErrorBeforeTerminalSettled !== undefined) {
        throw wsErrorBeforeTerminalSettled;
      }
      throw err;
    }
  } finally {
    timeoutCleanup?.();
  }
}

/**
 * Prompts the user for a yes/no confirmation.
 *
 * When running inside a tunnel (subagent), the prompt is transparently forwarded
 * to the orchestrator. When running normally, calls inquirer directly.
 */
export async function promptConfirm(options: {
  message: string;
  default?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<boolean> {
  const { message, default: defaultValue, timeoutMs, signal: externalSignal } = options;
  const promptMessage = buildPromptRequest(
    'confirm',
    {
      message,
      ...(defaultValue != null ? { default: defaultValue } : {}),
    },
    timeoutMs
  );

  return runPrompt({
    promptMessage,
    timeoutMs,
    externalSignal,
    runLocalPrompt: (signal) =>
      inquirerConfirm({ message, default: defaultValue }, signal ? { signal } : undefined),
  });
}

/**
 * Prompts the user to select a single option from a list.
 *
 * When running inside a tunnel (subagent), the prompt is transparently forwarded
 * to the orchestrator. When running normally, calls inquirer directly.
 */
export async function promptSelect<Value extends string | number | boolean>(options: {
  message: string;
  header?: string;
  question?: string;
  choices: Array<{ name: string; value: Value; description?: string }>;
  default?: Value;
  pageSize?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<Value> {
  const {
    message,
    header,
    question,
    choices,
    default: defaultValue,
    pageSize,
    timeoutMs,
    signal: externalSignal,
  } = options;
  const promptMessage = buildPromptRequest(
    'select',
    {
      message,
      ...(header != null ? { header } : {}),
      ...(question != null ? { question } : {}),
      choices: choices.map((c) => ({
        name: c.name,
        value: c.value,
        ...(c.description != null ? { description: c.description } : {}),
      })) as PromptChoiceConfig[],
      ...(defaultValue != null ? { default: defaultValue } : {}),
      ...(pageSize != null ? { pageSize } : {}),
    },
    timeoutMs
  );

  return runPrompt({
    promptMessage,
    timeoutMs,
    externalSignal,
    runLocalPrompt: (signal) =>
      inquirerSelect<Value>(
        { message, choices, default: defaultValue, pageSize },
        signal ? { signal } : undefined
      ),
  });
}

/**
 * Prompts the user for free-form text input.
 *
 * When running inside a tunnel (subagent), the prompt is transparently forwarded
 * to the orchestrator. When running normally, calls inquirer directly.
 */
export async function promptInput(options: {
  message: string;
  default?: string;
  validationHint?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<string> {
  const {
    message,
    default: defaultValue,
    validationHint,
    timeoutMs,
    signal: externalSignal,
  } = options;
  const promptMessage = buildPromptRequest(
    'input',
    {
      message,
      ...(defaultValue != null ? { default: defaultValue } : {}),
      ...(validationHint != null ? { validationHint } : {}),
    },
    timeoutMs
  );

  return runPrompt({
    promptMessage,
    timeoutMs,
    externalSignal,
    runLocalPrompt: (signal) =>
      inquirerInput({ message, default: defaultValue }, signal ? { signal } : undefined),
  });
}

/**
 * Prompts the user to select multiple options from a list.
 *
 * When running inside a tunnel (subagent), the prompt is transparently forwarded
 * to the orchestrator. When running normally, calls inquirer directly.
 */
export async function promptCheckbox<Value extends string | number | boolean>(options: {
  message: string;
  header?: string;
  question?: string;
  choices: Array<{ name: string; value: Value; description?: string; checked?: boolean }>;
  pageSize?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<Value[]> {
  const {
    message,
    header,
    question,
    choices,
    pageSize,
    timeoutMs,
    signal: externalSignal,
  } = options;
  const promptMessage = buildPromptRequest(
    'checkbox',
    {
      message,
      ...(header != null ? { header } : {}),
      ...(question != null ? { question } : {}),
      choices: choices.map((c) => ({
        name: c.name,
        value: c.value,
        ...(c.description != null ? { description: c.description } : {}),
        ...(c.checked != null ? { checked: c.checked } : {}),
      })) as PromptChoiceConfig[],
      ...(pageSize != null ? { pageSize } : {}),
    },
    timeoutMs
  );

  return runPrompt({
    promptMessage,
    timeoutMs,
    externalSignal,
    runLocalPrompt: (signal) =>
      inquirerCheckbox<Value>({ message, choices, pageSize }, signal ? { signal } : undefined),
  });
}

/**
 * Prompts the user to choose a Bash command prefix (or exact command).
 *
 * When running inside a tunnel (subagent), the prompt is transparently forwarded
 * to the orchestrator. When running normally, uses the custom prefix prompt.
 */
export async function promptPrefixSelect(options: {
  message: string;
  command: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<PrefixPromptResult> {
  const { message, command, timeoutMs, signal: externalSignal } = options;
  const promptMessage = buildPromptRequest(
    'prefix_select',
    {
      message,
      command,
    },
    timeoutMs
  );

  return runPrompt({
    promptMessage,
    timeoutMs,
    externalSignal,
    runLocalPrompt: (signal) =>
      runPrefixPrompt({ message, command }, signal ? { signal } : undefined),
  });
}
