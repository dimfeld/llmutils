import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { $ } from 'bun';
import type { Database } from 'bun:sqlite';
import { getGitRoot, getUsingJj } from '../../common/git.js';
import { parsePrOrIssueNumber } from '../../common/github/identifiers.js';
import { getGitHubAppInstallationTokenForOwner } from '../../common/github/app_auth.js';
import {
  isReviewCommandEnabled,
  REVIEW_COMMAND_PROJECT_SETTING_KEY,
  type ReviewCommandProjectSetting,
} from '../../common/github/review_command.js';
import {
  isReviewGuideCommentPostReviewEnabled,
  parseReviewGuideCommentProjectSetting,
  REVIEW_GUIDE_COMMENT_PROJECT_SETTING_KEY,
  type ReviewGuideCommentProjectSetting,
} from '../../common/github/review_guide_comment_setting.js';
import {
  addIssueCommentReaction,
  findPullRequestCommentByMarker,
  type IssueCommentReaction,
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
import {
  buildReviewGuideCommentPrompt,
  JJ_NON_TEST_CHANGE_STATS_FILESET,
  type PrReviewMetadata,
} from './review_pr_prompt.js';
import { loadCustomReviewInstructions, resolveProjectContextForRepo } from './review_workflow.js';
import { buildTimWorkspaceCommandEnvironmentOptionsForPath } from '../environment_options.js';
import { LATEST_GPT5_MODEL } from '../constants.js';
import type { TimConfig } from '../configSchema.js';
import { runAutomaticPrReview, type AutomaticPrReviewResult } from './review_guide_auto_review.js';

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
  /** Re-post even if a review-guide comment already exists. */
  force?: boolean;
  /** Generate and print the guide, but do not post it to GitHub. */
  dryRun?: boolean;
  /**
   * Also generate review issues and post them as a GitHub review. When unset, the
   * project's reviewGuideComment.postReview setting decides.
   */
  postReview?: boolean;
  /**
   * Post only a new automatic review. Do not post, check for, or edit a guide comment.
   * Used by the `/tim review` PR comment command.
   */
  reviewOnly?: boolean;
  /** PR comment that requested the review. It gets 👀 at the start and 😕 on failure. */
  triggerCommentId?: number;
  verbose?: boolean;
}

function getRootOptions(command: RootCommandLike | undefined): { config?: string } {
  let current = command;
  while (current?.parent) {
    current = current.parent;
  }
  return current?.opts?.() ?? {};
}

function resolveCommentExecutor(executor: string | undefined, configuredExecutor?: string): string {
  const selectedExecutor = executor ?? configuredExecutor;
  if (selectedExecutor === ClaudeCodeExecutorName || selectedExecutor === CodexCliExecutorName) {
    return selectedExecutor;
  }
  if (selectedExecutor) {
    throw new Error(
      `Unknown executor "${selectedExecutor}". Use "${ClaudeCodeExecutorName}" or "${CodexCliExecutorName}".`
    );
  }
  // The automatic guide comment is a short, single-pass task; default to codex-cli.
  return CodexCliExecutorName;
}

function buildPrMetadata(
  context: Awaited<ReturnType<typeof gatherPrContext>>,
  baseSha: string
): PrReviewMetadata {
  return {
    kind: 'pr',
    prUrl: context.prUrl,
    prNumber: context.prNumber,
    title: context.prStatus.title,
    author: context.prStatus.author,
    baseBranch: context.baseBranch,
    baseSha,
    headBranch: context.headBranch,
    owner: context.owner,
    repo: context.repo,
  };
}

async function loadJjNonTestChangeStats(baseDir: string, baseSha: string): Promise<string | null> {
  if (!(await getUsingJj(baseDir))) {
    return null;
  }

  const proc = Bun.spawn(
    ['jj', 'diff', '--stat', '-f', baseSha, JJ_NON_TEST_CHANGE_STATS_FILESET],
    {
      cwd: baseDir,
      stdout: 'pipe',
      stderr: 'pipe',
    }
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    warn(
      `Failed to compute jj non-test change stats for review guide comment: ${stderr.trim() || `exit code ${exitCode}`}`
    );
    return null;
  }

  const trimmed = stdout.trim();
  return trimmed || null;
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

async function writeReviewGuideCommentSetting(
  patch: ReviewGuideCommentProjectSetting,
  command: RootCommandLike | undefined
): Promise<{ project: Project; setting: ReviewGuideCommentProjectSetting }> {
  const globalOpts = getRootOptions(command);
  const config = await loadEffectiveConfig(globalOpts.config, { cwd: process.cwd() });
  const project = await resolveCurrentProject();
  const db = getDatabase();
  const existing = parseReviewGuideCommentProjectSetting(
    getProjectSetting(db, project.id, REVIEW_GUIDE_COMMENT_PROJECT_SETTING_KEY)
  );
  const setting: ReviewGuideCommentProjectSetting = { ...existing, ...patch };
  await writeProjectSettingSet(
    db,
    config,
    project.id,
    REVIEW_GUIDE_COMMENT_PROJECT_SETTING_KEY,
    setting,
    'latest'
  );
  return { project, setting };
}

export interface PrReviewGuideCommentEnableOptions {
  /** Sets the postReview field. Named `review` so it does not collide with the parent command's --post-review. */
  review?: boolean;
}

export async function handlePrReviewGuideCommentEnableCommand(
  options: PrReviewGuideCommentEnableOptions,
  command: RootCommandLike | undefined
): Promise<void> {
  const { project, setting } = await writeReviewGuideCommentSetting(
    {
      enabled: true,
      ...(options.review !== undefined ? { postReview: options.review } : {}),
    },
    command
  );
  log(`Enabled automatic PR review-guide comments for ${project.repository_id}.`);
  log(
    `Automatic reviews with inline issue comments are ${setting.postReview === true ? 'enabled' : 'disabled'}.`
  );
}

export async function handlePrReviewGuideCommentDisableCommand(
  _options: Record<string, never>,
  command: RootCommandLike | undefined
): Promise<void> {
  const { project } = await writeReviewGuideCommentSetting({ enabled: false }, command);
  log(`Disabled automatic PR review-guide comments for ${project.repository_id}.`);
}

export async function handlePrReviewGuideCommentStatusCommand(): Promise<void> {
  const project = await resolveCurrentProject();
  const setting = parseReviewGuideCommentProjectSetting(
    getProjectSetting(getDatabase(), project.id, REVIEW_GUIDE_COMMENT_PROJECT_SETTING_KEY)
  );
  const status = setting?.enabled === true ? 'enabled' : 'disabled';
  const reviewStatus = setting?.postReview === true ? 'enabled' : 'disabled';
  log(`Automatic PR review-guide comments are ${status} for ${project.repository_id}.`);
  log(`Automatic reviews with inline issue comments are ${reviewStatus}.`);
}

async function writeReviewCommandSetting(
  enabled: boolean,
  command: RootCommandLike | undefined
): Promise<Project> {
  const globalOpts = getRootOptions(command);
  const config = await loadEffectiveConfig(globalOpts.config, { cwd: process.cwd() });
  const project = await resolveCurrentProject();
  const setting: ReviewCommandProjectSetting = { enabled };
  await writeProjectSettingSet(
    getDatabase(),
    config,
    project.id,
    REVIEW_COMMAND_PROJECT_SETTING_KEY,
    setting,
    'latest'
  );
  return project;
}

export async function handlePrReviewCommandEnableCommand(
  _options: Record<string, never>,
  command: RootCommandLike | undefined
): Promise<void> {
  const project = await writeReviewCommandSetting(true, command);
  log(`Enabled \`/tim review\` PR comment commands for ${project.repository_id}.`);
}

export async function handlePrReviewCommandDisableCommand(
  _options: Record<string, never>,
  command: RootCommandLike | undefined
): Promise<void> {
  const project = await writeReviewCommandSetting(false, command);
  log(`Disabled \`/tim review\` PR comment commands for ${project.repository_id}.`);
}

export async function handlePrReviewCommandStatusCommand(): Promise<void> {
  const project = await resolveCurrentProject();
  const enabled = isReviewCommandEnabled(
    getProjectSetting(getDatabase(), project.id, REVIEW_COMMAND_PROJECT_SETTING_KEY)
  );
  log(
    `\`/tim review\` PR comment commands are ${enabled ? 'enabled' : 'disabled'} for ${project.repository_id}.`
  );
}

async function resolveHeadSha(baseDir: string): Promise<string> {
  const result = await $`git rev-parse HEAD`.cwd(baseDir).quiet().nothrow();
  const sha = result.stdout.toString().trim();
  if (result.exitCode !== 0 || !sha) {
    throw new Error(
      `Failed to resolve the checked-out PR head commit: ${result.stderr.toString().trim() || 'git rev-parse failed.'}`
    );
  }
  return sha;
}

/** State of the automatic review that runs next to the guide comment. */
export type AutoReviewState =
  | { kind: 'running' }
  | { kind: 'posted'; result: AutomaticPrReviewResult }
  | { kind: 'failed' };

export function formatAutoReviewStatus(state: AutoReviewState): string {
  if (state.kind === 'running') {
    return '⏳ An automated review is in progress. This comment will update when the review is posted.';
  }
  if (state.kind === 'failed') {
    return '⚠️ The automated review failed.';
  }

  const { issueCount, githubReviewUrl } = state.result;
  const link = githubReviewUrl ? ` [View the review](${githubReviewUrl}).` : '';
  if (issueCount === 0) {
    return `✅ The automated review found no issues.${link}`;
  }
  return `🔎 The automated review found ${issueCount} ${issueCount === 1 ? 'issue' : 'issues'}.${link}`;
}

export function buildGuideCommentBody(options: {
  guide: string;
  reviewStatus: string | null;
  updatedAt: string | null;
}): string {
  const status = options.reviewStatus ? `> ${options.reviewStatus}\n\n` : '';
  const footer = options.updatedAt
    ? `\n\n---\n<sub>${UPDATED_AT_FOOTER_PREFIX} ${options.updatedAt}</sub>`
    : '';
  return `${REVIEW_GUIDE_COMMENT_MARKER}\n${status}${options.guide}${footer}\n`;
}

/** A posted guide comment, with what is needed to edit its review status line later. */
interface PostedGuideComment {
  commentId: number;
  guide: string;
  updatedAt: string | null;
  /** The status line in the posted body, or null if it had none. */
  reviewState: AutoReviewState | null;
}

async function generateAndPostGuideComment(args: {
  config: TimConfig;
  options: PrReviewGuideCommentOptions;
  executorName: string;
  baseDir: string;
  prContext: Awaited<ReturnType<typeof gatherPrContext>>;
  metadata: PrReviewMetadata;
  nonTestChangeStats: string | null;
  customInstructions: string | undefined;
  existingComment: Awaited<ReturnType<typeof findPullRequestCommentByMarker>>;
  appToken: string;
  /** Returns the automatic review state when the comment is posted, or null with no review. */
  getReviewState: () => AutoReviewState | null;
}): Promise<PostedGuideComment | null> {
  const { config, options, executorName, baseDir, prContext, existingComment, appToken } = args;

  const outputDir = path.join(baseDir, TMP_DIR);
  const outputPath = path.join(outputDir, `pr-review-guide-comment-${prContext.prNumber}.md`);
  await fs.mkdir(outputDir, { recursive: true });

  const configModel =
    executorName === ClaudeCodeExecutorName
      ? config.reviewGuideComments?.model?.claude
      : config.reviewGuideComments?.model?.codex;

  const executor = buildExecutorAndLog(
    executorName,
    {
      baseDir,
      model:
        options.model ??
        configModel ??
        (executorName === CodexCliExecutorName ? LATEST_GPT5_MODEL : undefined),
      terminalInput: false,
      noninteractive: true,
      timEnvironment: buildTimWorkspaceCommandEnvironmentOptionsForPath(config, baseDir, {
        branch: prContext.headBranch,
      }),
    },
    config,
    executorName === ClaudeCodeExecutorName ? { reasoningEffort: 'medium' } : {}
  );

  try {
    await executor.execute(
      buildReviewGuideCommentPrompt({
        metadata: args.metadata,
        outputPath,
        // checkoutPrBranch uses Git fetch/checkout even for colocated jj repositories, so the
        // executor must diff against the detached Git HEAD instead of the jj working-copy revision.
        useJj: false,
        nonTestChangeStats: args.nonTestChangeStats,
        customInstructions: args.customInstructions,
        commentInstructions: config.reviewGuideComments?.instructions,
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
      return null;
    }

    const reviewState = args.getReviewState();
    const updatedAt = options.force && existingComment ? new Date().toISOString() : null;
    const body = buildGuideCommentBody({
      guide,
      reviewStatus: reviewState ? formatAutoReviewStatus(reviewState) : null,
      updatedAt,
    });

    if (options.force && existingComment) {
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
      return { commentId: updated.id, guide, updatedAt, reviewState };
    }

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
    return { commentId: posted.id, guide, updatedAt, reviewState };
  } finally {
    await fs
      .rm(outputPath, { force: true })
      .catch((err) => warn(`Failed to clean up ${outputPath}: ${String(err)}`));
  }
}

export async function handlePrReviewGuideCommentCommand(
  prArg: string | undefined,
  options: PrReviewGuideCommentOptions,
  command: RootCommandLike
): Promise<void> {
  if (!prArg) {
    throw new Error('Provide a PR URL or number.');
  }
  if (options.reviewOnly === true && options.postReview === false) {
    throw new Error('--review-only cannot be used with --no-post-review.');
  }
  if (
    options.triggerCommentId !== undefined &&
    (!Number.isInteger(options.triggerCommentId) || options.triggerCommentId <= 0)
  ) {
    throw new Error('--trigger-comment-id must be a positive integer.');
  }

  const globalOpts = getRootOptions(command);
  const db: Database = getDatabase();
  const initialRepoRoot = await getGitRoot(process.cwd());
  const config = await loadEffectiveConfig(globalOpts.config, { cwd: initialRepoRoot });
  const tunnelActive = isTunnelActive();

  await runWithHeadlessAdapterIfEnabled({
    enabled: !tunnelActive,
    command: 'review-guide-comment',
    interactive: options.nonInteractive !== true,
    callback: async () => {
      const executorName = resolveCommentExecutor(
        options.executor,
        config.reviewGuideComments?.executor
      );

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

      const triggerCommentId = options.triggerCommentId;
      const reactToTrigger = async (content: IssueCommentReaction): Promise<void> => {
        if (triggerCommentId === undefined) {
          return;
        }
        try {
          await addIssueCommentReaction(parsedPr.owner, parsedPr.repo, triggerCommentId, content, {
            authToken: appToken,
          });
        } catch (err) {
          warn(
            `Failed to add a ${content} reaction to comment ${triggerCommentId}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      };

      await reactToTrigger('eyes');
      try {
        const prContext = await gatherPrContext({
          db,
          prUrlOrNumber: prUrl,
          cwd: initialRepoRoot,
          authToken: appToken,
        });
        updateReviewGuideCommentSessionInfo(db, prContext);

        // Validate that the current repository is the one the PR belongs to before checking out
        // its branch, mirroring `tim pr review-guide`.
        const { repoRoot, projectId } = await resolveProjectContextForRepo(db, initialRepoRoot);
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
          options.dryRun === true || options.reviewOnly === true
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

        const remoteBaseRef = `origin/${prContext.baseBranch}`;
        const mergeBaseResult = await $`git merge-base HEAD ${remoteBaseRef}`
          .cwd(baseDir)
          .quiet()
          .nothrow();
        const baseSha = mergeBaseResult.stdout.toString().trim();
        if (mergeBaseResult.exitCode !== 0 || !baseSha) {
          throw new Error(
            `Failed to resolve PR review guide comment merge base from ${remoteBaseRef}: ${mergeBaseResult.stderr.toString().trim() || 'git merge-base failed.'}`
          );
        }

        if (options.reviewOnly === true) {
          await runAutomaticPrReview({
            db,
            config,
            baseDir,
            projectId,
            prStatusId: prContext.prStatus.id,
            metadata: buildPrMetadata(prContext, baseSha),
            baseSha,
            reviewedSha: await resolveHeadSha(baseDir),
            customInstructions: await loadCustomReviewInstructions(config, baseDir),
            authToken: appToken,
            dryRun: options.dryRun,
            filesReviewed: prContext.prStatus.changed_files ?? 0,
          });
          return;
        }

        const nonTestChangeStats = await loadJjNonTestChangeStats(baseDir, baseSha);
        const customInstructions = await loadCustomReviewInstructions(config, baseDir);
        const metadata = buildPrMetadata(prContext, baseSha);

        const postReview =
          options.postReview ??
          isReviewGuideCommentPostReviewEnabled(
            getProjectSetting(db, projectId, REVIEW_GUIDE_COMMENT_PROJECT_SETTING_KEY)
          );

        let reviewState: AutoReviewState | null = null;
        let reviewPromise: Promise<unknown> | null = null;
        if (postReview) {
          const reviewedSha = await resolveHeadSha(baseDir);
          reviewState = { kind: 'running' };
          reviewPromise = runAutomaticPrReview({
            db,
            config,
            baseDir,
            projectId,
            prStatusId: prContext.prStatus.id,
            metadata,
            baseSha,
            reviewedSha,
            customInstructions,
            authToken: appToken,
            dryRun: options.dryRun,
            filesReviewed: prContext.prStatus.changed_files ?? 0,
          }).then(
            (result) => {
              reviewState = { kind: 'posted', result };
            },
            (err: unknown) => {
              reviewState = { kind: 'failed' };
              throw err;
            }
          );
          // Errors are handled below, after the comment step finishes.
          reviewPromise.catch(() => {});
        }

        let commentError: unknown;
        let postedComment: PostedGuideComment | null = null;
        try {
          postedComment = await generateAndPostGuideComment({
            config,
            options,
            executorName,
            baseDir,
            prContext,
            metadata,
            nonTestChangeStats,
            customInstructions,
            existingComment,
            appToken,
            getReviewState: () => reviewState,
          });
        } catch (err) {
          commentError = err;
        }

        let reviewError: Error | null = null;
        if (reviewPromise) {
          try {
            await reviewPromise;
          } catch (err) {
            reviewError = err instanceof Error ? err : new Error(String(err));
          }
        }

        // The comment was posted while the review was still running: replace the
        // in-progress line with the final review status.
        if (postedComment?.reviewState?.kind === 'running' && reviewState) {
          try {
            await updatePullRequestComment(
              prContext.owner,
              prContext.repo,
              postedComment.commentId,
              buildGuideCommentBody({
                guide: postedComment.guide,
                reviewStatus: formatAutoReviewStatus(reviewState),
                updatedAt: postedComment.updatedAt,
              }),
              { authToken: appToken }
            );
          } catch (err) {
            warn(
              `Failed to update the review status in the guide comment: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }

        if (reviewError) {
          if (!commentError) {
            throw reviewError;
          }
          warn(`Automatic review failed: ${reviewError.message}`);
        }

        if (commentError) {
          throw commentError;
        }
      } catch (err) {
        await reactToTrigger('confused');
        throw err;
      }
    },
  });
}
