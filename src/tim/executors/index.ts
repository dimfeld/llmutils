import { DEFAULT_RUN_MODEL } from '../llm_utils/run_and_apply.js';
import { executors } from './build.ts';
import { ClaudeCodeExecutor } from './claude_code.ts';
import { CodexCliExecutor } from './codex_cli';
import { DEFAULT_EXECUTOR } from '../constants.js';
import { ClaudeCodeExecutorName, CodexCliExecutorName } from './schemas.js';

// Re-export for backward compatibility
export { DEFAULT_EXECUTOR };

export * from './build.ts';
export { ClaudeCodeExecutor, ClaudeCodeExecutorName, CodexCliExecutor, CodexCliExecutorName };

export function defaultModelForExecutor(executorId: string, modelType: 'execution' | 'answerPr') {
  const executor = executors.get(executorId);
  modelType = modelType ?? 'execution';
  return executor?.defaultModel?.[modelType] ?? DEFAULT_RUN_MODEL;
}
