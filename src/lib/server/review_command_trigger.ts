import type { Database } from 'bun:sqlite';

import { constructGitHubRepositoryId } from '$common/github/pull_requests.js';
import {
  isReviewCommandEnabled,
  REVIEW_COMMAND_PROJECT_SETTING_KEY,
  type ReviewCommandRequest,
} from '$common/github/review_command.js';

import { loadEffectiveConfig } from '../../tim/configLoader.js';
import { getProject } from '../../tim/db/project.js';
import { getProjectSetting } from '../../tim/db/project_settings.js';
import { getPrimaryWorkspacePath } from './db_queries.js';
import { spawnPrReviewCommandProcess } from './plan_actions.js';

/**
 * For each `/tim review` PR comment, spawn a detached `tim pr review-guide-comment
 * --review-only` process in the project's primary workspace. The spawn is gated on the
 * global githubWebhooks.reviewCommands config (default false) and the project-level
 * reviewCommand setting. Webhook ingest has already checked the comment author and the
 * side-effect cutoff.
 */
export async function triggerReviewCommands(
  db: Database,
  requests: ReviewCommandRequest[]
): Promise<void> {
  for (const request of requests) {
    try {
      const project = getProject(db, constructGitHubRepositoryId(request.owner, request.repo));
      if (!project) {
        console.info(
          `[review-command] skipping /tim review on ${request.prUrl}: ${request.owner}/${request.repo} is not a known project`
        );
        continue;
      }

      const primaryWorkspacePath = getPrimaryWorkspacePath(db, project.id);
      if (!primaryWorkspacePath) {
        console.warn(
          `[review-command] No primary workspace for ${request.owner}/${request.repo}; skipping PR #${request.prNumber}`
        );
        continue;
      }

      const config = await loadEffectiveConfig(undefined, { cwd: primaryWorkspacePath });
      if (config.githubWebhooks?.reviewCommands !== true) {
        console.info(
          `[review-command] skipping /tim review on ${request.prUrl}: githubWebhooks.reviewCommands is not enabled on this machine`
        );
        continue;
      }

      if (
        !isReviewCommandEnabled(
          getProjectSetting(db, project.id, REVIEW_COMMAND_PROJECT_SETTING_KEY)
        )
      ) {
        console.info(
          `[review-command] skipping /tim review on ${request.prUrl}: the project has not enabled it (run \`tim pr review-command enable\`)`
        );
        continue;
      }

      const result = await spawnPrReviewCommandProcess(
        request.prNumber,
        request.commentId,
        primaryWorkspacePath
      );
      if (result.success) {
        console.info(
          `[review-command] Started review for ${request.prUrl} requested by ${request.commenter}`
        );
      } else {
        console.error(
          `[review-command] Failed to start review for ${request.prUrl}: ${result.error}`
        );
      }
    } catch (err) {
      console.error(
        `[review-command] Error handling PR #${request.prNumber} for ${request.owner}/${request.repo}:`,
        err
      );
    }
  }
}
