import { describe, test, expect } from 'vitest';
import { wrapForExecutionMode, type OrchestrationExecutionMode } from './orchestration_wrapper.ts';

describe('wrapForExecutionMode', () => {
  test('reviewExecutor reaches normal and tdd wrappers but not simple', () => {
    const normalOutput = wrapForExecutionMode('normal', 'context', 'plan-1', {
      reviewExecutor: 'codex-cli',
    });
    const tddOutput = wrapForExecutionMode('tdd', 'context', 'plan-1', {
      reviewExecutor: 'codex-cli',
    });
    const simpleOutput = wrapForExecutionMode('simple', 'context', 'plan-1', {
      reviewExecutor: 'codex-cli',
    });

    expect(normalOutput).toContain('--executor codex-cli');
    expect(tddOutput).toContain('--executor codex-cli');
    expect(simpleOutput).not.toContain('--executor codex-cli');
  });

  test('simpleMode changes only the tdd wrapper output', () => {
    const tddWithSimple = wrapForExecutionMode('tdd', 'context', 'plan-1', {
      simpleMode: true,
    });
    const tddWithoutSimple = wrapForExecutionMode('tdd', 'context', 'plan-1', {
      simpleMode: false,
    });

    // Non-simple TDD includes a dedicated Tester subagent; simple TDD folds
    // testing into the reviewer and drops it entirely.
    expect(tddWithoutSimple).toContain('tim subagent tester');
    expect(tddWithSimple).not.toContain('tim subagent tester');
    expect(tddWithSimple).not.toEqual(tddWithoutSimple);

    const normalWithSimple = wrapForExecutionMode('normal', 'context', 'plan-1', {
      simpleMode: true,
    });
    const normalWithoutSimple = wrapForExecutionMode('normal', 'context', 'plan-1', {
      simpleMode: false,
    });
    expect(normalWithSimple).toEqual(normalWithoutSimple);

    const simpleWithSimple = wrapForExecutionMode('simple', 'context', 'plan-1', {
      simpleMode: true,
    });
    const simpleWithoutSimple = wrapForExecutionMode('simple', 'context', 'plan-1', {
      simpleMode: false,
    });
    expect(simpleWithSimple).toEqual(simpleWithoutSimple);
  });

  test('structuralReviewCompleted reaches all three wrappers', () => {
    for (const mode of ['normal', 'simple', 'tdd'] as OrchestrationExecutionMode[]) {
      const completed = wrapForExecutionMode(mode, 'context', 'plan-1', {
        batchMode: true,
        structuralReviewCompleted: true,
      });
      const notCompleted = wrapForExecutionMode(mode, 'context', 'plan-1', {
        batchMode: true,
        structuralReviewCompleted: false,
      });
      expect(completed).not.toEqual(notCompleted);
    }
  });

  test('false and undefined agentMessagingEnabled preserve the legacy prompt output', () => {
    for (const mode of ['normal', 'simple', 'tdd'] as OrchestrationExecutionMode[]) {
      const disabled = wrapForExecutionMode(mode, 'context', 'plan-1', {
        agentMessagingEnabled: false,
      });
      const absent = wrapForExecutionMode(mode, 'context', 'plan-1', {});

      expect(absent).toBe(disabled);
      expect(disabled).not.toContain('StartTimAgent');
      expect(disabled).not.toContain('ListTimAgents');
      expect(disabled).not.toContain('SendTimAgentMessage');
      expect(disabled).not.toContain('StopTimAgent');
      expect(disabled).not.toContain('FinishTimAgent');
    }
  });

  test.each(['normal', 'simple', 'tdd'] as OrchestrationExecutionMode[])(
    'selects collaborative prompt semantics for enabled %s mode',
    (mode) => {
      const output = wrapForExecutionMode(mode, 'context', 'plan-1', {
        agentMessagingEnabled: true,
        batchMode: mode === 'tdd',
        simpleMode: mode === 'simple',
      });

      expect(output).toContain('StartTimAgent');
      expect(output).toContain('ListTimAgents');
      expect(output).toContain('SendTimAgentMessage');
      expect(output).toContain('StopTimAgent');
      expect(output).toContain('FinishTimAgent');
      expect(output).not.toContain('tim subagent');
    }
  );

  test('throws on an unsupported execution mode', () => {
    expect(() =>
      wrapForExecutionMode('bogus' as OrchestrationExecutionMode, 'context', 'plan-1', {})
    ).toThrow('Unsupported orchestration execution mode');
  });
});
