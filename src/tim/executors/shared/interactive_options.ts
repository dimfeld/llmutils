import { CodexCliExecutorName } from '../schemas.js';
import type { ExecutorCommonOptions } from '../types.js';

export interface BuildInteractiveExecutorOptionsInput {
  baseDir: string;
  model?: string;
  noninteractive: boolean;
  executorName: string;
  requestedTerminalInput?: boolean;
  configTerminalInput?: boolean;
  stdinIsTTY: boolean;
  codexAppServerEnabled: boolean;
}

export interface InteractiveExecutorOptionsResult {
  sharedExecutorOptions: ExecutorCommonOptions;
  terminalInputEnabled: boolean;
  canUseTerminalInput: boolean;
}

export function buildInteractiveExecutorOptions(
  input: BuildInteractiveExecutorOptionsInput
): InteractiveExecutorOptionsResult {
  const canUseTerminalInput =
    !input.noninteractive &&
    input.stdinIsTTY &&
    input.requestedTerminalInput !== false &&
    input.configTerminalInput !== false;
  const terminalInputEnabled =
    input.executorName === CodexCliExecutorName && !input.codexAppServerEnabled
      ? false
      : canUseTerminalInput;

  return {
    sharedExecutorOptions: {
      baseDir: input.baseDir,
      model: input.model,
      noninteractive: input.noninteractive ? true : undefined,
      terminalInput: terminalInputEnabled,
      closeTerminalInputOnResult: false,
      disableInactivityTimeout: true,
    },
    terminalInputEnabled,
    canUseTerminalInput,
  };
}
