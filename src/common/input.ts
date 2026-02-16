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

/**
 * Races a terminal inquirer prompt against a websocket prompt response.
 * Whichever channel responds first wins; the loser is cancelled.
 * After resolution, a prompt_answered structured message is broadcast.
 */
async function raceWithWebSocket<T>(
  headlessAdapter: HeadlessAdapter,
  promptMessage: PromptRequestMessage,
  runInquirer: (signal?: AbortSignal) => Promise<T>,
  timeoutMs?: number
): Promise<T> {
  const { promise: wsPromise, cancel: cancelWs } = headlessAdapter.waitForPromptResponse(
    promptMessage.requestId
  );
  // Suppress unhandled rejection (cancel() rejects the promise)
  wsPromise.catch(() => {});

  const wsAbortController = new AbortController();
  // When ws resolves, abort the terminal prompt
  wsPromise.then(
    () => wsAbortController.abort(),
    () => {}
  );

  // Combine ws-abort signal with optional timeout signal
  let timeoutCleanup: (() => void) | undefined;
  const signals: AbortSignal[] = [wsAbortController.signal];
  if (timeoutMs != null && timeoutMs > 0) {
    const timeout = createTimeoutSignal(timeoutMs);
    signals.push(timeout.signal);
    timeoutCleanup = timeout.cleanup;
  }
  const combinedSignal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);

  try {
    // Attempt terminal prompt -- may complete or be aborted by ws/timeout
    const value = await runInquirer(combinedSignal);
    // Terminal won
    cancelWs();
    sendPromptAnswered(promptMessage, value, 'terminal');
    return value;
  } catch (err) {
    // Terminal was aborted. Was it because ws responded?
    cancelWs(); // Clean up ws regardless
    try {
      const wsValue = await wsPromise;
      // WS won (promise already resolved before cancel was called)
      sendPromptAnswered(promptMessage, wsValue, 'websocket');
      return wsValue as T;
    } catch {
      // WS was also cancelled/failed -- rethrow the original error (likely timeout)
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
}): Promise<boolean> {
  const { message, default: defaultValue, timeoutMs } = options;
  const tunnelAdapter = getTunnelAdapter();

  const promptMessage = buildPromptRequest(
    'confirm',
    {
      message,
      ...(defaultValue != null ? { default: defaultValue } : {}),
    },
    timeoutMs
  );

  if (tunnelAdapter) {
    return (await tunnelAdapter.sendPromptRequest(promptMessage, timeoutMs)) as boolean;
  }

  sendStructured(promptMessage);

  const headlessAdapter = getHeadlessAdapter();
  if (headlessAdapter) {
    return raceWithWebSocket(
      headlessAdapter,
      promptMessage,
      (signal) =>
        withTerminalInputPaused(() =>
          inquirerConfirm({ message, default: defaultValue }, { signal })
        ),
      timeoutMs
    );
  }

  let timeout: { signal: AbortSignal; cleanup: () => void } | undefined;
  if (timeoutMs != null && timeoutMs > 0) {
    timeout = createTimeoutSignal(timeoutMs);
  }

  try {
    const value = await withTerminalInputPaused(() =>
      inquirerConfirm(
        { message, default: defaultValue },
        timeout ? { signal: timeout.signal } : undefined
      )
    );
    sendPromptAnswered(promptMessage, value, 'terminal');
    return value;
  } finally {
    timeout?.cleanup();
  }
}

/**
 * Prompts the user to select a single option from a list.
 *
 * When running inside a tunnel (subagent), the prompt is transparently forwarded
 * to the orchestrator. When running normally, calls inquirer directly.
 */
export async function promptSelect<Value extends string | number | boolean>(options: {
  message: string;
  choices: Array<{ name: string; value: Value; description?: string }>;
  default?: Value;
  pageSize?: number;
  timeoutMs?: number;
}): Promise<Value> {
  const { message, choices, default: defaultValue, pageSize, timeoutMs } = options;
  const tunnelAdapter = getTunnelAdapter();

  const promptMessage = buildPromptRequest(
    'select',
    {
      message,
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

  if (tunnelAdapter) {
    return (await tunnelAdapter.sendPromptRequest(promptMessage, timeoutMs)) as Value;
  }

  sendStructured(promptMessage);

  const headlessAdapter = getHeadlessAdapter();
  if (headlessAdapter) {
    return raceWithWebSocket(
      headlessAdapter,
      promptMessage,
      (signal) =>
        withTerminalInputPaused(() =>
          inquirerSelect<Value>({ message, choices, default: defaultValue, pageSize }, { signal })
        ),
      timeoutMs
    );
  }

  let timeout: { signal: AbortSignal; cleanup: () => void } | undefined;
  if (timeoutMs != null && timeoutMs > 0) {
    timeout = createTimeoutSignal(timeoutMs);
  }

  try {
    const value = await withTerminalInputPaused(() =>
      inquirerSelect<Value>(
        { message, choices, default: defaultValue, pageSize },
        timeout ? { signal: timeout.signal } : undefined
      )
    );
    sendPromptAnswered(promptMessage, value, 'terminal');
    return value;
  } finally {
    timeout?.cleanup();
  }
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
}): Promise<string> {
  const { message, default: defaultValue, validationHint, timeoutMs } = options;
  const tunnelAdapter = getTunnelAdapter();

  const promptMessage = buildPromptRequest(
    'input',
    {
      message,
      ...(defaultValue != null ? { default: defaultValue } : {}),
      ...(validationHint != null ? { validationHint } : {}),
    },
    timeoutMs
  );

  if (tunnelAdapter) {
    return (await tunnelAdapter.sendPromptRequest(promptMessage, timeoutMs)) as string;
  }

  sendStructured(promptMessage);

  const headlessAdapter = getHeadlessAdapter();
  if (headlessAdapter) {
    return raceWithWebSocket(
      headlessAdapter,
      promptMessage,
      (signal) =>
        withTerminalInputPaused(() =>
          inquirerInput({ message, default: defaultValue }, { signal })
        ),
      timeoutMs
    );
  }

  let timeout: { signal: AbortSignal; cleanup: () => void } | undefined;
  if (timeoutMs != null && timeoutMs > 0) {
    timeout = createTimeoutSignal(timeoutMs);
  }

  try {
    const value = await withTerminalInputPaused(() =>
      inquirerInput(
        { message, default: defaultValue },
        timeout ? { signal: timeout.signal } : undefined
      )
    );
    sendPromptAnswered(promptMessage, value, 'terminal');
    return value;
  } finally {
    timeout?.cleanup();
  }
}

/**
 * Prompts the user to select multiple options from a list.
 *
 * When running inside a tunnel (subagent), the prompt is transparently forwarded
 * to the orchestrator. When running normally, calls inquirer directly.
 */
export async function promptCheckbox<Value extends string | number | boolean>(options: {
  message: string;
  choices: Array<{ name: string; value: Value; description?: string; checked?: boolean }>;
  pageSize?: number;
  timeoutMs?: number;
}): Promise<Value[]> {
  const { message, choices, pageSize, timeoutMs } = options;
  const tunnelAdapter = getTunnelAdapter();

  const promptMessage = buildPromptRequest(
    'checkbox',
    {
      message,
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

  if (tunnelAdapter) {
    return (await tunnelAdapter.sendPromptRequest(promptMessage, timeoutMs)) as Value[];
  }

  sendStructured(promptMessage);

  const headlessAdapter = getHeadlessAdapter();
  if (headlessAdapter) {
    return raceWithWebSocket(
      headlessAdapter,
      promptMessage,
      (signal) =>
        withTerminalInputPaused(() =>
          inquirerCheckbox<Value>({ message, choices, pageSize }, { signal })
        ),
      timeoutMs
    );
  }

  let timeout: { signal: AbortSignal; cleanup: () => void } | undefined;
  if (timeoutMs != null && timeoutMs > 0) {
    timeout = createTimeoutSignal(timeoutMs);
  }

  try {
    const value = await withTerminalInputPaused(() =>
      inquirerCheckbox<Value>(
        { message, choices, pageSize },
        timeout ? { signal: timeout.signal } : undefined
      )
    );
    sendPromptAnswered(promptMessage, value, 'terminal');
    return value;
  } finally {
    timeout?.cleanup();
  }
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
}): Promise<PrefixPromptResult> {
  const { message, command, timeoutMs } = options;
  const tunnelAdapter = getTunnelAdapter();

  const promptMessage = buildPromptRequest(
    'prefix_select',
    {
      message,
      command,
    },
    timeoutMs
  );

  if (tunnelAdapter) {
    return (await tunnelAdapter.sendPromptRequest(promptMessage, timeoutMs)) as PrefixPromptResult;
  }

  sendStructured(promptMessage);

  const headlessAdapter = getHeadlessAdapter();
  if (headlessAdapter) {
    return raceWithWebSocket(
      headlessAdapter,
      promptMessage,
      (signal) => withTerminalInputPaused(() => runPrefixPrompt({ message, command }, { signal })),
      timeoutMs
    );
  }

  let timeout: { signal: AbortSignal; cleanup: () => void } | undefined;
  if (timeoutMs != null && timeoutMs > 0) {
    timeout = createTimeoutSignal(timeoutMs);
  }

  try {
    const value = await withTerminalInputPaused(() =>
      runPrefixPrompt({ message, command }, timeout ? { signal: timeout.signal } : undefined)
    );
    sendPromptAnswered(promptMessage, value, 'terminal');
    return value;
  } finally {
    timeout?.cleanup();
  }
}
