import { describe, expect, test, vi } from 'bun:test';
import { handleExecStepCommand } from './exec_step.js';

describe('handleExecStepCommand', () => {
  test('builds and executes implementer prompt via codex', async () => {
    const executeCodexStepFn = vi.fn(async (prompt: string) => {
      expect(prompt).toContain('You are a tim implementer agent');
      expect(prompt).toContain('Context and Task');
      return 'done from codex';
    });
    const stdoutWrite = vi.fn();

    await handleExecStepCommand(
      'implementer',
      'Implement a parser',
      {
        executor: 'codex',
        reasoningLevel: 'high',
      },
      {},
      {
        loadEffectiveConfigFn: vi.fn(async () => ({ headless: undefined }) as any),
        executeCodexStepFn: executeCodexStepFn as any,
        stdoutWrite,
        isTunnelActiveFn: vi.fn(() => true),
      }
    );

    expect(executeCodexStepFn).toHaveBeenCalled();
    expect(stdoutWrite).toHaveBeenCalledWith('done from codex\n');
  });

  test('builds tester context with implementer output when provided', async () => {
    const executeCodexStepFn = vi.fn(async (prompt: string) => {
      expect(prompt).toContain('### Implementer Output');
      expect(prompt).toContain('Implemented thing');
      expect(prompt).toContain('### Newly Completed Tasks');
      return 'tester done';
    });

    await handleExecStepCommand(
      'tester',
      'Test the feature',
      {
        executor: 'codex',
        implementerOutput: 'Implemented thing',
        newlyCompletedTask: ['Task A,Task B'],
      },
      {},
      {
        loadEffectiveConfigFn: vi.fn(async () => ({ headless: undefined }) as any),
        executeCodexStepFn: executeCodexStepFn as any,
        stdoutWrite: vi.fn(),
        isTunnelActiveFn: vi.fn(() => true),
      }
    );

    expect(executeCodexStepFn).toHaveBeenCalled();
  });

  test('requires fixer inputs', async () => {
    await expect(
      handleExecStepCommand(
        'fixer',
        undefined,
        { executor: 'codex' },
        {},
        {
          loadEffectiveConfigFn: vi.fn(async () => ({ headless: undefined }) as any),
          executeCodexStepFn: vi.fn() as any,
          stdoutWrite: vi.fn(),
          isTunnelActiveFn: vi.fn(() => true),
        }
      )
    ).rejects.toThrow('Fixer step requires --implementer-output or --implementer-output-file.');
  });

  test('executes with claude when selected', async () => {
    const executeClaudePromptFn = vi.fn(async (_prompt: string) => 'done from claude');
    const stdoutWrite = vi.fn();

    await handleExecStepCommand(
      'implementer',
      'Implement a parser',
      { executor: 'claude', model: 'claude-sonnet-4-5-20250929' },
      {},
      {
        loadEffectiveConfigFn: vi.fn(async () => ({ headless: undefined }) as any),
        executeClaudePromptFn: executeClaudePromptFn as any,
        executeCodexStepFn: vi.fn() as any,
        stdoutWrite,
        isTunnelActiveFn: vi.fn(() => true),
      }
    );

    expect(executeClaudePromptFn).toHaveBeenCalled();
    expect(stdoutWrite).toHaveBeenCalledWith('done from claude\n');
  });
});
