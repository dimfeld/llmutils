import type { Database } from 'bun:sqlite';
import { parseOwnerRepoFromRepositoryId } from '../../common/github/pull_requests.js';
import { log } from '../../logging.js';
import { getDatabase } from '../db/database.js';
import { getPlanByPlanId, type PlanRow } from '../db/plan.js';
import { getProjectById } from '../db/project.js';
import {
  getLinkedPlansByPrUrl,
  getPrStatusByUrl,
  getPrStatusForPlan,
  type LinkedPlanSummary,
  type PrStatusRow,
} from '../db/pr_status.js';
import {
  getReviewIssueById,
  getReviewIssues,
  getReviewsByPlanUuid,
  getReviewsByPrUrl,
  updateReviewIssue,
  type ReviewIssueRow,
  type ReviewWithIssueCounts,
} from '../db/review.js';
import { parsePlanIdFromCliArg } from '../plans.js';
import { resolvePrUrl } from '../utils/pr_context_gathering.js';
import { resolveProjectContextForRepo } from './review_workflow.js';

export interface ReviewGuideListIssuesOptions {
  all?: boolean;
}

export interface ReviewGuideResolveIssueOptions {
  unresolved?: boolean;
}

type ResolvedReviewGuideTarget =
  | {
      kind: 'plan';
      label: string;
      plan: PlanRow;
      linkedPrUrls: string[];
      reviews: ReviewWithIssueCounts[];
    }
  | {
      kind: 'pr';
      label: string;
      pr: PrStatusRow | null;
      prUrl: string;
      linkedPlans: LinkedPlanSummary[];
      reviews: ReviewWithIssueCounts[];
    };
type ResolvedPlanReviewGuideTarget = Extract<ResolvedReviewGuideTarget, { kind: 'plan' }>;
type ResolvedPrReviewGuideTarget = Extract<ResolvedReviewGuideTarget, { kind: 'pr' }>;

function parseJsonStringArray(value: string | null): string[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is string => typeof item === 'string' && item.length > 0);
  } catch {
    return [];
  }
}

function tryParsePlanId(value: string): number | null {
  try {
    return parsePlanIdFromCliArg(value);
  } catch {
    return null;
  }
}

function findPlansByBranch(db: Database, projectId: number, branch: string): PlanRow[] {
  return db
    .prepare(
      `
        SELECT *
        FROM plan
        WHERE project_id = ?
          AND branch = ?
        ORDER BY updated_at DESC, plan_id DESC, uuid DESC
      `
    )
    .all(projectId, branch) as PlanRow[];
}

function findPrsByBranch(db: Database, projectId: number, branch: string): PrStatusRow[] {
  const project = getProjectById(db, projectId);
  const ownerRepo = project ? parseOwnerRepoFromRepositoryId(project.repository_id) : null;
  if (!ownerRepo) {
    return [];
  }

  return db
    .prepare(
      `
        SELECT *
        FROM pr_status
        WHERE owner = ?
          AND repo = ?
          AND head_branch = ?
        ORDER BY updated_at DESC, id DESC
      `
    )
    .all(ownerRepo.owner, ownerRepo.repo, branch) as PrStatusRow[];
}

function buildPlanTarget(
  db: Database,
  projectId: number,
  plan: PlanRow
): ResolvedPlanReviewGuideTarget {
  const explicitPrUrls = parseJsonStringArray(plan.pull_request);
  const prStatuses = getPrStatusForPlan(db, plan.uuid, explicitPrUrls);
  const linkedPrUrls = prStatuses.map((detail) => detail.status.pr_url);

  return {
    kind: 'plan',
    label: `plan ${plan.plan_id}${plan.title ? `: ${plan.title}` : ''}`,
    plan,
    linkedPrUrls,
    reviews: getReviewsByPlanUuid(db, plan.uuid, { linkedPrUrls }),
  };
}

function buildPrTarget(db: Database, prUrl: string): ResolvedPrReviewGuideTarget {
  const detail = getPrStatusByUrl(db, prUrl);
  const resolvedPrUrl = detail?.status.pr_url ?? prUrl;
  const linkedPlans = getLinkedPlansByPrUrl(db, [resolvedPrUrl]).get(resolvedPrUrl) ?? [];
  const linkedPlanUuids = linkedPlans.map((plan) => plan.planUuid);

  return {
    kind: 'pr',
    label: detail
      ? `PR #${detail.status.pr_number}${detail.status.title ? `: ${detail.status.title}` : ''}`
      : resolvedPrUrl,
    pr: detail?.status ?? null,
    prUrl: resolvedPrUrl,
    linkedPlans,
    reviews: getReviewsByPrUrl(db, resolvedPrUrl, { linkedPlanUuids }),
  };
}

export function getLatestReviewGuide(
  reviews: ReviewWithIssueCounts[]
): ReviewWithIssueCounts | null {
  return (
    reviews.find((review) => review.review_guide != null && review.review_guide.trim() !== '') ??
    null
  );
}

function formatIssueLocation(issue: ReviewIssueRow): string {
  if (!issue.file) {
    return '(no file)';
  }
  if (issue.start_line && issue.line) {
    return `${issue.file}:${issue.start_line}-${issue.line}`;
  }
  if (issue.line) {
    return `${issue.file}:${issue.line}`;
  }
  return issue.file;
}

function formatReviewIssue(issue: ReviewIssueRow): string {
  const status = issue.resolved === 1 ? 'resolved' : 'open';
  const source = issue.source ? ` source=${issue.source}` : '';
  const sections = [
    `#${issue.id} [${status}] ${issue.severity}/${issue.category} ${formatIssueLocation(issue)}${source}`,
    `  ${issue.content}`,
  ];
  const suggestion = issue.suggestion?.trim();
  if (suggestion) {
    sections.push(`  Suggestion: ${suggestion}`);
  }
  return sections.join('\n');
}

function linkedSummary(target: ResolvedReviewGuideTarget): string {
  if (target.kind === 'plan') {
    return target.linkedPrUrls.length > 0 ? `Linked PRs: ${target.linkedPrUrls.join(', ')}` : '';
  }
  return target.linkedPlans.length > 0
    ? `Linked plans: ${target.linkedPlans.map((plan) => plan.planId).join(', ')}`
    : '';
}

export async function resolveReviewGuideTarget(
  db: Database,
  projectId: number,
  targetArg: string,
  cwd: string
): Promise<ResolvedReviewGuideTarget> {
  const planId = tryParsePlanId(targetArg);
  if (planId !== null) {
    const plan = getPlanByPlanId(db, projectId, planId);
    if (!plan) {
      throw new Error(`Plan ${planId} was not found in the current project.`);
    }
    return buildPlanTarget(db, projectId, plan);
  }

  if (/^https?:\/\//.test(targetArg)) {
    const prUrl = await resolvePrUrl({ db, prUrlOrNumber: targetArg, cwd });
    return buildPrTarget(db, prUrl);
  }

  const branchPlans = findPlansByBranch(db, projectId, targetArg);
  const branchPrs = findPrsByBranch(db, projectId, targetArg);

  if (branchPlans.length === 1) {
    const planTarget = buildPlanTarget(db, projectId, branchPlans[0]);
    const prUrls = new Set(planTarget.linkedPrUrls);
    const unlinkedPrs = branchPrs.filter((pr) => !prUrls.has(pr.pr_url));
    if (unlinkedPrs.length === 0) {
      return planTarget;
    }
  }

  if (branchPlans.length === 0 && branchPrs.length === 1) {
    return buildPrTarget(db, branchPrs[0].pr_url);
  }

  if (branchPlans.length === 0 && branchPrs.length === 0) {
    const review = db
      .prepare(
        `
          SELECT *
          FROM review
          WHERE project_id = ?
            AND branch = ?
            AND pr_url IS NOT NULL
          ORDER BY created_at DESC, id DESC
          LIMIT 1
        `
      )
      .get(projectId, targetArg) as { pr_url: string } | null;
    if (review?.pr_url) {
      return buildPrTarget(db, review.pr_url);
    }
    throw new Error(`No plan, PR, or review guide found for branch "${targetArg}".`);
  }

  throw new Error(
    `Branch "${targetArg}" is ambiguous. It matches ${branchPlans.length} plan(s) and ${branchPrs.length} PR(s); use a plan ID or PR URL.`
  );
}

export function listReviewGuideIssuesForTarget(
  db: Database,
  target: ResolvedReviewGuideTarget,
  options: ReviewGuideListIssuesOptions = {}
): string {
  const review = getLatestReviewGuide(target.reviews);
  if (!review) {
    throw new Error(`No stored review guide found for ${target.label}.`);
  }

  const issues = getReviewIssues(db, review.id)
    .filter((issue) => issue.severity !== 'note')
    .filter((issue) => options.all === true || issue.resolved === 0);
  const totalIssueCount = review.issue_count;
  const unresolvedIssueCount = review.unresolved_count;
  const header = [
    `${target.label}`,
    `Review #${review.id}: ${unresolvedIssueCount} unresolved / ${totalIssueCount} total issue(s)`,
    linkedSummary(target),
  ].filter(Boolean);

  if (issues.length === 0) {
    return `${header.join('\n')}\nNo ${options.all === true ? '' : 'unresolved '}issues found.`;
  }

  return `${header.join('\n')}\n\n${issues.map(formatReviewIssue).join('\n\n')}`;
}

export async function handleReviewGuideListIssuesCommand(
  targetArg: string,
  options: ReviewGuideListIssuesOptions
): Promise<void> {
  const db = getDatabase();
  const { projectId, repoRoot } = await resolveProjectContextForRepo(db, process.cwd());
  const target = await resolveReviewGuideTarget(db, projectId, targetArg, repoRoot);
  log(listReviewGuideIssuesForTarget(db, target, options));
}

export async function handleReviewGuideResolveIssueCommand(
  issueIdArg: string,
  targetArg: string | undefined,
  options: ReviewGuideResolveIssueOptions
): Promise<void> {
  const issueId = Number(issueIdArg);
  if (!Number.isInteger(issueId) || issueId <= 0) {
    throw new Error(`Expected a positive numeric review issue ID, got "${issueIdArg}".`);
  }

  const db = getDatabase();
  const issue = getReviewIssueById(db, issueId);
  if (!issue) {
    throw new Error(`Review issue ${issueId} was not found.`);
  }
  if (issue.severity === 'note') {
    throw new Error('Notes cannot be resolved.');
  }

  if (targetArg) {
    const { projectId, repoRoot } = await resolveProjectContextForRepo(db, process.cwd());
    const target = await resolveReviewGuideTarget(db, projectId, targetArg, repoRoot);
    const review = getLatestReviewGuide(target.reviews);
    if (!review) {
      throw new Error(`No stored review guide found for ${target.label}.`);
    }
    if (issue.review_id !== review.id) {
      throw new Error(`Review issue ${issueId} does not belong to latest review #${review.id}.`);
    }
  }

  const updated = updateReviewIssue(db, issueId, {
    resolved: options.unresolved === true ? false : true,
  });
  if (!updated) {
    throw new Error(`Review issue ${issueId} was not found.`);
  }

  log(`Issue #${issueId} marked ${updated.resolved === 1 ? 'resolved' : 'unresolved'}.`);
}
