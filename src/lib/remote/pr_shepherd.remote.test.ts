import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

import { clearGitHubTokenCache } from '$common/github/token.js';
import { invokeCommand } from '$lib/test-utils/invoke_command.js';
import { DATABASE_FILENAME, openDatabase } from '$tim/db/database.js';
import { upsertPrStatus } from '$tim/db/pr_status.js';
import { getOrCreateProject } from '$tim/db/project.js';

const { refreshPrStatus, setPullRequestDraftState, projectPrsRefresh } = vi.hoisted(() => ({
  refreshPrStatus: vi.fn(),
  setPullRequestDraftState: vi.fn(),
  projectPrsRefresh: vi.fn(),
}));

let currentDb: Database;

vi.mock('$lib/server/init.js', () => ({
  getServerContext: async () => ({
    config: { githubUsername: 'me' } as never,
    db: currentDb,
  }),
}));

vi.mock('$common/github/pr_status_service.js', async () => {
  const actual = await vi.importActual<typeof import('$common/github/pr_status_service.js')>(
    '$common/github/pr_status_service.js'
  );
  return { ...actual, refreshPrStatus };
});

vi.mock('$common/github/pull_requests.js', async () => {
  const actual = await vi.importActual<typeof import('$common/github/pull_requests.js')>(
    '$common/github/pull_requests.js'
  );
  return { ...actual, setPullRequestDraftState };
});

vi.mock('$lib/remote/project_prs.remote.js', () => ({
  getProjectPrs: () => ({ refresh: projectPrsRefresh }),
}));

describe('markPrReadyForReview', () => {
  const originalToken = process.env.GITHUB_TOKEN;
  let tempDir: string;
  let projectId: number;

  function addPr(prNumber: number, options: { author?: string; state?: string } = {}): void {
    upsertPrStatus(currentDb, {
      prUrl: `https://github.com/example/repo/pull/${prNumber}`,
      owner: 'example',
      repo: 'repo',
      prNumber,
      title: `PR ${prNumber}`,
      author: options.author ?? 'me',
      state: options.state ?? 'open',
      draft: true,
      lastFetchedAt: new Date().toISOString(),
    });
  }

  async function markReady(prNumber: number): Promise<{ draft: false }> {
    const { markPrReadyForReview } = await import('./pr_shepherd.remote.js');
    return invokeCommand(markPrReadyForReview, { projectId, prNumber });
  }

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-pr-shepherd-remote-test-'));
  });

  beforeEach(() => {
    currentDb = openDatabase(path.join(tempDir, `${crypto.randomUUID()}-${DATABASE_FILENAME}`));
    projectId = getOrCreateProject(currentDb, 'github.com__example__repo').id;
    refreshPrStatus.mockReset();
    setPullRequestDraftState.mockReset();
    projectPrsRefresh.mockReset();
    process.env.GITHUB_TOKEN = 'token';
    clearGitHubTokenCache();
  });

  afterEach(() => {
    currentDb.close(false);
    if (originalToken === undefined) {
      delete process.env.GITHUB_TOKEN;
    } else {
      process.env.GITHUB_TOKEN = originalToken;
    }
    clearGitHubTokenCache();
  });

  afterAll(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('marks the PR ready on GitHub and refreshes the cached status and the list', async () => {
    addPr(1);
    setPullRequestDraftState.mockResolvedValueOnce(true);

    await expect(markReady(1)).resolves.toEqual({ draft: false });

    expect(setPullRequestDraftState).toHaveBeenCalledWith('example', 'repo', 1, false);
    expect(refreshPrStatus).toHaveBeenCalledWith(
      currentDb,
      'https://github.com/example/repo/pull/1'
    );
    expect(projectPrsRefresh).toHaveBeenCalled();
  });

  test('succeeds and updates the list when only the status refresh fails', async () => {
    addPr(1);
    setPullRequestDraftState.mockResolvedValueOnce(true);
    refreshPrStatus.mockRejectedValueOnce(new Error('rate limited'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(markReady(1)).resolves.toEqual({ draft: false });

    expect(projectPrsRefresh).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('reports an error when GitHub refuses the change', async () => {
    addPr(1);
    setPullRequestDraftState.mockResolvedValueOnce(false);

    await expect(markReady(1)).rejects.toMatchObject({ status: 502 });

    expect(refreshPrStatus).not.toHaveBeenCalled();
    expect(projectPrsRefresh).not.toHaveBeenCalled();
  });

  test('requires a GitHub token', async () => {
    addPr(1);
    delete process.env.GITHUB_TOKEN;
    clearGitHubTokenCache();

    await expect(markReady(1)).rejects.toMatchObject({ status: 400 });

    expect(setPullRequestDraftState).not.toHaveBeenCalled();
  });

  test('rejects PRs by another author, closed PRs, and unknown PRs', async () => {
    addPr(2, { author: 'someone-else' });
    addPr(3, { state: 'closed' });

    await expect(markReady(2)).rejects.toMatchObject({ status: 400 });
    await expect(markReady(3)).rejects.toMatchObject({ status: 400 });
    await expect(markReady(404)).rejects.toMatchObject({ status: 404 });

    expect(setPullRequestDraftState).not.toHaveBeenCalled();
  });
});
