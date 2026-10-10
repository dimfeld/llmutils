import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { ReviewCommandRequest } from '$common/github/review_command.js';

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
  spawnPrReviewCommandProcess: vi.fn(),
}));
vi.mock('../../tim/configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(),
}));

import { loadEffectiveConfig } from '../../tim/configLoader.js';
import { getProject } from '../../tim/db/project.js';
import { getProjectSetting } from '../../tim/db/project_settings.js';
import { getPrimaryWorkspacePath } from './db_queries.js';
import { spawnPrReviewCommandProcess } from './plan_actions.js';
import { triggerReviewCommands } from './review_command_trigger.js';

const REQUEST: ReviewCommandRequest = {
  owner: 'example',
  repo: 'repo',
  prNumber: 7,
  prUrl: 'https://github.com/example/repo/pull/7',
  commentId: 9001,
  commenter: 'dana',
  requestedAt: '2026-01-01T12:00:00.000Z',
};

const fakeDb = {} as never;

describe('triggerReviewCommands', () => {
  beforeEach(() => {
    vi.mocked(getProject).mockReturnValue({ id: 1 } as never);
    vi.mocked(getProjectSetting).mockReturnValue({ enabled: true });
    vi.mocked(getPrimaryWorkspacePath).mockReturnValue('/workspaces/primary');
    vi.mocked(loadEffectiveConfig).mockResolvedValue({
      githubWebhooks: { reviewCommands: true },
    } as never);
    vi.mocked(spawnPrReviewCommandProcess).mockResolvedValue({ success: true, planId: 7 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('spawns a review-only process with the trigger comment when enabled', async () => {
    await triggerReviewCommands(fakeDb, [REQUEST]);

    expect(getProjectSetting).toHaveBeenCalledWith(fakeDb, 1, 'reviewCommand');
    expect(spawnPrReviewCommandProcess).toHaveBeenCalledWith(7, 9001, '/workspaces/primary');
  });

  test('does not spawn when the global config setting is off or absent', async () => {
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
    for (const config of [{ githubWebhooks: { reviewCommands: false } }, {}]) {
      vi.mocked(loadEffectiveConfig).mockResolvedValue(config as never);
      await triggerReviewCommands(fakeDb, [REQUEST]);
    }

    expect(consoleInfo).toHaveBeenCalledWith(
      '[review-command] skipping /tim review on https://github.com/example/repo/pull/7: githubWebhooks.reviewCommands is not enabled on this machine'
    );
    consoleInfo.mockRestore();
    expect(getProjectSetting).not.toHaveBeenCalled();
    expect(spawnPrReviewCommandProcess).not.toHaveBeenCalled();
  });

  test('does not spawn when the project setting is off or absent', async () => {
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
    for (const setting of [{ enabled: false }, null]) {
      vi.mocked(getProjectSetting).mockReturnValue(setting);
      await triggerReviewCommands(fakeDb, [REQUEST]);
    }

    expect(consoleInfo).toHaveBeenCalledWith(
      '[review-command] skipping /tim review on https://github.com/example/repo/pull/7: the project has not enabled it (run `tim pr review-command enable`)'
    );
    consoleInfo.mockRestore();

    expect(spawnPrReviewCommandProcess).not.toHaveBeenCalled();
  });

  test('does not spawn for unknown projects or projects without a primary workspace', async () => {
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(getProject).mockReturnValueOnce(null as never);
    await triggerReviewCommands(fakeDb, [REQUEST]);
    expect(consoleInfo).toHaveBeenCalledWith(
      '[review-command] skipping /tim review on https://github.com/example/repo/pull/7: example/repo is not a known project'
    );
    consoleInfo.mockRestore();
    vi.mocked(getPrimaryWorkspacePath).mockReturnValueOnce(null);
    await triggerReviewCommands(fakeDb, [REQUEST]);
    expect(consoleWarn).toHaveBeenCalledWith(
      '[review-command] No primary workspace for example/repo; skipping PR #7'
    );
    consoleWarn.mockRestore();

    expect(spawnPrReviewCommandProcess).not.toHaveBeenCalled();
  });

  test('one failing request does not stop the others', async () => {
    vi.mocked(spawnPrReviewCommandProcess)
      .mockRejectedValueOnce(new Error('spawn failed'))
      .mockResolvedValueOnce({ success: true, planId: 8 });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await triggerReviewCommands(fakeDb, [REQUEST, { ...REQUEST, prNumber: 8, commentId: 9002 }]);

    expect(spawnPrReviewCommandProcess).toHaveBeenLastCalledWith(8, 9002, '/workspaces/primary');
    consoleError.mockRestore();
  });
});
