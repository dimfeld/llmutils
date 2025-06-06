import { DEFAULT_RUN_MODEL } from '../llm_utils/run_and_apply.js';
import { executors } from './build.ts';
import { ClaudeCodeExecutor, ClaudeCodeExecutorName } from './claude_code.ts';
import { CopyOnlyExecutor, CopyOnlyExecutorName } from './copy_only.ts';
import {
  CopyOnlyStateMachineExecutor,
  CopyOnlyStateMachineExecutorName,
} from './copy_only_statemachine.ts';
import { CopyPasteExecutor, CopyPasteExecutorName } from './copy_paste.ts';
import { OneCallExecutor, OneCallExecutorName } from './one-call';
import { DEFAULT_EXECUTOR } from '../constants.js';

// Re-export for backward compatibility
export { DEFAULT_EXECUTOR };

export * from './build.ts';
export {
  ClaudeCodeExecutor,
  ClaudeCodeExecutorName,
  CopyOnlyExecutor,
  CopyOnlyExecutorName,
  CopyOnlyStateMachineExecutor,
  CopyOnlyStateMachineExecutorName,
  CopyPasteExecutor,
  CopyPasteExecutorName,
  OneCallExecutor,
  OneCallExecutorName,
};

export function defaultModelForExecutor(executorId: string, modelType: 'execution' | 'answerPr') {
  const executor = executors.get(executorId);
  modelType = modelType ?? 'execution';
  return executor?.defaultModel?.[modelType] ?? DEFAULT_RUN_MODEL;
}
