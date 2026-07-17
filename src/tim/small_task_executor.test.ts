import { describe, expect, test } from 'vitest';
import type { TimConfig } from './configSchema.js';
import {
  DEFAULT_SMALL_TASK_EXECUTOR,
  DEFAULT_SMALL_TASK_MODEL,
  resolveSmallTaskExecutor,
} from './small_task_executor.js';

describe('resolveSmallTaskExecutor', () => {
  test('defaults small tasks to Codex Luna with medium reasoning', () => {
    expect(resolveSmallTaskExecutor({})).toEqual({
      executorName: DEFAULT_SMALL_TASK_EXECUTOR,
      model: DEFAULT_SMALL_TASK_MODEL,
    });
  });

  test('uses the centrally configured executor and model', () => {
    const config = {
      smallTasks: {
        executor: 'claude-code',
        model: 'sonnet',
      },
    } satisfies TimConfig;

    expect(resolveSmallTaskExecutor(config)).toEqual({
      executorName: 'claude-code',
      model: 'sonnet',
    });
  });

  test('does not send a configured model to a different executor override', () => {
    const config = {
      smallTasks: {
        executor: 'codex-cli',
        model: 'gpt-5.6-luna:medium',
      },
    } satisfies TimConfig;

    expect(resolveSmallTaskExecutor(config, { executor: 'claude-code' })).toEqual({
      executorName: 'claude-code',
      model: undefined,
    });
  });

  test('command model overrides take precedence', () => {
    expect(resolveSmallTaskExecutor({}, { model: 'gpt-5.6-sol:high' })).toEqual({
      executorName: 'codex-cli',
      model: 'gpt-5.6-sol:high',
    });
  });
});
