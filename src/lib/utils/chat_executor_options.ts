import type { ChatExecutorOption } from '$tim/configSchema.js';
import { ClaudeCodeExecutorName, CodexCliExecutorName } from '$tim/executors/schemas.js';

export const DEFAULT_CHAT_EXECUTOR_OPTIONS: ChatExecutorOption[] = [
  { executor: ClaudeCodeExecutorName },
  { executor: CodexCliExecutorName },
];

export function chatExecutorLabel(executor: ChatExecutorOption['executor']): string {
  return executor === ClaudeCodeExecutorName ? 'Claude Code' : 'Codex CLI';
}

export function chatOptionKey(option: ChatExecutorOption): string {
  return option.executor + ':' + (option.model ?? '');
}
