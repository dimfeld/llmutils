import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const originalCodexUseAppServer = process.env.CODEX_USE_APP_SERVER;

beforeEach(() => {
  process.env.CODEX_USE_APP_SERVER = 'false';
  vi.resetModules();
});

afterEach(() => {
  if (originalCodexUseAppServer === undefined) {
    delete process.env.CODEX_USE_APP_SERVER;
  } else {
    process.env.CODEX_USE_APP_SERVER = originalCodexUseAppServer;
  }
  vi.clearAllMocks();
});

describe('CodexCliExecutor - failure detection across agents', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = '/tmp/codex-failure-test';
    (await import('node:fs/promises')).mkdir(tempDir, { recursive: true }).catch(() => {});
  });

  test('implementer failure short-circuits execution and skips auto-mark', async () => {
    vi.doMock('../../logging.ts', () => ({
      log: vi.fn(() => {}),
      warn: vi.fn(() => {}),
      error: vi.fn(() => {}),
      sendStructured: vi.fn(),
    }));

    vi.doMock('../../common/git.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../common/git.js')>();
      return {
        ...actual,
        getGitRoot: vi.fn(async () => tempDir),
        getUsingJj: vi.fn(async () => false),
      };
    });

    const executeCodexStepMock = vi.fn(
      async () =>
        'FAILED: Implementer hit impossible requirements\nProblems:\n- conflict\nRequirements:\n- task A'
    );
    vi.doMock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: executeCodexStepMock,
    }));

    const { CodexCliExecutor } = await import('./codex_cli.js');
    const exec = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    const out = (await exec.execute('CTX', {
      planId: '1',
      planTitle: 'P',
      planFilePath: `${tempDir}/plan.yml`,
      executionMode: 'normal',
      captureOutput: 'result',
    })) as any;

    expect(executeCodexStepMock).toHaveBeenCalledTimes(1);
    expect(out).toBeDefined();
    expect(out.success).toBe(false);
    expect(out.failureDetails?.sourceAgent).toBe('implementer');
    expect(out.failureDetails?.problems).toContain('conflict');
  });

  test('sends single orchestrator prompt for normal mode execution', async () => {
    vi.doMock('../../logging.ts', () => ({
      log: vi.fn(() => {}),
      warn: vi.fn(() => {}),
      error: vi.fn(() => {}),
      sendStructured: vi.fn(),
    }));

    vi.doMock('../../common/git.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../common/git.js')>();
      return {
        ...actual,
        getGitRoot: vi.fn(async () => tempDir),
        getUsingJj: vi.fn(async () => false),
      };
    });

    // Reset failure_detection to real module (prior test mocks it with fewer exports)
    vi.doMock('./failure_detection.ts', async (importOriginal) =>
      importOriginal<typeof import('./failure_detection.js')>()
    );

    const executeCodexStepMock = vi.fn(async () => 'Implementation complete');
    vi.doMock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: executeCodexStepMock,
    }));

    const { CodexCliExecutor } = await import('./codex_cli.js');
    const exec = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    const result = await exec.execute('CTX', {
      planId: '1',
      planTitle: 'Plan',
      planFilePath: `${tempDir}/plan.yml`,
      executionMode: 'normal',
    });

    expect(result).toBeUndefined();
    expect(executeCodexStepMock).toHaveBeenCalledTimes(1);
    const prompt = executeCodexStepMock.mock.calls[0][0] as string;
    expect(prompt).toContain('tim subagent implementer 1');
    expect(prompt).toContain('tim subagent tester 1');
    expect(prompt).toContain('tim subagent reviewer 1');
    // Codex must receive the raw plan path, never Claude's `@` file-prefix.
    expect(prompt).toContain(`${tempDir}/plan.yml`);
    expect(prompt).not.toContain(`@${tempDir}/plan.yml`);
  });

  test('routes normal mode to simple wrapper when executor simpleMode is enabled', async () => {
    vi.doMock('../../logging.ts', () => ({
      log: vi.fn(() => {}),
      warn: vi.fn(() => {}),
      error: vi.fn(() => {}),
      sendStructured: vi.fn(),
    }));

    vi.doMock('../../common/git.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../common/git.js')>();
      return {
        ...actual,
        getGitRoot: vi.fn(async () => tempDir),
        getUsingJj: vi.fn(async () => false),
      };
    });

    vi.doMock('./failure_detection.ts', async (importOriginal) =>
      importOriginal<typeof import('./failure_detection.js')>()
    );

    const executeCodexStepMock = vi.fn(async () => 'done');
    vi.doMock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: executeCodexStepMock,
    }));

    const { CodexCliExecutor } = await import('./codex_cli.js');
    // Executor configured with simpleMode, but execution mode stays 'normal'.
    const exec = new CodexCliExecutor({ simpleMode: true }, { baseDir: tempDir }, {} as any);

    await exec.execute('CTX', {
      planId: '7',
      planTitle: 'Plan',
      planFilePath: `${tempDir}/plan.yml`,
      executionMode: 'normal',
    });

    expect(executeCodexStepMock).toHaveBeenCalledTimes(1);
    const prompt = executeCodexStepMock.mock.calls[0][0] as string;
    // Simple wrapper uses implementer -> verifier, not the normal tester/review loop.
    expect(prompt).toContain('tim subagent implementer 7');
    expect(prompt).toContain('tim subagent verifier 7');
    expect(prompt).not.toContain('tim subagent tester 7');
  });

  test('adds sandbox writable roots when using external storage', async () => {
    const recordedArgs: string[][] = [];
    const externalDir = '/tmp/tim/external-config';
    const originalAllowAll = process.env.ALLOW_ALL_TOOLS;
    process.env.ALLOW_ALL_TOOLS = 'false';

    vi.doMock('../../common/git.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../common/git.js')>();
      return {
        ...actual,
        getGitRoot: vi.fn(async () => tempDir),
        captureRepositoryState: vi.fn(async () => ({ commitHash: 'hash', hasChanges: false })),
      };
    });

    vi.doMock('../plans.ts', () => ({
      readPlanFile: vi.fn(async () => ({
        id: 1,
        title: 'Plan',
        tasks: [{ title: 'Task', done: false }],
      })),
    }));

    vi.doMock('../../logging.ts', () => ({
      log: vi.fn(() => {}),
      warn: vi.fn(() => {}),
      error: vi.fn(() => {}),
      sendStructured: vi.fn(),
    }));

    vi.doMock('../../common/process.ts', () => ({
      spawnAndLogOutput: vi.fn(async (args: string[], opts: any) => {
        recordedArgs.push(args);
        if (opts && typeof opts.formatStdout === 'function') opts.formatStdout('ignored');
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    }));

    vi.doMock('./codex_cli/format.ts', () => ({
      createCodexStdoutFormatter: () => ({
        formatChunk: () => '',
        getFinalAgentMessage: () => 'FAILED: Implementer hit impossible requirements',
        getFailedAgentMessage: () => 'FAILED: Implementer hit impossible requirements',
        getThreadId: () => undefined,
        getSessionId: () => undefined,
      }),
    }));

    vi.doMock('./failure_detection.ts', async (importOriginal) =>
      importOriginal<typeof import('./failure_detection.js')>()
    );

    vi.doMock('../../../logging/tunnel_client.js', () => ({ isTunnelActive: vi.fn(() => false) }));
    vi.doMock('../../../logging/tunnel_server.js', () => ({
      createTunnelServer: vi.fn(async () => ({ close: vi.fn() })),
    }));
    vi.doMock('../../../logging/tunnel_prompt_handler.js', () => ({
      createPromptRequestHandler: vi.fn(() => vi.fn()),
    }));
    vi.doMock('../../../logging/tunnel_protocol.js', () => ({
      TIM_OUTPUT_SOCKET: 'TIM_OUTPUT_SOCKET',
    }));

    // Use real codex_runner.ts so spawnAndLogOutput is called (overrides any stale mock from earlier tests)
    vi.doMock('./codex_cli/codex_runner.ts', async (importOriginal) =>
      importOriginal<typeof import('./codex_cli/codex_runner.js')>()
    );

    const { CodexCliExecutor } = await import('./codex_cli.js');
    const exec = new CodexCliExecutor({}, { baseDir: tempDir }, {
      issueTracker: 'github',
      isUsingExternalStorage: true,
      externalRepositoryConfigDir: externalDir,
    } as any);

    try {
      await exec.execute('CTX', {
        planId: '1',
        planTitle: 'P',
        planFilePath: `${tempDir}/plan.yml`,
        executionMode: 'normal',
        captureOutput: 'result',
      });
    } finally {
      if (originalAllowAll == null) {
        delete process.env.ALLOW_ALL_TOOLS;
      } else {
        process.env.ALLOW_ALL_TOOLS = originalAllowAll;
      }
    }

    expect(recordedArgs).toHaveLength(1);
    const args = recordedArgs[0];
    expect(args).toContain('--sandbox');
    expect(args).toContain('-c');
    expect(args.includes(`sandbox_workspace_write.writable_roots=["${externalDir}"]`)).toBe(true);
  });

  test('omits sandbox writable roots when external storage is disabled', async () => {
    const recordedArgs: string[][] = [];
    const originalAllowAll = process.env.ALLOW_ALL_TOOLS;
    process.env.ALLOW_ALL_TOOLS = 'false';

    vi.doMock('../../common/git.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../common/git.js')>();
      return {
        ...actual,
        getGitRoot: vi.fn(async () => tempDir),
        captureRepositoryState: vi.fn(async () => ({ commitHash: 'hash', hasChanges: false })),
      };
    });

    vi.doMock('../plans.ts', () => ({
      readPlanFile: vi.fn(async () => ({
        id: 1,
        title: 'Plan',
        tasks: [{ title: 'Task', done: false }],
      })),
    }));

    vi.doMock('../../logging.ts', () => ({
      log: vi.fn(() => {}),
      warn: vi.fn(() => {}),
      error: vi.fn(() => {}),
      sendStructured: vi.fn(),
    }));

    vi.doMock('../../common/process.ts', () => ({
      spawnAndLogOutput: vi.fn(async (args: string[], opts: any) => {
        recordedArgs.push(args);
        if (opts && typeof opts.formatStdout === 'function') opts.formatStdout('ignored');
        return { exitCode: 0, stdout: '', stderr: '' };
      }),
    }));

    vi.doMock('./codex_cli/format.ts', () => ({
      createCodexStdoutFormatter: () => ({
        formatChunk: () => '',
        getFinalAgentMessage: () => 'FAILED: Implementer hit impossible requirements',
        getFailedAgentMessage: () => 'FAILED: Implementer hit impossible requirements',
        getThreadId: () => undefined,
        getSessionId: () => undefined,
      }),
    }));

    vi.doMock('./failure_detection.ts', async (importOriginal) =>
      importOriginal<typeof import('./failure_detection.js')>()
    );

    vi.doMock('../../../logging/tunnel_client.js', () => ({ isTunnelActive: vi.fn(() => false) }));
    vi.doMock('../../../logging/tunnel_server.js', () => ({
      createTunnelServer: vi.fn(async () => ({ close: vi.fn() })),
    }));
    vi.doMock('../../../logging/tunnel_prompt_handler.js', () => ({
      createPromptRequestHandler: vi.fn(() => vi.fn()),
    }));
    vi.doMock('../../../logging/tunnel_protocol.js', () => ({
      TIM_OUTPUT_SOCKET: 'TIM_OUTPUT_SOCKET',
    }));

    // Use real codex_runner.ts so spawnAndLogOutput is called (overrides any stale mock from earlier tests)
    vi.doMock('./codex_cli/codex_runner.ts', async (importOriginal) =>
      importOriginal<typeof import('./codex_cli/codex_runner.js')>()
    );

    const { CodexCliExecutor } = await import('./codex_cli.js');
    const exec = new CodexCliExecutor({}, { baseDir: tempDir }, {
      issueTracker: 'github',
      isUsingExternalStorage: false,
    } as any);

    try {
      await exec.execute('CTX', {
        planId: '1',
        planTitle: 'P',
        planFilePath: `${tempDir}/plan.yml`,
        executionMode: 'normal',
        captureOutput: 'result',
      });
    } finally {
      if (originalAllowAll == null) {
        delete process.env.ALLOW_ALL_TOOLS;
      } else {
        process.env.ALLOW_ALL_TOOLS = originalAllowAll;
      }
    }

    expect(recordedArgs).toHaveLength(1);
    const args = recordedArgs[0];
    expect(args).toContain('--sandbox');
    expect(args.filter((value) => value === '-c')).toHaveLength(1);
    expect(args.some((value) => value.startsWith('sandbox_workspace_write.writable_roots='))).toBe(
      false
    );
  });
});

describe('CodexCliExecutor project environment threading', () => {
  test('passes shared timEnvironment into bare-mode Codex subprocess options', async () => {
    const executeCodexStep = vi.fn(async () => 'done');
    vi.doMock('../../common/git.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../common/git.js')>();
      return {
        ...actual,
        getGitRoot: vi.fn(async () => '/tmp/codex-env-threading'),
      };
    });
    vi.doMock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep,
    }));

    const { CodexCliExecutor } = await import('./codex_cli.js');
    const timEnvironment = {
      environment: {
        TIM_DATABASE_NAME: 'db_{{planId}}',
      },
      context: {
        planId: '374',
      },
    };
    const executor = new CodexCliExecutor(
      {},
      {
        baseDir: '/tmp/codex-env-threading',
        timEnvironment,
      },
      {} as any
    );

    await executor.execute('prompt', {
      planId: '374',
      planTitle: 'Plan',
      planFilePath: '/tmp/codex-env-threading/374.plan.md',
      executionMode: 'bare',
    });

    expect(executeCodexStep).toHaveBeenCalledWith(
      'prompt',
      '/tmp/codex-env-threading',
      {},
      expect.objectContaining({ timEnvironment })
    );
  });
});

describe('CodexCliExecutor - tdd execution mode routing', () => {
  const tempDir = '/tmp/codex-routing-test';

  test('routes tdd mode to orchestrator with TDD wrapper (simpleMode=false)', async () => {
    vi.doMock('../../logging.ts', () => ({
      log: vi.fn(() => {}),
      warn: vi.fn(() => {}),
      sendStructured: vi.fn(),
    }));

    vi.doMock('../../common/git.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../common/git.js')>();
      return {
        ...actual,
        getGitRoot: vi.fn(async () => tempDir),
        getUsingJj: vi.fn(async () => false),
      };
    });

    const executeCodexStepMock = vi.fn(async () => 'TDD complete');
    vi.doMock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: executeCodexStepMock,
    }));

    const { CodexCliExecutor } = await import('./codex_cli.js');
    const executor = new CodexCliExecutor({}, { baseDir: tempDir, simpleMode: false }, {} as any);

    await executor.execute('CTX', {
      planId: '175',
      planTitle: 'TDD Plan',
      planFilePath: `${tempDir}/plan.md`,
      executionMode: 'tdd',
    });

    expect(executeCodexStepMock).toHaveBeenCalledTimes(1);
    const prompt = executeCodexStepMock.mock.calls[0][0] as string;
    expect(prompt).toContain('tim subagent tdd-tests 175');
    expect(prompt).toContain('tim subagent implementer 175');
    expect(prompt).toContain('tim subagent tester 175');
    expect(prompt).toContain('tim subagent reviewer 175');
    expect(prompt).not.toContain('tim subagent verifier');
  });

  test('routes tdd mode to orchestrator with TDD simple wrapper (simpleMode=true)', async () => {
    vi.doMock('../../logging.ts', () => ({
      log: vi.fn(() => {}),
      warn: vi.fn(() => {}),
      sendStructured: vi.fn(),
    }));

    vi.doMock('../../common/git.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../common/git.js')>();
      return {
        ...actual,
        getGitRoot: vi.fn(async () => tempDir),
        getUsingJj: vi.fn(async () => false),
      };
    });

    const executeCodexStepMock = vi.fn(async () => 'TDD simple complete');
    vi.doMock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: executeCodexStepMock,
    }));

    const { CodexCliExecutor } = await import('./codex_cli.js');
    const executor = new CodexCliExecutor({}, { baseDir: tempDir, simpleMode: true }, {} as any);

    await executor.execute('CTX', {
      planId: '175',
      planTitle: 'TDD Plan',
      planFilePath: `${tempDir}/plan.md`,
      executionMode: 'tdd',
    });

    expect(executeCodexStepMock).toHaveBeenCalledTimes(1);
    const prompt = executeCodexStepMock.mock.calls[0][0] as string;
    expect(prompt).toContain('tim subagent tdd-tests 175');
    expect(prompt).toContain('tim subagent implementer 175');
    expect(prompt).toContain('tim subagent verifier 175');
    expect(prompt).not.toContain('tim subagent tester');
  });
});

describe('CodexCliExecutor - planning mode routing', () => {
  const tempDir = '/tmp/codex-planning-routing-test';

  test('enables chat-style session mode for planning execution', async () => {
    const executeBareModeMock = vi.fn(async () => ({ content: 'planning flow' }));

    vi.doMock('./codex_cli/bare_mode.ts', () => ({
      executeBareMode: executeBareModeMock,
    }));

    const { CodexCliExecutor } = await import('./codex_cli.js');
    const executor = new CodexCliExecutor({}, { baseDir: tempDir, terminalInput: true }, {} as any);

    await executor.execute('CTX', {
      planId: '301',
      planTitle: 'Planning Plan',
      planFilePath: `${tempDir}/plan.md`,
      executionMode: 'planning',
    });

    expect(executeBareModeMock).toHaveBeenCalledTimes(1);
    expect(executeBareModeMock.mock.calls[0]?.[5]).toEqual({
      appServerMode: 'chat-session',
      reasoningLevel: 'high',
      terminalInput: true,
    });
  });

  test('planning execution honors executor reasoning override', async () => {
    const executeBareModeMock = vi.fn(async () => ({ content: 'planning flow' }));

    vi.doMock('./codex_cli/bare_mode.ts', () => ({
      executeBareMode: executeBareModeMock,
    }));

    const { CodexCliExecutor } = await import('./codex_cli.js');
    const executor = new CodexCliExecutor(
      { reasoning: { default: 'xhigh' } },
      { baseDir: tempDir },
      { executors: { 'codex-cli': { reasoning: { generate: 'high' } } } } as any
    );

    await executor.execute('CTX', {
      planId: '302',
      planTitle: 'PR Fix',
      planFilePath: `${tempDir}/plan.md`,
      executionMode: 'planning',
    });

    expect(executeBareModeMock.mock.calls[0]?.[5]).toEqual(
      expect.objectContaining({ reasoningLevel: 'xhigh' })
    );
  });
});

describe('CodexCliExecutor - orchestrator routing contract', () => {
  const tempDir = '/tmp/codex-orchestrator-test';

  async function setupOrchestratorMocks(opts?: { useJj?: boolean }) {
    vi.doMock('../../logging.ts', () => ({
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      sendStructured: vi.fn(),
    }));

    const useJj = opts?.useJj ?? false;
    vi.doMock('../../common/git.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../common/git.js')>();
      return {
        ...actual,
        getGitRoot: vi.fn(async () => tempDir),
        getUsingJj: vi.fn(async () => useJj),
      };
    });

    // Ensure failure_detection uses the real module (prior tests in the suite may have
    // registered a partial mock that omits parseFailedReportAnywhere)
    vi.doMock('./failure_detection.ts', async (importOriginal) =>
      importOriginal<typeof import('./failure_detection.js')>()
    );

    const executeCodexStepMock = vi.fn(async () => 'Success output');
    vi.doMock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: executeCodexStepMock,
    }));

    const { CodexCliExecutor } = await import('./codex_cli.js');
    return { CodexCliExecutor, executeCodexStepMock };
  }

  test('normal mode: wraps with orchestration and calls executeCodexStep once', async () => {
    const { CodexCliExecutor, executeCodexStepMock } = await setupOrchestratorMocks();
    const exec = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    await exec.execute('CTX', {
      planId: '42',
      planTitle: 'Test Plan',
      planFilePath: '/tmp/plan.md',
      executionMode: 'normal',
    });

    expect(executeCodexStepMock).toHaveBeenCalledTimes(1);
    const prompt = executeCodexStepMock.mock.calls[0][0] as string;
    expect(prompt).toContain('tim subagent implementer 42');
    expect(prompt).toContain('tim subagent tester 42');
    expect(prompt).toContain('tim subagent reviewer 42');
    expect(prompt).toContain('CTX');
  });

  test('simple mode: implementer + verifier, no tester subagent', async () => {
    const { CodexCliExecutor, executeCodexStepMock } = await setupOrchestratorMocks();
    const exec = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    await exec.execute('CTX', {
      planId: '43',
      planTitle: 'Simple Plan',
      planFilePath: '/tmp/plan.md',
      executionMode: 'simple',
    });

    expect(executeCodexStepMock).toHaveBeenCalledTimes(1);
    const prompt = executeCodexStepMock.mock.calls[0][0] as string;
    expect(prompt).toContain('tim subagent implementer 43');
    expect(prompt).toContain('tim subagent verifier 43');
    expect(prompt).not.toContain('tim subagent tester');
  });

  test('tdd mode simpleMode=false: tdd-tests + tester + review', async () => {
    const { CodexCliExecutor, executeCodexStepMock } = await setupOrchestratorMocks();
    const exec = new CodexCliExecutor({}, { baseDir: tempDir, simpleMode: false }, {} as any);

    await exec.execute('CTX', {
      planId: '44',
      planTitle: 'TDD Plan',
      planFilePath: '/tmp/plan.md',
      executionMode: 'tdd',
    });

    expect(executeCodexStepMock).toHaveBeenCalledTimes(1);
    const prompt = executeCodexStepMock.mock.calls[0][0] as string;
    expect(prompt).toContain('tim subagent tdd-tests 44');
    expect(prompt).toContain('tim subagent implementer 44');
    expect(prompt).toContain('tim subagent tester 44');
    expect(prompt).toContain('tim subagent reviewer 44');
    expect(prompt).not.toContain('tim subagent verifier');
  });

  test('tdd mode simpleMode=true: tdd-tests + verifier, no tester', async () => {
    const { CodexCliExecutor, executeCodexStepMock } = await setupOrchestratorMocks();
    const exec = new CodexCliExecutor({}, { baseDir: tempDir, simpleMode: true }, {} as any);

    await exec.execute('CTX', {
      planId: '44',
      planTitle: 'TDD Plan',
      planFilePath: '/tmp/plan.md',
      executionMode: 'tdd',
    });

    expect(executeCodexStepMock).toHaveBeenCalledTimes(1);
    const prompt = executeCodexStepMock.mock.calls[0][0] as string;
    expect(prompt).toContain('tim subagent tdd-tests 44');
    expect(prompt).toContain('tim subagent implementer 44');
    expect(prompt).toContain('tim subagent verifier 44');
    expect(prompt).not.toContain('tim subagent tester');
  });

  test('passes appServerMode single-turn-with-steering and model to executeCodexStep', async () => {
    const { CodexCliExecutor, executeCodexStepMock } = await setupOrchestratorMocks();
    const exec = new CodexCliExecutor({}, { baseDir: tempDir, model: 'gpt-test-model' }, {} as any);

    await exec.execute('CTX', {
      planId: '45',
      planTitle: 'Plan',
      planFilePath: '/tmp/plan.md',
      executionMode: 'normal',
    });

    const options = executeCodexStepMock.mock.calls[0][3];
    expect(options).toMatchObject({
      appServerMode: 'single-turn-with-steering',
      model: 'gpt-test-model',
    });
  });

  test('uses reasoningLevel from timConfig executor config', async () => {
    const { CodexCliExecutor, executeCodexStepMock } = await setupOrchestratorMocks();
    const exec = new CodexCliExecutor({}, { baseDir: tempDir }, {
      executors: { 'codex-cli': { reasoning: { default: 'high' } } },
    } as any);

    await exec.execute('CTX', {
      planId: '47',
      planTitle: 'Plan',
      planFilePath: '/tmp/plan.md',
      executionMode: 'normal',
    });

    const options = executeCodexStepMock.mock.calls[0][3];
    expect(options).toMatchObject({ reasoningLevel: 'high' });
  });

  test('defaults reasoningLevel to medium when not configured', async () => {
    const { CodexCliExecutor, executeCodexStepMock } = await setupOrchestratorMocks();
    const exec = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    await exec.execute('CTX', {
      planId: '48',
      planTitle: 'Plan',
      planFilePath: '/tmp/plan.md',
      executionMode: 'normal',
    });

    const options = executeCodexStepMock.mock.calls[0][3];
    expect(options).toMatchObject({ reasoningLevel: 'medium' });
  });

  test('orchestrator effort override on executor options takes precedence over config', async () => {
    const { CodexCliExecutor, executeCodexStepMock } = await setupOrchestratorMocks();
    // agent.ts merges config.orchestrator.effort.codex into the executor options as
    // reasoning.default; that override must win over the raw timConfig executor default.
    const exec = new CodexCliExecutor(
      { reasoning: { default: 'xhigh' } } as any,
      { baseDir: tempDir },
      {
        executors: { 'codex-cli': { reasoning: { default: 'medium' } } },
      } as any
    );

    await exec.execute('CTX', {
      planId: '50',
      planTitle: 'Plan',
      planFilePath: '/tmp/plan.md',
      executionMode: 'normal',
    });

    const options = executeCodexStepMock.mock.calls[0][3];
    expect(options).toMatchObject({ reasoningLevel: 'xhigh' });
  });

  test('subagentExecutor codex-cli: prompt includes -x codex-cli flags', async () => {
    const { CodexCliExecutor, executeCodexStepMock } = await setupOrchestratorMocks();
    const exec = new CodexCliExecutor(
      {},
      { baseDir: tempDir, subagentExecutor: 'codex-cli' },
      {} as any
    );

    await exec.execute('CTX', {
      planId: '49',
      planTitle: 'Plan',
      planFilePath: '/tmp/plan.md',
      executionMode: 'normal',
    });

    const prompt = executeCodexStepMock.mock.calls[0][0] as string;
    expect(prompt).toContain('-x codex-cli');
    expect(prompt).not.toContain('-x claude-code');
  });

  test('subagentExecutor claude-code: prompt includes -x claude-code flags', async () => {
    const { CodexCliExecutor, executeCodexStepMock } = await setupOrchestratorMocks();
    const exec = new CodexCliExecutor(
      {},
      { baseDir: tempDir, subagentExecutor: 'claude-code' },
      {} as any
    );

    await exec.execute('CTX', {
      planId: '49',
      planTitle: 'Plan',
      planFilePath: '/tmp/plan.md',
      executionMode: 'normal',
    });

    const prompt = executeCodexStepMock.mock.calls[0][0] as string;
    expect(prompt).toContain('-x claude-code');
    expect(prompt).not.toContain('-x codex-cli');
  });

  test('subagentExecutor dynamic: prompt includes executor selection guidance', async () => {
    const { CodexCliExecutor, executeCodexStepMock } = await setupOrchestratorMocks();
    const exec = new CodexCliExecutor(
      {},
      {
        baseDir: tempDir,
        subagentExecutor: 'dynamic',
        dynamicSubagentInstructions: 'prefer codex for backend',
      },
      {} as any
    );

    await exec.execute('CTX', {
      planId: '49',
      planTitle: 'Plan',
      planFilePath: '/tmp/plan.md',
      executionMode: 'normal',
    });

    const prompt = executeCodexStepMock.mock.calls[0][0] as string;
    expect(prompt).toContain('prefer codex for backend');
    expect(prompt).toContain('Subagent Executor Selection');
  });

  test('reviewExecutor propagated in normal mode prompt', async () => {
    const { CodexCliExecutor, executeCodexStepMock } = await setupOrchestratorMocks();
    const exec = new CodexCliExecutor(
      {},
      { baseDir: tempDir, reviewExecutor: 'claude-code' },
      {} as any
    );

    await exec.execute('CTX', {
      planId: '50',
      planTitle: 'Plan',
      planFilePath: '/tmp/plan.md',
      executionMode: 'normal',
    });

    const prompt = executeCodexStepMock.mock.calls[0][0] as string;
    expect(prompt).toContain('--executor claude-code');
  });

  test('batchMode=true: prompt includes batch guidance and task marking', async () => {
    const { CodexCliExecutor, executeCodexStepMock } = await setupOrchestratorMocks();
    const exec = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    await exec.execute('CTX', {
      planId: '51',
      planTitle: 'Plan',
      planFilePath: '/tmp/plan.md',
      executionMode: 'normal',
      batchMode: true,
    });

    const prompt = executeCodexStepMock.mock.calls[0][0] as string;
    expect(prompt).toContain('Batch Task Processing Mode');
    expect(prompt).toContain('tim set-task-done 51');
  });

  test('jj guidance included when getUsingJj returns true', async () => {
    const { CodexCliExecutor, executeCodexStepMock } = await setupOrchestratorMocks({
      useJj: true,
    });
    const exec = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    await exec.execute('CTX', {
      planId: '52',
      planTitle: 'Plan',
      planFilePath: '/tmp/plan.md',
      executionMode: 'normal',
    });

    const prompt = executeCodexStepMock.mock.calls[0][0] as string;
    expect(prompt).toContain('Jujutsu (jj)');
  });

  test('jj guidance omitted when getUsingJj returns false', async () => {
    const { CodexCliExecutor, executeCodexStepMock } = await setupOrchestratorMocks({
      useJj: false,
    });
    const exec = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    await exec.execute('CTX', {
      planId: '52',
      planTitle: 'Plan',
      planFilePath: '/tmp/plan.md',
      executionMode: 'normal',
    });

    const prompt = executeCodexStepMock.mock.calls[0][0] as string;
    expect(prompt).not.toContain('Jujutsu (jj)');
  });

  test('defensive no-wrap when planId is empty: sends raw prompt', async () => {
    const { CodexCliExecutor, executeCodexStepMock } = await setupOrchestratorMocks();
    const exec = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    await exec.execute('MY_RAW_CONTEXT', {
      planId: '',
      planTitle: 'Plan',
      planFilePath: '/tmp/plan.md',
      executionMode: 'normal',
    });

    expect(executeCodexStepMock).toHaveBeenCalledTimes(1);
    const prompt = executeCodexStepMock.mock.calls[0][0] as string;
    expect(prompt).toBe('MY_RAW_CONTEXT');
  });

  test('defensive no-wrap when planFilePath is empty: sends raw prompt', async () => {
    const { CodexCliExecutor, executeCodexStepMock } = await setupOrchestratorMocks();
    const exec = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    await exec.execute('MY_RAW_CONTEXT', {
      planId: '53',
      planTitle: 'Plan',
      planFilePath: '',
      executionMode: 'normal',
    });

    expect(executeCodexStepMock).toHaveBeenCalledTimes(1);
    const prompt = executeCodexStepMock.mock.calls[0][0] as string;
    expect(prompt).toBe('MY_RAW_CONTEXT');
  });

  test('failure output: FAILED line returns success=false with failureDetails', async () => {
    vi.doMock('../../logging.ts', () => ({
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      sendStructured: vi.fn(),
    }));
    vi.doMock('../../common/git.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../common/git.js')>();
      return {
        ...actual,
        getGitRoot: vi.fn(async () => tempDir),
        getUsingJj: vi.fn(async () => false),
      };
    });
    vi.doMock('./failure_detection.ts', async (importOriginal) =>
      importOriginal<typeof import('./failure_detection.js')>()
    );
    vi.doMock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: vi.fn(
        async () =>
          'Some work done\nFAILED: tester reported a failure — tests are broken\nProblems:\n- build errors\nRequirements:\n- passing tests'
      ),
    }));

    const { CodexCliExecutor } = await import('./codex_cli.js');
    const exec = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    const out = (await exec.execute('CTX', {
      planId: '54',
      planTitle: 'Plan',
      planFilePath: '/tmp/plan.md',
      executionMode: 'normal',
    })) as any;

    expect(out).toBeDefined();
    expect(out.success).toBe(false);
    expect(out.metadata).toEqual({ phase: 'orchestrator' });
    expect(out.failureDetails).toBeDefined();
  });
});

describe('CodexCliExecutor - routing preservation', () => {
  const tempDir = '/tmp/codex-routing-preservation-test';

  test('review mode routes to executeReviewMode, not orchestrator', async () => {
    const executeReviewModeMock = vi.fn(async () => ({ content: 'review result', success: true }));
    vi.doMock('./codex_cli/review_mode.ts', () => ({
      executeReviewMode: executeReviewModeMock,
    }));

    const executeCodexStepMock = vi.fn(async () => 'should not be called');
    vi.doMock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: executeCodexStepMock,
    }));

    const { CodexCliExecutor } = await import('./codex_cli.js');
    const executor = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    await executor.execute('CTX', {
      planId: '302',
      planTitle: 'Review Plan',
      planFilePath: `${tempDir}/plan.md`,
      executionMode: 'review',
    });

    expect(executeReviewModeMock).toHaveBeenCalledTimes(1);
    expect(executeCodexStepMock).not.toHaveBeenCalled();
  });

  test('bare mode routes to executeBareMode, not orchestrator', async () => {
    const executeBareModeMock = vi.fn(async () => ({ content: 'bare result' }));
    vi.doMock('./codex_cli/bare_mode.ts', () => ({
      executeBareMode: executeBareModeMock,
    }));

    const executeCodexStepMock = vi.fn(async () => 'should not be called');
    vi.doMock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: executeCodexStepMock,
    }));

    const { CodexCliExecutor } = await import('./codex_cli.js');
    const executor = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    await executor.execute('CTX', {
      planId: '303',
      planTitle: 'Bare Plan',
      planFilePath: `${tempDir}/plan.md`,
      executionMode: 'bare',
    });

    expect(executeBareModeMock).toHaveBeenCalledTimes(1);
    expect(executeCodexStepMock).not.toHaveBeenCalled();
  });
});

test('CodexCliExecutor - parseReviewerVerdict', async () => {
  const { parseReviewerVerdict } = await vi.importActual<
    typeof import('./codex_cli/verdict_parser.js')
  >('./codex_cli/verdict_parser.js');
  const testCases = [
    ['**VERDICT:** ACCEPTABLE', 'ACCEPTABLE'],
    ['**VERDICT**: ACCEPTABLE', 'ACCEPTABLE'],
    ['**VERDICT:** NEEDS_FIXES', 'NEEDS_FIXES'],
    ['**VERDICT:**', 'UNKNOWN'],
    ['VERDICT: ACCEPTABLE', 'ACCEPTABLE'],
    ['VERDICT: NEEDS_FIXES', 'NEEDS_FIXES'],
    ['VERDICT: ', 'UNKNOWN'],
    ['VERDICT: ACCEPTABLE\n', 'ACCEPTABLE'],
    ['VERDICT: NEEDS_FIXES', 'NEEDS_FIXES'],
    ['VERDICT: ACCEPTABLE', 'ACCEPTABLE'],
    [
      ` **Status**: RESOLVED
**VERDICT:** ACCEPTABLE\n`,
      'ACCEPTABLE',
    ],
  ];

  for (const [input, expected] of testCases) {
    const result = parseReviewerVerdict(input) as string;
    expect(result, input).toBe(expected);
  }
});

test('CodexCliExecutor - supportsSubagents is true', async () => {
  const { CodexCliExecutor } = await import('./codex_cli.js');
  expect(CodexCliExecutor.supportsSubagents).toBe(true);
  const exec = new CodexCliExecutor({}, { baseDir: '/tmp' }, {} as any);
  expect(exec.supportsSubagents).toBe(true);
});
