import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

describe('CodexCliExecutor captureOutput', () => {
  const tempDir = '/tmp/codex-capture-output-test';

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function setupMocks(executeCodexStepFn: (prompt: string) => Promise<string>) {
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

    vi.doMock('./codex_cli/codex_runner.ts', () => ({
      executeCodexStep: vi.fn(executeCodexStepFn),
    }));

    const { CodexCliExecutor } = await import('./codex_cli.js');
    return CodexCliExecutor;
  }

  test('captureOutput result: returns single orchestrator output with phase metadata', async () => {
    const CodexCliExecutor = await setupMocks(async () => 'Orchestrator completed all tasks');

    const exec = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    const res = await exec.execute('CTX', {
      planId: '200',
      planTitle: 'capture run',
      planFilePath: '/tmp/repo/tasks/200.plan.md',
      executionMode: 'normal',
      captureOutput: 'result',
    });

    expect(res).toBeDefined();
    expect(res).toMatchObject({
      content: 'Orchestrator completed all tasks',
      metadata: { phase: 'orchestrator' },
    });
    expect((res as any).success).toBeUndefined();
  }, 20000);

  test('captureOutput all: returns single orchestrator output with phase metadata', async () => {
    const CodexCliExecutor = await setupMocks(async () => 'All tasks done by orchestrator');

    const exec = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    const res = await exec.execute('CTX', {
      planId: '201',
      planTitle: 'capture all run',
      planFilePath: '/tmp/repo/tasks/201.plan.md',
      executionMode: 'normal',
      captureOutput: 'all',
    });

    expect(res).toBeDefined();
    expect(res).toMatchObject({
      content: 'All tasks done by orchestrator',
      metadata: { phase: 'orchestrator' },
    });
  }, 20000);

  test('captureOutput none: returns undefined on success', async () => {
    const CodexCliExecutor = await setupMocks(async () => 'Success with no capture');

    const exec = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    const res = await exec.execute('CTX', {
      planId: '202',
      planTitle: 'no capture run',
      planFilePath: '/tmp/repo/tasks/202.plan.md',
      executionMode: 'normal',
      captureOutput: 'none',
    });

    expect(res).toBeUndefined();
  }, 20000);

  test('FAILED output: returns success=false with failureDetails regardless of captureOutput', async () => {
    const CodexCliExecutor = await setupMocks(
      async () =>
        'Starting work...\nFAILED: implementer reported a failure — conflicting requirements\nRequirements:\n- add feature X\nProblems:\n- contradicts existing constraint Y\nPossible solutions:\n- remove constraint Y'
    );

    const exec = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    const res = (await exec.execute('CTX', {
      planId: '203',
      planTitle: 'failure run',
      planFilePath: '/tmp/repo/tasks/203.plan.md',
      executionMode: 'normal',
      captureOutput: 'none',
    })) as any;

    expect(res).toBeDefined();
    expect(res.success).toBe(false);
    expect(res.metadata).toEqual({ phase: 'orchestrator' });
    expect(res.failureDetails).toBeDefined();
    expect(res.failureDetails.sourceAgent).toBe('implementer');
    expect(res.content).toContain('FAILED:');
  }, 20000);

  test('FAILED output with captureOutput result: still returns failure structure', async () => {
    const CodexCliExecutor = await setupMocks(
      async () =>
        'FAILED: tester reported a failure — tests broken\nRequirements:\n- all tests pass\nProblems:\n- 5 tests failing'
    );

    const exec = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    const res = (await exec.execute('CTX', {
      planId: '204',
      planTitle: 'failure with capture',
      planFilePath: '/tmp/repo/tasks/204.plan.md',
      executionMode: 'normal',
      captureOutput: 'result',
    })) as any;

    expect(res.success).toBe(false);
    expect(res.failureDetails?.sourceAgent).toBe('tester');
    expect(res.metadata).toEqual({ phase: 'orchestrator' });
  }, 20000);
});
