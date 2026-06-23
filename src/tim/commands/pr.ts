import path from 'node:path';

import chalk from 'chalk';
import {
  canonicalizePrUrl,
  deduplicatePrUrls,
  parsePrOrIssueNumber,
} from '../../common/github/identifiers.js';
import { fetchRemoteBranch, getGitRepository, remoteBranchExists } from '../../common/git.js';
import { getWebhookServerUrl } from '../../common/github/webhook_client.js';
import {
  formatWebhookIngestErrors,
  ingestWebhookEvents,
} from '../../common/github/webhook_ingest.js';
import { resolveGitHubToken } from '../../common/github/token.js';
import { getGitHubUsername } from '../../common/github/user.js';
import { refreshProjectPrs } from '../../common/github/project_pr_service.js';
import {
  parseOwnerRepoFromRepositoryId,
  fetchOpenPullRequests,
  postPullRequestComment,
  resolveReviewThread,
} from '../../common/github/pull_requests.js';
import { refreshPrStatus, syncPlanPrLinks } from '../../common/github/pr_status_service.js';
import { log, warn } from '../../logging.js';
import { isTunnelActive } from '../../logging/tunnel_client.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { getDatabase } from '../db/database.js';
import { getProject, getProjectById, listProjects, type Project } from '../db/project.js';
import {
  cleanOrphanedPrStatus,
  getLinkedPlansByPrUrl,
  getPrStatusForPlan,
  getPrStatusByUrl,
  linkPlanToPr,
  unlinkPlanFromPr,
  type PrCheckRunRow,
  type PrReviewThreadDetail,
  type PrReviewRow,
  type PrStatusDetail,
  type PrStatusRow,
} from '../db/pr_status.js';
import type { PlanSchema } from '../planSchema.js';
import {
  parsePlanIdFromCliArg,
  resolvePlanByNumericId,
  resolvePlanByUuid,
  writePlanFile,
} from '../plans.js';
import { resolveRepoRoot } from '../plan_repo_root.js';
import { getWorkspaceInfoByPath, touchWorkspaceInfo } from '../workspace/workspace_info.js';
import { setupWorkspace } from '../workspace/workspace_setup.js';
import {
  materializePlansForExecution,
  prepareWorkspaceRoundTrip,
  runPostExecutionWorkspaceSync,
  runPreExecutionWorkspaceSync,
} from '../workspace/workspace_roundtrip.js';
import {
  buildExecutorAndLog,
  DEFAULT_EXECUTOR,
  defaultModelForExecutor,
} from '../executors/index.js';
import type { ExecutorCommonOptions } from '../executors/types.js';
import {
  ClaudeCodeExecutorName,
  CodexCliExecutorName,
  type ClaudeCodeReasoningEffort,
  type CodexReasoningLevel,
} from '../executors/schemas.js';
import { buildTimWorkspaceCommandEnvironmentOptionsForPath } from '../environment_options.js';
import { runWithHeadlessAdapterIfEnabled, updateHeadlessSessionInfo } from '../headless.js';
import { LifecycleManager } from '../lifecycle.js';
import { isShuttingDown } from '../shutdown_state.js';
import { gatherPrContext } from '../utils/pr_context_gathering.js';

interface RootCommandLike {
  parent?: RootCommandLike;
  opts?: () => {
    config?: string;
  };
}

interface PrStatusCommandOptions {
  forceRefresh?: boolean;
}

export interface PrFixCommandOptions {
  pr?: string;
  plan?: string | number;
  current?: boolean;
  branch?: string;
  executor?: string;
  orchestrator?: string;
  model?: string;
  effort?: string;
  autoWorkspace?: boolean;
  workspace?: string;
  newWorkspace?: boolean;
  workspaceSync?: boolean;
  nonInteractive?: boolean;
  terminalInput?: boolean;
}

export interface PlanPrFixTarget {
  kind: 'plan';
  planId: number;
  plan: PlanSchema;
  planPath: string | null;
  repoRoot: string;
  prStatuses: PrStatusDetail[];
}

export interface PullRequestFixTarget {
  kind: 'pr';
  repoRoot: string;
  canonicalPrUrl: string;
  prNumber: number;
  owner: string;
  repo: string;
  title?: string;
  author?: string;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  prStatus: PrStatusDetail;
}

export type PrFixTarget = PlanPrFixTarget | PullRequestFixTarget;

export type PrFixTargetIntent =
  | { mode: 'plan'; planId?: number }
  | { mode: 'pr'; prUrlOrNumber: string };

type PrRefreshTarget = Project | 'all';

function getRootCommand(command: RootCommandLike): RootCommandLike {
  let cursor = command;
  while (cursor.parent) {
    cursor = cursor.parent;
  }
  return cursor;
}

function getPrFixExecutorKey(executorName: string): 'claude' | 'codex' | undefined {
  if (executorName === ClaudeCodeExecutorName || executorName === 'claude') {
    return 'claude';
  }
  if (executorName === CodexCliExecutorName || executorName === 'codex') {
    return 'codex';
  }
  return undefined;
}

async function resolvePrRefreshTarget(target: string | undefined): Promise<PrRefreshTarget> {
  const db = getDatabase();
  if (!target) {
    const repository = await getRepositoryIdentity();
    const project = getProject(db, repository.repositoryId);
    if (!project) {
      throw new Error(
        `No tim project found for current repository ${repository.repositoryId}. Run from a registered project checkout or pass a project id.`
      );
    }
    return project;
  }

  if (target === 'all') {
    return 'all';
  }

  const projectId = Number(target);
  if (!Number.isInteger(projectId) || projectId <= 0 || String(projectId) !== target) {
    throw new Error(`Expected a numeric project id or "all", got "${target}".`);
  }

  const project = getProjectById(db, projectId);
  if (!project) {
    throw new Error(`Project ${projectId} not found.`);
  }
  return project;
}

function formatRefreshProjectLabel(project: Project): string {
  return `project ${project.id} (${project.repository_id})`;
}

export async function handlePrRefreshCommand(
  target: string | undefined,
  command: RootCommandLike
): Promise<void> {
  if (!resolveGitHubToken()) {
    throw new Error('GITHUB_TOKEN environment variable is required for PR refresh commands');
  }

  const rootCommand = getRootCommand(command);
  const globalOpts = typeof rootCommand?.opts === 'function' ? rootCommand.opts() : {};
  const config = await loadEffectiveConfig(globalOpts.config);
  const username = await getGitHubUsername({ githubUsername: config.githubUsername });
  if (!username) {
    throw new Error('Could not resolve GitHub username');
  }

  const db = getDatabase();
  const resolvedTarget = await resolvePrRefreshTarget(target);
  const projects = resolvedTarget === 'all' ? listProjects(db) : [resolvedTarget];

  let refreshedProjectCount = 0;
  let refreshedPrCount = 0;
  let newLinkCount = 0;

  for (const project of projects) {
    try {
      const result = await refreshProjectPrs(db, project.id, username);
      refreshedProjectCount += 1;
      refreshedPrCount += result.refreshed.length;
      newLinkCount += result.newLinks.length;
      log(
        `Refreshed ${formatRefreshProjectLabel(project)}: ${result.refreshed.length} open PR${result.refreshed.length === 1 ? '' : 's'}, ${result.newLinks.length} new plan link${result.newLinks.length === 1 ? '' : 's'}.`
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (resolvedTarget === 'all') {
        log(chalk.yellow(`Skipping ${formatRefreshProjectLabel(project)}: ${message}`));
        continue;
      }
      throw err;
    }
  }

  log(
    chalk.green(
      `PR refresh complete: ${refreshedProjectCount} project${refreshedProjectCount === 1 ? '' : 's'}, ${refreshedPrCount} open PR${refreshedPrCount === 1 ? '' : 's'}, ${newLinkCount} new plan link${newLinkCount === 1 ? '' : 's'}.`
    )
  );
}

function buildPrFixExecutorOptions(
  executorName: string,
  effort: string | undefined,
  config: Awaited<ReturnType<typeof loadEffectiveConfig>>
): Record<string, unknown> | undefined {
  if (!effort) {
    return undefined;
  }

  const executorKey = getPrFixExecutorKey(executorName);
  if (executorKey === 'claude') {
    return { reasoningEffort: effort as ClaudeCodeReasoningEffort };
  }

  if (executorKey === 'codex') {
    const codexExecutorOptions = config.executors?.[CodexCliExecutorName];
    const existingReasoning =
      codexExecutorOptions && 'reasoning' in codexExecutorOptions
        ? codexExecutorOptions.reasoning
        : undefined;
    return {
      reasoning: {
        ...(existingReasoning &&
        typeof existingReasoning === 'object' &&
        !Array.isArray(existingReasoning)
          ? existingReasoning
          : {}),
        default: effort as CodexReasoningLevel,
      },
    };
  }

  return undefined;
}

function resolveStringOption(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function getRootOptions(command: RootCommandLike | undefined): { config?: string } {
  let current = command;
  while (current?.parent) {
    current = current.parent;
  }

  return current?.opts?.() ?? {};
}

function isNumericIdentifier(value: string): boolean {
  return /^\d+$/.test(value.trim());
}

function isUnambiguousPrIdentifier(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.includes('github.com') || trimmed.includes('/') || trimmed.includes('#');
}

export function resolvePrFixTargetIntent(
  positionalArg: string | number | undefined,
  options: PrFixCommandOptions
): PrFixTargetIntent {
  if (options.current === true) {
    throw new Error(
      'tim pr fix requires unresolved GitHub PR review threads and does not support --current. Use tim review --current for current-checkout review work.'
    );
  }

  const branch = resolveStringOption(options.branch);
  if (branch) {
    throw new Error(
      'tim pr fix requires unresolved GitHub PR review threads and does not support --branch. Use tim review --branch for branch review work.'
    );
  }

  const prOption = resolveStringOption(options.pr);
  if (prOption) {
    return { mode: 'pr', prUrlOrNumber: prOption };
  }

  if (options.plan !== undefined) {
    return { mode: 'plan', planId: parsePlanIdFromCliArg(String(options.plan)) };
  }

  const positional =
    typeof positionalArg === 'number' ? String(positionalArg) : resolveStringOption(positionalArg);
  if (!positional) {
    return { mode: 'plan' };
  }

  if (isNumericIdentifier(positional)) {
    return { mode: 'plan', planId: parsePlanIdFromCliArg(positional) };
  }

  if (isUnambiguousPrIdentifier(positional)) {
    return { mode: 'pr', prUrlOrNumber: positional };
  }

  throw new Error(
    `Could not resolve PR fix target "${positional}". Use "tim pr fix <planId>", "tim pr fix --plan <planId>", or "tim pr fix --pr <pr-url-or-number>". URL-like positional PR identifiers such as GitHub URLs or owner/repo#123 are also supported.`
  );
}

function getWorkspacePlanReference(cwd: string): number | null {
  let currentDir = cwd;

  while (true) {
    const workspaceInfo = getWorkspaceInfoByPath(currentDir);
    if (workspaceInfo) {
      if (!workspaceInfo.planId) {
        return null;
      }
      try {
        return parsePlanIdFromCliArg(workspaceInfo.planId);
      } catch (error) {
        log(
          chalk.yellow(
            `Warning: workspace at ${currentDir} has invalid plan_id "${workspaceInfo.planId}": ${(error as Error).message}`
          )
        );
        return null;
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

async function resolvePlanForCommand(
  planId: number | undefined,
  command: RootCommandLike | undefined
): Promise<{ plan: PlanSchema; planPath: string | null; repoRoot: string }> {
  const effectivePlanId = planId ?? getWorkspacePlanReference(process.cwd()) ?? undefined;

  if (!effectivePlanId) {
    throw new Error(
      'Please provide a plan ID or run this command from a workspace linked to a plan'
    );
  }

  const globalOpts = getRootOptions(command);
  const repoRoot = await resolveRepoRoot(globalOpts.config, process.cwd());
  const resolved = await resolvePlanByNumericId(effectivePlanId, repoRoot);
  return { ...resolved, repoRoot };
}

function requirePlanUuid(plan: PlanSchema, planPath: string): string {
  if (!plan.uuid) {
    throw new Error(`Plan ${planPath} is missing a UUID and cannot be linked to pull requests`);
  }

  return plan.uuid;
}

function logWebhookIngestWarnings(errors: string[]): void {
  const message = formatWebhookIngestErrors(errors);
  if (message) {
    log(chalk.yellow(message));
  }
}

/** Update pullRequest URLs in the plan file. Returns true if the file was modified. */
async function persistPlanPullRequests(
  repoRoot: string,
  planPath: string | null,
  currentPlan: PlanSchema,
  updatePullRequests: (pullRequests: string[]) => string[]
): Promise<boolean> {
  // Re-read from DB for freshest state. Small TOCTOU window between read and write
  // is acceptable for a CLI tool — much smaller than the old window that spanned API calls.
  const resolved = currentPlan.uuid
    ? await resolvePlanByUuid(currentPlan.uuid, repoRoot)
    : await resolvePlanByNumericId(currentPlan.id, repoRoot);
  const freshPlan = resolved.plan;

  const currentPullRequests = freshPlan.pullRequest ?? [];
  const nextPullRequests = updatePullRequests(currentPullRequests);

  // Skip write if nothing changed
  if (
    nextPullRequests.length === currentPullRequests.length &&
    nextPullRequests.every((url, i) => url === currentPullRequests[i])
  ) {
    return false;
  }

  const updatedPlan = { ...freshPlan, pullRequest: nextPullRequests };
  await writePlanFile(planPath, updatedPlan, { cwdForIdentity: repoRoot });
  return true;
}

function normalizeStoredPullRequests(pullRequests: string[]): string[] {
  return [
    ...new Set(
      pullRequests.map((pullRequest) => {
        try {
          return canonicalizePrUrl(pullRequest);
        } catch {
          return pullRequest;
        }
      })
    ),
  ];
}

/** Look up a GitHub PR URL by matching the plan's branch name against open PRs. */
async function findPrUrlForBranch(branch: string): Promise<string | null> {
  const repoInfo = await getGitRepository();
  if (!repoInfo) {
    return null;
  }

  const [owner, repo] = repoInfo.split('/');
  if (!owner || !repo) {
    return null;
  }

  const openPrs = await fetchOpenPullRequests(owner, repo);
  const matching = openPrs.filter((pr) => pr.headRefName === branch);

  if (matching.length === 1) {
    const pr = matching[0];
    log(`Found PR #${pr.number} (${pr.title}) for branch "${branch}"`);
    return `https://github.com/${owner}/${repo}/pull/${pr.number}`;
  }

  if (matching.length > 1) {
    log(
      chalk.yellow(
        `Found ${matching.length} PRs for branch "${branch}": ${matching.map((pr) => `#${pr.number}`).join(', ')}. Please specify a PR URL explicitly.`
      )
    );
  }

  return null;
}

function isUrlIdentifier(identifier: string): boolean {
  try {
    new URL(identifier);
    return true;
  } catch {
    return false;
  }
}

function formatLifecycleState(status: PrStatusRow): string {
  if (status.draft === 1) {
    return chalk.yellow('draft');
  }

  switch (status.state) {
    case 'open':
      return chalk.green('open');
    case 'merged':
      return chalk.magenta('merged');
    case 'closed':
      return chalk.gray('closed');
    default:
      return chalk.white(status.state);
  }
}

function formatRollupState(state: string | null): string {
  if (!state) {
    return chalk.gray('none');
  }

  switch (state) {
    case 'success':
      return chalk.green('success');
    case 'failure':
    case 'error':
      return chalk.red(state);
    case 'pending':
    case 'expected':
      return chalk.yellow(state);
    default:
      return chalk.white(state);
  }
}

function formatMergeableState(mergeable: string | null): string {
  if (!mergeable) {
    return chalk.gray('unknown');
  }

  switch (mergeable) {
    case 'MERGEABLE':
      return chalk.green('mergeable');
    case 'CONFLICTING':
      return chalk.red('conflicting');
    case 'UNKNOWN':
      return chalk.yellow('unknown');
    default:
      return chalk.white(mergeable.toLowerCase());
  }
}

function getCheckLineColor(check: PrCheckRunRow): (text: string) => string {
  if (check.status !== 'completed') {
    return chalk.yellow;
  }

  switch (check.conclusion) {
    case 'success':
      return chalk.green;
    case 'failure':
    case 'timed_out':
    case 'action_required':
    case 'startup_failure':
    case 'stale':
    case 'error':
      return chalk.red;
    case 'cancelled':
    case 'neutral':
    case 'skipped':
      return chalk.gray;
    default:
      return chalk.white;
  }
}

function getCheckIcon(check: PrCheckRunRow): string {
  if (check.status !== 'completed') {
    return '●';
  }

  switch (check.conclusion) {
    case 'success':
      return '✓';
    case 'failure':
    case 'timed_out':
    case 'action_required':
    case 'startup_failure':
    case 'stale':
    case 'error':
      return '✗';
    case 'cancelled':
    case 'neutral':
    case 'skipped':
      return '○';
    default:
      return '•';
  }
}

function formatCheckStatus(check: PrCheckRunRow): string {
  if (check.status !== 'completed') {
    return check.status;
  }

  return check.conclusion ? `${check.status}/${check.conclusion}` : check.status;
}

export function formatReviewSummary(reviews: PrReviewRow[], reviewDecision: string | null): string {
  if (reviews.length === 0) {
    if (reviewDecision === 'APPROVED') {
      return chalk.green('approved');
    }
    if (reviewDecision === 'CHANGES_REQUESTED') {
      return chalk.red('changes requested');
    }
    if (reviewDecision === 'REVIEW_REQUIRED') {
      return chalk.yellow('review required');
    }

    return chalk.gray('no reviews');
  }

  const counts = new Map<string, number>();
  for (const review of reviews) {
    counts.set(review.state, (counts.get(review.state) ?? 0) + 1);
  }

  const parts: string[] = [];
  const pushCount = (state: string, color: (text: string) => string, label: string): void => {
    const count = counts.get(state);
    if (count) {
      parts.push(color(`${count} ${label}`));
    }
  };

  pushCount('APPROVED', chalk.green, 'approved');
  pushCount('CHANGES_REQUESTED', chalk.red, 'changes requested');
  pushCount('COMMENTED', chalk.gray, 'commented');
  pushCount('DISMISSED', chalk.gray, 'dismissed');
  pushCount('PENDING', chalk.yellow, 'pending');

  if (parts.length === 0) {
    return chalk.gray(`${reviews.length} reviews`);
  }

  return parts.join(chalk.gray(', '));
}

export function getMergeReadiness(detail: PrStatusDetail): string {
  const { status } = detail;

  if (status.state === 'merged') {
    return chalk.green('merged');
  }

  if (status.state !== 'open') {
    return chalk.gray('not open');
  }

  if (status.draft === 1) {
    return chalk.yellow('draft');
  }

  if (status.mergeable === 'CONFLICTING') {
    return chalk.red('blocked by conflicts');
  }

  if (status.review_decision === 'CHANGES_REQUESTED') {
    return chalk.red('changes requested');
  }

  if (status.check_rollup_state === 'failure' || status.check_rollup_state === 'error') {
    return chalk.red('failing checks');
  }

  if (status.mergeable === 'UNKNOWN') {
    return chalk.yellow('mergeability unknown');
  }

  if (status.review_decision === 'REVIEW_REQUIRED' || status.review_decision === null) {
    return chalk.yellow('awaiting review');
  }

  if (status.check_rollup_state === 'pending' || status.check_rollup_state === 'expected') {
    return chalk.yellow('checks pending');
  }

  if (status.mergeable === 'MERGEABLE' && status.review_decision === 'APPROVED') {
    return chalk.green('ready');
  }

  return chalk.yellow('not ready');
}

function logPrStatus(detail: PrStatusDetail): void {
  const { status, checks, reviews, labels } = detail;
  const title = status.title ?? '(untitled)';

  log(chalk.bold(`${status.owner}/${status.repo}#${status.pr_number}: ${title}`));
  log(`  State: ${formatLifecycleState(status)}`);
  log(`  Checks: ${formatRollupState(status.check_rollup_state)}`);
  log(`  Reviews: ${formatReviewSummary(reviews, status.review_decision)}`);
  log(`  Mergeable: ${formatMergeableState(status.mergeable)}`);
  log(`  Merge readiness: ${getMergeReadiness(detail)}`);

  if (labels.length > 0) {
    log(`  Labels: ${labels.map((label) => label.name).join(', ')}`);
  }

  if (checks.length === 0) {
    log(`  Check runs: ${chalk.gray('none')}`);
  } else {
    log('  Check runs:');
    for (const check of checks) {
      const color = getCheckLineColor(check);
      const detailsSuffix = check.details_url ? chalk.dim(` ${check.details_url}`) : '';
      const sourceSuffix =
        check.source === 'status_context' ? chalk.dim(' [status]') : chalk.dim(' [check]');
      log(
        color(
          `    ${getCheckIcon(check)} ${check.name}${sourceSuffix} ${formatCheckStatus(check)}`
        ) + detailsSuffix
      );
    }
  }

  if (reviews.length === 0) {
    log(`  Review entries: ${chalk.gray('none')}`);
  } else {
    log('  Review entries:');
    for (const review of reviews) {
      let reviewState = review.state.toLowerCase().replaceAll('_', ' ');
      if (review.state === 'APPROVED') {
        reviewState = chalk.green(reviewState);
      } else if (review.state === 'CHANGES_REQUESTED') {
        reviewState = chalk.red(reviewState);
      } else if (review.state === 'PENDING') {
        reviewState = chalk.yellow(reviewState);
      } else {
        reviewState = chalk.gray(reviewState);
      }

      log(`    ${review.author}: ${reviewState}`);
    }
  }
}

export async function handlePrStatusCommand(
  planId: number | undefined,
  options: Record<string, unknown>,
  command: RootCommandLike
): Promise<void> {
  const { plan, planPath, repoRoot } = await resolvePlanForCommand(planId, command);
  let prUrls = plan.pullRequest ?? [];
  const explicitPrUrls = [...prUrls];
  const { forceRefresh = false } = options as PrStatusCommandOptions;
  const webhookServerUrl = getWebhookServerUrl();
  const useWebhookFirst = Boolean(webhookServerUrl) && !forceRefresh;
  const hasGitHubToken = Boolean(resolveGitHubToken());
  const db = getDatabase();

  // Ingest webhook events early so auto-linked PRs are available for junction checks
  if (useWebhookFirst) {
    const ingestResult = await ingestWebhookEvents(db);
    logWebhookIngestWarnings(ingestResult.errors);

    if (plan.uuid) {
      const cachedExplicitUrls = explicitPrUrls.filter((url) => getPrStatusByUrl(db, url) !== null);
      try {
        await syncPlanPrLinks(db, plan.uuid, cachedExplicitUrls);
      } catch (err) {
        log(chalk.yellow(`Warning: failed to sync PR cache junctions: ${(err as Error).message}`));
      }
      cleanOrphanedPrStatus(db);
    }
  }

  if (plan.uuid) {
    const autoLinkedPrUrls = getPrStatusForPlan(db, plan.uuid, []).map(
      (detail) => detail.status.pr_url
    );
    if (autoLinkedPrUrls.length > 0) {
      prUrls = [...new Set([...prUrls, ...autoLinkedPrUrls])];
    }
  }

  if (prUrls.length === 0 && !plan.branch) {
    log(`Plan ${plan.id} has no linked pull requests and no branch to look up.`);
    return;
  }

  if (!useWebhookFirst && !hasGitHubToken) {
    throw new Error('GITHUB_TOKEN environment variable is required for PR status commands');
  }

  // If no PRs linked, try to find one from the plan's branch via GitHub API
  // Skip in webhook mode (auto-linking is handled by webhook event handlers)
  if (prUrls.length === 0 && plan.branch && !useWebhookFirst) {
    const foundUrl = hasGitHubToken ? await findPrUrlForBranch(plan.branch) : null;
    if (foundUrl) {
      // Auto-link the discovered PR to the plan
      const planUuid = plan.uuid;
      await persistPlanPullRequests(repoRoot, planPath, plan, (pullRequests) => {
        const normalized = normalizeStoredPullRequests(pullRequests);
        return normalized.includes(foundUrl) ? normalized : [...normalized, foundUrl];
      });
      if (planUuid) {
        const detail = await refreshPrStatus(db, foundUrl);
        linkPlanToPr(db, planUuid, detail.status.id);
      }
      prUrls = [foundUrl];
    }

    if (prUrls.length === 0) {
      log(`Plan ${plan.id} has no linked pull requests.`);
      return;
    }
  }

  if (prUrls.length === 0) {
    log(`Plan ${plan.id} has no linked pull requests.`);
    return;
  }

  // Canonicalize and deduplicate PR URLs before fetching
  const { valid: uniquePrUrls, invalid: invalidUrls } = deduplicatePrUrls(prUrls);
  for (const url of invalidUrls) {
    log(chalk.yellow(`Warning: skipping invalid PR URL: ${url}`));
  }

  const details: PrStatusDetail[] = [];
  const successfulUrls: string[] = [];
  const errors: Array<{ url: string; error: Error }> = [];
  for (const prUrl of uniquePrUrls) {
    try {
      let detail: PrStatusDetail;
      if (useWebhookFirst) {
        // In webhook mode, read from DB cache (webhook ingestion already ran above)
        const cached = getPrStatusByUrl(db, prUrl);
        if (!cached) {
          errors.push({ url: prUrl, error: new Error('No cached data available') });
          continue;
        }
        detail = cached;
      } else {
        detail = await refreshPrStatus(db, prUrl);
      }
      details.push(detail);
      successfulUrls.push(prUrl);
    } catch (err) {
      errors.push({ url: prUrl, error: err as Error });
    }
  }

  // Display results before junction sync (so partial results are always shown)
  for (const detail of details) {
    logPrStatus(detail);
    log('');
  }

  for (const { url, error } of errors) {
    log(chalk.red(`Failed to fetch status for ${url}: ${error.message}`));
  }

  // Sync explicit plan_pr junctions after GitHub-refresh mode fetches (best-effort, skip if no UUID).
  // Try full explicit URLs first to preserve links for previously-cached PRs that failed to refresh.
  // If that fails (uncached PR can't be fetched), fall back to just successful explicit URLs.
  if (plan.uuid && !useWebhookFirst) {
    const successfulExplicitUrls = explicitPrUrls.filter((url) => successfulUrls.includes(url));
    try {
      await syncPlanPrLinks(db, plan.uuid, explicitPrUrls);
    } catch {
      try {
        await syncPlanPrLinks(db, plan.uuid, successfulExplicitUrls);
      } catch (err) {
        log(chalk.yellow(`Warning: failed to sync PR cache junctions: ${(err as Error).message}`));
      }
    }
    cleanOrphanedPrStatus(db);
  }

  if (errors.length > 0 && details.length === 0) {
    throw new Error('Failed to fetch status for all linked pull requests');
  }
}

export async function handlePrCommentCommand(prIdentifier: string, body: string): Promise<void> {
  if (!resolveGitHubToken()) {
    throw new Error('GITHUB_TOKEN environment variable is required to comment on pull requests');
  }

  const parsed = await parsePrOrIssueNumber(prIdentifier);
  if (!parsed) {
    throw new Error(`Could not parse pull request identifier: ${prIdentifier}`);
  }

  const comment = await postPullRequestComment(parsed.owner, parsed.repo, parsed.number, body);
  const location = comment.htmlUrl ? `: ${comment.htmlUrl}` : '';
  log(chalk.green(`Commented on ${parsed.owner}/${parsed.repo}#${parsed.number}${location}`));
}

export async function handlePrResolveCommand(threadId: string): Promise<void> {
  const success = await resolveReviewThread(threadId);

  if (!success) {
    throw new Error(`Failed to resolve review thread ${threadId}`);
  }

  // Update local DB cache to match GitHub state
  try {
    const db = getDatabase();
    db.run('UPDATE pr_review_thread SET is_resolved = 1 WHERE thread_id = ?', [threadId]);
  } catch (err) {
    log(
      chalk.yellow(`Warning: Failed to update local DB cache for resolved thread: ${err as Error}`)
    );
  }

  log(chalk.green(`Resolved review thread ${threadId}`));
}

function formatNullableLine(label: string, value: string | number | null | undefined): string {
  return `- ${label}: ${value ?? 'n/a'}`;
}

function formatReviewThreadLocation(thread: PrReviewThreadDetail): string {
  const startLine = thread.thread.start_line ?? thread.thread.original_start_line;
  const endLine = thread.thread.line ?? thread.thread.original_line;

  if (startLine && endLine && startLine !== endLine) {
    return `${thread.thread.path}:${startLine}-${endLine}`;
  }

  const line = endLine ?? startLine;
  return line ? `${thread.thread.path}:${line}` : thread.thread.path;
}

function indentBlock(value: string, spaces: number): string {
  const prefix = ' '.repeat(spaces);
  return value
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function formatReviewThreadForPrompt(
  item: { thread: PrReviewThreadDetail; prUrl: string },
  index: number
): string[] {
  const { thread, prUrl } = item;
  const lines = [
    `### Thread ${index + 1}: ${formatReviewThreadLocation(thread)}`,
    '',
    formatNullableLine('PR', prUrl),
    formatNullableLine('PRRT thread ID', thread.thread.thread_id),
    formatNullableLine('File', thread.thread.path),
    formatNullableLine('Line', thread.thread.line),
    formatNullableLine('Original line', thread.thread.original_line),
    formatNullableLine('Start line', thread.thread.start_line),
    formatNullableLine('Original start line', thread.thread.original_start_line),
    formatNullableLine('Outdated', thread.thread.is_outdated ? 'yes' : 'no'),
    '',
    'Related comments in this review thread:',
  ];

  if (thread.comments.length === 0) {
    lines.push('- No comments were returned for this thread.', '');
    return lines;
  }

  thread.comments.forEach((comment, commentIndex) => {
    lines.push(
      '',
      `#### Comment ${commentIndex + 1}`,
      '',
      formatNullableLine('Comment ID', comment.comment_id),
      formatNullableLine('Database ID', comment.database_id),
      formatNullableLine('Author', comment.author),
      formatNullableLine('Created at', comment.created_at),
      formatNullableLine('State', comment.state),
      '',
      'Body:',
      '',
      indentBlock(comment.body ?? '(empty)', 2)
    );

    if (comment.diff_hunk) {
      lines.push('', 'Diff hunk:', '', '```diff', comment.diff_hunk, '```');
    }
  });

  lines.push('');
  return lines;
}

export function buildReviewThreadFixPrompt(
  planData: PlanSchema,
  threads: Array<{ thread: PrReviewThreadDetail; prUrl: string }>
): string {
  const prUrls = [...new Set(threads.map(({ prUrl }) => prUrl))];
  const branch = planData.branch?.trim() || 'Current working branch';
  const prompt = [
    '# Address Pull Request Review Comments',
    '',
    'You are addressing review comments on a pull request for the current branch.',
    '',
    'The PR branch, PR URLs, unresolved review threads, and related review-thread comments are already provided below; do not spend time auto-discovering or re-fetching them before starting.',
    '',
    '## Plan Context',
    '',
    `**Plan ID:** ${planData.id}`,
    `**Title:** ${planData.title}`,
    `**Goal:** ${planData.goal ?? 'No goal provided'}`,
    `**Branch:** ${branch}`,
    '',
  ];

  if (planData.details) {
    prompt.push('**Details:**', planData.details, '');
  }

  if (prUrls.length > 0) {
    prompt.push('## Pull Request URLs', '');
    for (const prUrl of prUrls) {
      prompt.push(`- ${prUrl}`);
    }
    prompt.push('');
  }

  prompt.push(...buildReviewThreadFixInstructions(threads));

  return prompt.join('\n');
}

export function buildPrReviewThreadFixPrompt(
  target: PullRequestFixTarget,
  threads: Array<{ thread: PrReviewThreadDetail; prUrl: string }>
): string {
  const prompt = [
    '# Address Pull Request Review Comments',
    '',
    'You are addressing review comments on a pull request for the current branch.',
    '',
    'The PR branch, PR URLs, unresolved review threads, and related review-thread comments are already provided below; do not spend time auto-discovering or re-fetching them before starting.',
    '',
    '## Pull Request Context',
    '',
    `**PR URL:** ${target.canonicalPrUrl}`,
    `**PR Number:** ${target.prNumber}`,
    `**Repository:** ${target.owner}/${target.repo}`,
    `**Title:** ${target.title ?? 'No title provided'}`,
  ];

  if (target.author) {
    prompt.push(`**Author:** ${target.author}`);
  }

  prompt.push(
    `**Base Branch:** ${target.baseBranch}`,
    `**Head Branch:** ${target.headBranch}`,
    `**Head SHA:** ${target.headSha}`,
    '',
    'No tim plan is associated with this run; do not update plan files, plan tasks, plan status, or plan assignments.',
    ''
  );

  prompt.push(...buildReviewThreadFixInstructions(threads));

  return prompt.join('\n');
}

export function buildReviewThreadFixInstructions(
  threads: Array<{ thread: PrReviewThreadDetail; prUrl: string }>
): string[] {
  const prompt = [
    '## Unresolved Review Threads',
    '',
    'Each thread below includes the PRRT thread ID and all comments currently linked to that review thread.',
  ];

  if (threads.length === 0) {
    prompt.push('', 'No unresolved review threads were provided.', '');
  } else {
    prompt.push('');
    threads.forEach((thread, index) => {
      prompt.push(...formatReviewThreadForPrompt(thread, index));
    });
  }

  prompt.push(
    '## Additional PR Feedback',
    '',
    'If the fetched thread data points to related PR feedback that is not represented as a review thread, address it when appropriate and leave a standalone PR comment using:',
    '   `tim pr comment <PR URL or owner/repo#number> "explanation of fix"`',
    '',
    'Do not use standalone PR comments for review-thread replies. Use GraphQL review-thread replies for review threads, and `tim pr comment` only for feedback that is not represented as a review thread.',
    ''
  );

  prompt.push(
    '## User Feedback',
    '',
    'List the review threads above for the user before making code changes. Show the whole contents of each issue/comment, including enough context to distinguish each item, such as author, file, and line.',
    '',
    'Ask the user for feedback on which review comments to address and how. If the user has already given clear instructions, follow those instructions; otherwise wait for direction before implementing fixes.',
    '',
    '## Responsibilities',
    '',
    '1. Read the fetched PR comments, review comments, review threads, and reviews, then identify the actionable AI feedback. A single comment may enumerate several distinct issues; treat each listed issue as its own actionable item.',
    '2. Inspect the surrounding code to understand the intent behind each comment. When additional context is needed, diff against the base branch, which is probably `main`.',
    '   When a comment lists one or more issues, scan all later comments on the same thread and PR to determine whether each issue was already addressed (for example, acknowledged as fixed, resolved, or withdrawn in a subsequent comment). Skip issues that later comments indicate were already handled, and address the remaining issues that no later comment resolves.',
    '3. Ask the user for feedback on which review comments to address and how, as described above.',
    '4. Apply focused changes that resolve the raised concerns without altering unrelated code.',
    '5. Run type checking, linting, and tests appropriate to the files you changed. Add tests only when necessary to cover the fixes.',
    '6. Commit the code changes. If the repository uses jj, update the current bookmark to the commit you created before pushing, for example `jj bookmark set <current-bookmark> -r @-` after `jj commit` creates the new empty working-copy commit.',
    '7. Push the branch/bookmark changes to the PR before replying to review comments.',
    '8. Reply to each addressed review thread with a concise explanation of what changed using one pending GraphQL review per PR, then submit that pending review with event `COMMENT`.',
    '9. For addressed feedback that was not a review-thread comment, leave an appropriate PR comment describing the change using:',
    '   `tim pr comment <PR URL or owner/repo#number> "explanation of fix"`',
    '10. Before finishing, make sure you have reviewed all provided AI comments.',
    '',
    'Every comment posted to the PR, including review-thread replies and standalone PR comments, must start with `AI Response: ` so it is clear the message came from the bot and not the actual user.',
    '',
    '## GraphQL Review Reply Workflow',
    '',
    'Batch review-thread replies through GitHub GraphQL instead of a tim CLI command:',
    '',
    '1. Group addressed threads by PR URL.',
    '2. For each PR, get its PR node ID. You can query the PR by owner/repo/number from the PR URL:',
    "   `gh api graphql -f query='query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){id}}}' -f owner=OWNER -f repo=REPO -F number=NUMBER`",
    '3. Create one pending review for that PR and save the returned `pullRequestReview.id`:',
    '   `mutation($pr:ID!){addPullRequestReview(input:{pullRequestId:$pr}){pullRequestReview{id}}}`',
    '4. Add each addressed thread reply to that pending review with the provided PRRT thread ID:',
    '   `mutation($review:ID!,$thread:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewId:$review,pullRequestReviewThreadId:$thread,body:$body}){comment{id url}}}`',
    '5. Submit the pending review so the replies are published:',
    '   `mutation($review:ID!){submitPullRequestReview(input:{pullRequestReviewId:$review,event:COMMENT}){pullRequestReview{id url state}}}`',
    '',
    'Do not leave a pending review unsubmitted. If a GraphQL mutation fails, report the failing PR URL, thread ID, and mutation step.',
    '',
    'Do not mark review comments or threads resolved.',
    'Do not update the status of the issue or PR.',
    'Do not request or re-request reviews.',
    '',
    'Block comments can apply to multiple lines of code. Single-line comments can also apply to multiple lines; infer the intended scope from the comment and surrounding code.',
    '',
    'When done, print the GitHub URL for the PR, but use `https://linear.review` as the domain instead of `https://github.com`.'
  );

  return prompt;
}

async function refreshPrFixStatuses(
  db: ReturnType<typeof getDatabase>,
  planUuid: string,
  prUrls: string[] | undefined
): Promise<PrStatusDetail[]> {
  const cachedStatuses = getPrStatusForPlan(db, planUuid, prUrls, {
    includeReviewThreads: true,
  });
  const urlsToRefresh = [
    ...new Set([...(prUrls ?? []), ...cachedStatuses.map((detail) => detail.status.pr_url)]),
  ];

  if (urlsToRefresh.length === 0) {
    return cachedStatuses;
  }

  const refreshedStatuses: PrStatusDetail[] = [];
  const errors: string[] = [];
  for (const prUrl of urlsToRefresh) {
    try {
      refreshedStatuses.push(await refreshPrStatus(db, prUrl));
    } catch (err) {
      errors.push(`${prUrl}: ${(err as Error).message}`);
    }
  }

  if (errors.length > 0 && refreshedStatuses.length === 0) {
    throw new Error(`Failed to fetch PR review data: ${errors.join('; ')}`);
  }

  for (const errorMessage of errors) {
    log(chalk.yellow(`Warning: failed to fetch PR review data for ${errorMessage}`));
  }

  return refreshedStatuses;
}

function validatePrMatchesCurrentRepository(
  target: { canonicalPrUrl: string; owner: string; repo: string },
  repositoryId: string
): void {
  const parsedRepositoryId = parseOwnerRepoFromRepositoryId(repositoryId);
  if (!parsedRepositoryId) {
    throw new Error(
      `Cannot validate repository identity: ${repositoryId} is not a recognized GitHub repository. This command only works with GitHub PRs.`
    );
  }

  if (
    parsedRepositoryId.owner.toLowerCase() !== target.owner.toLowerCase() ||
    parsedRepositoryId.repo.toLowerCase() !== target.repo.toLowerCase()
  ) {
    throw new Error(
      `PR ${target.canonicalPrUrl} belongs to ${target.owner}/${target.repo}, but the current repository is ${parsedRepositoryId.owner}/${parsedRepositoryId.repo}. Run this command from inside the matching repository.`
    );
  }
}

function getUnresolvedReviewThreads(
  prStatuses: PrStatusDetail[]
): Array<{ thread: PrReviewThreadDetail; prUrl: string }> {
  const unresolvedThreads: Array<{ thread: PrReviewThreadDetail; prUrl: string }> = [];
  for (const prStatus of prStatuses) {
    for (const reviewThread of prStatus.reviewThreads ?? []) {
      if (!reviewThread.thread.is_resolved) {
        unresolvedThreads.push({ thread: reviewThread, prUrl: prStatus.status.pr_url });
      }
    }
  }
  return unresolvedThreads;
}

export async function resolvePrFixTarget(
  intent: PrFixTargetIntent,
  command: RootCommandLike | undefined
): Promise<PrFixTarget> {
  const globalOptions = getRootOptions(command);
  const repoRoot = await resolveRepoRoot(globalOptions.config, process.cwd());
  const db = getDatabase();

  if (intent.mode === 'plan') {
    const {
      plan,
      planPath,
      repoRoot: planRepoRoot,
    } = await resolvePlanForCommand(intent.planId, command);
    const planUuid = requirePlanUuid(plan, planPath ?? `plan ${plan.id}`);
    const dedupedUrls = plan.pullRequest?.length
      ? deduplicatePrUrls(plan.pullRequest).valid
      : undefined;
    const prUrls = dedupedUrls?.length ? dedupedUrls : undefined;
    const prStatuses = await refreshPrFixStatuses(db, planUuid, prUrls);
    return {
      kind: 'plan',
      planId: intent.planId ?? plan.id,
      plan,
      planPath,
      repoRoot: planRepoRoot,
      prStatuses,
    };
  }

  // Force a fresh PR status fetch so unresolved review threads reflect the current
  // state of the PR, matching the plan-backed path's unconditional refresh. `pr fix`
  // acts on currently-unresolved threads, so acting on stale cached threads risks
  // replying to already-resolved threads or missing new ones.
  const prContext = await gatherPrContext({
    db,
    prUrlOrNumber: intent.prUrlOrNumber,
    cwd: repoRoot,
    maxStatusAgeMs: 0,
  });
  const repoIdentity = await getRepositoryIdentity({ cwd: repoRoot });
  validatePrMatchesCurrentRepository(
    {
      canonicalPrUrl: prContext.prUrl,
      owner: prContext.owner,
      repo: prContext.repo,
    },
    repoIdentity.repositoryId
  );
  const prStatus = getPrStatusByUrl(db, prContext.prUrl, { includeReviewThreads: true });
  if (!prStatus) {
    throw new Error(`Failed to load PR review data for ${prContext.prUrl}.`);
  }

  return {
    kind: 'pr',
    repoRoot,
    canonicalPrUrl: prContext.prUrl,
    prNumber: prContext.prNumber,
    owner: prContext.owner,
    repo: prContext.repo,
    title: prStatus.status.title ?? undefined,
    author: prStatus.status.author ?? undefined,
    baseBranch: prContext.baseBranch,
    headBranch: prContext.headBranch,
    headSha: prContext.headSha,
    prStatus,
  };
}

export async function handlePrFixCommand(
  positionalArg: string | number | undefined,
  options: PrFixCommandOptions,
  command: RootCommandLike
): Promise<void> {
  const intent = resolvePrFixTargetIntent(positionalArg, options);

  if (!resolveGitHubToken()) {
    throw new Error('GITHUB_TOKEN environment variable is required for PR status commands');
  }

  const target = await resolvePrFixTarget(intent, command);
  const globalOptions = getRootOptions(command);
  const config = await loadEffectiveConfig(globalOptions.config);
  const noninteractive = options.nonInteractive === true;
  const terminalInputEnabled =
    !noninteractive &&
    process.stdin.isTTY === true &&
    options.terminalInput !== false &&
    config.terminalInput !== false;

  await runWithHeadlessAdapterIfEnabled({
    enabled: !isTunnelActive(),
    command: 'pr-fix',
    interactive: !noninteractive,
    plan:
      target.kind === 'plan'
        ? {
            id: target.plan.id,
            uuid: target.plan.uuid,
            title: target.plan.title,
          }
        : undefined,
    sessionInfo:
      target.kind === 'pr'
        ? {
            linkedPrUrl: target.canonicalPrUrl,
            linkedPrNumber: target.prNumber,
            linkedPrTitle: target.title,
          }
        : undefined,
    callback: async () => {
      await executePrFixCommand({
        target,
        options,
        config,
        noninteractive,
        terminalInputEnabled,
      });
    },
  });
}

export interface PrFixHeadBranchValidationDependencies {
  remoteBranchExists?: (repoRoot: string, headBranch: string) => Promise<boolean>;
}

export async function ensurePrFixHeadBranchPushableOnOrigin(
  target: Pick<PullRequestFixTarget, 'canonicalPrUrl' | 'repoRoot' | 'headBranch'>,
  deps: PrFixHeadBranchValidationDependencies = {}
): Promise<void> {
  // Use the jj-aware dispatcher so the fork check works in non-colocated jj repos,
  // where the plain `git ls-remote` path cannot reach the backing store.
  const branchExists = await (deps.remoteBranchExists ?? remoteBranchExists)(
    target.repoRoot,
    target.headBranch
  );

  if (!branchExists) {
    throw new Error(
      `tim pr fix cannot safely mutate fork PR ${target.canonicalPrUrl}: head branch "${target.headBranch}" is not present on origin, so changes cannot be pushed back. Fork PR fix support is not implemented yet.`
    );
  }
}

export interface PrFixBaseBranchFetchDependencies {
  fetchRemoteBranch?: (workspacePath: string, baseBranch: string) => Promise<boolean>;
}

export async function fetchPrFixBaseBranch(
  workspacePath: string,
  baseBranch: string,
  deps: PrFixBaseBranchFetchDependencies = {}
): Promise<void> {
  const fetched = await (deps.fetchRemoteBranch ?? fetchRemoteBranch)(workspacePath, baseBranch);
  if (!fetched) {
    throw new Error(`Failed to fetch base branch "${baseBranch}" for PR fix.`);
  }
}

function updatePrFixHeadlessSessionInfo(
  db: ReturnType<typeof getDatabase>,
  target: PullRequestFixTarget,
  workspacePath: string
): void {
  const linkedPlan = getLinkedPlansByPrUrl(db, [target.canonicalPrUrl]).get(
    target.canonicalPrUrl
  )?.[0];

  updateHeadlessSessionInfo({
    linkedPrUrl: target.canonicalPrUrl,
    linkedPrNumber: target.prNumber,
    linkedPrTitle: target.title,
    linkedPlanId: linkedPlan?.planId,
    linkedPlanUuid: linkedPlan?.planUuid,
    linkedPlanTitle: linkedPlan?.title ?? undefined,
    workspacePath,
  });
}

async function executePrFixCommand({
  target,
  options,
  config,
  noninteractive,
  terminalInputEnabled,
}: {
  target: PrFixTarget;
  options: PrFixCommandOptions;
  config: Awaited<ReturnType<typeof loadEffectiveConfig>>;
  noninteractive: boolean;
  terminalInputEnabled: boolean;
}): Promise<void> {
  const prStatuses = target.kind === 'plan' ? target.prStatuses : [target.prStatus];
  const unresolvedThreads = getUnresolvedReviewThreads(prStatuses);

  if (unresolvedThreads.length === 0) {
    if (target.kind === 'plan') {
      log(`Plan ${target.plan.id} has no unresolved PR review threads.`);
    } else {
      log(`PR ${target.canonicalPrUrl} has no unresolved PR review threads.`);
    }
    return;
  }

  const fixPrompt =
    target.kind === 'plan'
      ? buildReviewThreadFixPrompt(target.plan, unresolvedThreads)
      : buildPrReviewThreadFixPrompt(target, unresolvedThreads);

  if (target.kind === 'pr') {
    await ensurePrFixHeadBranchPushableOnOrigin(target);
    // Patch PR identity into the headless session as early as possible (before
    // workspace setup) so `hasActiveSessionForPr` can detect this run immediately.
    // Otherwise a slow workspace setup could outlast the launch lock and let a
    // duplicate launch slip past both guards. workspacePath is patched in later.
    updateHeadlessSessionInfo({
      linkedPrUrl: target.canonicalPrUrl,
      linkedPrNumber: target.prNumber,
      linkedPrTitle: target.title,
    });
  }

  const repoRoot = target.repoRoot;
  const configuredPrFix = config.prFix;

  const executorName =
    resolveStringOption(options.executor) ??
    resolveStringOption(options.orchestrator) ??
    configuredPrFix?.executor ??
    config.defaultExecutor ??
    DEFAULT_EXECUTOR;
  const model =
    resolveStringOption(options.model) ??
    configuredPrFix?.model ??
    config.models?.execution ??
    defaultModelForExecutor(executorName, 'execution');
  const effort = resolveStringOption(options.effort) ?? configuredPrFix?.effort;

  let currentBaseDir = repoRoot;
  let currentPlanFile = target.kind === 'plan' ? (target.planPath ?? '') : '';
  let touchedWorkspacePath: string | null = null;
  let roundTripContext: Awaited<ReturnType<typeof prepareWorkspaceRoundTrip>> = null;
  let lifecycleManager: LifecycleManager | undefined;
  let executionError: unknown;

  try {
    const workspaceMode =
      options.workspace !== undefined ||
      options.autoWorkspace === true ||
      options.newWorkspace === true;
    const shouldUseWorkspace = target.kind === 'pr' || workspaceMode;

    if (target.kind === 'pr' && !workspaceMode) {
      log(
        'Selecting a managed workspace for PR fix because mutating a PR branch must not use the current checkout.'
      );
    }

    if (shouldUseWorkspace) {
      const workspaceResult = await setupWorkspace(
        target.kind === 'plan'
          ? {
              workspace: resolveStringOption(options.workspace),
              autoWorkspace: options.autoWorkspace === true,
              newWorkspace: options.newWorkspace === true,
              nonInteractive: noninteractive,
              planId: target.plan.id,
              planUuid: target.plan.uuid,
              checkoutBranch: target.plan.branch,
              createBranch: false,
              allowPrimaryWorkspaceWhenLocked: true,
            }
          : {
              workspace: resolveStringOption(options.workspace),
              // PR fix must always run in a managed workspace so it never mutates the
              // user's current checkout. Force auto-selection unless an explicit
              // workspace name was given (which routes through the named-workspace path).
              // This also covers `--new-workspace` alone, which otherwise would not
              // satisfy setupWorkspace's `workspace || autoWorkspace` guard.
              autoWorkspace:
                resolveStringOption(options.workspace) === undefined
                  ? true
                  : options.autoWorkspace === true,
              newWorkspace: options.newWorkspace === true,
              nonInteractive: noninteractive,
              branchName: target.headBranch,
              checkoutBranch: target.headBranch,
              createBranch: false,
              allowPrimaryWorkspaceWhenLocked: true,
            },
        currentBaseDir,
        currentPlanFile || undefined,
        config,
        'tim pr fix'
      );

      currentBaseDir = workspaceResult.baseDir;
      currentPlanFile = workspaceResult.planFile;
      touchedWorkspacePath = currentBaseDir;

      if (target.kind === 'pr') {
        await fetchPrFixBaseBranch(currentBaseDir, target.baseBranch);
        updatePrFixHeadlessSessionInfo(getDatabase(), target, currentBaseDir);
      }

      if (path.resolve(currentBaseDir) !== path.resolve(repoRoot)) {
        roundTripContext = await prepareWorkspaceRoundTrip({
          workspacePath: currentBaseDir,
          workspaceSyncEnabled: options.workspaceSync !== false,
          branchCreatedDuringSetup: workspaceResult.branchCreatedDuringSetup,
        });
      }

      if (roundTripContext) {
        await runPreExecutionWorkspaceSync(roundTripContext);

        if (target.kind === 'plan') {
          const materializedPlanFile = await materializePlansForExecution(
            currentBaseDir,
            target.plan.id
          );
          if (materializedPlanFile) {
            currentPlanFile = materializedPlanFile;
          }
        }
      }
    }

    const timEnvironment = buildTimWorkspaceCommandEnvironmentOptionsForPath(
      config,
      currentBaseDir,
      target.kind === 'plan'
        ? {
            planId: target.plan.id,
            planUuid: target.plan.uuid,
            planFilePath: currentPlanFile || undefined,
            branch: target.plan.branch,
          }
        : null,
      repoRoot
    );
    if (config.lifecycle?.commands && config.lifecycle.commands.length > 0 && !isShuttingDown()) {
      const workspaceInfo = getWorkspaceInfoByPath(currentBaseDir);
      lifecycleManager = new LifecycleManager(
        config.lifecycle.commands,
        currentBaseDir,
        workspaceInfo?.workspaceType,
        'pr-fix',
        undefined,
        { timEnvironment }
      );
      await lifecycleManager.startup();
    }

    const sharedExecutorOptions: ExecutorCommonOptions = {
      baseDir: currentBaseDir,
      model,
      noninteractive: noninteractive ? true : undefined,
      terminalInput: terminalInputEnabled,
      closeTerminalInputOnResult: false,
      disableInactivityTimeout: true,
      timEnvironment,
    };
    const executor = buildExecutorAndLog(
      executorName,
      sharedExecutorOptions,
      config,
      buildPrFixExecutorOptions(executorName, effort, config)
    );

    if (target.kind === 'plan') {
      await executor.execute(fixPrompt, {
        planId: String(target.plan.id ?? target.planId),
        planTitle: target.plan.title || `Plan ${target.plan.id ?? target.planId}`,
        planFilePath: currentPlanFile,
        executionMode: 'planning',
      });
    } else {
      await executor.execute(fixPrompt, {
        planId: `pr-${target.prNumber}`,
        planTitle: target.title || `PR #${target.prNumber}`,
        executionMode: 'planning',
      });
    }
  } catch (err) {
    executionError = err;
  } finally {
    let roundTripError: unknown;
    let lifecycleShutdownError: unknown;
    if (lifecycleManager) {
      try {
        await lifecycleManager.shutdown();
      } catch (err) {
        lifecycleShutdownError = err;
      }
    }

    if (roundTripContext) {
      try {
        await runPostExecutionWorkspaceSync(roundTripContext, 'PR review fixes');
      } catch (err) {
        roundTripError = err;
      }
    }

    if (touchedWorkspacePath) {
      try {
        touchWorkspaceInfo(touchedWorkspacePath);
      } catch (err) {
        warn(`Failed to update workspace last used time: ${err as Error}`);
      }
    }

    if (executionError) {
      if (lifecycleShutdownError) {
        warn(`Lifecycle shutdown failed after PR fix error: ${lifecycleShutdownError as Error}`);
      }
      if (roundTripError) {
        warn(`Workspace sync failed after PR fix error: ${roundTripError as Error}`);
      }
      throw executionError;
    }

    if (lifecycleShutdownError) {
      throw lifecycleShutdownError;
    }

    if (roundTripError) {
      throw roundTripError;
    }
  }
}

export async function handlePrLinkCommand(
  planId: number,
  prUrl: string | undefined,
  _options: Record<string, unknown>,
  command: RootCommandLike
): Promise<void> {
  if (!resolveGitHubToken()) {
    throw new Error('GITHUB_TOKEN environment variable is required for PR status commands');
  }

  const { plan, planPath, repoRoot } = await resolvePlanForCommand(planId, command);
  const planUuid = requirePlanUuid(plan, planPath ?? `plan ${plan.id}`);

  // Resolve the PR URL: could be a URL, short-form (owner/repo#123), branch name, or omitted
  let effectivePrUrl = prUrl;
  if (effectivePrUrl) {
    // Check if it looks like a PR identifier (URL or owner/repo#N) vs a branch name
    const parsedAsIdentifier = await parsePrOrIssueNumber(effectivePrUrl);
    if (!parsedAsIdentifier) {
      // Treat as a branch name
      const foundUrl = await findPrUrlForBranch(effectivePrUrl);
      if (!foundUrl) {
        throw new Error(
          `No open PR found for branch "${effectivePrUrl}". Please specify a PR URL explicitly.`
        );
      }
      effectivePrUrl = foundUrl;
    }
  } else {
    // No argument provided, try to find one from the plan's branch
    const branch = plan.branch;
    if (branch) {
      const foundUrl = await findPrUrlForBranch(branch);
      if (!foundUrl) {
        throw new Error(
          `No open PR found for branch "${branch}". Please specify a PR URL explicitly.`
        );
      }
      effectivePrUrl = foundUrl;
    }
  }

  if (!effectivePrUrl) {
    throw new Error(
      'No PR URL provided and the plan has no branch to look up. Please specify a PR URL.'
    );
  }

  const normalizedInput = canonicalizePrUrl(effectivePrUrl);
  const parsed = await parsePrOrIssueNumber(normalizedInput);

  if (!parsed) {
    throw new Error(`Invalid GitHub pull request identifier: ${normalizedInput}`);
  }

  // For URL inputs, canonicalizePrUrl already returns the canonical form.
  // For non-URL inputs (e.g. owner/repo#123), construct the canonical URL from parsed components.
  const canonicalUrl = isUrlIdentifier(normalizedInput)
    ? normalizedInput
    : `https://github.com/${parsed.owner}/${parsed.repo}/pull/${parsed.number}`;

  // Validate with GitHub first - don't modify plan file if PR doesn't exist
  const db = getDatabase();
  const detail = await refreshPrStatus(db, canonicalUrl);

  // Now persist to plan file (source of truth) and create DB junction
  await persistPlanPullRequests(repoRoot, planPath, plan, (pullRequests) => {
    const normalizedPullRequests = normalizeStoredPullRequests(pullRequests);
    return normalizedPullRequests.includes(canonicalUrl)
      ? normalizedPullRequests
      : [...normalizedPullRequests, canonicalUrl];
  });
  linkPlanToPr(db, planUuid, detail.status.id);

  log(
    `Linked ${chalk.cyan(`${parsed.owner}/${parsed.repo}#${parsed.number}`)} to plan ${chalk.bold(String(plan.id))}`
  );
}

export async function handlePrUnlinkCommand(
  planId: number,
  prUrl: string,
  _options: Record<string, unknown>,
  command: RootCommandLike
): Promise<void> {
  const { plan, planPath, repoRoot } = await resolvePlanForCommand(planId, command);
  const planUuid = requirePlanUuid(plan, planPath ?? `plan ${plan.id}`);

  const normalizedInput = canonicalizePrUrl(prUrl);
  const parsed = await parsePrOrIssueNumber(normalizedInput);
  const canonicalUrl =
    parsed && !isUrlIdentifier(normalizedInput)
      ? `https://github.com/${parsed.owner}/${parsed.repo}/pull/${parsed.number}`
      : normalizedInput;

  // Remove from plan (writes DB, then re-materializes file if present)
  let removed = false;
  await persistPlanPullRequests(repoRoot, planPath, plan, (pullRequests) => {
    const normalizedPullRequests = normalizeStoredPullRequests(pullRequests);
    const filtered = normalizedPullRequests.filter(
      (existingPrUrl) => existingPrUrl !== canonicalUrl
    );
    removed = filtered.length < normalizedPullRequests.length;
    return filtered;
  });

  // Best-effort DB cleanup - PR status may not be cached yet (lazy population)
  const db = getDatabase();
  const detail = getPrStatusByUrl(db, canonicalUrl);
  if (detail) {
    unlinkPlanFromPr(db, planUuid, detail.status.id);
    cleanOrphanedPrStatus(db);
  }

  if (removed) {
    log(`Unlinked ${chalk.cyan(canonicalUrl)} from plan ${chalk.bold(String(plan.id))}`);
  } else {
    log(`${chalk.yellow(canonicalUrl)} was not linked to plan ${chalk.bold(String(plan.id))}`);
  }
}
