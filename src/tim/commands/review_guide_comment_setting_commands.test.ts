import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  isReviewGuideCommentPostReviewEnabled,
  parseReviewGuideCommentProjectSetting,
} from '../../common/github/review_guide_comment_setting.js';
import { openDatabase } from '../db/database.js';
import { getOrCreateProject } from '../db/project.js';
import { getProjectSetting } from '../db/project_settings.js';

const mocks = vi.hoisted(() => ({ db: null as Database | null }));

vi.mock('../../logging.js', () => ({
  log: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../db/database.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db/database.js')>()),
  getDatabase: () => mocks.db,
}));

vi.mock('../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(async () => ({})),
}));

vi.mock('../assignments/workspace_identifier.js', () => ({
  getRepositoryIdentity: vi.fn(async () => ({ repositoryId: 'github.com__acme__repo' })),
}));

import {
  handlePrReviewCommandDisableCommand,
  handlePrReviewCommandEnableCommand,
  handlePrReviewGuideCommentDisableCommand,
  handlePrReviewGuideCommentEnableCommand,
} from './review_guide_comment.js';

describe('parseReviewGuideCommentProjectSetting', () => {
  test('reads postReview and ignores values that are not booleans', () => {
    expect(parseReviewGuideCommentProjectSetting({ enabled: true, postReview: true })).toEqual({
      enabled: true,
      postReview: true,
    });
    expect(parseReviewGuideCommentProjectSetting({ enabled: true, postReview: 'yes' })).toEqual({
      enabled: true,
      postReview: undefined,
    });
    expect(isReviewGuideCommentPostReviewEnabled({ enabled: true })).toBe(false);
    expect(isReviewGuideCommentPostReviewEnabled(null)).toBe(false);
  });
});

describe('review-guide-comment enable/disable', () => {
  let projectId: number;

  beforeEach(() => {
    mocks.db = openDatabase(':memory:');
    projectId = getOrCreateProject(mocks.db, 'github.com__acme__repo').id;
  });

  afterEach(() => {
    mocks.db?.close(false);
    mocks.db = null;
  });

  function readSetting(): unknown {
    return getProjectSetting(mocks.db!, projectId, 'reviewGuideComment');
  }

  test('enable --review turns on reviews, and later commands keep that value', async () => {
    await handlePrReviewGuideCommentEnableCommand({ review: true }, undefined);
    expect(readSetting()).toEqual({ enabled: true, postReview: true });

    await handlePrReviewGuideCommentDisableCommand({}, undefined);
    expect(readSetting()).toEqual({ enabled: false, postReview: true });

    await handlePrReviewGuideCommentEnableCommand({}, undefined);
    expect(readSetting()).toEqual({ enabled: true, postReview: true });

    await handlePrReviewGuideCommentEnableCommand({ review: false }, undefined);
    expect(readSetting()).toEqual({ enabled: true, postReview: false });
  });

  test('enable without --review does not turn on reviews', async () => {
    await handlePrReviewGuideCommentEnableCommand({}, undefined);
    expect(readSetting()).toEqual({ enabled: true });
  });

  test('review-command enable and disable write their own setting', async () => {
    await handlePrReviewGuideCommentEnableCommand({}, undefined);
    await handlePrReviewCommandEnableCommand({}, undefined);
    expect(getProjectSetting(mocks.db!, projectId, 'reviewCommand')).toEqual({ enabled: true });

    await handlePrReviewCommandDisableCommand({}, undefined);
    expect(getProjectSetting(mocks.db!, projectId, 'reviewCommand')).toEqual({ enabled: false });
    // The guide comment setting is separate.
    expect(readSetting()).toEqual({ enabled: true });
  });
});
