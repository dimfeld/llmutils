import chalk from 'chalk';
import { parsePrOrIssueNumber } from '../../common/github/identifiers.js';
import { refreshPrStatus } from '../../common/github/pr_status_service.js';
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
  const workspaceInfo = getWorkspaceInfoByPath(cwd);
  if (!workspaceInfo) {
    return null;
  }

  return workspaceInfo.originalPlanFilePath ?? workspaceInfo.planId ?? null;
}

async function resolvePlanForCommand(
  planArg: string | undefined,
  command: RootCommandLike | undefined
): Promise<{ plan: PlanSchema; planPath: string }> {
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
  return resolvePlan(effectivePlanArg, {
    gitRoot: process.cwd(),
    configPath: globalOpts.config,
  });
}

function requirePlanUuid(plan: PlanSchema, planPath: string): string {
  if (!plan.uuid) {
    throw new Error(`Plan ${planPath} is missing a UUID and cannot be linked to pull requests`);
  }

  return plan.uuid;
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
  const { plan } = await resolvePlanForCommand(planId, command);
  const prUrls = plan.pullRequest ?? [];

  if (prUrls.length === 0) {
    log(`Plan ${plan.id} has no linked pull requests.`);
    return;
  }

  const db = getDatabase();

  for (const prUrl of prUrls) {
    const detail = await refreshPrStatus(db, prUrl);
    logPrStatus(detail);
    log('');
  }
}

export async function handlePrLinkCommand(
  planId: string,
  prUrl: string,
  _options: Record<string, unknown>,
  command: RootCommandLike
): Promise<void> {
  const { plan, planPath } = await resolvePlanForCommand(planId, command);
  const planUuid = requirePlanUuid(plan, planPath);
  const parsed = await parsePrOrIssueNumber(prUrl);

  if (!parsed) {
    throw new Error(`Invalid GitHub pull request identifier: ${prUrl}`);
  }

  const db = getDatabase();
  const detail = await refreshPrStatus(db, prUrl);
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
  const { plan, planPath } = await resolvePlanForCommand(planId, command);
  const planUuid = requirePlanUuid(plan, planPath);
  const db = getDatabase();
  const detail = getPrStatusByUrl(db, prUrl);

  if (!detail) {
    throw new Error(`No cached PR status found for ${prUrl}`);
  }

  unlinkPlanFromPr(db, planUuid, detail.status.id);
  cleanOrphanedPrStatus(db);

  log(`Unlinked ${chalk.cyan(prUrl)} from plan ${chalk.bold(String(plan.id))}`);
}
