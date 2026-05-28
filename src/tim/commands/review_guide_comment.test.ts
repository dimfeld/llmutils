import { beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../logging.js', () => ({
  log: vi.fn(),
  warn: vi.fn(),
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
import { log } from '../../logging.js';
import { getGitHubAppInstallationTokenForOwner } from '../../common/github/app_auth.js';
import { parsePrOrIssueNumber } from '../../common/github/identifiers.js';
import {
  findPullRequestCommentByMarker,
  parseOwnerRepoFromRepositoryId,
  postPullRequestComment,
  updatePullRequestComment,
} from '../../common/github/pull_requests.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { getDatabase } from '../db/database.js';
import { buildExecutorAndLog } from '../executors/index.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { gatherPrContext, checkoutPrBranch, resolvePrUrl } from '../utils/pr_context_gathering.js';
import { loadCustomReviewInstructions, resolveProjectContextForRepo } from './review_workflow.js';
import { handlePrReviewGuideCommentCommand } from './review_guide_comment.js';

const mockGetGitRoot = vi.mocked(getGitRoot);
const mockGetUsingJj = vi.mocked(getUsingJj);
const mockLog = vi.mocked(log);
const mockGetGitHubAppInstallationTokenForOwner = vi.mocked(getGitHubAppInstallationTokenForOwner);
const mockParsePrOrIssueNumber = vi.mocked(parsePrOrIssueNumber);
const mockFindPullRequestCommentByMarker = vi.mocked(findPullRequestCommentByMarker);
const mockParseOwnerRepoFromRepositoryId = vi.mocked(parseOwnerRepoFromRepositoryId);
const mockPostPullRequestComment = vi.mocked(postPullRequestComment);
const mockUpdatePullRequestComment = vi.mocked(updatePullRequestComment);
const mockLoadEffectiveConfig = vi.mocked(loadEffectiveConfig);
const mockGetDatabase = vi.mocked(getDatabase);
const mockBuildExecutorAndLog = vi.mocked(buildExecutorAndLog);
const mockGetRepositoryIdentity = vi.mocked(getRepositoryIdentity);
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
  let capturedPrompt = '';

  beforeEach(async () => {
    vi.clearAllMocks();
    capturedPrompt = '';
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-review-guide-comment-'));

    mockGetDatabase.mockReturnValue({} as any);
    mockGetGitRoot.mockResolvedValue(tempDir);
    mockGetUsingJj.mockResolvedValue(true);
    mockResolvePrUrl.mockResolvedValue('https://github.com/acme/repo/pull/42');
    mockParsePrOrIssueNumber.mockResolvedValue({ owner: 'acme', repo: 'repo', number: 42 });
    mockGetGitHubAppInstallationTokenForOwner.mockResolvedValue('app-installation-token');
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
      },
      prUrl: 'https://github.com/acme/repo/pull/42',
      prNumber: 42,
      owner: 'acme',
      repo: 'repo',
      baseBranch: 'main',
      headBranch: 'feature/review-guide',
      headSha: 'abc123',
    } as any);
    mockResolveProjectContextForRepo.mockResolvedValue({ repoRoot: tempDir } as any);
    mockGetRepositoryIdentity.mockResolvedValue({
      repositoryId: 'github:acme/repo',
    } as any);
    mockParseOwnerRepoFromRepositoryId.mockReturnValue({ owner: 'acme', repo: 'repo' });
    mockFindPullRequestCommentByMarker.mockResolvedValue(null);
    mockCheckoutPrBranch.mockResolvedValue(undefined);
    mockLoadCustomReviewInstructions.mockResolvedValue('');
    mockPostPullRequestComment.mockResolvedValue({ id: 123, htmlUrl: 'https://comment/123' });
    mockUpdatePullRequestComment.mockResolvedValue({ id: 123, htmlUrl: 'https://comment/123' });
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

  test('uses Git diff instructions after Git checkout in jj workspaces', async () => {
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
    expect(mockGetUsingJj).not.toHaveBeenCalled();
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
    expect(capturedPrompt).toContain("git merge-base 'origin/main' HEAD");
    expect(capturedPrompt).not.toContain('Repository is jj-based');
    expect(capturedPrompt).not.toContain('jj diff');
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
});
