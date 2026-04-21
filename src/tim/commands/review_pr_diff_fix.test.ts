import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';

const executorMocks = vi.hoisted(() => ({
  reviewExecute: vi.fn(),
  repairExecute: vi.fn(),
}));

vi.mock('../../logging.js', () => ({
  log: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../logging/tunnel_client.js', () => ({
  isTunnelActive: vi.fn(() => false),
}));

vi.mock('../../common/git.js', () => ({
  getGitInfoExcludePath: vi.fn(() => undefined),
  getMergeBase: vi.fn(),
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
    resolveReviewExecutorSelection: vi.fn(() => 'claude-code'),
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
  WorkspaceAutoSelector: class {},
}));

vi.mock('../workspace/workspace_lock.js', () => ({
  WorkspaceLock: {
    acquireLock: vi.fn(),
    setupCleanupHandlers: vi.fn(),
  },
}));

vi.mock('../shutdown_state.js', () => ({
  isShuttingDown: vi.fn(() => false),
  getSignalExitCode: vi.fn(() => 143),
  setDeferSignalExit: vi.fn(() => {}),
}));

vi.mock('../lifecycle.js', () => ({
  LifecycleManager: class {
    startup = vi.fn(async () => {});
    shutdown = vi.fn(async () => {});
    killDaemons = vi.fn(() => {});

    constructor(...args: unknown[]) {
      void args;
    }
  },
}));

import { getGitRoot, getMergeBase, getUsingJj } from '../../common/git.js';
import { getDatabase } from '../db/database.js';
import {
  createReview,
  getReviewIssues,
  insertReviewIssues,
  updateReview,
} from '../db/review.js';
import { getOrCreateProject } from '../db/project.js';
import { buildExecutorAndLog } from '../executors/index.js';
import { loadEffectiveConfig } from '../configLoader.js';
import {
  gatherPrContext,
  checkoutPrBranch,
  resolvePrUrl,
} from '../utils/pr_context_gathering.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { handleReviewGuideCommand } from './review_pr.js';

const mockGetGitRoot = vi.mocked(getGitRoot);
const mockGetMergeBase = vi.mocked(getMergeBase);
const mockGetUsingJj = vi.mocked(getUsingJj);
const mockGetDatabase = vi.mocked(getDatabase);
const mockLoadEffectiveConfig = vi.mocked(loadEffectiveConfig);
const mockGatherPrContext = vi.mocked(gatherPrContext);
const mockResolvePrUrl = vi.mocked(resolvePrUrl);
const mockGetRepositoryIdentity = vi.mocked(getRepositoryIdentity);
const mockGetOrCreateProject = vi.mocked(getOrCreateProject);
const mockCreateReview = vi.mocked(createReview);
const mockGetReviewIssues = vi.mocked(getReviewIssues);
const mockInsertReviewIssues = vi.mocked(insertReviewIssues);
const mockUpdateReview = vi.mocked(updateReview);
const mockCheckoutPrBranch = vi.mocked(checkoutPrBranch);
const mockBuildExecutorAndLog = vi.mocked(buildExecutorAndLog);

function makeCommand(config?: string) {
  return {
    parent: {
      opts: () => ({ config }),
    },
  } as any;
}

describe('review_pr diff repair', () => {
  let tempDir: string;
  let guidePath: string;

  beforeEach(async () => {
    vi.clearAllMocks();

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-review-pr-diff-fix-'));
    execFileSync('git', ['init', '-q'], { cwd: tempDir });
    guidePath = path.join(tempDir, '.tim', 'tmp', 'review-501', 'review-guide.md');

    await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'src/a.ts'), 'const alpha = 2;\n', 'utf8');
    await fs.writeFile(path.join(tempDir, 'src/b.ts'), 'const beta = 3;\n', 'utf8');

    mockGetDatabase.mockReturnValue({} as any);
    mockGetGitRoot.mockResolvedValue(tempDir);
    mockGetMergeBase.mockResolvedValue('base123');
    mockGetUsingJj.mockResolvedValue(false);
    mockLoadEffectiveConfig.mockResolvedValue({
      terminalInput: true,
      review: {},
      executors: {},
    } as any);
    mockGatherPrContext.mockResolvedValue({
      prStatus: {
        id: 99,
        title: 'PR title',
        author: 'alice',
        changed_files: 2,
      },
      baseBranch: 'main',
      headBranch: 'feature/pr',
      headSha: 'sha123',
      owner: 'acme',
      repo: 'repo',
      prNumber: 42,
      prUrl: 'https://github.com/acme/repo/pull/42',
    } as any);
    mockResolvePrUrl.mockResolvedValue('https://github.com/acme/repo/pull/42');
    mockGetRepositoryIdentity.mockResolvedValue({
      repositoryId: 'github.com__acme__repo',
      remoteUrl: 'https://github.com/acme/repo.git',
      gitRoot: tempDir,
    });
    mockGetOrCreateProject.mockReturnValue({ id: 7 } as any);
    mockCreateReview.mockReturnValue({ id: 501 } as any);
    mockGetReviewIssues.mockReturnValue([]);
    mockCheckoutPrBranch.mockResolvedValue(undefined);

    mockBuildExecutorAndLog.mockImplementation((name, sharedOptions) => {
      if (name === 'claude-code' && (sharedOptions as any)?.model === 'sonnet') {
        return { execute: executorMocks.repairExecute } as any;
      }

      if (name === 'claude-code') {
        return { execute: executorMocks.reviewExecute } as any;
      }

      throw new Error(`Unexpected executor: ${name}`);
    });

    executorMocks.reviewExecute.mockImplementation(async (prompt: string) => {
      if (prompt.includes('must produce a complete review guide')) {
        await fs.mkdir(path.dirname(guidePath), { recursive: true });
        await fs.writeFile(
          guidePath,
          [
            '# Guide',
            '',
            '```unified-diff',
            'diff --git a/src/a.ts b/src/a.ts',
            '--- a/src/a.ts',
            '+++ b/src/a.ts',
            '@@ -1 +1 @@',
            '-const alpha = 1;',
            '+const alpha = 2;',
            '',
            'diff --git a/src/b.ts b/src/b.ts',
            '--- a/src/b.ts',
            '+++ b/src/b.ts',
            '+const beta = 3;',
            '```',
            '',
          ].join('\n'),
          'utf8'
        );
        return { content: 'ok' };
      }

      if (
        prompt.includes('standalone PR code review and must return structured JSON issues only')
      ) {
        return {
          content: JSON.stringify({ issues: [], recommendations: [], actionItems: [] }),
        };
      }

      throw new Error(`Unexpected review prompt: ${prompt}`);
    });

    executorMocks.repairExecute.mockImplementation(async (prompt: string) => {
      expect(prompt).toContain('You are repairing a malformed unified diff section');
      expect(prompt).toContain('git apply --reverse --check');
      expect(prompt).toContain('src/b.ts');
      expect(prompt).not.toContain('src/a.ts');

      return {
        content: [
          'diff --git a/src/b.ts b/src/b.ts',
          '--- a/src/b.ts',
          '+++ b/src/b.ts',
          '@@ -1 +1 @@',
          '-const beta = 2;',
          '+const beta = 3;',
          '',
        ].join('\n'),
      };
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('repairs only the malformed file section and keeps the valid section intact', async () => {
    await handleReviewGuideCommand('42', { executor: 'claude-code', terminalInput: false }, makeCommand());

    expect(executorMocks.repairExecute).toHaveBeenCalledTimes(1);
    expect(mockUpdateReview).toHaveBeenCalledTimes(1);

    const updateArgs = mockUpdateReview.mock.calls[0];
    expect(updateArgs?.[1]).toBe(501);
    expect(updateArgs?.[2]).toEqual(
      expect.objectContaining({
        reviewGuide: expect.stringContaining('@@ -1 +1 @@'),
      })
    );

    const reviewGuide = String((updateArgs?.[2] as any)?.reviewGuide);
    expect(reviewGuide).toContain('diff --git a/src/a.ts b/src/a.ts');
    expect(reviewGuide).toContain('diff --git a/src/b.ts b/src/b.ts');
    expect(reviewGuide).toContain('@@ -1 +1 @@');

    const repairPrompt = executorMocks.repairExecute.mock.calls[0]?.[0] as string;
    expect(repairPrompt).toContain('src/b.ts');
    expect(repairPrompt).not.toContain('src/a.ts');
  });
});
