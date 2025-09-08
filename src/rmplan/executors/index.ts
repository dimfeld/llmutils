import { DEFAULT_RUN_MODEL } from '../llm_utils/run_and_apply.js';
import { executors } from './build.ts';
import { ClaudeCodeExecutor } from './claude_code.ts';
import { CopyOnlyExecutor } from './copy_only.ts';
import {
  CopyOnlyStateMachineExecutor,
  CopyOnlyStateMachineExecutorName,
} from './copy_only_statemachine.ts';
import { CopyPasteExecutor } from './copy_paste.ts';
import { OneCallExecutor } from './one-call';
import { CodexCliExecutor } from './codex_cli';
import { DEFAULT_EXECUTOR } from '../constants.js';
import {
  ClaudeCodeExecutorName,
  CopyOnlyExecutorName,
  CopyPasteExecutorName,
  OneCallExecutorName,
  CodexCliExecutorName,
} from './schemas.js';

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
  CodexCliExecutor,
  CodexCliExecutorName,
};

export function defaultModelForExecutor(executorId: string, modelType: 'execution' | 'answerPr') {
  const executor = executors.get(executorId);
  modelType = modelType ?? 'execution';
  return executor?.defaultModel?.[modelType] ?? DEFAULT_RUN_MODEL;
}
