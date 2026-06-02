import path from 'node:path';

import chalk from 'chalk';
import {
  canonicalizePrUrl,
  deduplicatePrUrls,
  parsePrOrIssueNumber,
} from '../../common/github/identifiers.js';
import { getGitRepository } from '../../common/git.js';
import { getWebhookServerUrl } from '../../common/github/webhook_client.js';
import {
  formatWebhookIngestErrors,
  ingestWebhookEvents,
} from '../../common/github/webhook_ingest.js';
import { resolveGitHubToken } from '../../common/github/token.js';
import {
  addReplyToReviewThread,
  fetchOpenPullRequests,
  resolveReviewThread,
} from '../../common/github/pull_requests.js';
import { refreshPrStatus, syncPlanPrLinks } from '../../common/github/pr_status_service.js';
import { log, warn } from '../../logging.js';
import { isTunnelActive } from '../../logging/tunnel_client.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { getDatabase } from '../db/database.js';
import {
  cleanOrphanedPrStatus,
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
import { runWithHeadlessAdapterIfEnabled } from '../headless.js';

interface RootCommandLike {
  parent?: RootCommandLike;
  opts?: () => {
    config?: string;
  };
}

interface PrStatusCommandOptions {
  forceRefresh?: boolean;
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

export async function handlePrReplyCommand(threadId: string, body: string): Promise<void> {
  const success = await addReplyToReviewThread(threadId, body);

  if (!success) {
    throw new Error(`Failed to reply to review thread ${threadId}`);
  }

  log(chalk.green(`Replied to review thread ${threadId}`));
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

export function buildReviewThreadFixPrompt(
  planData: PlanSchema,
  threads: Array<{ thread: PrReviewThreadDetail; prUrl: string }>
): string {
  const prUrls = [...new Set(threads.map(({ prUrl }) => prUrl))];
  const branch = planData.branch?.trim() || 'Current working branch';
  const prSelector = planData.branch?.trim() || prUrls[0] || '<pr-url-or-branch>';
  const prompt = [
    '# Address Pull Request Review Comments',
    '',
    'You are addressing review comments on a pull request for the current branch.',
    '',
    'The PR branch and PR URLs are already known from the plan context below; do not spend time auto-discovering the branch.',
    'Fetch the full PR feedback yourself before changing code so review threads, general PR comments, and reviews that are not tied to a diff line are all included.',
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

  prompt.push(
    '## Fetch Full Review Feedback',
    '',
    'Before making code changes, fetch the complete PR feedback for the branch/PR above:',
    `- \`gh pr view ${prSelector} --json number,title,headRefName,baseRefName,url,author,reviewDecision\``,
    `- \`gh pr view ${prSelector} --comments\``,
    '- `gh api repos/:owner/:repo/pulls/<number>/comments` for line-level review comments',
    '- `gh api repos/:owner/:repo/pulls/<number>/reviews` for submitted review summaries',
    '',
    'List the comments you found in your working notes before implementing fixes, including author, file, line when present, comment summary, and whether each item is a review-thread comment or general PR feedback.',
    '',
    'For feedback that is not a review-thread comment, leave an appropriate PR comment describing the change after addressing it.',
    ''
  );

  prompt.push(
    '## User Feedback',
    '',
    'After fetching the review comments and related feedback, list the comments for the user before making code changes. Include enough context to distinguish each item, such as author, file, line, comment summary, and whether it is a review-thread comment or general PR feedback.',
    '',
    'Ask the user for feedback on which review comments to address and how. If the user has already given clear instructions, follow those instructions; otherwise wait for direction before implementing fixes.',
    '',
    '## Responsibilities',
    '',
    '1. Read the fetched PR comments, review comments, review threads, and reviews, then identify the actionable AI feedback.',
    '2. Inspect the surrounding code to understand the intent behind each comment. When additional context is needed, diff against the base branch, which is probably `main`.',
    '3. Ask the user for feedback on which review comments to address and how, as described above.',
    '4. Apply focused changes that resolve the raised concerns without altering unrelated code.',
    '5. Run type checking, linting, and tests appropriate to the files you changed. Add tests only when necessary to cover the fixes.',
    '6. Reply to each addressed review thread with a concise explanation of what changed using:',
    '   `tim pr reply <Thread ID> "explanation of fix"`',
    '7. For addressed feedback that was not a review-thread comment, leave an appropriate PR comment reply describing the change.',
    '8. Before finishing, make sure you have reviewed all fetched AI comments.',
    '',
    'Do not mark review comments or threads resolved.',
    'Do not update the status of the issue or PR.',
    'Do not request or re-request reviews.',
    '',
    'Block comments can apply to multiple lines of code. Single-line comments can also apply to multiple lines; infer the intended scope from the comment and surrounding code.',
    '',
    'When done, print the GitHub URL for the PR, but use `https://linear.review` as the domain instead of `https://github.com`.'
  );

  return prompt.join('\n');
}

export async function handlePrFixCommand(
  planId: number,
  options: Record<string, unknown>,
  command: RootCommandLike
): Promise<void> {
  if (!resolveGitHubToken()) {
    throw new Error('GITHUB_TOKEN environment variable is required for PR status commands');
  }

  const { plan, planPath, repoRoot } = await resolvePlanForCommand(planId, command);
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
    plan: {
      id: plan.id,
      uuid: plan.uuid,
      title: plan.title,
    },
    callback: async () => {
      await executePrFixCommand({
        planId,
        options,
        plan,
        planPath,
        repoRoot,
        config,
        noninteractive,
        terminalInputEnabled,
      });
    },
  });
}

async function executePrFixCommand({
  planId,
  options,
  plan,
  planPath,
  repoRoot,
  config,
  noninteractive,
  terminalInputEnabled,
}: {
  planId: number;
  options: Record<string, unknown>;
  plan: PlanSchema;
  planPath: string | null;
  repoRoot: string;
  config: Awaited<ReturnType<typeof loadEffectiveConfig>>;
  noninteractive: boolean;
  terminalInputEnabled: boolean;
}): Promise<void> {
  const planUuid = requirePlanUuid(plan, planPath ?? `plan ${plan.id}`);
  const db = getDatabase();
  const dedupedUrls = plan.pullRequest?.length
    ? deduplicatePrUrls(plan.pullRequest).valid
    : undefined;
  const prUrls = dedupedUrls?.length ? dedupedUrls : undefined;
  const prStatuses = getPrStatusForPlan(db, planUuid, prUrls, {
    includeReviewThreads: true,
  });

  const unresolvedThreads: Array<{ thread: PrReviewThreadDetail; prUrl: string }> = [];
  for (const prStatus of prStatuses) {
    for (const reviewThread of prStatus.reviewThreads ?? []) {
      if (!reviewThread.thread.is_resolved) {
        unresolvedThreads.push({ thread: reviewThread, prUrl: prStatus.status.pr_url });
      }
    }
  }

  if (unresolvedThreads.length === 0) {
    log(`Plan ${plan.id} has no unresolved PR review threads.`);
    return;
  }

  const fixPrompt = buildReviewThreadFixPrompt(plan, unresolvedThreads);
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
  let currentPlanFile = planPath ?? '';
  let touchedWorkspacePath: string | null = null;
  let roundTripContext: Awaited<ReturnType<typeof prepareWorkspaceRoundTrip>> = null;
  let executionError: unknown;

  try {
    const workspaceMode =
      options.workspace !== undefined ||
      options.autoWorkspace === true ||
      options.newWorkspace === true;

    if (workspaceMode) {
      const workspaceResult = await setupWorkspace(
        {
          workspace: resolveStringOption(options.workspace),
          autoWorkspace: options.autoWorkspace === true,
          newWorkspace: options.newWorkspace === true,
          nonInteractive: noninteractive,
          planId: plan.id,
          planUuid: plan.uuid,
          checkoutBranch: plan.branch,
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

      if (path.resolve(currentBaseDir) !== path.resolve(repoRoot)) {
        roundTripContext = await prepareWorkspaceRoundTrip({
          workspacePath: currentBaseDir,
          workspaceSyncEnabled: options.workspaceSync !== false,
          branchCreatedDuringSetup: workspaceResult.branchCreatedDuringSetup,
        });
      }

      if (roundTripContext) {
        await runPreExecutionWorkspaceSync(roundTripContext);

        const materializedPlanFile = await materializePlansForExecution(currentBaseDir, plan.id);
        if (materializedPlanFile) {
          currentPlanFile = materializedPlanFile;
        }
      }
    }

    const sharedExecutorOptions: ExecutorCommonOptions = {
      baseDir: currentBaseDir,
      model,
      noninteractive: noninteractive ? true : undefined,
      terminalInput: terminalInputEnabled,
      closeTerminalInputOnResult: false,
      disableInactivityTimeout: true,
      timEnvironment: buildTimWorkspaceCommandEnvironmentOptionsForPath(
        config,
        currentBaseDir,
        {
          planId: plan.id,
          planUuid: plan.uuid,
          planFilePath: currentPlanFile || undefined,
          branch: plan.branch,
        },
        repoRoot
      ),
    };
    const executor = buildExecutorAndLog(
      executorName,
      sharedExecutorOptions,
      config,
      buildPrFixExecutorOptions(executorName, effort, config)
    );

    await executor.execute(fixPrompt, {
      planId: String(plan.id ?? planId),
      planTitle: plan.title || `Plan ${plan.id ?? planId}`,
      planFilePath: currentPlanFile,
      executionMode: 'planning',
    });
  } catch (err) {
    executionError = err;
  } finally {
    let roundTripError: unknown;
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
      if (roundTripError) {
        warn(`Workspace sync failed after PR fix error: ${roundTripError as Error}`);
      }
      throw executionError;
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
