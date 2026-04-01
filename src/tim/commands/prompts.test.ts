import { beforeEach, describe, expect, vi, test } from 'vitest';

vi.mock('../../logging.js', () => ({
  log: vi.fn(),
  writeStdout: vi.fn(),
}));

vi.mock('../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(),
}));

vi.mock('../path_resolver.js', () => ({
  resolvePlanPathContext: vi.fn(),
}));

vi.mock('../mcp/generate_mode.js', () => ({
  loadGeneratePrompt: vi.fn(() => {
    throw new Error('unexpected call');
  }),
  loadImplementPrompt: vi.fn(() => {
    throw new Error('unexpected call');
  }),
  loadPlanPrompt: vi.fn(() => {
    throw new Error('unexpected call');
  }),
  loadQuestionsPrompt: vi.fn(() => {
    throw new Error('unexpected call');
  }),
  loadResearchPrompt: vi.fn(() => {
    throw new Error('unexpected call');
  }),
}));

describe('handlePromptsCommand', () => {
  let writeStdoutSpy: ReturnType<typeof vi.fn>;
  let loadEffectiveConfigSpy: ReturnType<typeof vi.fn>;
  let resolvePlanPathContextSpy: ReturnType<typeof vi.fn>;
  let loadImplementPromptSpy: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const loggingModule = await import('../../logging.js');
    writeStdoutSpy = vi.mocked(loggingModule.writeStdout);
    writeStdoutSpy.mockReset().mockImplementation(() => {});

    const configLoaderModule = await import('../configLoader.js');
    loadEffectiveConfigSpy = vi.mocked(configLoaderModule.loadEffectiveConfig);
    loadEffectiveConfigSpy.mockReset().mockResolvedValue({ paths: { tasks: '/tmp/tasks' } } as any);

    const pathResolverModule = await import('../path_resolver.js');
    resolvePlanPathContextSpy = vi.mocked(pathResolverModule.resolvePlanPathContext);
    resolvePlanPathContextSpy.mockReset().mockResolvedValue({
      gitRoot: '/tmp/repo',
      tasksDir: '/tmp/tasks',
    });

    const mcpModule = await import('../mcp/generate_mode.js');
    loadImplementPromptSpy = vi.mocked(mcpModule.loadImplementPrompt);
    loadImplementPromptSpy.mockReset().mockResolvedValue({
      messages: [
        {
          content: {
            type: 'text',
            text: 'implement prompt text',
          },
        },
      ],
    });
    vi.mocked(mcpModule.loadGeneratePrompt)
      .mockReset()
      .mockImplementation(() => {
        throw new Error('unexpected call');
      });
    vi.mocked(mcpModule.loadPlanPrompt)
      .mockReset()
      .mockImplementation(() => {
        throw new Error('unexpected call');
      });
    vi.mocked(mcpModule.loadQuestionsPrompt)
      .mockReset()
      .mockImplementation(() => {
        throw new Error('unexpected call');
      });
    vi.mocked(mcpModule.loadResearchPrompt)
      .mockReset()
      .mockImplementation(() => {
        throw new Error('unexpected call');
      });
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
