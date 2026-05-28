import type { Database } from 'bun:sqlite';

import { constructGitHubRepositoryId } from '$common/github/pull_requests.js';
import type { ReadyForReviewPr } from '$common/github/webhook_ingest.js';
import {
  isReviewGuideCommentEnabled,
  REVIEW_GUIDE_COMMENT_PROJECT_SETTING_KEY,
} from '$common/github/review_guide_comment_setting.js';

import { getProject } from '../../tim/db/project.js';
import { getProjectSetting } from '../../tim/db/project_settings.js';
import { getPrimaryWorkspacePath } from './db_queries.js';
import { spawnPrReviewGuideCommentProcess } from './plan_actions.js';

/**
 * For each PR that just became ready for review, spawn a detached `tim pr
 * review-guide-comment` process in the project's primary workspace. The spawned
 * command is gated on the project-level reviewGuideComment setting (checked here
 * to avoid spawning when disabled, and again inside the command).
 */
export async function triggerReviewGuideComments(
  db: Database,
  readyPrs: ReadyForReviewPr[]
): Promise<void> {
  for (const pr of readyPrs) {
    try {
      const project = getProject(db, constructGitHubRepositoryId(pr.owner, pr.repo));
      if (!project) {
        continue;
      }

      const primaryWorkspacePath = getPrimaryWorkspacePath(db, project.id);
      if (!primaryWorkspacePath) {
        console.warn(
          `[review-guide-comment] No primary workspace for ${pr.owner}/${pr.repo}; skipping PR #${pr.prNumber}`
        );
        continue;
      }

      if (
        !isReviewGuideCommentEnabled(
          getProjectSetting(db, project.id, REVIEW_GUIDE_COMMENT_PROJECT_SETTING_KEY)
        )
      ) {
        continue;
      }

      const result = await spawnPrReviewGuideCommentProcess(pr.prNumber, primaryWorkspacePath);
      if (result.success) {
        console.info(`[review-guide-comment] Started review guide comment for ${pr.prUrl}`);
      } else {
        console.error(
          `[review-guide-comment] Failed to start review guide comment for ${pr.prUrl}: ${result.error}`
        );
      }
    } catch (err) {
      console.error(
        `[review-guide-comment] Error handling PR #${pr.prNumber} for ${pr.owner}/${pr.repo}:`,
        err
      );
    }
  }
}
