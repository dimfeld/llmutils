import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { ReadyForReviewPr } from '$common/github/webhook_ingest.js';

vi.mock('../../tim/db/project.js', () => ({
  getProject: vi.fn(),
}));
vi.mock('../../tim/db/project_settings.js', () => ({
  getProjectSetting: vi.fn(),
}));
vi.mock('./db_queries.js', () => ({
  getPrimaryWorkspacePath: vi.fn(),
}));
vi.mock('./plan_actions.js', () => ({
  spawnPrReviewGuideCommentProcess: vi.fn(),
}));
vi.mock('../../tim/configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(),
}));

import { loadEffectiveConfig } from '../../tim/configLoader.js';
import { getProject } from '../../tim/db/project.js';
import { getProjectSetting } from '../../tim/db/project_settings.js';
import { getPrimaryWorkspacePath } from './db_queries.js';
import { spawnPrReviewGuideCommentProcess } from './plan_actions.js';
import { triggerReviewGuideComments } from './review_guide_comment_trigger.js';

const READY_PR: ReadyForReviewPr = {
  owner: 'example',
  repo: 'repo',
  prNumber: 7,
  prUrl: 'https://github.com/example/repo/pull/7',
  readyForReviewAt: '2026-01-01T12:00:00.000Z',
};

const fakeDb = {} as never;

describe('triggerReviewGuideComments', () => {
  beforeEach(() => {
    vi.mocked(getProject).mockReturnValue({ id: 1 } as never);
    vi.mocked(getProjectSetting).mockReturnValue({ enabled: true });
    vi.mocked(getPrimaryWorkspacePath).mockReturnValue('/workspaces/primary');
    vi.mocked(loadEffectiveConfig).mockResolvedValue({
      githubWebhooks: { reviewGuideComments: true },
    } as never);
    vi.mocked(spawnPrReviewGuideCommentProcess).mockResolvedValue({
      success: true,
      planId: 7,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('spawns the review guide comment process when enabled', async () => {
    await triggerReviewGuideComments(fakeDb, [READY_PR]);

    expect(spawnPrReviewGuideCommentProcess).toHaveBeenCalledWith(7, '/workspaces/primary');
  });

  test('does not spawn when the global config setting is disabled', async () => {
    vi.mocked(loadEffectiveConfig).mockResolvedValue({
      githubWebhooks: { reviewGuideComments: false },
    } as never);

    await triggerReviewGuideComments(fakeDb, [READY_PR]);

    expect(getProjectSetting).not.toHaveBeenCalled();
    expect(spawnPrReviewGuideCommentProcess).not.toHaveBeenCalled();
  });

  test('does not spawn when the ready event is before the side-effect cutoff', async () => {
    vi.mocked(loadEffectiveConfig).mockResolvedValue({
      githubWebhooks: {
        reviewGuideComments: true,
        ignoreSideEffectsBefore: '2026-01-01T12:00:01.000Z',
      },
    } as never);

    await triggerReviewGuideComments(fakeDb, [READY_PR]);

    expect(getProjectSetting).not.toHaveBeenCalled();
    expect(spawnPrReviewGuideCommentProcess).not.toHaveBeenCalled();
  });

  test('does not spawn when the global config setting is absent', async () => {
    vi.mocked(loadEffectiveConfig).mockResolvedValue({} as never);

    await triggerReviewGuideComments(fakeDb, [READY_PR]);

    expect(getProjectSetting).not.toHaveBeenCalled();
    expect(spawnPrReviewGuideCommentProcess).not.toHaveBeenCalled();
  });

  test('does not spawn when the project setting is disabled', async () => {
    vi.mocked(getProjectSetting).mockReturnValue({ enabled: false });

    await triggerReviewGuideComments(fakeDb, [READY_PR]);

    expect(spawnPrReviewGuideCommentProcess).not.toHaveBeenCalled();
  });

  test('does not spawn when the project setting is absent', async () => {
    vi.mocked(getProjectSetting).mockReturnValue(null);

    await triggerReviewGuideComments(fakeDb, [READY_PR]);

    expect(spawnPrReviewGuideCommentProcess).not.toHaveBeenCalled();
  });

  test('does not spawn when there is no primary workspace', async () => {
    vi.mocked(getPrimaryWorkspacePath).mockReturnValue(null);

    await triggerReviewGuideComments(fakeDb, [READY_PR]);

    expect(getProjectSetting).not.toHaveBeenCalled();
    expect(spawnPrReviewGuideCommentProcess).not.toHaveBeenCalled();
  });

  test('skips PRs for unknown projects', async () => {
    vi.mocked(getProject).mockReturnValue(undefined as never);

    await triggerReviewGuideComments(fakeDb, [READY_PR]);

    expect(getPrimaryWorkspacePath).not.toHaveBeenCalled();
    expect(spawnPrReviewGuideCommentProcess).not.toHaveBeenCalled();
  });
});
