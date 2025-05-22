import { DEFAULT_RUN_MODEL } from '../../common/run_and_apply.ts';
import { executors } from './build.ts';
import { ClaudeCodeExecutor } from './claude_code.ts';
import { CopyOnlyExecutor } from './copy_only.ts';
import { CopyOnlyStateMachineExecutor } from './copy_only_statemachine.ts';
import { CopyPasteExecutor } from './copy_paste.ts';
import { OneCallExecutor } from './one-call';
import type { ExecutorFactory } from './types.ts';

export const DEFAULT_EXECUTOR = CopyOnlyExecutor.name;

export * from './build.ts';
export {
  ClaudeCodeExecutor,
  CopyOnlyExecutor,
  CopyOnlyStateMachineExecutor,
  CopyPasteExecutor,
  OneCallExecutor,
};

export function defaultModelForExecutor(executorId: string, modelType: 'execution' | 'answerPr') {
  const executor = executors.get(executorId);
  modelType = modelType ?? 'execution';
  return executor?.defaultModel?.[modelType] ?? DEFAULT_RUN_MODEL;
}
