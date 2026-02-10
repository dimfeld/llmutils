import { randomUUID } from 'node:crypto';
import {
  confirm as inquirerConfirm,
  select as inquirerSelect,
  input as inquirerInput,
  checkbox as inquirerCheckbox,
} from '@inquirer/prompts';
import { getLoggerAdapter } from '../logging/adapter.js';
import { TunnelAdapter } from '../logging/tunnel_client.js';
import { sendStructured } from '../logging.js';
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

  let timeout: { signal: AbortSignal; cleanup: () => void } | undefined;
  if (timeoutMs != null && timeoutMs > 0) {
    timeout = createTimeoutSignal(timeoutMs);
  }

  try {
    return await inquirerConfirm(
      { message, default: defaultValue },
      timeout ? { signal: timeout.signal } : undefined
    );
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

  let timeout: { signal: AbortSignal; cleanup: () => void } | undefined;
  if (timeoutMs != null && timeoutMs > 0) {
    timeout = createTimeoutSignal(timeoutMs);
  }

  try {
    return await inquirerSelect<Value>(
      { message, choices, default: defaultValue, pageSize },
      timeout ? { signal: timeout.signal } : undefined
    );
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

  let timeout: { signal: AbortSignal; cleanup: () => void } | undefined;
  if (timeoutMs != null && timeoutMs > 0) {
    timeout = createTimeoutSignal(timeoutMs);
  }

  try {
    return await inquirerInput(
      { message, default: defaultValue },
      timeout ? { signal: timeout.signal } : undefined
    );
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

  let timeout: { signal: AbortSignal; cleanup: () => void } | undefined;
  if (timeoutMs != null && timeoutMs > 0) {
    timeout = createTimeoutSignal(timeoutMs);
  }

  try {
    return await inquirerCheckbox<Value>(
      { message, choices, pageSize },
      timeout ? { signal: timeout.signal } : undefined
    );
  } finally {
    timeout?.cleanup();
  }
}
