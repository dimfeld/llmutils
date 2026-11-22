import type { ExecutorCommonOptions } from '../types.js';

export interface BuildInteractiveExecutorOptionsInput {
  baseDir: string;
  model?: string;
  noninteractive: boolean;
  requestedTerminalInput?: boolean;
  configTerminalInput?: boolean;
  stdinIsTTY: boolean;
}

export interface InteractiveExecutorOptionsResult {
  sharedExecutorOptions: ExecutorCommonOptions;
  terminalInputEnabled: boolean;
}

export function buildInteractiveExecutorOptions(
  input: BuildInteractiveExecutorOptionsInput
): InteractiveExecutorOptionsResult {
  const terminalInputEnabled =
    !input.noninteractive &&
    input.stdinIsTTY &&
    input.requestedTerminalInput !== false &&
    input.configTerminalInput !== false;

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
  };
}
