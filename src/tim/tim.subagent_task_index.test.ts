import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const { handleSubagentCommandMock } = vi.hoisted(() => ({
  handleSubagentCommandMock: vi.fn(async () => {}),
}));

vi.mock('./commands/subagent.js', () => ({
  handleSubagentCommand: handleSubagentCommandMock,
}));

import { program } from './tim.ts';

async function runTimCli(args: string[]): Promise<void> {
  await program.parseAsync(['node', 'tim', ...args]);
}

describe('tim subagent --task-index Commander registration', () => {
  beforeAll(() => {
    program.exitOverride();
  });

  beforeEach(() => {
    handleSubagentCommandMock.mockClear();
  });

  test.each(['implementer', 'tester', 'tdd-tests'] as const)(
    'registers --task-index on the %s subcommand and accumulates repeated flags',
    async (agentType) => {
      await runTimCli(['subagent', agentType, '123', '--task-index', '2', '--task-index', '3']);

      expect(handleSubagentCommandMock).toHaveBeenCalledTimes(1);
      const [calledAgentType, planId, options] = handleSubagentCommandMock.mock.calls[0];
      expect(calledAgentType).toBe(agentType);
      expect(planId).toBe(123);
      expect(options.taskIndex).toEqual(['2', '3']);
    }
  );

  test.each(['implementer', 'tester', 'tdd-tests'] as const)(
    'accepts a comma-separated --task-index value on the %s subcommand',
    async (agentType) => {
      await runTimCli(['subagent', agentType, '123', '--task-index', '2,3']);

      expect(handleSubagentCommandMock).toHaveBeenCalledTimes(1);
      const [, , options] = handleSubagentCommandMock.mock.calls[0];
      expect(options.taskIndex).toEqual(['2,3']);
    }
  );

  test('does not set taskIndex when --task-index is omitted', async () => {
    await runTimCli(['subagent', 'implementer', '123']);

    expect(handleSubagentCommandMock).toHaveBeenCalledTimes(1);
    const [, , options] = handleSubagentCommandMock.mock.calls[0];
    expect(options.taskIndex).toBeUndefined();
  });
});
