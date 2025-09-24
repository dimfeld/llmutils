import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import type { RepositoryState } from '../../common/git.ts';
import { ModuleMocker } from '../../testing.js';

describe('CodexCliExecutor implementer auto-retry', () => {
  let moduleMocker: ModuleMocker;
  let logMessages: string[];
  let warnMessages: string[];

  beforeEach(() => {
    moduleMocker = new ModuleMocker(import.meta);
    logMessages = [];
    warnMessages = [];
  });

  afterEach(() => {
    moduleMocker.clear();
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

    const captureMock = mock(async () => {
      const next = repoStates.shift();
      return next ?? repoStates[repoStates.length - 1];
    });

    const logMock = mock((...args: any[]) => {
      logMessages.push(args.map((a) => String(a)).join(' '));
    });
    const warnMock = mock((...args: any[]) => {
      warnMessages.push(args.map((a) => String(a)).join(' '));
    });

    await moduleMocker.mock('../../logging.ts', () => ({
      log: logMock,
      warn: warnMock,
      error: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
      captureRepositoryState: captureMock,
    }));

    const finals = [
      'Plan: I will handle the changes in a follow-up.',
      'Implementation complete. Files updated.',
      'Tests all pass.',
      'Everything looks good.\nVERDICT: ACCEPTABLE',
    ];

    await moduleMocker.mock('./codex_cli/format.ts', () => ({
      createCodexStdoutFormatter: () => {
        let final: string | undefined;
        return {
          formatChunk: () => {
            final = finals.shift();
            return '';
          },
          getFinalAgentMessage: () => final,
          getFailedAgentMessage: () => undefined,
        };
      },
    }));

    const spawnMock = mock(async (_args: string[], opts: any) => {
      if (opts && typeof opts.formatStdout === 'function') {
        opts.formatStdout('ignored');
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: spawnMock,
    }));

    await moduleMocker.mock('../plans.ts', () => ({
      readPlanFile: mock(async () => ({
        id: 1,
        title: 'Retry Plan',
        tasks: [],
      })),
    }));

    const { CodexCliExecutor } = await import('./codex_cli.ts');
    const executor = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    await executor.execute('Context', {
      planId: '1',
      planTitle: 'Plan',
      planFilePath: path.join(tempDir, 'plan.yml'),
      executionMode: 'normal',
      captureOutput: 'none',
    });

    expect(spawnMock).toHaveBeenCalledTimes(4);
    expect(captureMock).toHaveBeenCalledTimes(3);
    expect(
      warnMessages.some((msg) =>
        msg.includes('produced planning output without repository changes')
      )
    ).toBeTrue();
    expect(
      logMessages.some((msg) =>
        msg.includes('Retrying implementer with more explicit instructions (attempt 2/4)')
      )
    ).toBeTrue();
    expect(
      logMessages.some((msg) =>
        msg.includes('produced repository changes after 1 planning-only attempt')
      )
    ).toBeTrue();

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

    const captureMock = mock(async () => {
      const next = repoStates.shift();
      return next ?? repoStates[repoStates.length - 1];
    });

    const logMock = mock((...args: any[]) => {
      logMessages.push(args.map((a) => String(a)).join(' '));
    });
    const warnMock = mock((...args: any[]) => {
      warnMessages.push(args.map((a) => String(a)).join(' '));
    });

    await moduleMocker.mock('../../logging.ts', () => ({
      log: logMock,
      warn: warnMock,
      error: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
      captureRepositoryState: captureMock,
    }));

    const finals = [
      '- Plan: make edits later',
      'Plan: still outlining next steps',
      'Plan: awaiting confirmation before coding',
      'Plan: will implement changes shortly',
      'Tests skipped.',
      'Review done.\nVERDICT: ACCEPTABLE',
    ];

    await moduleMocker.mock('./codex_cli/format.ts', () => ({
      createCodexStdoutFormatter: () => {
        let final: string | undefined;
        return {
          formatChunk: () => {
            final = finals.shift();
            return '';
          },
          getFinalAgentMessage: () => final,
          getFailedAgentMessage: () => undefined,
        };
      },
    }));

    const spawnMock = mock(async (_args: string[], opts: any) => {
      if (opts && typeof opts.formatStdout === 'function') {
        opts.formatStdout('ignored');
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: spawnMock,
    }));

    await moduleMocker.mock('../plans.ts', () => ({
      readPlanFile: mock(async () => ({
        id: 2,
        title: 'JJ Plan',
        tasks: [],
      })),
    }));

    const { CodexCliExecutor } = await import('./codex_cli.ts');
    const executor = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    await executor.execute('Context', {
      planId: '2',
      planTitle: 'Plan',
      planFilePath: path.join(tempDir, 'plan.yml'),
      executionMode: 'normal',
      captureOutput: 'none',
    });

    expect(spawnMock).toHaveBeenCalledTimes(6);
    expect(captureMock).toHaveBeenCalledTimes(5);
    const detectionWarnings = warnMessages.filter((msg) =>
      msg.includes('produced planning output without repository changes')
    );
    expect(detectionWarnings.length).toBe(4);
    expect(
      warnMessages.some((msg) =>
        msg.includes('Implementer planned without executing changes after exhausting 4 attempts')
      )
    ).toBeTrue();
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

    const captureMock = mock(async () => {
      const next = repoStates.shift();
      return next ?? repoStates[repoStates.length - 1];
    });

    const logMock = mock((...args: any[]) => {
      logMessages.push(args.map((a) => String(a)).join(' '));
    });
    const warnMock = mock((...args: any[]) => {
      warnMessages.push(args.map((a) => String(a)).join(' '));
    });

    await moduleMocker.mock('../../logging.ts', () => ({
      log: logMock,
      warn: warnMock,
      error: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
      captureRepositoryState: captureMock,
    }));

    const finals = [
      'Plan: gathering context before coding',
      'Tests completed.',
      'Review done.\nVERDICT: ACCEPTABLE',
    ];

    await moduleMocker.mock('./codex_cli/format.ts', () => ({
      createCodexStdoutFormatter: () => {
        let final: string | undefined;
        return {
          formatChunk: () => {
            final = finals.shift();
            return '';
          },
          getFinalAgentMessage: () => final,
          getFailedAgentMessage: () => undefined,
        };
      },
    }));

    const spawnMock = mock(async (_args: string[], opts: any) => {
      if (opts && typeof opts.formatStdout === 'function') {
        opts.formatStdout('ignored');
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: spawnMock,
    }));

    await moduleMocker.mock('../plans.ts', () => ({
      readPlanFile: mock(async () => ({
        id: 4,
        title: 'Unavailable Repo State',
        tasks: [],
      })),
    }));

    const { CodexCliExecutor } = await import('./codex_cli.ts');
    const executor = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    await executor.execute('Context', {
      planId: '4',
      planTitle: 'Plan',
      planFilePath: path.join(tempDir, 'plan.yml'),
      executionMode: 'normal',
      captureOutput: 'none',
    });

    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(captureMock).toHaveBeenCalledTimes(2);
    expect(
      warnMessages.some(
        (msg) =>
          msg.includes('Could not verify repository state after implementer attempt 1/4') &&
          msg.includes('skipping planning-only detection for this attempt')
      )
    ).toBeTrue();
    expect(
      warnMessages.some((msg) =>
        msg.includes('produced planning output without repository changes')
      )
    ).toBeFalse();
    expect(
      logMessages.some((msg) =>
        msg.includes('Retrying implementer with more explicit instructions')
      )
    ).toBeFalse();

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('does not retry when a direct commit occurs during implementer run', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-retry-direct-commit-'));
    const repoStates: RepositoryState[] = [
      { commitHash: 'git-sha10', hasChanges: false, statusOutput: '', diffHash: undefined },
      { commitHash: 'git-sha11', hasChanges: false, statusOutput: '', diffHash: undefined },
    ];

    const captureMock = mock(async () => {
      const next = repoStates.shift();
      return next ?? repoStates[repoStates.length - 1];
    });

    const logMock = mock((...args: any[]) => {
      logMessages.push(args.map((a) => String(a)).join(' '));
    });
    const warnMock = mock((...args: any[]) => {
      warnMessages.push(args.map((a) => String(a)).join(' '));
    });

    await moduleMocker.mock('../../logging.ts', () => ({
      log: logMock,
      warn: warnMock,
      error: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
      captureRepositoryState: captureMock,
    }));

    const finals = [
      'Plan: I will apply these changes and have already committed them.',
      'Tests complete.',
      'Review looks good.\nVERDICT: ACCEPTABLE',
    ];

    await moduleMocker.mock('./codex_cli/format.ts', () => ({
      createCodexStdoutFormatter: () => {
        let final: string | undefined;
        return {
          formatChunk: () => {
            final = finals.shift();
            return '';
          },
          getFinalAgentMessage: () => final,
          getFailedAgentMessage: () => undefined,
        };
      },
    }));

    const spawnMock = mock(async (_args: string[], opts: any) => {
      if (opts && typeof opts.formatStdout === 'function') {
        opts.formatStdout('ignored');
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: spawnMock,
    }));

    await moduleMocker.mock('../plans.ts', () => ({
      readPlanFile: mock(async () => ({
        id: 5,
        title: 'Direct Commit Plan',
        tasks: [],
      })),
    }));

    const { CodexCliExecutor } = await import('./codex_cli.ts');
    const executor = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    await executor.execute('Context', {
      planId: '5',
      planTitle: 'Plan',
      planFilePath: path.join(tempDir, 'plan.yml'),
      executionMode: 'normal',
      captureOutput: 'none',
    });

    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(captureMock).toHaveBeenCalledTimes(2);
    expect(
      warnMessages.some((msg) =>
        msg.includes('produced planning output without repository changes')
      )
    ).toBeFalse();
    expect(
      logMessages.some((msg) =>
        msg.includes('Retrying implementer with more explicit instructions')
      )
    ).toBeFalse();

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

    const captureMock = mock(async () => {
      const next = repoStates.shift();
      return next ?? repoStates[repoStates.length - 1];
    });

    const logMock = mock((...args: any[]) => {
      logMessages.push(args.map((a) => String(a)).join(' '));
    });
    const warnMock = mock((...args: any[]) => {
      warnMessages.push(args.map((a) => String(a)).join(' '));
    });

    await moduleMocker.mock('../../logging.ts', () => ({
      log: logMock,
      warn: warnMock,
      error: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
      captureRepositoryState: captureMock,
    }));

    const finals = [
      'Plan: coordinate with external changes later.',
      'Tests done.',
      'Review done.\nVERDICT: ACCEPTABLE',
    ];

    await moduleMocker.mock('./codex_cli/format.ts', () => ({
      createCodexStdoutFormatter: () => {
        let final: string | undefined;
        return {
          formatChunk: () => {
            final = finals.shift();
            return '';
          },
          getFinalAgentMessage: () => final,
          getFailedAgentMessage: () => undefined,
        };
      },
    }));

    const spawnMock = mock(async (_args: string[], opts: any) => {
      if (opts && typeof opts.formatStdout === 'function') {
        opts.formatStdout('ignored');
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: spawnMock,
    }));

    await moduleMocker.mock('../plans.ts', () => ({
      readPlanFile: mock(async () => ({
        id: 6,
        title: 'Concurrent Changes Plan',
        tasks: [],
      })),
    }));

    const { CodexCliExecutor } = await import('./codex_cli.ts');
    const executor = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    await executor.execute('Context', {
      planId: '6',
      planTitle: 'Plan',
      planFilePath: path.join(tempDir, 'plan.yml'),
      executionMode: 'normal',
      captureOutput: 'none',
    });

    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(captureMock).toHaveBeenCalledTimes(2);
    expect(
      warnMessages.some((msg) =>
        msg.includes('produced planning output without repository changes')
      )
    ).toBeFalse();
    expect(
      logMessages.some((msg) =>
        msg.includes('Retrying implementer with more explicit instructions')
      )
    ).toBeFalse();

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('does not retry when there is no planning language even if repo stays unchanged', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-retry-no-plan-'));
    const repoStates: RepositoryState[] = [
      { commitHash: 'git-sha2', hasChanges: false, statusOutput: '', diffHash: undefined },
      { commitHash: 'git-sha2', hasChanges: false, statusOutput: '', diffHash: undefined },
    ];

    const captureMock = mock(async () => {
      const next = repoStates.shift();
      return next ?? repoStates[repoStates.length - 1];
    });

    const logMock = mock((...args: any[]) => {
      logMessages.push(args.map((a) => String(a)).join(' '));
    });
    const warnMock = mock((...args: any[]) => {
      warnMessages.push(args.map((a) => String(a)).join(' '));
    });

    await moduleMocker.mock('../../logging.ts', () => ({
      log: logMock,
      warn: warnMock,
      error: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/git.ts', () => ({
      getGitRoot: mock(async () => tempDir),
      captureRepositoryState: captureMock,
    }));

    const finals = [
      'Implementation done; see diff for details.',
      'Tests? N/A.',
      'Looks acceptable.\nVERDICT: ACCEPTABLE',
    ];

    await moduleMocker.mock('./codex_cli/format.ts', () => ({
      createCodexStdoutFormatter: () => {
        let final: string | undefined;
        return {
          formatChunk: () => {
            final = finals.shift();
            return '';
          },
          getFinalAgentMessage: () => final,
          getFailedAgentMessage: () => undefined,
        };
      },
    }));

    const spawnMock = mock(async (_args: string[], opts: any) => {
      if (opts && typeof opts.formatStdout === 'function') {
        opts.formatStdout('ignored');
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });

    await moduleMocker.mock('../../common/process.ts', () => ({
      spawnAndLogOutput: spawnMock,
    }));

    await moduleMocker.mock('../plans.ts', () => ({
      readPlanFile: mock(async () => ({
        id: 3,
        title: 'No Plan Text',
        tasks: [],
      })),
    }));

    const { CodexCliExecutor } = await import('./codex_cli.ts');
    const executor = new CodexCliExecutor({}, { baseDir: tempDir }, {} as any);

    await executor.execute('Context', {
      planId: '3',
      planTitle: 'Plan',
      planFilePath: path.join(tempDir, 'plan.yml'),
      executionMode: 'normal',
      captureOutput: 'none',
    });

    expect(spawnMock).toHaveBeenCalledTimes(3);
    expect(captureMock).toHaveBeenCalledTimes(2);
    expect(warnMessages.some((msg) => msg.includes('produced planning output'))).toBeFalse();
    expect(
      logMessages.some((msg) =>
        msg.includes('Retrying implementer with more explicit instructions')
      )
    ).toBeFalse();

    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
