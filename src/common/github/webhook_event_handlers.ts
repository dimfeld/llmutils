import type { Database } from 'bun:sqlite';
import { canonicalizePrUrl } from './identifiers.js';
import { getProjectPlanBranchMatches } from './project_pr_service.js';
import { constructGitHubRepositoryId } from './pull_requests.js';
import { getProject } from '../../tim/db/project.js';
import {
  clearPrCheckRuns,
  getKnownRepoFullNames,
  getPrStatusByRepoAndNumber,
  getPrStatusByUrl,
  recomputeCheckRollupState,
  upsertPrCheckRunByName,
  upsertPrReviewByAuthor,
  upsertPrReviewRequestByReviewer,
  upsertPrStatusMetadata,
} from '../../tim/db/pr_status.js';

/** Identifies a PR that needs a follow-up API refresh (mergeable/review_decision). */
export interface PrRefreshTarget {
  owner: string;
  repo: string;
  prNumber: number;
  /** Human-readable label for error messages. */
  operation: string;
}

export interface WebhookHandlerResult {
  updated: boolean;
  prUrl?: string;
  prUrls?: string[];
  /** PRs that need a follow-up API refresh. Callers should deduplicate before executing. */
  apiRefreshTargets?: PrRefreshTarget[];
}

interface ParsedRepoInfo {
  owner: string;
  repo: string;
  fullName: string;
}

interface ParsedPullRequestPayload {
  action: string | null;
  repository: ParsedRepoInfo;
  pullRequest: {
    number: number;
    title: string | null;
    author: string | null;
    state: string;
    draft: boolean;
    headSha: string | null;
    baseRef: string | null;
    headRef: string | null;
    mergedAt: string | null;
    updatedAt: string | null;
    labels: Array<{ name: string; color: string | null }>;
    requestedReviewers: string[];
    requestedReviewerLogin: string | null;
  };
}

interface ParsedReviewPayload {
  repository: ParsedRepoInfo;
  pullRequestNumber: number;
  review: {
    author: string;
    state: string;
    submittedAt: string | null;
  };
}

interface ParsedCheckRunPayload {
  repository: ParsedRepoInfo;
  checkRun: {
    name: string;
    status: string;
    conclusion: string | null;
    detailsUrl: string | null;
    startedAt: string | null;
    completedAt: string | null;
    pullRequests: Array<{ number: number }>;
  };
}

function getNowIsoString(): string {
  return new Date().toISOString();
}

function parseRepository(payload: unknown): ParsedRepoInfo | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const repository = (payload as { repository?: unknown }).repository;
  if (!repository || typeof repository !== 'object') {
    return null;
  }

  const fullName = (repository as { full_name?: unknown }).full_name;
  if (typeof fullName !== 'string') {
    return null;
  }

  const [owner, repo] = fullName.split('/');
  if (!owner || !repo) {
    return null;
  }

  return { owner, repo, fullName };
}

function parseLabels(labels: unknown): Array<{ name: string; color: string | null }> {
  if (!Array.isArray(labels)) {
    return [];
  }

  return labels.flatMap((label) => {
    if (!label || typeof label !== 'object') {
      return [];
    }

    const name = (label as { name?: unknown }).name;
    if (typeof name !== 'string') {
      return [];
    }

    const color = (label as { color?: unknown }).color;
    return [{ name, color: typeof color === 'string' ? color : null }];
  });
}

function parseRequestedReviewers(requestedReviewers: unknown): string[] {
  if (!Array.isArray(requestedReviewers)) {
    return [];
  }

  return requestedReviewers.flatMap((reviewer) => {
    if (!reviewer || typeof reviewer !== 'object') {
      return [];
    }

    const login = (reviewer as { login?: unknown }).login;
    return typeof login === 'string' ? [login] : [];
  });
}

function parseRequestedReviewer(requestedReviewer: unknown): string | null {
  if (!requestedReviewer || typeof requestedReviewer !== 'object') {
    return null;
  }

  const login = (requestedReviewer as { login?: unknown }).login;
  return typeof login === 'string' ? login : null;
}

function parsePullRequestPayload(payload: unknown): ParsedPullRequestPayload | null {
  const repository = parseRepository(payload);
  if (!repository || !payload || typeof payload !== 'object') {
    return null;
  }

  const pullRequest = (payload as { pull_request?: unknown }).pull_request;
  if (!pullRequest || typeof pullRequest !== 'object') {
    return null;
  }

  const number = (pullRequest as { number?: unknown }).number;
  const state = (pullRequest as { state?: unknown }).state;
  const draft = (pullRequest as { draft?: unknown }).draft;
  if (typeof number !== 'number' || typeof state !== 'string' || typeof draft !== 'boolean') {
    return null;
  }

  const head = (pullRequest as { head?: unknown }).head;
  const base = (pullRequest as { base?: unknown }).base;
  const user = (pullRequest as { user?: unknown }).user;
  const mergedAt = (pullRequest as { merged_at?: unknown }).merged_at;
  const updatedAt = (pullRequest as { updated_at?: unknown }).updated_at;
  const title = (pullRequest as { title?: unknown }).title;
  const requestedReviewer = (pullRequest as { requested_reviewer?: unknown }).requested_reviewer;

  return {
    action:
      typeof (payload as { action?: unknown }).action === 'string'
        ? ((payload as { action?: string }).action ?? null)
        : null,
    repository,
    pullRequest: {
      number,
      title: typeof title === 'string' ? title : null,
      author:
        user && typeof user === 'object' && typeof (user as { login?: unknown }).login === 'string'
          ? ((user as { login: string }).login ?? null)
          : null,
      state,
      draft,
      headSha:
        head && typeof head === 'object' && typeof (head as { sha?: unknown }).sha === 'string'
          ? ((head as { sha: string }).sha ?? null)
          : null,
      baseRef:
        base && typeof base === 'object' && typeof (base as { ref?: unknown }).ref === 'string'
          ? ((base as { ref: string }).ref ?? null)
          : null,
      headRef:
        head && typeof head === 'object' && typeof (head as { ref?: unknown }).ref === 'string'
          ? ((head as { ref: string }).ref ?? null)
          : null,
      mergedAt: typeof mergedAt === 'string' ? mergedAt : null,
      updatedAt: typeof updatedAt === 'string' ? updatedAt : null,
      labels: parseLabels((pullRequest as { labels?: unknown }).labels),
      requestedReviewers: parseRequestedReviewers(
        (pullRequest as { requested_reviewers?: unknown }).requested_reviewers
      ),
      requestedReviewerLogin: parseRequestedReviewer(requestedReviewer),
    },
  };
}

function parseReviewPayload(payload: unknown): ParsedReviewPayload | null {
  const repository = parseRepository(payload);
  if (!repository || !payload || typeof payload !== 'object') {
    return null;
  }

  const review = (payload as { review?: unknown }).review;
  const pullRequest = (payload as { pull_request?: unknown }).pull_request;
  if (!review || typeof review !== 'object' || !pullRequest || typeof pullRequest !== 'object') {
    return null;
  }

  const author = (review as { user?: { login?: unknown } }).user?.login;
  const state = (review as { state?: unknown }).state;
  const submittedAt = (review as { submitted_at?: unknown }).submitted_at;
  const number = (pullRequest as { number?: unknown }).number;

  if (typeof author !== 'string' || typeof state !== 'string' || typeof number !== 'number') {
    return null;
  }

  return {
    repository,
    pullRequestNumber: number,
    review: {
      author,
      state,
      submittedAt: typeof submittedAt === 'string' ? submittedAt : null,
    },
  };
}

function parseCheckRunPayload(payload: unknown): ParsedCheckRunPayload | null {
  const repository = parseRepository(payload);
  if (!repository || !payload || typeof payload !== 'object') {
    return null;
  }

  const checkRun = (payload as { check_run?: unknown }).check_run;
  if (!checkRun || typeof checkRun !== 'object') {
    return null;
  }

  const name = (checkRun as { name?: unknown }).name;
  const status = (checkRun as { status?: unknown }).status;
  const conclusion = (checkRun as { conclusion?: unknown }).conclusion;
  const detailsUrl = (checkRun as { details_url?: unknown }).details_url;
  const startedAt = (checkRun as { started_at?: unknown }).started_at;
  const completedAt = (checkRun as { completed_at?: unknown }).completed_at;
  const pullRequests = (checkRun as { pull_requests?: unknown }).pull_requests;

  if (typeof name !== 'string' || typeof status !== 'string') {
    return null;
  }

  return {
    repository,
    checkRun: {
      name,
      status,
      conclusion: typeof conclusion === 'string' ? conclusion : null,
      detailsUrl: typeof detailsUrl === 'string' ? detailsUrl : null,
      startedAt: typeof startedAt === 'string' ? startedAt : null,
      completedAt: typeof completedAt === 'string' ? completedAt : null,
      pullRequests: Array.isArray(pullRequests)
        ? pullRequests.flatMap((pullRequest) => {
            if (!pullRequest || typeof pullRequest !== 'object') {
              return [];
            }

            const number = (pullRequest as { number?: unknown }).number;
            return typeof number === 'number' ? [{ number }] : [];
          })
        : [],
    },
  };
}

export interface WebhookHandlerOptions {
  knownRepos?: Set<string>;
}

function isKnownRepository(db: Database, fullName: string, knownRepos?: Set<string>): boolean {
  return (knownRepos ?? getKnownRepoFullNames(db)).has(fullName);
}

function getCanonicalPrUrl(owner: string, repo: string, prNumber: number): string {
  return canonicalizePrUrl(`https://github.com/${owner}/${repo}/pull/${prNumber}`);
}

export function handlePullRequestEvent(
  db: Database,
  payload: unknown,
  options?: WebhookHandlerOptions
): WebhookHandlerResult {
  const parsed = parsePullRequestPayload(payload);
  if (!parsed || !isKnownRepository(db, parsed.repository.fullName, options?.knownRepos)) {
    return { updated: false };
  }

  const { owner, repo } = parsed.repository;
  const { pullRequest } = parsed;
  const prUrl = getCanonicalPrUrl(owner, repo, pullRequest.number);
  const state =
    pullRequest.state === 'closed' ? (pullRequest.mergedAt ? 'merged' : 'closed') : 'open';
  const { updated, isNewRow } = db
    .transaction((nextOwner: string, nextRepo: string) => {
      const repositoryId = constructGitHubRepositoryId(nextOwner, nextRepo);
      const project = getProject(db, repositoryId);
      const insertPlanPrLink = db.prepare(
        "INSERT OR IGNORE INTO plan_pr (plan_uuid, pr_status_id, source) VALUES (?, ?, 'auto')"
      );
      const existing = getPrStatusByRepoAndNumber(db, nextOwner, nextRepo, pullRequest.number);
      const previousHeadSha = existing?.head_sha ?? null;
      let reviewRequestChanged = false;
      const isPushAction =
        parsed.action === 'synchronize' ||
        parsed.action === 'opened' ||
        parsed.action === 'reopened';
      const nextDetail = upsertPrStatusMetadata(db, {
        prUrl,
        owner: nextOwner,
        repo: nextRepo,
        prNumber: pullRequest.number,
        author: pullRequest.author,
        title: pullRequest.title,
        state,
        draft: pullRequest.draft,
        mergeable: null,
        headSha: pullRequest.headSha,
        baseBranch: pullRequest.baseRef,
        headBranch: pullRequest.headRef,
        requestedReviewers: pullRequest.requestedReviewers,
        reviewDecision: null,
        checkRollupState: null,
        mergedAt: pullRequest.mergedAt,
        prUpdatedAt: pullRequest.updatedAt,
        lastFetchedAt: getNowIsoString(),
        labels: pullRequest.labels,
        latestCommitPushedAt: isPushAction ? (pullRequest.updatedAt ?? null) : undefined,
      });

      if (!nextDetail) {
        throw new Error(`Failed to load PR status detail for ${prUrl}`);
      }

      const eventTime = pullRequest.updatedAt ?? getNowIsoString();
      if (parsed.action === 'review_requested' && pullRequest.requestedReviewerLogin) {
        reviewRequestChanged =
          upsertPrReviewRequestByReviewer(db, nextDetail.status.id, {
            reviewer: pullRequest.requestedReviewerLogin,
            action: 'requested',
            eventAt: eventTime,
          }) || reviewRequestChanged;
      } else if (parsed.action === 'review_request_removed' && pullRequest.requestedReviewerLogin) {
        reviewRequestChanged =
          upsertPrReviewRequestByReviewer(db, nextDetail.status.id, {
            reviewer: pullRequest.requestedReviewerLogin,
            action: 'removed',
            eventAt: eventTime,
          }) || reviewRequestChanged;
      }

      const headShaChanged =
        nextDetail.changed &&
        previousHeadSha !== null &&
        pullRequest.headSha !== null &&
        previousHeadSha !== pullRequest.headSha;

      if (headShaChanged) {
        clearPrCheckRuns(db, nextDetail.status.id);
        db.prepare('UPDATE pr_status SET check_rollup_state = NULL WHERE id = ?').run(
          nextDetail.status.id
        );
      }

      // Auto-link idempotently based on persisted head_branch, not gated on whether
      // this specific event's metadata was applied. A stale event still has the correct
      // branch on the current row, and plans created after the original event need linking.
      if (project && nextDetail.status.head_branch) {
        const branchMatches =
          getProjectPlanBranchMatches(db, project.id).get(nextDetail.status.head_branch) ?? [];
        for (const match of branchMatches) {
          insertPlanPrLink.run(match.planUuid, nextDetail.status.id);
        }
      }

      return { updated: nextDetail.changed || reviewRequestChanged, isNewRow: !existing };
    })
    .immediate(owner, repo);

  // Trigger targeted API fetch for new rows (any action that creates the row)
  // and for specific actions that change mergeable/review_decision on existing rows
  const needsApiRefresh =
    updated &&
    (isNewRow ||
      parsed.action === 'opened' ||
      parsed.action === 'synchronize' ||
      parsed.action === 'reopened' ||
      parsed.action === 'ready_for_review');
  return {
    updated,
    prUrl,
    apiRefreshTargets: needsApiRefresh
      ? [
          {
            owner,
            repo,
            prNumber: pullRequest.number,
            operation: 'mergeable/review_decision refresh failed',
          },
        ]
      : [],
  };
}

export function handlePullRequestReviewEvent(
  db: Database,
  payload: unknown,
  options?: WebhookHandlerOptions
): WebhookHandlerResult {
  const parsed = parseReviewPayload(payload);
  if (!parsed || !isKnownRepository(db, parsed.repository.fullName, options?.knownRepos)) {
    return { updated: false };
  }

  const { owner, repo } = parsed.repository;
  const row = getPrStatusByRepoAndNumber(db, owner, repo, parsed.pullRequestNumber);
  // Known limitation: review events that arrive before the PR row exists are dropped.
  // A later pull_request event or manual full refresh will backfill the missing state.
  if (!row) {
    return { updated: false };
  }

  const updated = upsertPrReviewByAuthor(db, row.id, {
    author: parsed.review.author,
    state: parsed.review.state.toUpperCase(),
    submittedAt: parsed.review.submittedAt,
  });

  const reviewState = parsed.review.state.toUpperCase();
  const affectsReviewDecision =
    reviewState === 'APPROVED' ||
    reviewState === 'CHANGES_REQUESTED' ||
    reviewState === 'DISMISSED';

  return {
    updated,
    prUrl: row.pr_url,
    apiRefreshTargets:
      updated && affectsReviewDecision
        ? [
            {
              owner,
              repo,
              prNumber: parsed.pullRequestNumber,
              operation: 'review_decision refresh failed',
            },
          ]
        : [],
  };
}

export function handleCheckRunEvent(
  db: Database,
  payload: unknown,
  options?: WebhookHandlerOptions
): WebhookHandlerResult {
  const parsed = parseCheckRunPayload(payload);
  if (!parsed || !isKnownRepository(db, parsed.repository.fullName, options?.knownRepos)) {
    return { updated: false };
  }

  const { owner, repo } = parsed.repository;
  const prUrls = new Set<string>();

  for (const pullRequest of parsed.checkRun.pullRequests) {
    const row = getPrStatusByRepoAndNumber(db, owner, repo, pullRequest.number);
    // Known limitation: check_run events that arrive before the PR row exists are dropped.
    // A later pull_request event or manual full refresh will backfill the missing state.
    if (!row) {
      continue;
    }

    db.transaction((nextRowId: number) => {
      upsertPrCheckRunByName(db, nextRowId, {
        name: parsed.checkRun.name,
        source: 'check_run',
        status: parsed.checkRun.status,
        conclusion: parsed.checkRun.conclusion,
        detailsUrl: parsed.checkRun.detailsUrl,
        startedAt: parsed.checkRun.startedAt,
        completedAt: parsed.checkRun.completedAt,
      });
      recomputeCheckRollupState(db, nextRowId);
    }).immediate(row.id);
    prUrls.add(row.pr_url);
  }

  return {
    updated: prUrls.size > 0,
    prUrls: [...prUrls],
  };
}

// TODO: Handle check_suite events when we need suite-level catch-up for missing individual check_run payloads.
// TODO: Handle status events by mapping commit SHA updates back to matching PRs.
