import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const workspaceAutoSelectorMocks = vi.hoisted(() => ({
  ctor: vi.fn(),
  selectWorkspace: vi.fn(),
}));

const lifecycleManagerMocks = vi.hoisted(() => ({
  ctor: vi.fn(),
  instances: [] as Array<{
    startup: ReturnType<typeof vi.fn>;
    shutdown: ReturnType<typeof vi.fn>;
    killDaemons: ReturnType<typeof vi.fn>;
  }>,
}));

const shutdownStateMocks = vi.hoisted(() => ({
  isShuttingDown: vi.fn(() => false),
  getSignalExitCode: vi.fn(() => 143),
  setDeferSignalExit: vi.fn(() => {}),
}));

vi.mock('../../logging.js', () => ({
  log: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../logging/tunnel_client.js', () => ({
  isTunnelActive: vi.fn(() => false),
}));

vi.mock('../../common/git.js', () => ({
  getGitInfoExcludePath: vi.fn(),
  getGitRoot: vi.fn(),
  getUsingJj: vi.fn(),
  isIgnoredByGitSharedExcludes: vi.fn(),
}));

vi.mock('../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(),
}));

vi.mock('../db/database.js', () => ({
  getDatabase: vi.fn(),
}));

vi.mock('../db/review.js', () => ({
  createReview: vi.fn(),
  getLatestReviewByPrUrl: vi.fn(),
  getReviewIssues: vi.fn(),
  insertReviewIssues: vi.fn(),
  updateReview: vi.fn(),
}));

vi.mock('../db/project.js', () => ({
  getOrCreateProject: vi.fn(),
}));

vi.mock('../executors/index.js', () => ({
  buildExecutorAndLog: vi.fn(),
}));

vi.mock('../headless.js', () => ({
  runWithHeadlessAdapterIfEnabled: vi.fn(async ({ callback }: { callback: () => Promise<void> }) =>
    callback()
  ),
  updateHeadlessSessionInfo: vi.fn(),
}));

vi.mock('../review_runner.js', async () => {
  const actual = await vi.importActual<typeof import('../review_runner.js')>('../review_runner.js');
  return {
    ...actual,
    resolveReviewExecutorSelection: vi.fn((selection: string | undefined) => selection ?? 'both'),
  };
});

vi.mock('../utils/pr_context_gathering.js', () => ({
  gatherPrContext: vi.fn(),
  checkoutPrBranch: vi.fn(),
  resolvePrUrl: vi.fn(),
}));

vi.mock('../assignments/workspace_identifier.js', () => ({
  getRepositoryIdentity: vi.fn(),
}));

vi.mock('../workspace/workspace_info.js', () => ({
  getWorkspaceInfoByPath: vi.fn(() => null),
}));

vi.mock('../workspace/workspace_auto_selector.js', () => ({
  WorkspaceAutoSelector: class {
    constructor(...args: unknown[]) {
      workspaceAutoSelectorMocks.ctor(...args);
    }

    selectWorkspace = workspaceAutoSelectorMocks.selectWorkspace;
  },
}));

vi.mock('../workspace/workspace_lock.js', () => ({
  WorkspaceLock: {
    acquireLock: vi.fn(),
    setupCleanupHandlers: vi.fn(),
  },
}));

vi.mock('../shutdown_state.js', () => shutdownStateMocks);

vi.mock('../lifecycle.js', () => ({
  LifecycleManager: class {
    startup = vi.fn(async () => {});
    shutdown = vi.fn(async () => {});
    killDaemons = vi.fn(() => {});

    constructor(...args: unknown[]) {
      lifecycleManagerMocks.ctor(...args);
      lifecycleManagerMocks.instances.push(this);
    }
  },
}));

import {
  getGitInfoExcludePath,
  getGitRoot,
  getUsingJj,
  isIgnoredByGitSharedExcludes,
} from '../../common/git.js';
import { warn } from '../../logging.js';
import { isTunnelActive } from '../../logging/tunnel_client.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { getDatabase } from '../db/database.js';
import {
  createReview,
  getLatestReviewByPrUrl,
  getReviewIssues,
  insertReviewIssues,
  updateReview,
} from '../db/review.js';
import { getOrCreateProject } from '../db/project.js';
import { buildExecutorAndLog } from '../executors/index.js';
import { gatherPrContext, checkoutPrBranch, resolvePrUrl } from '../utils/pr_context_gathering.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { LifecycleManager } from '../lifecycle.js';
import { getSignalExitCode, isShuttingDown, setDeferSignalExit } from '../shutdown_state.js';
import { WorkspaceLock } from '../workspace/workspace_lock.js';
import { handleMaterializeCommand, handleReviewGuideCommand, parseLineRange } from './review_pr.js';

const mockGetGitInfoExcludePath = vi.mocked(getGitInfoExcludePath);
const mockGetGitRoot = vi.mocked(getGitRoot);
const mockGetUsingJj = vi.mocked(getUsingJj);
const mockIsIgnoredByGitSharedExcludes = vi.mocked(isIgnoredByGitSharedExcludes);
const mockLoadEffectiveConfig = vi.mocked(loadEffectiveConfig);
const mockIsTunnelActive = vi.mocked(isTunnelActive);
const mockGetDatabase = vi.mocked(getDatabase);
const mockCreateReview = vi.mocked(createReview);
const mockGetLatestReviewByPrUrl = vi.mocked(getLatestReviewByPrUrl);
const mockGetReviewIssues = vi.mocked(getReviewIssues);
const mockInsertReviewIssues = vi.mocked(insertReviewIssues);
const mockUpdateReview = vi.mocked(updateReview);
const mockGetOrCreateProject = vi.mocked(getOrCreateProject);
const mockBuildExecutorAndLog = vi.mocked(buildExecutorAndLog);
const mockGatherPrContext = vi.mocked(gatherPrContext);
const mockCheckoutPrBranch = vi.mocked(checkoutPrBranch);
const mockResolvePrUrl = vi.mocked(resolvePrUrl);
const mockGetRepositoryIdentity = vi.mocked(getRepositoryIdentity);
const mockWorkspaceLockAcquireLock = vi.mocked(WorkspaceLock.acquireLock);
const mockWorkspaceLockSetupCleanupHandlers = vi.mocked(WorkspaceLock.setupCleanupHandlers);
const mockWarn = vi.mocked(warn);
const mockIsShuttingDown = vi.mocked(isShuttingDown);
const mockGetSignalExitCode = vi.mocked(getSignalExitCode);
const mockSetDeferSignalExit = vi.mocked(setDeferSignalExit);

function makeCommand(config?: string) {
  return {
    parent: {
      opts: () => ({ config }),
    },
  } as any;
}

function installExecutorMock(options: {
  claudeExecute?: ReturnType<typeof vi.fn>;
  codexExecute?: ReturnType<typeof vi.fn>;
  combineExecute?: ReturnType<typeof vi.fn>;
}) {
  mockBuildExecutorAndLog.mockImplementation((name, sharedOptions) => {
    if (name === 'claude-code' && (sharedOptions as any)?.model === 'haiku') {
      if (!options.combineExecute) {
        throw new Error('Unexpected Claude combination executor request');
      }
      return { execute: options.combineExecute } as any;
    }

    if (name === 'claude-code') {
      if (!options.claudeExecute) {
        throw new Error('Unexpected Claude executor request');
      }
      return { execute: options.claudeExecute } as any;
    }

    if (name === 'codex-cli') {
      if (!options.codexExecute) {
        throw new Error('Unexpected Codex executor request');
      }
      return { execute: options.codexExecute } as any;
    }

    throw new Error(`Unexpected executor ${name}`);
  });
}

describe('parseLineRange', () => {
  test('splits hyphen range into startLine and line', () => {
    expect(parseLineRange('10-20')).toEqual({ startLine: '10', line: '20' });
  });

  test('splits en-dash range into startLine and line', () => {
    expect(parseLineRange('10\u201320')).toEqual({ startLine: '10', line: '20' });
  });

  test('returns null startLine for plain number', () => {
    expect(parseLineRange('42')).toEqual({ startLine: null, line: '42' });
  });

  test('returns null startLine for number input', () => {
    expect(parseLineRange(100)).toEqual({ startLine: null, line: '100' });
  });

  test('returns nulls for null input', () => {
    expect(parseLineRange(null)).toEqual({ startLine: null, line: null });
  });

  test('returns nulls for undefined input', () => {
    expect(parseLineRange(undefined)).toEqual({ startLine: null, line: null });
  });

  test('returns null startLine for non-range string', () => {
    expect(parseLineRange('L100')).toEqual({ startLine: null, line: 'L100' });
  });

  test('returns null startLine for multi-hyphen string', () => {
    expect(parseLineRange('10-20-30')).toEqual({ startLine: null, line: '10-20-30' });
  });

  test('returns null startLine for empty string', () => {
    expect(parseLineRange('')).toEqual({ startLine: null, line: '' });
  });
});

describe('review_pr command', () => {
  let tempDir: string;
  let guidePath: string;
  let issuesPath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    lifecycleManagerMocks.instances.length = 0;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-review-pr-test-'));
    // Review ID is 501 from the mock, so temp dir is review-501
    guidePath = path.join(tempDir, '.tim', 'tmp', 'review-501', 'review-guide.md');
    issuesPath = path.join(tempDir, '.tim', 'tmp', 'review-501', 'review-issues.json');

    mockGetDatabase.mockReturnValue({} as any);
    mockGetGitRoot.mockResolvedValue(tempDir);
    mockGetUsingJj.mockResolvedValue(false);
    mockGetRepositoryIdentity.mockResolvedValue({
      repositoryId: 'github.com__acme__repo',
      remoteUrl: 'https://github.com/acme/repo.git',
      gitRoot: tempDir,
    });
    mockGetOrCreateProject.mockReturnValue({ id: 7 } as any);
    mockLoadEffectiveConfig.mockResolvedValue({
      terminalInput: true,
      review: {},
      executors: {},
    } as any);
    mockIsTunnelActive.mockReturnValue(false);
    mockGatherPrContext.mockResolvedValue({
      prStatus: {
        id: 99,
        title: 'PR title',
        author: 'alice',
        changed_files: 3,
      },
      baseBranch: 'main',
      headBranch: 'feature/pr',
      headSha: 'sha123',
      owner: 'acme',
      repo: 'repo',
      prNumber: 42,
      prUrl: 'https://github.com/acme/repo/pull/42',
    } as any);
    mockCreateReview.mockReturnValue({ id: 501 } as any);
    mockResolvePrUrl.mockResolvedValue('https://github.com/acme/repo/pull/42');
    mockWorkspaceLockAcquireLock.mockResolvedValue({ type: 'pid' } as any);
    workspaceAutoSelectorMocks.ctor.mockReset();
    workspaceAutoSelectorMocks.selectWorkspace.mockReset();
    workspaceAutoSelectorMocks.selectWorkspace.mockResolvedValue({
      workspace: {
        workspacePath: tempDir,
      },
      isNew: false,
      clearedStaleLock: false,
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('runs both executors and combines issues when both succeed', async () => {
    const claudeExecute = vi.fn().mockImplementation(async (prompt: string) => {
      if (prompt.includes('must produce a complete review guide')) {
        await fs.mkdir(path.dirname(guidePath), { recursive: true });
        await fs.writeFile(guidePath, '# Guide\n\nBody', 'utf8');
        return { content: 'ok' };
      }

      if (prompt.includes('standalone PR code review and must return structured JSON issues only')) {
        return {
          content: JSON.stringify({
            issues: [
              {
                severity: 'major',
                category: 'bug',
                content: 'Claude issue',
                file: 'src/a.ts',
                line: '10',
                suggestion: 'Fix A',
              },
            ],
            recommendations: [],
            actionItems: [],
          }),
        };
      }

      throw new Error(`Unexpected Claude prompt: ${prompt}`);
    });

    const codexExecute = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        issues: [
          {
            severity: 'minor',
            category: 'style',
            content: 'Codex issue',
            file: 'src/b.ts',
            line: '20',
            suggestion: 'Fix B',
          },
        ],
        recommendations: [],
        actionItems: [],
      }),
    });

    const combineExecute = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        issues: [
          {
            severity: 'major',
            category: 'bug',
            content: 'Merged issue',
            file: 'src/a.ts',
            line: '10',
            suggestion: 'Fix merged',
            source: 'combined',
          },
        ],
        recommendations: [],
        actionItems: [],
      }),
    });

    installExecutorMock({ claudeExecute, codexExecute, combineExecute });

    await handleReviewGuideCommand('42', { terminalInput: false }, makeCommand());

    expect(claudeExecute).toHaveBeenCalledTimes(2);
    const guideCall = claudeExecute.mock.calls.find(([prompt]) =>
      String(prompt).includes('must produce a complete review guide')
    );
    const issuesCall = claudeExecute.mock.calls.find(([prompt]) =>
      String(prompt).includes('standalone PR code review and must return structured JSON issues only')
    );
    expect(guideCall?.[1]).toEqual(expect.objectContaining({ executionMode: 'bare' }));
    expect(issuesCall?.[1]).toEqual(expect.objectContaining({ executionMode: 'review' }));
    expect(issuesCall?.[0]).toBe(codexExecute.mock.calls[0]?.[0]);

    expect(mockCheckoutPrBranch).toHaveBeenCalled();
    expect(mockInsertReviewIssues).toHaveBeenCalledTimes(1);
    const inserted = mockInsertReviewIssues.mock.calls[0]?.[1];
    expect(inserted?.issues).toHaveLength(1);
    expect(inserted?.issues?.[0]?.content).toBe('Merged issue');
    expect(inserted?.issues?.[0]?.source).toBe('combined');

    expect(mockUpdateReview).toHaveBeenCalledWith(
      expect.anything(),
      501,
      expect.objectContaining({ status: 'complete', reviewedSha: 'sha123' })
    );

    await expect(fs.stat(guidePath)).rejects.toThrow();
    await expect(fs.stat(issuesPath)).rejects.toThrow();
  });

  test('forces noninteractive executors when running both executors concurrently', async () => {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });

    const claudeExecute = vi.fn().mockImplementation(async (prompt: string) => {
      if (prompt.includes('must produce a complete review guide')) {
        await fs.mkdir(path.dirname(guidePath), { recursive: true });
        await fs.writeFile(guidePath, '# Guide\n\nBody', 'utf8');
        return { content: 'ok' };
      }

      if (prompt.includes('standalone PR code review and must return structured JSON issues only')) {
        return {
          content: JSON.stringify({ issues: [], recommendations: [], actionItems: [] }),
        };
      }

      throw new Error(`Unexpected Claude prompt: ${prompt}`);
    });
    const codexExecute = vi.fn().mockResolvedValue({
      content: JSON.stringify({ issues: [], recommendations: [], actionItems: [] }),
    });
    const combineExecute = vi.fn().mockResolvedValue({
      content: JSON.stringify({ issues: [], recommendations: [], actionItems: [] }),
    });

    installExecutorMock({ claudeExecute, codexExecute, combineExecute });

    try {
      await handleReviewGuideCommand(
        '42',
        { terminalInput: true, nonInteractive: false },
        makeCommand()
      );

      const claudeBuildArgs = mockBuildExecutorAndLog.mock.calls.find(
        (call) => call[0] === 'claude-code'
      )?.[1];
      const codexBuildArgs = mockBuildExecutorAndLog.mock.calls.find(
        (call) => call[0] === 'codex-cli'
      )?.[1];

      expect(claudeBuildArgs).toEqual(
        expect.objectContaining({ noninteractive: true, terminalInput: false })
      );
      expect(codexBuildArgs).toEqual(
        expect.objectContaining({ noninteractive: true, terminalInput: false })
      );
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: originalIsTTY,
        configurable: true,
      });
    }
  });

  test('single executor stays interactive via headless input when no TTY is available', async () => {
    const codexExecute = vi.fn().mockResolvedValue({
      content: JSON.stringify({ issues: [], recommendations: [], actionItems: [] }),
    });
    mockBuildExecutorAndLog.mockReturnValue({ execute: codexExecute } as any);
    const runWithHeadlessAdapterIfEnabledMock = vi.mocked(
      (await import('../headless.js')).runWithHeadlessAdapterIfEnabled
    );

    await handleReviewGuideCommand(
      '42',
      { executor: 'codex-cli', terminalInput: true, nonInteractive: false },
      makeCommand()
    );

    const codexBuildArgs = mockBuildExecutorAndLog.mock.calls.find(
      (call) => call[0] === 'codex-cli'
    )?.[1];
    expect(codexBuildArgs).toEqual(
      expect.objectContaining({ noninteractive: false, terminalInput: false })
    );
    expect(runWithHeadlessAdapterIfEnabledMock).toHaveBeenCalledWith(
      expect.objectContaining({ interactive: true })
    );
  });

  test('defers SIGTERM until review-guide cleanup completes', async () => {
    mockIsShuttingDown.mockReturnValue(true);
    mockGetSignalExitCode.mockReturnValue(143);

    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;

    try {
      const codexExecute = vi.fn().mockResolvedValue({
        content: JSON.stringify({ issues: [], recommendations: [], actionItems: [] }),
      });
      mockBuildExecutorAndLog.mockReturnValue({ execute: codexExecute } as any);

      await expect(
        handleReviewGuideCommand(
          '42',
          { executor: 'codex-cli', terminalInput: false },
          makeCommand()
        )
      ).rejects.toThrow('process.exit(143)');

      expect(mockSetDeferSignalExit).toHaveBeenNthCalledWith(1, true);
      expect(mockSetDeferSignalExit).toHaveBeenLastCalledWith(false);
      expect(mockGetSignalExitCode).toHaveBeenCalled();
    } finally {
      process.exit = originalExit;
      mockIsShuttingDown.mockReturnValue(false);
    }
  });

  test('single executor stays interactive when tunnel input is available without TTY', async () => {
    mockIsTunnelActive.mockReturnValue(true);
    const codexExecute = vi.fn().mockResolvedValue({
      content: JSON.stringify({ issues: [], recommendations: [], actionItems: [] }),
    });
    mockBuildExecutorAndLog.mockReturnValue({ execute: codexExecute } as any);
    const runWithHeadlessAdapterIfEnabledMock = vi.mocked(
      (await import('../headless.js')).runWithHeadlessAdapterIfEnabled
    );

    await handleReviewGuideCommand(
      '42',
      { executor: 'codex-cli', terminalInput: true, nonInteractive: false },
      makeCommand()
    );

    const codexBuildArgs = mockBuildExecutorAndLog.mock.calls.find(
      (call) => call[0] === 'codex-cli'
    )?.[1];
    expect(codexBuildArgs).toEqual(
      expect.objectContaining({ noninteractive: false, terminalInput: false })
    );
    expect(runWithHeadlessAdapterIfEnabledMock).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, interactive: true })
    );
  });

  test('single executor allows interactive mode when TTY is available', async () => {
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      const codexExecute = vi.fn().mockResolvedValue({
        content: JSON.stringify({ issues: [], recommendations: [], actionItems: [] }),
      });
      mockBuildExecutorAndLog.mockReturnValue({ execute: codexExecute } as any);

      await handleReviewGuideCommand(
        '42',
        { executor: 'codex-cli', terminalInput: true, nonInteractive: false },
        makeCommand()
      );

      const codexBuildArgs = mockBuildExecutorAndLog.mock.calls.find(
        (call) => call[0] === 'codex-cli'
      )?.[1];
      expect(codexBuildArgs).toEqual(
        expect.objectContaining({ noninteractive: false, terminalInput: true })
      );
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: originalIsTTY,
        configurable: true,
      });
    }
  });

  test('runs lifecycle hooks in review context when configured', async () => {
    mockLoadEffectiveConfig.mockResolvedValueOnce({
      terminalInput: true,
      review: {},
      lifecycle: {
        commands: [
          {
            title: 'install deps',
            command: 'pnpm install',
            runIn: ['review'],
          },
        ],
      },
      executors: {},
    } as any);

    const codexExecute = vi.fn().mockResolvedValue({
      content: JSON.stringify({ issues: [], recommendations: [], actionItems: [] }),
    });
    mockBuildExecutorAndLog.mockReturnValue({ execute: codexExecute } as any);

    await handleReviewGuideCommand(
      '42',
      { executor: 'codex-cli', terminalInput: false },
      makeCommand()
    );

    expect(lifecycleManagerMocks.ctor).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          title: 'install deps',
          runIn: ['review'],
        }),
      ]),
      tempDir,
      undefined,
      'review'
    );

    const lifecycleInstance = lifecycleManagerMocks.instances[0];
    expect(lifecycleInstance.startup).toHaveBeenCalledTimes(1);
    expect(lifecycleInstance.shutdown).toHaveBeenCalledTimes(1);
  });

  test('single executor mode skips combination', async () => {
    const codexExecute = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        issues: [
          {
            severity: 'critical',
            category: 'security',
            content: 'Critical issue',
            file: 'src/sec.ts',
            line: '1',
            suggestion: 'Fix',
          },
        ],
        recommendations: [],
        actionItems: [],
      }),
    });

    mockBuildExecutorAndLog.mockImplementation((name) => {
      expect(name).toBe('codex-cli');
      return { execute: codexExecute } as any;
    });

    await handleReviewGuideCommand(
      '42',
      { executor: 'codex-cli', terminalInput: false },
      makeCommand()
    );

    expect(mockBuildExecutorAndLog).toHaveBeenCalledTimes(1);
    expect(mockInsertReviewIssues).toHaveBeenCalledTimes(1);
    const inserted = mockInsertReviewIssues.mock.calls[0]?.[1];
    expect(inserted?.issues).toHaveLength(1);
    expect(inserted?.issues?.[0]?.source).toBe('codex-cli');
  });

  test('uses codex results when claude fails and skips combination', async () => {
    const claudeExecute = vi.fn().mockRejectedValue(new Error('claude failed'));
    const codexExecute = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        issues: [
          {
            severity: 'minor',
            category: 'testing',
            content: 'Codex-only issue',
            file: 'src/c.ts',
            line: '7',
            suggestion: 'Add test',
          },
        ],
        recommendations: [],
        actionItems: [],
      }),
    });

    installExecutorMock({ claudeExecute, codexExecute });

    await handleReviewGuideCommand('42', { terminalInput: false }, makeCommand());

    expect(mockBuildExecutorAndLog).toHaveBeenCalledTimes(3);
    const inserted = mockInsertReviewIssues.mock.calls[0]?.[1];
    expect(inserted?.issues).toHaveLength(1);
    expect(inserted?.issues?.[0]?.content).toBe('Codex-only issue');
    expect(inserted?.issues?.[0]?.source).toBe('codex-cli');
    expect(mockUpdateReview).toHaveBeenCalledWith(
      expect.anything(),
      501,
      expect.objectContaining({ status: 'complete' })
    );

    await expect(fs.stat(guidePath)).rejects.toThrow();
    await expect(fs.stat(issuesPath)).rejects.toThrow();
  });

  test('uses claude results when codex fails and skips combination', async () => {
    const claudeExecute = vi.fn().mockImplementation(async (prompt: string) => {
      if (prompt.includes('must produce a complete review guide')) {
        await fs.mkdir(path.dirname(guidePath), { recursive: true });
        await fs.writeFile(guidePath, '# Guide\n\nBody', 'utf8');
        return { content: 'ok' };
      }

      if (prompt.includes('standalone PR code review and must return structured JSON issues only')) {
        return {
          content: JSON.stringify({
            issues: [
              {
                severity: 'major',
                category: 'bug',
                content: 'Claude-only issue',
                file: 'src/d.ts',
                line: '9',
                suggestion: 'Fix it',
              },
            ],
            recommendations: [],
            actionItems: [],
          }),
        };
      }

      throw new Error(`Unexpected Claude prompt: ${prompt}`);
    });
    const codexExecute = vi.fn().mockRejectedValue(new Error('codex failed'));

    installExecutorMock({ claudeExecute, codexExecute });

    await handleReviewGuideCommand('42', { terminalInput: false }, makeCommand());

    expect(mockBuildExecutorAndLog).toHaveBeenCalledTimes(3);
    const inserted = mockInsertReviewIssues.mock.calls[0]?.[1];
    expect(inserted?.issues).toHaveLength(1);
    expect(inserted?.issues?.[0]?.content).toBe('Claude-only issue');
    expect(inserted?.issues?.[0]?.source).toBe('claude-code');
    expect(mockUpdateReview).toHaveBeenCalledWith(
      expect.anything(),
      501,
      expect.objectContaining({ status: 'complete' })
    );
  });

  test('falls back to merged raw issues when combination fails', async () => {
    const claudeExecute = vi.fn().mockImplementation(async (prompt: string) => {
      if (prompt.includes('must produce a complete review guide')) {
        await fs.mkdir(path.dirname(guidePath), { recursive: true });
        await fs.writeFile(guidePath, '# Guide\n\nBody', 'utf8');
        return { content: 'ok' };
      }

      if (prompt.includes('standalone PR code review and must return structured JSON issues only')) {
        return {
          content: JSON.stringify({
            issues: [
              {
                severity: 'major',
                category: 'bug',
                content: 'Claude issue',
                file: 'src/a.ts',
                line: '10',
                suggestion: 'Fix A',
              },
            ],
            recommendations: [],
            actionItems: [],
          }),
        };
      }

      throw new Error(`Unexpected Claude prompt: ${prompt}`);
    });
    const codexExecute = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        issues: [
          {
            severity: 'minor',
            category: 'style',
            content: 'Codex issue',
            file: 'src/b.ts',
            line: '20',
            suggestion: 'Fix B',
          },
        ],
        recommendations: [],
        actionItems: [],
      }),
    });
    const combineExecute = vi.fn().mockRejectedValue(new Error('combine failed'));

    installExecutorMock({ claudeExecute, codexExecute, combineExecute });

    await handleReviewGuideCommand('42', { terminalInput: false }, makeCommand());

    const inserted = mockInsertReviewIssues.mock.calls[0]?.[1];
    expect(inserted?.issues).toHaveLength(2);
    const sources = (inserted?.issues ?? []).map((issue) => issue.source).sort();
    expect(sources).toEqual(['claude-code', 'codex-cli']);
    expect(mockUpdateReview).toHaveBeenCalledWith(
      expect.anything(),
      501,
      expect.objectContaining({ status: 'complete' })
    );
  });

  test('marks review as error when all selected executors fail', async () => {
    const codexExecute = vi.fn().mockRejectedValue(new Error('codex failed'));
    mockBuildExecutorAndLog.mockReturnValue({ execute: codexExecute } as any);

    await expect(
      handleReviewGuideCommand('42', { executor: 'codex-cli', terminalInput: false }, makeCommand())
    ).rejects.toThrow('All review executors failed');

    expect(mockUpdateReview).toHaveBeenCalledWith(
      expect.anything(),
      501,
      expect.objectContaining({ status: 'error', reviewedSha: 'sha123' })
    );
  });

  test('marks review as error and cleans temp files when insertReviewIssues throws', async () => {
    const codexExecute = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        issues: [
          {
            severity: 'critical',
            category: 'security',
            content: 'Issue',
            file: 'src/a.ts',
            line: '1',
            suggestion: 'Fix',
          },
        ],
        recommendations: [],
        actionItems: [],
      }),
    });

    mockBuildExecutorAndLog.mockReturnValue({ execute: codexExecute } as any);
    mockInsertReviewIssues.mockImplementationOnce(() => {
      throw new Error('DB write failed');
    });

    await expect(
      handleReviewGuideCommand('42', { executor: 'codex-cli', terminalInput: false }, makeCommand())
    ).rejects.toThrow('DB write failed');

    expect(mockUpdateReview).toHaveBeenCalledWith(
      expect.anything(),
      501,
      expect.objectContaining({ status: 'error' })
    );

    await expect(fs.stat(guidePath)).rejects.toThrow();
    await expect(fs.stat(issuesPath)).rejects.toThrow();
  });

  test('marks review as error when updateReview for completion throws', async () => {
    const codexExecute = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        issues: [
          {
            severity: 'minor',
            category: 'style',
            content: 'Issue',
            file: 'src/b.ts',
            line: '5',
            suggestion: 'Fix',
          },
        ],
        recommendations: [],
        actionItems: [],
      }),
    });

    mockBuildExecutorAndLog.mockReturnValue({ execute: codexExecute } as any);

    let callCount = 0;
    mockUpdateReview.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // First call is the completion update - throw
        throw new Error('DB update failed');
      }
      // Second call is the error-marking catch handler
      return null;
    });

    await expect(
      handleReviewGuideCommand('42', { executor: 'codex-cli', terminalInput: false }, makeCommand())
    ).rejects.toThrow('DB update failed');

    // The catch block should have attempted to mark as error
    expect(mockUpdateReview).toHaveBeenCalledWith(
      expect.anything(),
      501,
      expect.objectContaining({ status: 'error' })
    );

    await expect(fs.stat(guidePath)).rejects.toThrow();
    await expect(fs.stat(issuesPath)).rejects.toThrow();
  });

  test('stores actual git HEAD SHA instead of cached value when checkout succeeds', async () => {
    // Initialize tempDir as a real git repo so git rev-parse HEAD succeeds
    const { execSync } = await import('node:child_process');
    execSync('git init', { cwd: tempDir, stdio: 'ignore' });
    execSync('git commit --allow-empty -m "init"', { cwd: tempDir, stdio: 'ignore' });
    const realSha = execSync('git rev-parse HEAD', { cwd: tempDir }).toString().trim();

    const codexExecute = vi.fn().mockResolvedValue({
      content: JSON.stringify({ issues: [], recommendations: [], actionItems: [] }),
    });
    mockBuildExecutorAndLog.mockReturnValue({ execute: codexExecute } as any);

    await handleReviewGuideCommand(
      '42',
      { executor: 'codex-cli', terminalInput: false },
      makeCommand()
    );

    expect(mockUpdateReview).toHaveBeenCalledWith(
      expect.anything(),
      501,
      expect.objectContaining({ status: 'complete', reviewedSha: realSha })
    );
    // Verify it's NOT the cached value
    expect(realSha).not.toBe('sha123');
  });

  test('loads trimmed custom instructions from file and passes them into executor prompt', async () => {
    const instructionsPath = path.join(tempDir, 'review-instructions.md');
    await fs.writeFile(instructionsPath, '\n\n  Focus on auth logic and test gaps.  \n', 'utf8');

    mockLoadEffectiveConfig.mockResolvedValueOnce({
      terminalInput: true,
      review: { customInstructionsPath: 'review-instructions.md' },
      executors: {},
    } as any);

    const codexExecute = vi.fn().mockResolvedValue({
      content: JSON.stringify({ issues: [], recommendations: [], actionItems: [] }),
    });
    mockBuildExecutorAndLog.mockReturnValue({ execute: codexExecute } as any);

    await handleReviewGuideCommand(
      '42',
      { executor: 'codex-cli', terminalInput: false },
      makeCommand()
    );

    const prompt = codexExecute.mock.calls[0]?.[0];
    expect(prompt).toContain('## Custom Instructions');
    expect(prompt).toContain('Focus on auth logic and test gaps.');
    expect(mockWarn).not.toHaveBeenCalled();
  });

  test('warns and omits custom instructions when configured file does not exist', async () => {
    mockLoadEffectiveConfig.mockResolvedValueOnce({
      terminalInput: true,
      review: { customInstructionsPath: 'missing-instructions.md' },
      executors: {},
    } as any);

    const codexExecute = vi.fn().mockResolvedValue({
      content: JSON.stringify({ issues: [], recommendations: [], actionItems: [] }),
    });
    mockBuildExecutorAndLog.mockReturnValue({ execute: codexExecute } as any);

    await handleReviewGuideCommand(
      '42',
      { executor: 'codex-cli', terminalInput: false },
      makeCommand()
    );

    const prompt = codexExecute.mock.calls[0]?.[0];
    expect(prompt).not.toContain('## Custom Instructions');
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('Could not read custom instructions file: missing-instructions.md')
    );
  });

  test('warns and omits custom instructions when configured path traverses outside repo', async () => {
    mockLoadEffectiveConfig.mockResolvedValueOnce({
      terminalInput: true,
      review: { customInstructionsPath: '../../etc/passwd' },
      executors: {},
    } as any);

    const codexExecute = vi.fn().mockResolvedValue({
      content: JSON.stringify({ issues: [], recommendations: [], actionItems: [] }),
    });
    mockBuildExecutorAndLog.mockReturnValue({ execute: codexExecute } as any);

    await handleReviewGuideCommand(
      '42',
      { executor: 'codex-cli', terminalInput: false },
      makeCommand()
    );

    const prompt = codexExecute.mock.calls[0]?.[0];
    expect(prompt).not.toContain('## Custom Instructions');
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('Could not read custom instructions file: ../../etc/passwd')
    );
  });

  test('rejects cross-repo PR URLs when current repository does not match PR owner/repo', async () => {
    mockGetRepositoryIdentity.mockResolvedValue({
      repositoryId: 'github.com__other__project',
      remoteUrl: 'https://github.com/other/project.git',
      gitRoot: tempDir,
    });

    await expect(
      handleReviewGuideCommand('42', { terminalInput: false }, makeCommand())
    ).rejects.toThrow('belongs to acme/repo, but the current repository is other/project');
  });

  test('rejects non-GitHub repository identity', async () => {
    mockGetRepositoryIdentity.mockResolvedValue({
      repositoryId: 'gitlab.com__other__project',
      remoteUrl: 'https://gitlab.com/other/project.git',
      gitRoot: tempDir,
    });

    await expect(
      handleReviewGuideCommand('42', { executor: 'codex-cli', terminalInput: false }, makeCommand())
    ).rejects.toThrow('not a recognized GitHub repository');
  });

  test('stores startLine and end line separately when issue line is a range', async () => {
    const codexExecute = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        issues: [
          {
            severity: 'major',
            category: 'bug',
            content: 'Range issue',
            file: 'src/range.ts',
            line: '10-20',
            suggestion: 'Fix range',
          },
        ],
        recommendations: [],
        actionItems: [],
      }),
    });
    mockBuildExecutorAndLog.mockReturnValue({ execute: codexExecute } as any);

    await handleReviewGuideCommand(
      '42',
      { executor: 'codex-cli', terminalInput: false },
      makeCommand()
    );

    const inserted = mockInsertReviewIssues.mock.calls[0]?.[1];
    expect(inserted?.issues).toHaveLength(1);
    expect(inserted?.issues?.[0]).toMatchObject({
      file: 'src/range.ts',
      startLine: '10',
      line: '20',
    });
  });

  test('stores startLine and end line separately when issue line is an en-dash range', async () => {
    const codexExecute = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        issues: [
          {
            severity: 'major',
            category: 'bug',
            content: 'En-dash range issue',
            file: 'src/range.ts',
            line: '10\u201320', // en-dash U+2013
            suggestion: 'Fix range',
          },
        ],
        recommendations: [],
        actionItems: [],
      }),
    });
    mockBuildExecutorAndLog.mockReturnValue({ execute: codexExecute } as any);

    await handleReviewGuideCommand(
      '42',
      { executor: 'codex-cli', terminalInput: false },
      makeCommand()
    );

    const inserted = mockInsertReviewIssues.mock.calls[0]?.[1];
    expect(inserted?.issues).toHaveLength(1);
    expect(inserted?.issues?.[0]).toMatchObject({
      file: 'src/range.ts',
      startLine: '10',
      line: '20',
    });
  });

  test('stores null startLine for plain line number', async () => {
    const codexExecute = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        issues: [
          {
            severity: 'minor',
            category: 'style',
            content: 'Plain line issue',
            file: 'src/plain.ts',
            line: '42',
            suggestion: 'Fix it',
          },
        ],
        recommendations: [],
        actionItems: [],
      }),
    });
    mockBuildExecutorAndLog.mockReturnValue({ execute: codexExecute } as any);

    await handleReviewGuideCommand(
      '42',
      { executor: 'codex-cli', terminalInput: false },
      makeCommand()
    );

    const inserted = mockInsertReviewIssues.mock.calls[0]?.[1];
    expect(inserted?.issues).toHaveLength(1);
    expect(inserted?.issues?.[0]).toMatchObject({
      file: 'src/plain.ts',
      startLine: null,
      line: '42',
    });
  });

  test('stores null startLine and null line for null line from combination output', async () => {
    // The null line case cannot come from Codex (strict schema), but can come from the combination step.
    // The "accepts null file/line from combination output" test covers this.
    // This test explicitly verifies the null-line case results in null startLine and null line.
    const claudeExecute = vi.fn().mockImplementation(async (prompt: string) => {
      if (prompt.includes('must produce a complete review guide')) {
        await fs.mkdir(path.dirname(guidePath), { recursive: true });
        await fs.writeFile(guidePath, '# Guide', 'utf8');
        return { content: 'ok' };
      }

      if (prompt.includes('standalone PR code review and must return structured JSON issues only')) {
        return {
          content: JSON.stringify({
            issues: [
              {
                severity: 'info',
                category: 'other',
                content: 'C',
                file: 'f.ts',
                line: '1',
                suggestion: 'S',
              },
            ],
            recommendations: [],
            actionItems: [],
          }),
        };
      }

      throw new Error(`Unexpected Claude prompt: ${prompt}`);
    });
    const codexExecute = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        issues: [
          {
            severity: 'info',
            category: 'other',
            content: 'D',
            file: 'g.ts',
            line: '2',
            suggestion: 'T',
          },
        ],
        recommendations: [],
        actionItems: [],
      }),
    });
    const combineExecute = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        issues: [
          {
            severity: 'info',
            category: 'other',
            content: 'Null line issue',
            file: null,
            line: null,
            suggestion: 'Fix',
            source: 'combined',
          },
        ],
        recommendations: [],
        actionItems: [],
      }),
    });

    installExecutorMock({ claudeExecute, codexExecute, combineExecute });

    await handleReviewGuideCommand('42', { terminalInput: false }, makeCommand());

    const inserted = mockInsertReviewIssues.mock.calls[0]?.[1];
    expect(inserted?.issues).toHaveLength(1);
    expect(inserted?.issues?.[0]).toMatchObject({
      startLine: null,
      line: null,
    });
  });

  test('stores null startLine for non-range string line value', async () => {
    const codexExecute = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        issues: [
          {
            severity: 'minor',
            category: 'style',
            content: 'Non-range string issue',
            file: 'src/y.ts',
            line: 'L100',
            suggestion: '',
          },
        ],
        recommendations: [],
        actionItems: [],
      }),
    });
    mockBuildExecutorAndLog.mockReturnValue({ execute: codexExecute } as any);

    await handleReviewGuideCommand(
      '42',
      { executor: 'codex-cli', terminalInput: false },
      makeCommand()
    );

    const inserted = mockInsertReviewIssues.mock.calls[0]?.[1];
    expect(inserted?.issues).toHaveLength(1);
    expect(inserted?.issues?.[0]).toMatchObject({
      startLine: null,
      line: 'L100',
    });
  });

  test('accepts null file/line from combination output', async () => {
    const claudeExecute = vi.fn().mockImplementation(async (prompt: string) => {
      if (prompt.includes('must produce a complete review guide')) {
        await fs.mkdir(path.dirname(guidePath), { recursive: true });
        await fs.writeFile(guidePath, '# Guide\n\nBody', 'utf8');
        return { content: 'ok' };
      }

      if (prompt.includes('standalone PR code review and must return structured JSON issues only')) {
        return {
          content: JSON.stringify({
            issues: [
              {
                severity: 'major',
                category: 'bug',
                content: 'Claude issue',
                file: 'src/a.ts',
                line: '10',
                suggestion: 'Fix A',
              },
            ],
            recommendations: [],
            actionItems: [],
          }),
        };
      }

      throw new Error(`Unexpected Claude prompt: ${prompt}`);
    });
    const codexExecute = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        issues: [
          {
            severity: 'minor',
            category: 'style',
            content: 'Codex issue',
            file: 'src/b.ts',
            line: '20',
            suggestion: 'Fix B',
          },
        ],
        recommendations: [],
        actionItems: [],
      }),
    });
    const combineExecute = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        issues: [
          {
            severity: 'major',
            category: 'bug',
            content: 'Project-wide issue',
            file: null,
            line: null,
            suggestion: 'Fix merged',
            source: 'combined',
          },
        ],
        recommendations: [],
        actionItems: [],
      }),
    });

    installExecutorMock({ claudeExecute, codexExecute, combineExecute });

    await handleReviewGuideCommand('42', { terminalInput: false }, makeCommand());

    const inserted = mockInsertReviewIssues.mock.calls[0]?.[1];
    expect(inserted?.issues).toHaveLength(1);
    expect(inserted?.issues?.[0]).toMatchObject({
      content: 'Project-wide issue',
      file: null,
      line: null,
      source: 'combined',
    });
  });

  test('marks review as error when temp directory creation fails', async () => {
    const badBasePath = path.join(tempDir, 'not-a-directory');
    await fs.writeFile(badBasePath, 'x', 'utf8');
    mockGetGitRoot.mockResolvedValue(badBasePath);

    const codexExecute = vi.fn().mockResolvedValue({
      content: JSON.stringify({ issues: [], recommendations: [], actionItems: [] }),
    });
    mockBuildExecutorAndLog.mockReturnValue({ execute: codexExecute } as any);

    await expect(
      handleReviewGuideCommand('42', { executor: 'codex-cli', terminalInput: false }, makeCommand())
    ).rejects.toThrow();

    expect(mockUpdateReview).toHaveBeenCalledWith(
      expect.anything(),
      501,
      expect.objectContaining({ status: 'error' })
    );
  });

  test('warns when temp cleanup fails', async () => {
    const codexExecute = vi.fn().mockResolvedValue({
      content: JSON.stringify({ issues: [], recommendations: [], actionItems: [] }),
    });
    mockBuildExecutorAndLog.mockReturnValue({ execute: codexExecute } as any);

    const tmpParent = path.join(tempDir, '.tim', 'tmp');
    mockInsertReviewIssues.mockImplementationOnce(() => {
      // Make parent non-writable so recursive cleanup of review dir fails.
      fsSync.chmodSync(tmpParent, 0o500);
      return undefined as any;
    });

    await handleReviewGuideCommand(
      '42',
      { executor: 'codex-cli', terminalInput: false },
      makeCommand()
    );

    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to clean up temp files:')
    );
    fsSync.chmodSync(tmpParent, 0o700);
  });

  test('uses lightweight auto-workspace selection and then checks out the PR branch', async () => {
    const codexExecute = vi.fn().mockResolvedValue({
      content: JSON.stringify({ issues: [], recommendations: [], actionItems: [] }),
    });
    mockBuildExecutorAndLog.mockReturnValue({ execute: codexExecute } as any);

    await handleReviewGuideCommand(
      '42',
      { autoWorkspace: true, executor: 'codex-cli', terminalInput: false },
      makeCommand()
    );

    expect(workspaceAutoSelectorMocks.ctor).toHaveBeenCalledWith(tempDir, expect.anything());
    expect(workspaceAutoSelectorMocks.selectWorkspace).toHaveBeenCalledWith(
      expect.stringMatching(/^pr-review-42-/),
      undefined,
      expect.objectContaining({
        interactive: true,
        createBranch: false,
      })
    );
    expect(mockWorkspaceLockAcquireLock).toHaveBeenCalledWith(tempDir, 'tim pr review-guide', {
      type: 'pid',
    });
    expect(mockWorkspaceLockSetupCleanupHandlers).toHaveBeenCalledWith(tempDir, 'pid');
    expect(
      vi.mocked((await import('../headless.js')).updateHeadlessSessionInfo)
    ).toHaveBeenCalledWith({
      workspacePath: tempDir,
    });
    expect(mockCheckoutPrBranch).toHaveBeenCalledWith(
      expect.objectContaining({
        baseBranch: 'main',
        branch: 'feature/pr',
        skipDirtyCheck: true,
        cwd: tempDir,
      })
    );
  });

  test('materialize writes guide and issues markdown and updates git exclude', async () => {
    const infoExcludePath = path.join(tempDir, '.git', 'info', 'exclude');
    await fs.mkdir(path.dirname(infoExcludePath), { recursive: true });
    await fs.writeFile(infoExcludePath, '', 'utf8');

    mockGetLatestReviewByPrUrl.mockReturnValue({
      id: 77,
      review_guide: '# Stored Guide\n\nSome content',
    } as any);
    mockGetReviewIssues.mockReturnValue([
      {
        severity: 'major',
        category: 'bug',
        content: 'Issue one',
        file: 'src/a.ts',
        line: '10',
        start_line: null,
        suggestion: 'Fix it',
        source: 'claude-code',
        resolved: 0,
      },
    ] as any);
    mockGetGitInfoExcludePath.mockResolvedValue(infoExcludePath);
    mockIsIgnoredByGitSharedExcludes.mockResolvedValue(false);

    await handleMaterializeCommand('42', {}, makeCommand());

    const guideOut = await fs.readFile(
      path.join(tempDir, '.tim', 'reviews', 'review-guide.md'),
      'utf8'
    );
    const issuesOut = await fs.readFile(
      path.join(tempDir, '.tim', 'reviews', 'review-issues.md'),
      'utf8'
    );
    const excludeOut = await fs.readFile(infoExcludePath, 'utf8');

    expect(guideOut).toContain('# Stored Guide');
    expect(issuesOut).toContain('## Major (1)');
    expect(issuesOut).toContain('Issue one');
    expect(excludeOut).toContain('.tim/reviews');
  });

  test('materialize errors when no review exists', async () => {
    mockGetLatestReviewByPrUrl.mockReturnValue(null);

    await expect(handleMaterializeCommand('42', {}, makeCommand())).rejects.toThrow(
      'No completed review found'
    );
  });
});
