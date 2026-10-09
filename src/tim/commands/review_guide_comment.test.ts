import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { $ } from 'bun';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../logging.js', () => ({
  log: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../logging/tunnel_client.js', () => ({
  isTunnelActive: vi.fn(),
}));

vi.mock('../../common/git.js', () => ({
  getGitRoot: vi.fn(),
  getUsingJj: vi.fn(),
}));

vi.mock('../../common/github/app_auth.js', () => ({
  getGitHubAppInstallationTokenForOwner: vi.fn(),
}));

vi.mock('../../common/github/identifiers.js', () => ({
  parsePrOrIssueNumber: vi.fn(),
}));

vi.mock('../../common/github/pull_requests.js', () => ({
  addIssueCommentReaction: vi.fn(),
  findPullRequestCommentByMarker: vi.fn(),
  parseOwnerRepoFromRepositoryId: vi.fn(),
  postPullRequestComment: vi.fn(),
  updatePullRequestComment: vi.fn(),
}));

vi.mock('../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(),
}));

vi.mock('../db/database.js', () => ({
  getDatabase: vi.fn(),
}));

vi.mock('../db/pr_status.js', () => ({
  getLinkedPlansByPrUrl: vi.fn(),
}));

vi.mock('../db/project_settings.js', () => ({
  getProjectSetting: vi.fn(),
}));

vi.mock('./review_guide_auto_review.js', () => ({
  runAutomaticPrReview: vi.fn(),
}));

vi.mock('../executors/index.js', async () => {
  const actual =
    await vi.importActual<typeof import('../executors/index.js')>('../executors/index.js');
  return {
    ...actual,
    buildExecutorAndLog: vi.fn(),
  };
});

vi.mock('../assignments/workspace_identifier.js', () => ({
  getRepositoryIdentity: vi.fn(),
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

vi.mock('../headless.js', () => ({
  runWithHeadlessAdapterIfEnabled: vi.fn(async (options: { callback: () => Promise<void> }) =>
    options.callback()
  ),
  updateHeadlessSessionInfo: vi.fn(),
}));

vi.mock('../utils/pr_context_gathering.js', () => ({
  gatherPrContext: vi.fn(),
  checkoutPrBranch: vi.fn(),
  resolvePrUrl: vi.fn(),
}));

vi.mock('./review_workflow.js', () => ({
  loadCustomReviewInstructions: vi.fn(),
  resolveProjectContextForRepo: vi.fn(),
}));

import { getGitRoot, getUsingJj } from '../../common/git.js';
import { log, warn } from '../../logging.js';
import { isTunnelActive } from '../../logging/tunnel_client.js';
import { getGitHubAppInstallationTokenForOwner } from '../../common/github/app_auth.js';
import { parsePrOrIssueNumber } from '../../common/github/identifiers.js';
import {
  addIssueCommentReaction,
  findPullRequestCommentByMarker,
  parseOwnerRepoFromRepositoryId,
  postPullRequestComment,
  updatePullRequestComment,
} from '../../common/github/pull_requests.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { getDatabase } from '../db/database.js';
import { getLinkedPlansByPrUrl } from '../db/pr_status.js';
import { getProjectSetting } from '../db/project_settings.js';
import { runAutomaticPrReview } from './review_guide_auto_review.js';
import { buildExecutorAndLog } from '../executors/index.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { runWithHeadlessAdapterIfEnabled, updateHeadlessSessionInfo } from '../headless.js';
import { gatherPrContext, checkoutPrBranch, resolvePrUrl } from '../utils/pr_context_gathering.js';
import { loadCustomReviewInstructions, resolveProjectContextForRepo } from './review_workflow.js';
import {
  buildGuideCommentBody,
  formatAutoReviewStatus,
  handlePrReviewGuideCommentCommand,
} from './review_guide_comment.js';

const mockGetGitRoot = vi.mocked(getGitRoot);
const mockGetUsingJj = vi.mocked(getUsingJj);
const mockLog = vi.mocked(log);
const mockWarn = vi.mocked(warn);
const mockIsTunnelActive = vi.mocked(isTunnelActive);
const mockGetGitHubAppInstallationTokenForOwner = vi.mocked(getGitHubAppInstallationTokenForOwner);
const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);
const mockAddIssueCommentReaction = vi.mocked(addIssueCommentReaction);
const mockFindPullRequestCommentByMarker = vi.mocked(findPullRequestCommentByMarker);
const mockParseOwnerRepoFromRepositoryId = vi.mocked(parseOwnerRepoFromRepositoryId);
const mockPostPullRequestComment = vi.mocked(postPullRequestComment);
const mockUpdatePullRequestComment = vi.mocked(updatePullRequestComment);
const mockLoadEffectiveConfig = vi.mocked(loadEffectiveConfig);
const mockGetDatabase = vi.mocked(getDatabase);
const mockGetLinkedPlansByPrUrl = vi.mocked(getLinkedPlansByPrUrl);
const mockGetProjectSetting = vi.mocked(getProjectSetting);
const mockRunAutomaticPrReview = vi.mocked(runAutomaticPrReview);
const mockBuildExecutorAndLog = vi.mocked(buildExecutorAndLog);
const mockGetRepositoryIdentity = vi.mocked(getRepositoryIdentity);
const mockRunWithHeadlessAdapterIfEnabled = vi.mocked(runWithHeadlessAdapterIfEnabled);
const mockUpdateHeadlessSessionInfo = vi.mocked(updateHeadlessSessionInfo);
const mockGatherPrContext = vi.mocked(gatherPrContext);
const mockCheckoutPrBranch = vi.mocked(checkoutPrBranch);
const mockResolvePrUrl = vi.mocked(resolvePrUrl);
const mockLoadCustomReviewInstructions = vi.mocked(loadCustomReviewInstructions);
const mockResolveProjectContextForRepo = vi.mocked(resolveProjectContextForRepo);

function makeCommand(config?: string) {
  return {
    parent: {
      opts: () => ({ config }),
    },
  } as any;
}

describe('review_guide_comment', () => {
  let tempDir: string;
  let mergeBaseSha: string;
  let mainTipSha: string;
  let capturedPrompt = '';
  let spawnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async (): Promise<void> => {
    vi.clearAllMocks();
    capturedPrompt = '';
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-review-guide-comment-'));
    await $`git init -q --initial-branch=main`.cwd(tempDir);
    await $`git config user.email test@example.com`.cwd(tempDir);
    await $`git config user.name Test`.cwd(tempDir);
    await $`git -c commit.gpgsign=false commit -qm base --allow-empty`.cwd(tempDir);
    mergeBaseSha = (await $`git rev-parse HEAD`.cwd(tempDir).text()).trim();
    await $`git checkout -qb feature/review-guide`.cwd(tempDir);
    await fs.writeFile(path.join(tempDir, 'feature.ts'), 'export const feature = true;\n');
    await $`git add feature.ts`.cwd(tempDir);
    await $`git -c commit.gpgsign=false commit -qm feature`.cwd(tempDir);
    const headSha = (await $`git rev-parse HEAD`.cwd(tempDir).text()).trim();
    await $`git checkout -q main`.cwd(tempDir);
    await fs.writeFile(path.join(tempDir, 'main-only.ts'), 'export const mainOnly = true;\n');
    await $`git add main-only.ts`.cwd(tempDir);
    await $`git -c commit.gpgsign=false commit -qm "Advance main"`.cwd(tempDir);
    mainTipSha = (await $`git rev-parse HEAD`.cwd(tempDir).text()).trim();
    await $`git update-ref refs/remotes/origin/main ${mainTipSha}`.cwd(tempDir);

    mockGetDatabase.mockReturnValue({} as any);
    mockGetGitRoot.mockResolvedValue(tempDir);
    mockGetUsingJj.mockResolvedValue(true);
    mockIsTunnelActive.mockReturnValue(false);
    mockResolvePrUrl.mockResolvedValue('https://github.com/acme/repo/pull/42');
    mockParsePrOrIssueNumber.mockResolvedValue({ owner: 'acme', repo: 'repo', number: 42 });
    mockGetGitHubAppInstallationTokenForOwner.mockResolvedValue('app-installation-token');
    mockLoadEffectiveConfig.mockResolvedValue({
      terminalInput: true,
      review: {},
      githubWebhooks: { reviewGuideComments: true },
      executors: {},
    } as any);
    mockGatherPrContext.mockResolvedValue({
      prStatus: {
        id: 99,
        title: 'PR title',
        author: 'alice',
      },
      prUrl: 'https://github.com/acme/repo/pull/42',
      prNumber: 42,
      owner: 'acme',
      repo: 'repo',
      baseBranch: 'main',
      baseSha: mainTipSha,
      headBranch: 'feature/review-guide',
      headSha,
    } as any);
    mockGetLinkedPlansByPrUrl.mockReturnValue(new Map());
    mockResolveProjectContextForRepo.mockResolvedValue({ repoRoot: tempDir, projectId: 7 });
    mockGetProjectSetting.mockReturnValue({ enabled: true });
    mockRunAutomaticPrReview.mockResolvedValue({
      reviewId: 1,
      issueCount: 0,
      githubReviewUrl: null,
      inlineCount: 0,
      appendedCount: 0,
    });
    mockGetRepositoryIdentity.mockResolvedValue({
      repositoryId: 'github:acme/repo',
    } as any);
    mockParseOwnerRepoFromRepositoryId.mockReturnValue({ owner: 'acme', repo: 'repo' });
    mockFindPullRequestCommentByMarker.mockResolvedValue(null);
    mockAddIssueCommentReaction.mockResolvedValue(undefined);
    mockCheckoutPrBranch.mockImplementation(async (): Promise<void> => {
      await $`git checkout -q --detach feature/review-guide`.cwd(tempDir);
    });
    mockLoadCustomReviewInstructions.mockResolvedValue('');
    mockPostPullRequestComment.mockResolvedValue({ id: 123, htmlUrl: 'https://comment/123' });
    mockUpdatePullRequestComment.mockResolvedValue({ id: 123, htmlUrl: 'https://comment/123' });
    spawnSpy = vi.spyOn(Bun, 'spawn').mockReturnValue({
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('2 files changed, 45 insertions(+)\n'));
          controller.close();
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      exited: Promise.resolve(0),
    } as any);
    mockBuildExecutorAndLog.mockReturnValue({
      execute: vi.fn(async (prompt: string) => {
        capturedPrompt = prompt;
        const match = prompt.match(/Write the finished markdown comment .* to:\n`([^`]+)`/);
        if (!match) {
          throw new Error('Prompt did not include an output path');
        }
        await fs.mkdir(path.dirname(match[1]), { recursive: true });
        await fs.writeFile(match[1], '## Review Guide\n\nGenerated guide.\n', 'utf8');
      }),
    } as any);
  });

  afterEach(async (): Promise<void> => {
    spawnSpy.mockRestore();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('uses the merge base for the prompt and jj stats when the PR is behind main', async (): Promise<void> => {
    await handlePrReviewGuideCommentCommand(
      '42',
      { executor: 'codex-cli', force: true },
      makeCommand()
    );

    expect(mockCheckoutPrBranch).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: 'feature/review-guide',
        baseBranch: 'main',
        prNumber: 42,
        cwd: tempDir,
      })
    );
    expect(mockGetUsingJj).toHaveBeenCalledWith(tempDir);
    expect(spawnSpy).toHaveBeenCalledWith(
      [
        'jj',
        'diff',
        '--stat',
        '-f',
        mergeBaseSha,
        'all() ~ (glob:"**/*.spec.*" | glob:"**/*.test.*" | prefix-glob:"**/*_test_*" | prefix-glob:"**/*_fixture*")',
      ],
      expect.objectContaining({ cwd: tempDir })
    );
    expect(mockGetGitHubAppInstallationTokenForOwner).toHaveBeenCalledWith('acme');
    expect(mockFindPullRequestCommentByMarker).toHaveBeenCalledWith(
      'acme',
      'repo',
      42,
      '<!-- tim:pr-review-guide -->',
      { authToken: 'app-installation-token' }
    );
    expect(mockPostPullRequestComment).toHaveBeenCalledWith(
      'acme',
      'repo',
      42,
      expect.stringContaining('Generated guide.'),
      { authToken: 'app-installation-token' }
    );
    expect(mockLog).toHaveBeenCalledWith('## Review Guide\n\nGenerated guide.');
    expect(capturedPrompt).toContain('Repository is git-based');
    expect(capturedPrompt).toContain(`git diff '${mergeBaseSha}' HEAD`);
    expect(capturedPrompt).toContain(`- Base SHA: ${mergeBaseSha}`);
    expect(capturedPrompt).not.toContain(mainTipSha);
    expect(capturedPrompt).not.toContain('git merge-base');
    expect(capturedPrompt).toContain('Precomputed non-test change stats');
    expect(capturedPrompt).toContain('2 files changed, 45 insertions(+)');
    expect(capturedPrompt).toContain('### Non-test change stats');
    expect(capturedPrompt).not.toContain('Repository is jj-based');
    expect(capturedPrompt).not.toContain('jj diff');
  });

  test('uses the merge base in Git workspaces when the PR is behind main', async (): Promise<void> => {
    mockGetUsingJj.mockResolvedValue(false);

    await handlePrReviewGuideCommentCommand('42', { dryRun: true }, makeCommand());

    expect(capturedPrompt).toContain(`git diff '${mergeBaseSha}' HEAD`);
    expect(capturedPrompt).not.toContain(mainTipSha);
    expect(spawnSpy).not.toHaveBeenCalled();
    const changedFiles = (
      await $`git diff ${mergeBaseSha} HEAD --name-only`.cwd(tempDir).text()
    ).trim();
    expect(changedFiles).toBe('feature.ts');
  });

  test('stops before generation when the merge base cannot be resolved', async (): Promise<void> => {
    await $`git update-ref -d refs/remotes/origin/main`.cwd(tempDir);

    await expect(handlePrReviewGuideCommentCommand('42', {}, makeCommand())).rejects.toThrow(
      'Failed to resolve PR review guide comment merge base from origin/main'
    );

    expect(mockBuildExecutorAndLog).not.toHaveBeenCalled();
    expect(mockPostPullRequestComment).not.toHaveBeenCalled();
    expect(mockUpdatePullRequestComment).not.toHaveBeenCalled();
  });

  test('wraps comment generation in a headless review-guide session with PR metadata', async () => {
    await handlePrReviewGuideCommentCommand(
      '42',
      { executor: 'codex-cli', force: true },
      makeCommand()
    );

    expect(mockRunWithHeadlessAdapterIfEnabled).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        command: 'review-guide-comment',
        interactive: true,
      })
    );
    expect(mockUpdateHeadlessSessionInfo).toHaveBeenCalledWith({
      linkedPrUrl: 'https://github.com/acme/repo/pull/42',
      linkedPrNumber: 42,
      linkedPrTitle: 'PR title',
      linkedPlanId: undefined,
      linkedPlanUuid: undefined,
      linkedPlanTitle: undefined,
    });
  });

  test('does not create a headless adapter when tunnel mode is active', async () => {
    mockIsTunnelActive.mockReturnValue(true);

    await handlePrReviewGuideCommentCommand(
      '42',
      { executor: 'codex-cli', force: true },
      makeCommand()
    );

    expect(mockRunWithHeadlessAdapterIfEnabled).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
        command: 'review-guide-comment',
        interactive: true,
      })
    );
  });

  test('dry run logs the guide without posting', async () => {
    await handlePrReviewGuideCommentCommand(
      '42',
      { executor: 'codex-cli', dryRun: true },
      makeCommand()
    );

    expect(mockFindPullRequestCommentByMarker).not.toHaveBeenCalled();
    expect(mockPostPullRequestComment).not.toHaveBeenCalled();
    expect(mockUpdatePullRequestComment).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalledWith('## Review Guide\n\nGenerated guide.');
    expect(mockLog).toHaveBeenCalledWith('Dry run: not posting review guide comment.');
  });

  test('manual generation does not require githubWebhooks.reviewGuideComments', async () => {
    mockLoadEffectiveConfig.mockResolvedValue({
      terminalInput: true,
      review: {},
      executors: {},
    } as any);

    await handlePrReviewGuideCommentCommand(
      '42',
      { executor: 'codex-cli', force: true },
      makeCommand()
    );

    expect(mockGatherPrContext).toHaveBeenCalled();
    expect(mockPostPullRequestComment).toHaveBeenCalledWith(
      'acme',
      'repo',
      42,
      expect.stringContaining('Generated guide.'),
      { authToken: 'app-installation-token' }
    );
    expect(mockLog).toHaveBeenCalledWith('## Review Guide\n\nGenerated guide.');
  });

  test('force updates the existing guide comment with a timestamp footer', async () => {
    mockFindPullRequestCommentByMarker.mockResolvedValue({
      id: 456,
      htmlUrl: 'https://comment/456',
    });

    await handlePrReviewGuideCommentCommand(
      '42',
      { executor: 'codex-cli', force: true },
      makeCommand()
    );

    expect(mockPostPullRequestComment).not.toHaveBeenCalled();
    expect(mockUpdatePullRequestComment).toHaveBeenCalledWith(
      'acme',
      'repo',
      456,
      expect.stringContaining('Generated guide.'),
      { authToken: 'app-installation-token' }
    );
    const body = mockUpdatePullRequestComment.mock.calls[0]?.[3] ?? '';
    expect(body).toContain('<!-- tim:pr-review-guide -->');
    expect(body).toMatch(/<sub>Updated at \d{4}-\d{2}-\d{2}T/);
    expect(mockLog).toHaveBeenCalledWith(
      'Updated review guide comment for https://github.com/acme/repo/pull/42: https://comment/123'
    );
  });
  test('does not post a review when the project setting does not enable it', async () => {
    await handlePrReviewGuideCommentCommand('42', { executor: 'codex-cli' }, makeCommand());

    expect(mockGetProjectSetting).toHaveBeenCalledWith({}, 7, 'reviewGuideComment');
    expect(mockRunAutomaticPrReview).not.toHaveBeenCalled();
    expect(mockPostPullRequestComment).toHaveBeenCalled();
  });

  test('posts a review alongside the comment when the project setting enables it', async () => {
    mockGetProjectSetting.mockReturnValue({ enabled: true, postReview: true });

    await handlePrReviewGuideCommentCommand('42', { executor: 'codex-cli' }, makeCommand());

    const headSha = (await $`git rev-parse HEAD`.cwd(tempDir).text()).trim();
    expect(mockRunAutomaticPrReview).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 7,
        prStatusId: 99,
        baseDir: tempDir,
        baseSha: mergeBaseSha,
        reviewedSha: headSha,
        authToken: 'app-installation-token',
        metadata: expect.objectContaining({ prUrl: 'https://github.com/acme/repo/pull/42' }),
      })
    );
    expect(mockPostPullRequestComment).toHaveBeenCalled();
  });

  test('the --no-post-review option overrides the project setting', async () => {
    mockGetProjectSetting.mockReturnValue({ enabled: true, postReview: true });

    await handlePrReviewGuideCommentCommand(
      '42',
      { executor: 'codex-cli', postReview: false },
      makeCommand()
    );

    expect(mockRunAutomaticPrReview).not.toHaveBeenCalled();
  });

  test('passes dry run through to the automatic review', async () => {
    await handlePrReviewGuideCommentCommand(
      '42',
      { executor: 'codex-cli', dryRun: true, postReview: true },
      makeCommand()
    );

    expect(mockRunAutomaticPrReview).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true })
    );
    expect(mockPostPullRequestComment).not.toHaveBeenCalled();
  });

  test('skips the review when the guide comment already exists', async () => {
    mockGetProjectSetting.mockReturnValue({ enabled: true, postReview: true });
    mockFindPullRequestCommentByMarker.mockResolvedValue({ id: 456, htmlUrl: 'https://c/456' });

    await handlePrReviewGuideCommentCommand('42', { executor: 'codex-cli' }, makeCommand());

    expect(mockRunAutomaticPrReview).not.toHaveBeenCalled();
    expect(mockPostPullRequestComment).not.toHaveBeenCalled();
  });

  test('still posts the comment when the review fails, then reports the review error', async () => {
    mockRunAutomaticPrReview.mockRejectedValue(new Error('review exploded'));

    await expect(
      handlePrReviewGuideCommentCommand(
        '42',
        { executor: 'codex-cli', postReview: true },
        makeCommand()
      )
    ).rejects.toThrow('review exploded');

    expect(mockPostPullRequestComment).toHaveBeenCalled();
  });

  test('reports the comment error and warns about the review when both fail', async () => {
    mockRunAutomaticPrReview.mockRejectedValue(new Error('review exploded'));
    mockPostPullRequestComment.mockRejectedValue(new Error('comment exploded'));

    await expect(
      handlePrReviewGuideCommentCommand(
        '42',
        { executor: 'codex-cli', postReview: true },
        makeCommand()
      )
    ).rejects.toThrow('comment exploded');

    expect(mockWarn).toHaveBeenCalledWith('Automatic review failed: review exploded');
  });
  test('posts an in-progress status line, then edits it when the review is posted', async () => {
    let finishReview: () => void = () => {};
    mockRunAutomaticPrReview.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishReview = () =>
            resolve({
              reviewId: 1,
              issueCount: 3,
              githubReviewUrl: 'https://review/1',
              inlineCount: 2,
              appendedCount: 1,
            });
        })
    );
    // The review finishes only after the comment is posted.
    mockPostPullRequestComment.mockImplementation(async () => {
      finishReview();
      return { id: 123, htmlUrl: 'https://comment/123' };
    });

    await handlePrReviewGuideCommentCommand(
      '42',
      { executor: 'codex-cli', postReview: true },
      makeCommand()
    );

    const postedBody = mockPostPullRequestComment.mock.calls[0]?.[3] ?? '';
    expect(postedBody).toContain('> ⏳ An automated review is in progress.');
    expect(postedBody).toContain('Generated guide.');

    expect(mockUpdatePullRequestComment).toHaveBeenCalledTimes(1);
    const [owner, repo, commentId, updatedBody, auth] =
      mockUpdatePullRequestComment.mock.calls[0] ?? [];
    expect([owner, repo, commentId, auth]).toEqual([
      'acme',
      'repo',
      123,
      { authToken: 'app-installation-token' },
    ]);
    expect(updatedBody).toBe(
      '<!-- tim:pr-review-guide -->\n> 🔎 The automated review found 3 issues. [View the review](https://review/1).\n\n## Review Guide\n\nGenerated guide.\n'
    );
  });

  test('posts the final status directly when the review finishes first', async () => {
    mockRunAutomaticPrReview.mockResolvedValue({
      reviewId: 1,
      issueCount: 0,
      githubReviewUrl: 'https://review/1',
      inlineCount: 0,
      appendedCount: 0,
    });

    await handlePrReviewGuideCommentCommand(
      '42',
      { executor: 'codex-cli', postReview: true },
      makeCommand()
    );

    const postedBody = mockPostPullRequestComment.mock.calls[0]?.[3] ?? '';
    expect(postedBody).toContain(
      '> ✅ The automated review found no issues. [View the review](https://review/1).'
    );
    expect(mockUpdatePullRequestComment).not.toHaveBeenCalled();
  });

  test('marks the review as failed in the comment when the review fails', async () => {
    let failReview: () => void = () => {};
    mockRunAutomaticPrReview.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          failReview = () => reject(new Error('review exploded'));
        })
    );
    mockPostPullRequestComment.mockImplementation(async () => {
      failReview();
      return { id: 123, htmlUrl: 'https://comment/123' };
    });

    await expect(
      handlePrReviewGuideCommentCommand(
        '42',
        { executor: 'codex-cli', postReview: true },
        makeCommand()
      )
    ).rejects.toThrow('review exploded');

    expect(mockUpdatePullRequestComment.mock.calls[0]?.[3]).toContain(
      '> ⚠️ The automated review failed.'
    );
  });

  test('a status edit failure is only a warning', async () => {
    let finishReview: () => void = () => {};
    mockRunAutomaticPrReview.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishReview = () =>
            resolve({
              reviewId: 1,
              issueCount: 1,
              githubReviewUrl: null,
              inlineCount: 1,
              appendedCount: 0,
            });
        })
    );
    mockPostPullRequestComment.mockImplementation(async () => {
      finishReview();
      return { id: 123, htmlUrl: 'https://comment/123' };
    });
    mockUpdatePullRequestComment.mockRejectedValue(new Error('edit failed'));

    await handlePrReviewGuideCommentCommand(
      '42',
      { executor: 'codex-cli', postReview: true },
      makeCommand()
    );

    expect(mockWarn).toHaveBeenCalledWith(
      'Failed to update the review status in the guide comment: edit failed'
    );
  });

  test('has no status line when no review runs', async () => {
    await handlePrReviewGuideCommentCommand('42', { executor: 'codex-cli' }, makeCommand());

    expect(mockPostPullRequestComment.mock.calls[0]?.[3]).toBe(
      '<!-- tim:pr-review-guide -->\n## Review Guide\n\nGenerated guide.\n'
    );
  });
  test('review-only mode posts only a review and never touches the guide comment', async () => {
    mockFindPullRequestCommentByMarker.mockResolvedValue({ id: 456, htmlUrl: 'https://c/456' });

    await handlePrReviewGuideCommentCommand(
      '42',
      { executor: 'codex-cli', reviewOnly: true, triggerCommentId: 777 },
      makeCommand()
    );

    expect(mockFindPullRequestCommentByMarker).not.toHaveBeenCalled();
    expect(mockBuildExecutorAndLog).not.toHaveBeenCalled();
    expect(mockPostPullRequestComment).not.toHaveBeenCalled();
    expect(mockUpdatePullRequestComment).not.toHaveBeenCalled();
    expect(mockGetProjectSetting).not.toHaveBeenCalled();
    expect(mockRunAutomaticPrReview).toHaveBeenCalledWith(
      expect.objectContaining({
        baseSha: mergeBaseSha,
        authToken: 'app-installation-token',
        metadata: expect.objectContaining({ prNumber: 42 }),
      })
    );
    expect(mockAddIssueCommentReaction).toHaveBeenCalledTimes(1);
    expect(mockAddIssueCommentReaction).toHaveBeenCalledWith('acme', 'repo', 777, 'eyes', {
      authToken: 'app-installation-token',
    });
  });

  test('review-only mode adds a confused reaction when the review fails', async () => {
    mockRunAutomaticPrReview.mockRejectedValue(new Error('review exploded'));

    await expect(
      handlePrReviewGuideCommentCommand(
        '42',
        { executor: 'codex-cli', reviewOnly: true, triggerCommentId: 777 },
        makeCommand()
      )
    ).rejects.toThrow('review exploded');

    expect(mockAddIssueCommentReaction.mock.calls.map((call) => call[3])).toEqual([
      'eyes',
      'confused',
    ]);
  });

  test('a failed reaction is only a warning', async () => {
    mockAddIssueCommentReaction.mockRejectedValue(new Error('no permission'));

    await handlePrReviewGuideCommentCommand(
      '42',
      { executor: 'codex-cli', reviewOnly: true, triggerCommentId: 777 },
      makeCommand()
    );

    expect(mockWarn).toHaveBeenCalledWith(
      'Failed to add a eyes reaction to comment 777: no permission'
    );
    expect(mockRunAutomaticPrReview).toHaveBeenCalled();
  });

  test('review-only mode without a trigger comment adds no reactions', async () => {
    await handlePrReviewGuideCommentCommand(
      '42',
      { executor: 'codex-cli', reviewOnly: true },
      makeCommand()
    );

    expect(mockAddIssueCommentReaction).not.toHaveBeenCalled();
    expect(mockRunAutomaticPrReview).toHaveBeenCalled();
  });

  test('rejects conflicting and invalid review-only options before any work', async () => {
    await expect(
      handlePrReviewGuideCommentCommand(
        '42',
        { reviewOnly: true, postReview: false },
        makeCommand()
      )
    ).rejects.toThrow('--review-only cannot be used with --no-post-review.');
    await expect(
      handlePrReviewGuideCommentCommand(
        '42',
        { reviewOnly: true, triggerCommentId: Number.NaN },
        makeCommand()
      )
    ).rejects.toThrow('--trigger-comment-id must be a positive integer.');

    expect(mockGatherPrContext).not.toHaveBeenCalled();
  });
});

describe('guide comment review status', () => {
  test('formats each review state', () => {
    expect(formatAutoReviewStatus({ kind: 'failed' })).toBe('⚠️ The automated review failed.');
    expect(
      formatAutoReviewStatus({
        kind: 'posted',
        result: {
          reviewId: 1,
          issueCount: 1,
          githubReviewUrl: null,
          inlineCount: 1,
          appendedCount: 0,
        },
      })
    ).toBe('🔎 The automated review found 1 issue.');
  });

  test('keeps the Updated at footer below the guide', () => {
    expect(
      buildGuideCommentBody({
        guide: 'Guide',
        reviewStatus: 'Status',
        updatedAt: '2026-10-09T00:00:00.000Z',
      })
    ).toBe(
      '<!-- tim:pr-review-guide -->\n> Status\n\nGuide\n\n---\n<sub>Updated at 2026-10-09T00:00:00.000Z</sub>\n'
    );
  });
});
