import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { RepositoryState } from '../../common/git.ts';

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

describe('CodexCliExecutor implementer auto-retry', () => {
  let logMessages: string[];
  let warnMessages: string[];

  beforeEach(() => {
    logMessages = [];
    warnMessages = [];
  });

  test('retries when initial git attempt only plans and succeeds once repo changes appear', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-retry-git-'));
    const repoStates: RepositoryState[] = [
      { commitHash: 'git-sha1', hasChanges: false, statusOutput: '', diffHash: undefined },
      { commitHash: 'git-sha1', hasChanges: false, statusOutput: '', diffHash: undefined },
      {
        commitHash: 'git-sha1',
        hasChanges: true,
        statusOutput: ' M src/file.ts',
        diffHash: 'hash-1',
      },
    ];

    const captureMock = vi.fn(async () => {
      const next = repoStates.shift();
      return next ?? repoStates[repoStates.length - 1];
    });

    const logMock = vi.fn((...args: any[]) => {
      logMessages.push(args.map((a) => String(a)).join(' '));
    });
    const warnMock = vi.fn((...args: any[]) => {
      warnMessages.push(args.map((a) => String(a)).join(' '));
    });

    vi.doMock('../../logging.ts', () => ({
      log: logMock,
      warn: warnMock,
      error: vi.fn(() => {}),
      sendStructured: vi.fn(),
    }));

    vi.doMock('../../common/git.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../common/git.js')>();
      return {
        ...actual,
        getGitRoot: vi.fn(async () => tempDir),
        captureRepositoryState: captureMock,
      };
    });

    const finals = [
      'Plan: I will handle the changes in a follow-up.',
      'Implementation complete. Files updated.',
      'Tests all pass.',
      'Everything looks good.\nVERDICT: ACCEPTABLE',
    ];

    vi.doMock('./codex_cli/format.ts', () => ({
      createCodexStdoutFormatter: () => {
        let final: string | undefined;
        return {
          formatChunk: () => {
            final = finals.shift();
            return '';
          },
          getFinalAgentMessage: () => final,
          getFailedAgentMessage: () => undefined,
          getThreadId: () => undefined,
          getSessionId: () => undefined,
        };
      },
    }));

    const spawnMock = vi.fn(async (_args: string[], opts: any) => {
      if (opts && typeof opts.formatStdout === 'function') {
        opts.formatStdout('ignored');
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    vi.doMock('../../common/process.ts', () => ({
      spawnAndLogOutput: spawnMock,
    }));

    vi.doMock('../plans.ts', () => ({
      readPlanFile: vi.fn(async () => ({
        id: 1,
        title: 'Retry Plan',
        tasks: [],
      })),
    }));

    vi.doMock('./codex_cli/external_review.ts', () => ({
      loadReviewHierarchy: vi.fn(async () => ({ parentChain: [], completedChildren: [] })),
      runExternalReviewForCodex: vi.fn(async () => ({
        verdict: 'ACCEPTABLE',
        formattedOutput: 'Review ok.\n\nVERDICT: ACCEPTABLE',
        fixInstructions: 'No issues',
        reviewResult: { issues: [] },
        rawOutput: '{}',
        warnings: [],
      })),
    }));

    vi.doMock('../../../logging/tunnel_client.js', () => ({
      isTunnelActive: vi.fn(() => false),
    }));

    vi.doMock('../../../logging/tunnel_server.js', () => ({
      createTunnelServer: vi.fn(async () => ({ close: vi.fn() })),
    }));

    vi.doMock('../../../logging/tunnel_prompt_handler.js', () => ({
      createPromptRequestHandler: vi.fn(() => vi.fn()),
    }));

    vi.doMock('../../../logging/tunnel_protocol.js', () => ({
      TIM_OUTPUT_SOCKET: 'TIM_OUTPUT_SOCKET',
    }));

    const { CodexCliExecutor } = await import('./codex_cli.js');
    const executor = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    await executor.execute('Context', {
      planId: '1',
      planTitle: 'Plan',
      planFilePath: path.join(tempDir, 'plan.yml'),
      executionMode: 'normal',
      captureOutput: 'none',
    });

    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(captureMock).toHaveBeenCalledTimes(3);
    expect(
      warnMessages.some((msg) =>
        msg.includes('produced planning output without repository changes')
      )
    ).toBe(true);
    expect(
      logMessages.some((msg) =>
        msg.includes('Retrying implementer with more explicit instructions (attempt 2/4)')
      )
    ).toBe(true);
    expect(
      logMessages.some((msg) =>
        msg.includes('produced repository changes after 1 planning-only attempt')
      )
    ).toBe(true);

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('warns and continues when jj attempts exhaust retries without changes', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-retry-jj-'));
    const repoStates: RepositoryState[] = [
      { commitHash: 'jj@1', hasChanges: false, statusOutput: '', diffHash: undefined },
      { commitHash: 'jj@1', hasChanges: false, statusOutput: '', diffHash: undefined },
      { commitHash: 'jj@1', hasChanges: false, statusOutput: '', diffHash: undefined },
      { commitHash: 'jj@1', hasChanges: false, statusOutput: '', diffHash: undefined },
      { commitHash: 'jj@1', hasChanges: false, statusOutput: '', diffHash: undefined },
    ];

    const captureMock = vi.fn(async () => {
      const next = repoStates.shift();
      return next ?? repoStates[repoStates.length - 1];
    });

    const logMock = vi.fn((...args: any[]) => {
      logMessages.push(args.map((a) => String(a)).join(' '));
    });
    const warnMock = vi.fn((...args: any[]) => {
      warnMessages.push(args.map((a) => String(a)).join(' '));
    });

    vi.doMock('../../logging.ts', () => ({
      log: logMock,
      warn: warnMock,
      error: vi.fn(() => {}),
      sendStructured: vi.fn(),
    }));

    vi.doMock('../../common/git.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../common/git.js')>();
      return {
        ...actual,
        getGitRoot: vi.fn(async () => tempDir),
        captureRepositoryState: captureMock,
      };
    });

    const finals = [
      '- Plan: make edits later',
      'Plan: still outlining next steps',
      'Plan: awaiting confirmation before coding',
      'Plan: will implement changes shortly',
      'Tests skipped.',
      'Review done.\nVERDICT: ACCEPTABLE',
    ];

    vi.doMock('./codex_cli/format.ts', () => ({
      createCodexStdoutFormatter: () => {
        let final: string | undefined;
        return {
          formatChunk: () => {
            final = finals.shift();
            return '';
          },
          getFinalAgentMessage: () => final,
          getFailedAgentMessage: () => undefined,
          getThreadId: () => undefined,
          getSessionId: () => undefined,
        };
      },
    }));

    const spawnMock = vi.fn(async (_args: string[], opts: any) => {
      if (opts && typeof opts.formatStdout === 'function') {
        opts.formatStdout('ignored');
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    vi.doMock('../../common/process.ts', () => ({
      spawnAndLogOutput: spawnMock,
    }));

    vi.doMock('../plans.ts', () => ({
      readPlanFile: vi.fn(async () => ({
        id: 2,
        title: 'JJ Plan',
        tasks: [],
      })),
    }));

    vi.doMock('./codex_cli/external_review.ts', () => ({
      loadReviewHierarchy: vi.fn(async () => ({ parentChain: [], completedChildren: [] })),
      runExternalReviewForCodex: vi.fn(async () => ({
        verdict: 'ACCEPTABLE',
        formattedOutput: 'Review ok.\n\nVERDICT: ACCEPTABLE',
        fixInstructions: 'No issues',
        reviewResult: { issues: [] },
        rawOutput: '{}',
        warnings: [],
      })),
    }));

    vi.doMock('../../../logging/tunnel_client.js', () => ({
      isTunnelActive: vi.fn(() => false),
    }));

    vi.doMock('../../../logging/tunnel_server.js', () => ({
      createTunnelServer: vi.fn(async () => ({ close: vi.fn() })),
    }));

    vi.doMock('../../../logging/tunnel_prompt_handler.js', () => ({
      createPromptRequestHandler: vi.fn(() => vi.fn()),
    }));

    vi.doMock('../../../logging/tunnel_protocol.js', () => ({
      TIM_OUTPUT_SOCKET: 'TIM_OUTPUT_SOCKET',
    }));

    const { CodexCliExecutor } = await import('./codex_cli.js');
    const executor = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    await executor.execute('Context', {
      planId: '2',
      planTitle: 'Plan',
      planFilePath: path.join(tempDir, 'plan.yml'),
      executionMode: 'normal',
      captureOutput: 'none',
    });

    expect(spawnMock).toHaveBeenCalledTimes(5);
    expect(captureMock).toHaveBeenCalledTimes(5);
    const detectionWarnings = warnMessages.filter((msg) =>
      msg.includes('produced planning output without repository changes')
    );
    expect(detectionWarnings.length).toBe(4);
    expect(
      warnMessages.some((msg) =>
        msg.includes('Implementer planned without executing changes after exhausting 4 attempts')
      )
    ).toBe(true);
    expect(
      logMessages.filter((msg) =>
        msg.includes('Retrying implementer with more explicit instructions')
      ).length
    ).toBe(3);

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('warns when repository state cannot be verified and skips detection retries', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-retry-unavailable-'));
    const repoStates: RepositoryState[] = [
      { commitHash: 'git-sha3', hasChanges: false, statusCheckFailed: true },
      { commitHash: 'git-sha3', hasChanges: false, statusCheckFailed: true },
    ];

    const captureMock = vi.fn(async () => {
      const next = repoStates.shift();
      return next ?? repoStates[repoStates.length - 1];
    });

    const logMock = vi.fn((...args: any[]) => {
      logMessages.push(args.map((a) => String(a)).join(' '));
    });
    const warnMock = vi.fn((...args: any[]) => {
      warnMessages.push(args.map((a) => String(a)).join(' '));
    });

    vi.doMock('../../logging.ts', () => ({
      log: logMock,
      warn: warnMock,
      error: vi.fn(() => {}),
      sendStructured: vi.fn(),
    }));

    vi.doMock('../../common/git.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../common/git.js')>();
      return {
        ...actual,
        getGitRoot: vi.fn(async () => tempDir),
        captureRepositoryState: captureMock,
      };
    });

    const finals = [
      'Plan: gathering context before coding',
      'Tests completed.',
      'Review done.\nVERDICT: ACCEPTABLE',
    ];

    vi.doMock('./codex_cli/format.ts', () => ({
      createCodexStdoutFormatter: () => {
        let final: string | undefined;
        return {
          formatChunk: () => {
            final = finals.shift();
            return '';
          },
          getFinalAgentMessage: () => final,
          getFailedAgentMessage: () => undefined,
          getThreadId: () => undefined,
          getSessionId: () => undefined,
        };
      },
    }));

    const spawnMock = vi.fn(async (_args: string[], opts: any) => {
      if (opts && typeof opts.formatStdout === 'function') {
        opts.formatStdout('ignored');
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    vi.doMock('../../common/process.ts', () => ({
      spawnAndLogOutput: spawnMock,
    }));

    vi.doMock('../plans.ts', () => ({
      readPlanFile: vi.fn(async () => ({
        id: 4,
        title: 'Unavailable Repo State',
        tasks: [],
      })),
    }));

    vi.doMock('./codex_cli/external_review.ts', () => ({
      loadReviewHierarchy: vi.fn(async () => ({ parentChain: [], completedChildren: [] })),
      runExternalReviewForCodex: vi.fn(async () => ({
        verdict: 'ACCEPTABLE',
        formattedOutput: 'Review ok.\n\nVERDICT: ACCEPTABLE',
        fixInstructions: 'No issues',
        reviewResult: { issues: [] },
        rawOutput: '{}',
        warnings: [],
      })),
    }));

    vi.doMock('../../../logging/tunnel_client.js', () => ({
      isTunnelActive: vi.fn(() => false),
    }));

    vi.doMock('../../../logging/tunnel_server.js', () => ({
      createTunnelServer: vi.fn(async () => ({ close: vi.fn() })),
    }));

    vi.doMock('../../../logging/tunnel_prompt_handler.js', () => ({
      createPromptRequestHandler: vi.fn(() => vi.fn()),
    }));

    vi.doMock('../../../logging/tunnel_protocol.js', () => ({
      TIM_OUTPUT_SOCKET: 'TIM_OUTPUT_SOCKET',
    }));

    const { CodexCliExecutor } = await import('./codex_cli.js');
    const executor = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    await executor.execute('Context', {
      planId: '4',
      planTitle: 'Plan',
      planFilePath: path.join(tempDir, 'plan.yml'),
      executionMode: 'normal',
      captureOutput: 'none',
    });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(captureMock).toHaveBeenCalledTimes(2);
    expect(
      warnMessages.some(
        (msg) =>
          msg.includes('Could not verify repository state after implementer attempt 1/4') &&
          msg.includes('skipping planning-only detection for this attempt')
      )
    ).toBe(true);
    expect(
      warnMessages.some((msg) =>
        msg.includes('produced planning output without repository changes')
      )
    ).toBe(false);
    expect(
      logMessages.some((msg) =>
        msg.includes('Retrying implementer with more explicit instructions')
      )
    ).toBe(false);

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('does not retry when a direct commit occurs during implementer run', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-retry-direct-commit-'));
    const repoStates: RepositoryState[] = [
      { commitHash: 'git-sha10', hasChanges: false, statusOutput: '', diffHash: undefined },
      { commitHash: 'git-sha11', hasChanges: false, statusOutput: '', diffHash: undefined },
    ];

    const captureMock = vi.fn(async () => {
      const next = repoStates.shift();
      return next ?? repoStates[repoStates.length - 1];
    });

    const logMock = vi.fn((...args: any[]) => {
      logMessages.push(args.map((a) => String(a)).join(' '));
    });
    const warnMock = vi.fn((...args: any[]) => {
      warnMessages.push(args.map((a) => String(a)).join(' '));
    });

    vi.doMock('../../logging.ts', () => ({
      log: logMock,
      warn: warnMock,
      error: vi.fn(() => {}),
      sendStructured: vi.fn(),
    }));

    vi.doMock('../../common/git.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../common/git.js')>();
      return {
        ...actual,
        getGitRoot: vi.fn(async () => tempDir),
        captureRepositoryState: captureMock,
      };
    });

    const finals = [
      'Plan: I will apply these changes and have already committed them.',
      'Tests complete.',
      'Review looks good.\nVERDICT: ACCEPTABLE',
    ];

    vi.doMock('./codex_cli/format.ts', () => ({
      createCodexStdoutFormatter: () => {
        let final: string | undefined;
        return {
          formatChunk: () => {
            final = finals.shift();
            return '';
          },
          getFinalAgentMessage: () => final,
          getFailedAgentMessage: () => undefined,
          getThreadId: () => undefined,
          getSessionId: () => undefined,
        };
      },
    }));

    const spawnMock = vi.fn(async (_args: string[], opts: any) => {
      if (opts && typeof opts.formatStdout === 'function') {
        opts.formatStdout('ignored');
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    vi.doMock('../../common/process.ts', () => ({
      spawnAndLogOutput: spawnMock,
    }));

    vi.doMock('../plans.ts', () => ({
      readPlanFile: vi.fn(async () => ({
        id: 5,
        title: 'Direct Commit Plan',
        tasks: [],
      })),
    }));

    vi.doMock('./codex_cli/external_review.ts', () => ({
      loadReviewHierarchy: vi.fn(async () => ({ parentChain: [], completedChildren: [] })),
      runExternalReviewForCodex: vi.fn(async () => ({
        verdict: 'ACCEPTABLE',
        formattedOutput: 'Review ok.\n\nVERDICT: ACCEPTABLE',
        fixInstructions: 'No issues',
        reviewResult: { issues: [] },
        rawOutput: '{}',
        warnings: [],
      })),
    }));

    vi.doMock('../../../logging/tunnel_client.js', () => ({
      isTunnelActive: vi.fn(() => false),
    }));

    vi.doMock('../../../logging/tunnel_server.js', () => ({
      createTunnelServer: vi.fn(async () => ({ close: vi.fn() })),
    }));

    vi.doMock('../../../logging/tunnel_prompt_handler.js', () => ({
      createPromptRequestHandler: vi.fn(() => vi.fn()),
    }));

    vi.doMock('../../../logging/tunnel_protocol.js', () => ({
      TIM_OUTPUT_SOCKET: 'TIM_OUTPUT_SOCKET',
    }));

    const { CodexCliExecutor } = await import('./codex_cli.js');
    const executor = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    await executor.execute('Context', {
      planId: '5',
      planTitle: 'Plan',
      planFilePath: path.join(tempDir, 'plan.yml'),
      executionMode: 'normal',
      captureOutput: 'none',
    });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(captureMock).toHaveBeenCalledTimes(2);
    expect(
      warnMessages.some((msg) =>
        msg.includes('produced planning output without repository changes')
      )
    ).toBe(false);
    expect(
      logMessages.some((msg) =>
        msg.includes('Retrying implementer with more explicit instructions')
      )
    ).toBe(false);

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('treats concurrent workspace changes as real modifications', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-retry-concurrent-'));
    const repoStates: RepositoryState[] = [
      { commitHash: 'git-sha20', hasChanges: false, statusOutput: '', diffHash: undefined },
      {
        commitHash: 'git-sha20',
        hasChanges: true,
        statusOutput: '?? external.txt',
        diffHash: 'hash-external',
      },
    ];

    const captureMock = vi.fn(async () => {
      const next = repoStates.shift();
      return next ?? repoStates[repoStates.length - 1];
    });

    const logMock = vi.fn((...args: any[]) => {
      logMessages.push(args.map((a) => String(a)).join(' '));
    });
    const warnMock = vi.fn((...args: any[]) => {
      warnMessages.push(args.map((a) => String(a)).join(' '));
    });

    vi.doMock('../../logging.ts', () => ({
      log: logMock,
      warn: warnMock,
      error: vi.fn(() => {}),
      sendStructured: vi.fn(),
    }));

    vi.doMock('../../common/git.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../common/git.js')>();
      return {
        ...actual,
        getGitRoot: vi.fn(async () => tempDir),
        captureRepositoryState: captureMock,
      };
    });

    const finals = [
      'Plan: coordinate with external changes later.',
      'Tests done.',
      'Review done.\nVERDICT: ACCEPTABLE',
    ];

    vi.doMock('./codex_cli/format.ts', () => ({
      createCodexStdoutFormatter: () => {
        let final: string | undefined;
        return {
          formatChunk: () => {
            final = finals.shift();
            return '';
          },
          getFinalAgentMessage: () => final,
          getFailedAgentMessage: () => undefined,
          getThreadId: () => undefined,
          getSessionId: () => undefined,
        };
      },
    }));

    const spawnMock = vi.fn(async (_args: string[], opts: any) => {
      if (opts && typeof opts.formatStdout === 'function') {
        opts.formatStdout('ignored');
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    vi.doMock('../../common/process.ts', () => ({
      spawnAndLogOutput: spawnMock,
    }));

    vi.doMock('../plans.ts', () => ({
      readPlanFile: vi.fn(async () => ({
        id: 6,
        title: 'Concurrent Changes Plan',
        tasks: [],
      })),
    }));

    vi.doMock('./codex_cli/external_review.ts', () => ({
      loadReviewHierarchy: vi.fn(async () => ({ parentChain: [], completedChildren: [] })),
      runExternalReviewForCodex: vi.fn(async () => ({
        verdict: 'ACCEPTABLE',
        formattedOutput: 'Review ok.\n\nVERDICT: ACCEPTABLE',
        fixInstructions: 'No issues',
        reviewResult: { issues: [] },
        rawOutput: '{}',
        warnings: [],
      })),
    }));

    vi.doMock('../../../logging/tunnel_client.js', () => ({
      isTunnelActive: vi.fn(() => false),
    }));

    vi.doMock('../../../logging/tunnel_server.js', () => ({
      createTunnelServer: vi.fn(async () => ({ close: vi.fn() })),
    }));

    vi.doMock('../../../logging/tunnel_prompt_handler.js', () => ({
      createPromptRequestHandler: vi.fn(() => vi.fn()),
    }));

    vi.doMock('../../../logging/tunnel_protocol.js', () => ({
      TIM_OUTPUT_SOCKET: 'TIM_OUTPUT_SOCKET',
    }));

    const { CodexCliExecutor } = await import('./codex_cli.js');
    const executor = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    await executor.execute('Context', {
      planId: '6',
      planTitle: 'Plan',
      planFilePath: path.join(tempDir, 'plan.yml'),
      executionMode: 'normal',
      captureOutput: 'none',
    });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(captureMock).toHaveBeenCalledTimes(2);
    expect(
      warnMessages.some((msg) =>
        msg.includes('produced planning output without repository changes')
      )
    ).toBe(false);
    expect(
      logMessages.some((msg) =>
        msg.includes('Retrying implementer with more explicit instructions')
      )
    ).toBe(false);

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('does not retry when there is no planning language even if repo stays unchanged', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-retry-no-plan-'));
    const repoStates: RepositoryState[] = [
      { commitHash: 'git-sha2', hasChanges: false, statusOutput: '', diffHash: undefined },
      { commitHash: 'git-sha2', hasChanges: false, statusOutput: '', diffHash: undefined },
    ];

    const captureMock = vi.fn(async () => {
      const next = repoStates.shift();
      return next ?? repoStates[repoStates.length - 1];
    });

    const logMock = vi.fn((...args: any[]) => {
      logMessages.push(args.map((a) => String(a)).join(' '));
    });
    const warnMock = vi.fn((...args: any[]) => {
      warnMessages.push(args.map((a) => String(a)).join(' '));
    });

    vi.doMock('../../logging.ts', () => ({
      log: logMock,
      warn: warnMock,
      error: vi.fn(() => {}),
      sendStructured: vi.fn(),
    }));

    vi.doMock('../../common/git.ts', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../common/git.js')>();
      return {
        ...actual,
        getGitRoot: vi.fn(async () => tempDir),
        captureRepositoryState: captureMock,
      };
    });

    const finals = [
      'Implementation done; see diff for details.',
      'Tests? N/A.',
      'Looks acceptable.\nVERDICT: ACCEPTABLE',
    ];

    vi.doMock('./codex_cli/format.ts', () => ({
      createCodexStdoutFormatter: () => {
        let final: string | undefined;
        return {
          formatChunk: () => {
            final = finals.shift();
            return '';
          },
          getFinalAgentMessage: () => final,
          getFailedAgentMessage: () => undefined,
          getThreadId: () => undefined,
          getSessionId: () => undefined,
        };
      },
    }));

    const spawnMock = vi.fn(async (_args: string[], opts: any) => {
      if (opts && typeof opts.formatStdout === 'function') {
        opts.formatStdout('ignored');
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    vi.doMock('../../common/process.ts', () => ({
      spawnAndLogOutput: spawnMock,
    }));

    vi.doMock('../plans.ts', () => ({
      readPlanFile: vi.fn(async () => ({
        id: 3,
        title: 'No Plan Text',
        tasks: [],
      })),
    }));

    vi.doMock('./codex_cli/external_review.ts', () => ({
      loadReviewHierarchy: vi.fn(async () => ({ parentChain: [], completedChildren: [] })),
      runExternalReviewForCodex: vi.fn(async () => ({
        verdict: 'ACCEPTABLE',
        formattedOutput: 'Review ok.\n\nVERDICT: ACCEPTABLE',
        fixInstructions: 'No issues',
        reviewResult: { issues: [] },
        rawOutput: '{}',
        warnings: [],
      })),
    }));

    vi.doMock('../../../logging/tunnel_client.js', () => ({
      isTunnelActive: vi.fn(() => false),
    }));

    vi.doMock('../../../logging/tunnel_server.js', () => ({
      createTunnelServer: vi.fn(async () => ({ close: vi.fn() })),
    }));

    vi.doMock('../../../logging/tunnel_prompt_handler.js', () => ({
      createPromptRequestHandler: vi.fn(() => vi.fn()),
    }));

    vi.doMock('../../../logging/tunnel_protocol.js', () => ({
      TIM_OUTPUT_SOCKET: 'TIM_OUTPUT_SOCKET',
    }));

    const { CodexCliExecutor } = await import('./codex_cli.js');
    const executor = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    await executor.execute('Context', {
      planId: '3',
      planTitle: 'Plan',
      planFilePath: path.join(tempDir, 'plan.yml'),
      executionMode: 'normal',
      captureOutput: 'none',
    });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(captureMock).toHaveBeenCalledTimes(2);
    expect(warnMessages.some((msg) => msg.includes('produced planning output'))).toBe(false);
    expect(
      logMessages.some((msg) =>
        msg.includes('Retrying implementer with more explicit instructions')
      )
    ).toBe(false);

    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
