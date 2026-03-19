import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { ModuleMocker } from '../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

const writeStdoutSpy = mock(() => {});
const loadEffectiveConfigSpy = mock(async () => ({ paths: { tasks: '/tmp/tasks' } }));
const resolvePlanPathContextSpy = mock(async () => ({
  gitRoot: '/tmp/repo',
  tasksDir: '/tmp/tasks',
}));
const loadImplementPromptSpy = mock(async () => ({
  messages: [
    {
      content: {
        type: 'text',
        text: 'implement prompt text',
      },
    },
  ],
}));

describe('handlePromptsCommand', () => {
  beforeEach(async () => {
    writeStdoutSpy.mockClear();
    loadEffectiveConfigSpy.mockClear();
    resolvePlanPathContextSpy.mockClear();
    loadImplementPromptSpy.mockClear();

    await moduleMocker.mock('../../logging.js', () => ({
      log: mock(() => {}),
      writeStdout: writeStdoutSpy,
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: loadEffectiveConfigSpy,
    }));

    await moduleMocker.mock('../path_resolver.js', () => ({
      resolvePlanPathContext: resolvePlanPathContextSpy,
    }));

    await moduleMocker.mock('../mcp/generate_mode.js', () => ({
      loadGeneratePrompt: mock(() => {
        throw new Error('unexpected call');
      }),
      loadImplementPrompt: loadImplementPromptSpy,
      loadPlanPrompt: mock(() => {
        throw new Error('unexpected call');
      }),
      loadQuestionsPrompt: mock(() => {
        throw new Error('unexpected call');
      }),
      loadResearchPrompt: mock(() => {
        throw new Error('unexpected call');
      }),
    }));

    await moduleMocker.mock('../mcp/prompts/compact_plan.js', () => ({
      loadCompactPlanPrompt: mock(() => {
        throw new Error('unexpected call');
      }),
    }));
  });

  test('lists implement in available prompt names', async () => {
    const { handlePromptsCommand } = await import('./prompts.js');

    await handlePromptsCommand(
      undefined,
      undefined,
      {},
      {
        parent: { opts: () => ({}) },
      }
    );

    expect(writeStdoutSpy).toHaveBeenCalledWith(expect.stringContaining('implement'));
  });

  test('routes implement prompt generation through loadImplementPrompt', async () => {
    const { handlePromptsCommand } = await import('./prompts.js');

    await handlePromptsCommand(
      'implement',
      '123',
      {},
      {
        parent: { opts: () => ({ config: '/tmp/config.json' }) },
      }
    );

    expect(loadImplementPromptSpy).toHaveBeenCalledTimes(1);
    expect(loadImplementPromptSpy).toHaveBeenCalledWith(
      { plan: '123' },
      expect.objectContaining({
        configPath: '/tmp/config.json',
        gitRoot: '/tmp/repo',
      })
    );
    expect(writeStdoutSpy).toHaveBeenCalledWith('implement prompt text\n');
  });
});
