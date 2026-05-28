import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { getGitRoot } from '../../common/git.js';
import { parsePrOrIssueNumber } from '../../common/github/identifiers.js';
import { getGitHubAppInstallationTokenForOwner } from '../../common/github/app_auth.js';
import {
  isReviewGuideCommentEnabled,
  parseReviewGuideCommentProjectSetting,
  REVIEW_GUIDE_COMMENT_PROJECT_SETTING_KEY,
  type ReviewGuideCommentProjectSetting,
} from '../../common/github/review_guide_comment_setting.js';
import {
  findPullRequestCommentByMarker,
  parseOwnerRepoFromRepositoryId,
  postPullRequestComment,
  updatePullRequestComment,
} from '../../common/github/pull_requests.js';
import { log, warn } from '../../logging.js';
import { isTunnelActive } from '../../logging/tunnel_client.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { getDatabase } from '../db/database.js';
import { getProject, type Project } from '../db/project.js';
import { getProjectSetting } from '../db/project_settings.js';
import { getLinkedPlansByPrUrl } from '../db/pr_status.js';
import {
  buildExecutorAndLog,
  ClaudeCodeExecutorName,
  CodexCliExecutorName,
} from '../executors/index.js';
import { writeProjectSettingSet } from '../sync/write_router.js';
import { TMP_DIR } from '../plan_materialize.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { runWithHeadlessAdapterIfEnabled, updateHeadlessSessionInfo } from '../headless.js';
import { WorkspaceAutoSelector } from '../workspace/workspace_auto_selector.js';
import { WorkspaceLock } from '../workspace/workspace_lock.js';
import { gatherPrContext, checkoutPrBranch, resolvePrUrl } from '../utils/pr_context_gathering.js';
import { buildReviewGuideCommentPrompt, type PrReviewMetadata } from './review_pr_prompt.js';
import { loadCustomReviewInstructions, resolveProjectContextForRepo } from './review_workflow.js';

/** Hidden marker used to detect an existing review-guide comment so we post at most one per PR. */
export const REVIEW_GUIDE_COMMENT_MARKER = '<!-- tim:pr-review-guide -->';
const UPDATED_AT_FOOTER_PREFIX = 'Updated at';

interface RootCommandLike {
  parent?: RootCommandLike;
  opts?: () => {
    config?: string;
  };
}

export interface PrReviewGuideCommentOptions {
  executor?: string;
  model?: string;
  autoWorkspace?: boolean;
  nonInteractive?: boolean;
  terminalInput?: boolean;
  /** Set when invoked by the webhook trigger; only run if the project setting is enabled. */
  auto?: boolean;
  /** Re-post even if a review-guide comment already exists. */
  force?: boolean;
  /** Generate and print the guide, but do not post it to GitHub. */
  dryRun?: boolean;
  verbose?: boolean;
}

function getRootOptions(command: RootCommandLike | undefined): { config?: string } {
  let current = command;
  while (current?.parent) {
    current = current.parent;
  }
  return current?.opts?.() ?? {};
}

function resolveCommentExecutor(executor: string | undefined): string {
  if (executor === ClaudeCodeExecutorName || executor === CodexCliExecutorName) {
    return executor;
  }
  if (executor) {
    throw new Error(
      `Unknown executor "${executor}". Use "${ClaudeCodeExecutorName}" or "${CodexCliExecutorName}".`
    );
  }
  // The automatic guide comment is a short, single-pass task; default to codex-cli.
  return CodexCliExecutorName;
}

function buildPrMetadata(context: Awaited<ReturnType<typeof gatherPrContext>>): PrReviewMetadata {
  return {
    kind: 'pr',
    prUrl: context.prUrl,
    prNumber: context.prNumber,
    title: context.prStatus.title,
    author: context.prStatus.author,
    baseBranch: context.baseBranch,
    headBranch: context.headBranch,
    owner: context.owner,
    repo: context.repo,
  };
}

function updateReviewGuideCommentSessionInfo(
  db: Database,
  context: Awaited<ReturnType<typeof gatherPrContext>>
): void {
  const linkedPlan = getLinkedPlansByPrUrl(db, [context.prUrl]).get(context.prUrl)?.[0];

  updateHeadlessSessionInfo({
    linkedPrUrl: context.prUrl,
    linkedPrNumber: context.prNumber,
    linkedPrTitle: context.prStatus.title ?? undefined,
    linkedPlanId: linkedPlan?.planId,
    linkedPlanUuid: linkedPlan?.planUuid,
    linkedPlanTitle: linkedPlan?.title ?? undefined,
  });
}

async function resolveCurrentProject(cwd: string = process.cwd()): Promise<Project> {
  const repoIdentity = await getRepositoryIdentity({ cwd });
  const parsedRepositoryId = parseOwnerRepoFromRepositoryId(repoIdentity.repositoryId);
  if (!parsedRepositoryId) {
    throw new Error(
      `Cannot resolve current project: ${repoIdentity.repositoryId} is not a recognized GitHub repository.`
    );
  }

  const project = getProject(getDatabase(), repoIdentity.repositoryId);
  if (!project) {
    throw new Error(
      `Project not found for current repository: ${parsedRepositoryId.owner}/${parsedRepositoryId.repo}`
    );
  }
  return project;
}

function isProjectAutoReviewGuideCommentEnabled(db: Database, projectId: number): boolean {
  return isReviewGuideCommentEnabled(
    getProjectSetting(db, projectId, REVIEW_GUIDE_COMMENT_PROJECT_SETTING_KEY)
  );
}

async function writeReviewGuideCommentSetting(
  enabled: boolean,
  command: RootCommandLike | undefined
): Promise<Project> {
  const globalOpts = getRootOptions(command);
  const config = await loadEffectiveConfig(globalOpts.config, { cwd: process.cwd() });
  const project = await resolveCurrentProject();
  const setting: ReviewGuideCommentProjectSetting = { enabled };
  await writeProjectSettingSet(
    getDatabase(),
    config,
    project.id,
    REVIEW_GUIDE_COMMENT_PROJECT_SETTING_KEY,
    setting,
    'latest'
  );
  return project;
}

export async function handlePrReviewGuideCommentEnableCommand(
  _options: Record<string, never>,
  command: RootCommandLike | undefined
): Promise<void> {
  const project = await writeReviewGuideCommentSetting(true, command);
  log(`Enabled automatic PR review-guide comments for ${project.repository_id}.`);
}

export async function handlePrReviewGuideCommentDisableCommand(
  _options: Record<string, never>,
  command: RootCommandLike | undefined
): Promise<void> {
  const project = await writeReviewGuideCommentSetting(false, command);
  log(`Disabled automatic PR review-guide comments for ${project.repository_id}.`);
}

export async function handlePrReviewGuideCommentStatusCommand(): Promise<void> {
  const project = await resolveCurrentProject();
  const setting = parseReviewGuideCommentProjectSetting(
    getProjectSetting(getDatabase(), project.id, REVIEW_GUIDE_COMMENT_PROJECT_SETTING_KEY)
  );
  const status = setting?.enabled === true ? 'enabled' : 'disabled';
  log(`Automatic PR review-guide comments are ${status} for ${project.repository_id}.`);
}

export async function handlePrReviewGuideCommentCommand(
  prArg: string | undefined,
  options: PrReviewGuideCommentOptions,
  command: RootCommandLike
): Promise<void> {
  if (!prArg) {
    throw new Error('Provide a PR URL or number.');
  }

  const globalOpts = getRootOptions(command);
  const db: Database = getDatabase();
  const initialRepoRoot = await getGitRoot(process.cwd());
  const config = await loadEffectiveConfig(globalOpts.config, { cwd: initialRepoRoot });
  const tunnelActive = isTunnelActive();

  // When invoked by the webhook trigger, respect the project opt-in before doing any work.
  if (options.auto) {
    const project = await resolveCurrentProject(initialRepoRoot);
    if (!isProjectAutoReviewGuideCommentEnabled(db, project.id)) {
      log('Automatic PR review guide comments are disabled for this project; skipping.');
      return;
    }
  }

  await runWithHeadlessAdapterIfEnabled({
    enabled: !tunnelActive,
    command: 'review-guide-comment',
    interactive: options.nonInteractive !== true,
    callback: async () => {
      const executorName = resolveCommentExecutor(options.executor);

      const prUrl = await resolvePrUrl({
        db,
        prUrlOrNumber: prArg,
        cwd: initialRepoRoot,
      });
      const parsedPr = await parsePrOrIssueNumber(prUrl);
      if (!parsedPr) {
        throw new Error(`Invalid GitHub pull request identifier: ${prUrl}`);
      }
      const appToken = await getGitHubAppInstallationTokenForOwner(parsedPr.owner);
      if (!appToken) {
        throw new Error(
          `GitHub App installation token is not configured for ${parsedPr.owner}. Run \`tim github-app set\` from a repository owned by an installed account, or pass an explicit installation with \`tim github-app token --owner ${parsedPr.owner}\`.`
        );
      }

      const prContext = await gatherPrContext({
        db,
        prUrlOrNumber: prUrl,
        cwd: initialRepoRoot,
        authToken: appToken,
      });
      updateReviewGuideCommentSessionInfo(db, prContext);

      // Validate that the current repository is the one the PR belongs to before checking out
      // its branch, mirroring `tim pr review-guide`.
      const { repoRoot } = await resolveProjectContextForRepo(db, initialRepoRoot);
      const repoIdentity = await getRepositoryIdentity({ cwd: repoRoot });
      const parsedRepositoryId = parseOwnerRepoFromRepositoryId(repoIdentity.repositoryId);
      if (!parsedRepositoryId) {
        throw new Error(
          `Cannot validate repository identity: ${repoIdentity.repositoryId} is not a recognized GitHub repository. This command only works with GitHub PRs.`
        );
      }
      if (
        parsedRepositoryId.owner.toLowerCase() !== prContext.owner.toLowerCase() ||
        parsedRepositoryId.repo.toLowerCase() !== prContext.repo.toLowerCase()
      ) {
        throw new Error(
          `PR ${prContext.prUrl} belongs to ${prContext.owner}/${prContext.repo}, but the current repository is ${parsedRepositoryId.owner}/${parsedRepositoryId.repo}. Run this command from inside the matching repository.`
        );
      }

      // Idempotency: post at most one guide comment per PR unless --force is given.
      const existingComment =
        options.dryRun === true
          ? null
          : await findPullRequestCommentByMarker(
              prContext.owner,
              prContext.repo,
              prContext.prNumber,
              REVIEW_GUIDE_COMMENT_MARKER,
              { authToken: appToken }
            );
      if (!options.force && existingComment) {
        log(
          `Review guide comment already exists for ${prContext.prUrl} (${existingComment.htmlUrl ?? `#${existingComment.id}`}); skipping. Pass --force to update it.`
        );
        return;
      }

      let baseDir = initialRepoRoot;
      if (options.autoWorkspace === true) {
        const selector = new WorkspaceAutoSelector(baseDir, config);
        const taskId = `pr-review-guide-comment-${prContext.prNumber}-${Date.now()}`;
        const selectedWorkspace = await selector.selectWorkspace(taskId, undefined, {
          interactive: options.nonInteractive !== true,
          createBranch: false,
        });
        if (!selectedWorkspace) {
          throw new Error(
            'Failed to select or create a workspace for the PR review guide comment.'
          );
        }

        const lockInfo = await WorkspaceLock.acquireLock(
          selectedWorkspace.workspace.workspacePath,
          'tim pr review-guide-comment',
          {
            type: 'pid',
            ...(selectedWorkspace.isNew ? { allowPersistentToPidTransition: true } : {}),
          }
        );
        WorkspaceLock.setupCleanupHandlers(
          selectedWorkspace.workspace.workspacePath,
          lockInfo.type
        );
        baseDir = selectedWorkspace.workspace.workspacePath;
        updateHeadlessSessionInfo({ workspacePath: baseDir });
      }

      await checkoutPrBranch({
        branch: prContext.headBranch,
        baseBranch: prContext.baseBranch,
        prNumber: prContext.prNumber,
        skipDirtyCheck: options.autoWorkspace === true,
        cwd: baseDir,
      });

      // checkoutPrBranch uses Git fetch/checkout even for colocated jj repositories, so the
      // executor must diff against the detached Git HEAD instead of the jj working-copy revision.
      const useJjDiffInstructions = false;
      const customInstructions = await loadCustomReviewInstructions(config, baseDir);
      const metadata = buildPrMetadata(prContext);

      const outputDir = path.join(baseDir, TMP_DIR);
      const outputPath = path.join(outputDir, `pr-review-guide-comment-${prContext.prNumber}.md`);
      await fs.mkdir(outputDir, { recursive: true });

      const executor = buildExecutorAndLog(
        executorName,
        {
          baseDir,
          model: options.model,
          terminalInput: false,
          noninteractive: true,
        },
        config,
        executorName === ClaudeCodeExecutorName ? { reasoningEffort: 'medium' } : {}
      );

      try {
        await executor.execute(
          buildReviewGuideCommentPrompt({
            metadata,
            outputPath,
            useJj: useJjDiffInstructions,
            customInstructions,
          }),
          {
            planId: `pr-${prContext.prNumber}`,
            planTitle: `PR review guide comment: ${prContext.prUrl}`,
            planFilePath: '',
            captureOutput: 'result',
            executionMode: 'bare',
          }
        );

        let guide: string;
        try {
          guide = (await fs.readFile(outputPath, 'utf8')).trim();
        } catch (err) {
          throw new Error(
            `The executor completed but did not write the review guide to ${outputPath}.`,
            { cause: err }
          );
        }

        if (!guide) {
          throw new Error('The executor produced an empty review guide; nothing to post.');
        }

        log(guide);

        if (options.dryRun === true) {
          log('Dry run: not posting review guide comment.');
          return;
        }

        if (options.force && existingComment) {
          const body = `${REVIEW_GUIDE_COMMENT_MARKER}\n${guide}\n\n---\n<sub>${UPDATED_AT_FOOTER_PREFIX} ${new Date().toISOString()}</sub>\n`;
          const updated = await updatePullRequestComment(
            prContext.owner,
            prContext.repo,
            existingComment.id,
            body,
            { authToken: appToken }
          );
          log(
            `Updated review guide comment for ${prContext.prUrl}: ${updated.htmlUrl ?? `comment #${updated.id}`}`
          );
        } else {
          const body = `${REVIEW_GUIDE_COMMENT_MARKER}\n${guide}\n`;
          const posted = await postPullRequestComment(
            prContext.owner,
            prContext.repo,
            prContext.prNumber,
            body,
            { authToken: appToken }
          );
          log(
            `Posted review guide comment to ${prContext.prUrl}: ${posted.htmlUrl ?? `comment #${posted.id}`}`
          );
        }
      } finally {
        await fs
          .rm(outputPath, { force: true })
          .catch((err) => warn(`Failed to clean up ${outputPath}: ${String(err)}`));
      }
    },
  });
}
