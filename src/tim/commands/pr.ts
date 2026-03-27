import path from 'node:path';

import chalk from 'chalk';
import {
  canonicalizePrUrl,
  deduplicatePrUrls,
  parsePrOrIssueNumber,
} from '../../common/github/identifiers.js';
import { getGitRepository } from '../../common/git.js';
import { fetchOpenPullRequests } from '../../common/github/pull_requests.js';
import { refreshPrStatus, syncPlanPrLinks } from '../../common/github/pr_status_service.js';
import { log } from '../../logging.js';
import { getDatabase } from '../db/database.js';
import {
  cleanOrphanedPrStatus,
  getPrStatusByUrl,
  linkPlanToPr,
  unlinkPlanFromPr,
  type PrCheckRunRow,
  type PrReviewRow,
  type PrStatusDetail,
  type PrStatusRow,
} from '../db/pr_status.js';
import { resolvePlan } from '../plan_display.js';
import type { PlanSchema } from '../planSchema.js';
import { resolvePlanFromDb, writePlanFile } from '../plans.js';
import { resolveRepoRootForPlanArg } from '../plan_repo_root.js';
import { getWorkspaceInfoByPath } from '../workspace/workspace_info.js';

interface RootCommandLike {
  parent?: RootCommandLike;
  opts?: () => {
    config?: string;
  };
}

function getRootOptions(command: RootCommandLike | undefined): { config?: string } {
  let current = command;
  while (current?.parent) {
    current = current.parent;
  }

  return current?.opts?.() ?? {};
}

function getWorkspacePlanReference(cwd: string): string | null {
  let currentDir = cwd;

  while (true) {
    const workspaceInfo = getWorkspaceInfoByPath(currentDir);
    if (workspaceInfo) {
      return workspaceInfo.originalPlanFilePath ?? workspaceInfo.planId ?? null;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

async function resolvePlanForCommand(
  planArg: string | undefined,
  command: RootCommandLike | undefined
): Promise<{ plan: PlanSchema; planPath: string | null; repoRoot: string }> {
  const trimmedPlanArg = planArg?.trim();
  const effectivePlanArg =
    trimmedPlanArg && trimmedPlanArg.length > 0
      ? trimmedPlanArg
      : getWorkspacePlanReference(process.cwd());

  if (!effectivePlanArg) {
    throw new Error(
      'Please provide a plan ID/path or run this command from a workspace linked to a plan'
    );
  }

  const globalOpts = getRootOptions(command);
  const repoRoot = await resolveRepoRootForPlanArg(
    effectivePlanArg,
    process.cwd(),
    globalOpts.config
  );
  const resolved = await resolvePlan(effectivePlanArg, {
    gitRoot: repoRoot,
    configPath: globalOpts.config,
  });
  return { ...resolved, repoRoot };
}

function requirePlanUuid(plan: PlanSchema, planPath: string): string {
  if (!plan.uuid) {
    throw new Error(`Plan ${planPath} is missing a UUID and cannot be linked to pull requests`);
  }

  return plan.uuid;
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
  const resolved = await resolvePlanFromDb(currentPlan.uuid ?? String(currentPlan.id), repoRoot);
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
  planId: string | undefined,
  _options: Record<string, unknown>,
  command: RootCommandLike
): Promise<void> {
  const { plan, planPath, repoRoot } = await resolvePlanForCommand(planId, command);
  let prUrls = plan.pullRequest ?? [];

  if (prUrls.length === 0 && !plan.branch) {
    log(`Plan ${plan.id} has no linked pull requests and no branch to look up.`);
    return;
  }

  if (!process.env.GITHUB_TOKEN) {
    throw new Error('GITHUB_TOKEN environment variable is required for PR status commands');
  }

  // If no PRs linked, try to find one from the plan's branch
  if (prUrls.length === 0 && plan.branch) {
    const foundUrl = await findPrUrlForBranch(plan.branch);
    if (foundUrl) {
      // Auto-link the discovered PR to the plan
      const planUuid = plan.uuid;
      await persistPlanPullRequests(repoRoot, planPath, plan, (pullRequests) => {
        const normalized = normalizeStoredPullRequests(pullRequests);
        return normalized.includes(foundUrl) ? normalized : [...normalized, foundUrl];
      });
      if (planUuid) {
        const db = getDatabase();
        const detail = await refreshPrStatus(db, foundUrl);
        linkPlanToPr(db, planUuid, detail.status.id);
      }
      prUrls = [foundUrl];
    }
  }

  const db = getDatabase();

  // Canonicalize and deduplicate PR URLs before fetching
  const { valid: uniquePrUrls, invalid: invalidUrls } = deduplicatePrUrls(prUrls);
  for (const url of invalidUrls) {
    log(chalk.yellow(`Warning: skipping invalid PR URL: ${url}`));
  }

  // Force-refresh all PRs from GitHub (CLI always fetches fresh data)
  const details: PrStatusDetail[] = [];
  const successfulUrls: string[] = [];
  const errors: Array<{ url: string; error: Error }> = [];
  for (const prUrl of uniquePrUrls) {
    try {
      const detail = await refreshPrStatus(db, prUrl);
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

  // Sync plan_pr junctions (best-effort, skip if no UUID).
  // Try full prUrls first to preserve links for previously-cached PRs that failed to refresh.
  // If that fails (uncached PR can't be fetched), fall back to just successful URLs.
  if (plan.uuid) {
    try {
      await syncPlanPrLinks(db, plan.uuid, prUrls);
    } catch {
      try {
        await syncPlanPrLinks(db, plan.uuid, successfulUrls);
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

export async function handlePrLinkCommand(
  planId: string,
  prUrl: string | undefined,
  _options: Record<string, unknown>,
  command: RootCommandLike
): Promise<void> {
  if (!process.env.GITHUB_TOKEN) {
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
  planId: string,
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
