import type { Database } from 'bun:sqlite';

import {
  fetchAndUpdatePrMergeableStatus,
  refreshPrStatus,
} from '../../common/github/pr_status_service.js';
import { withRequiredCheckRollupState } from '../../common/github/required_check_rollup.js';
import { resolveGitHubToken } from '../../common/github/token.js';
import { getGitHubUsername } from '../../common/github/user.js';
import { normalizeGitHubUsername } from '../../common/github/username.js';
import { getWebhookServerUrl } from '../../common/github/webhook_client.js';
import type { IngestResult } from '../../common/github/webhook_ingest.js';
import { constructGitHubRepositoryId } from '../../common/github/pull_requests.js';
import { loadEffectiveConfig } from '../../tim/configLoader.js';
import { upsertInboxItem, type InboxItemKind } from '../../tim/db/inbox_item.js';
import {
  enrollPrShepherd,
  listOpenShepherdedPrs,
  parseNotifiedFlags,
  setPrShepherdNotifiedFlags,
  type ShepherdedPr,
} from '../../tim/db/pr_shepherd.js';
import { getPrStatusByUrl, type PrStatusRow } from '../../tim/db/pr_status.js';
import { getProject } from '../../tim/db/project.js';
import {
  evaluatePrShepherd,
  getPrShepherdNotificationFlags,
  type PrShepherdNotificationFlag,
} from '../utils/pr_shepherd.js';
import { getPrimaryWorkspacePath } from './db_queries.js';
import { getProjectIdsForPrUrls } from './pr_event_utils.js';
import type { SessionManager } from './session_manager.js';

/** Fallback refresh interval when webhooks report most changes. */
const WEBHOOK_MODE_INTERVAL_MS = 10 * 60 * 1000;
/** Without webhooks this loop is the only source of updates, so it runs more often. */
const POLLING_MODE_INTERVAL_MS = 2 * 60 * 1000;
const INITIAL_DELAY_MS = 60 * 1000;

export type PrShepherdSessionManager = Pick<
  SessionManager,
  'emitInboxUpdate' | 'hasInboxUpdateListeners' | 'emitPrUpdate' | 'hasPrUpdateListeners'
>;

export interface PrShepherdOptions {
  sessionManager?: Pick<SessionManager, 'emitInboxUpdate' | 'hasInboxUpdateListeners'>;
  resolveUsername?: (prStatus: PrStatusRow) => Promise<string | null>;
}

const NOTIFICATION_KINDS: Record<PrShepherdNotificationFlag, InboxItemKind> = {
  conflicts: 'pr_conflicts',
  ready: 'pr_ready_to_merge',
};

const NOTIFICATION_SUMMARIES: Record<PrShepherdNotificationFlag, string> = {
  conflicts: 'The PR has merge conflicts with its base branch',
  ready: 'Approved, checks pass, and no conflicts',
};

function getProjectIdForPr(db: Database, status: PrStatusRow): number | null {
  return getProject(db, constructGitHubRepositoryId(status.owner, status.repo))?.id ?? null;
}

async function resolveUsernameForPr(db: Database, status: PrStatusRow): Promise<string | null> {
  const projectId = getProjectIdForPr(db, status);
  const workspacePath = projectId === null ? null : getPrimaryWorkspacePath(db, projectId);
  const config = await loadEffectiveConfig(undefined, {
    quiet: true,
    ...(workspacePath ? { cwd: workspacePath } : {}),
  });
  return getGitHubUsername({ githubUsername: config.githubUsername });
}

/**
 * Add the user's own PRs that became ready for review to the shepherd list.
 * PRs that the user removed before are not added again.
 *
 * Returns the IDs of the PRs that are active in the list after the call.
 */
export async function autoEnrollReadyPrs(
  db: Database,
  prsReadyForReview: IngestResult['prsReadyForReview'],
  options: PrShepherdOptions = {}
): Promise<number[]> {
  const resolveUsername =
    options.resolveUsername ?? ((status: PrStatusRow) => resolveUsernameForPr(db, status));
  const enrolled: number[] = [];

  for (const pr of prsReadyForReview) {
    try {
      const detail = getPrStatusByUrl(db, pr.prUrl);
      if (!detail?.status.author || detail.status.state !== 'open') {
        continue;
      }

      const username = await resolveUsername(detail.status);
      if (
        !username ||
        normalizeGitHubUsername(username) !== normalizeGitHubUsername(detail.status.author)
      ) {
        continue;
      }

      if (enrollPrShepherd(db, detail.status.id, 'auto')) {
        enrolled.push(detail.status.id);
      }
    } catch (err) {
      console.warn(`[pr_shepherd] Failed to auto-enroll ${pr.prUrl}`, err);
    }
  }

  return enrolled;
}

/**
 * Evaluate shepherded PRs and write an inbox item for each notification flag that became
 * true since the last pass. A flag that clears and later becomes true again notifies again.
 *
 * When `prStatusIds` is given, only those PRs are evaluated.
 * Returns the project IDs that got new inbox items.
 */
export function updatePrShepherdNotifications(
  db: Database,
  options: PrShepherdOptions & { prStatusIds?: readonly number[] } = {}
): number[] {
  const filterIds = options.prStatusIds ? new Set(options.prStatusIds) : null;
  const affectedProjectIds = new Set<number>();

  for (const { status, shepherd } of listOpenShepherdedPrs(db)) {
    if (filterIds && !filterIds.has(status.id)) {
      continue;
    }

    try {
      const detail = getPrStatusByUrl(db, status.pr_url, { includeReviewThreads: true });
      if (!detail) {
        continue;
      }

      const evaluation = evaluatePrShepherd(withRequiredCheckRollupState(db, detail));
      const flags = getPrShepherdNotificationFlags(evaluation);
      const previousFlags = new Set(parseNotifiedFlags(shepherd.notified_flags));
      const newFlags = flags.filter((flag) => !previousFlags.has(flag));
      const projectId = getProjectIdForPr(db, detail.status);

      for (const flag of newFlags) {
        upsertInboxItem(db, {
          projectId,
          kind: NOTIFICATION_KINDS[flag],
          prUrl: detail.status.pr_url,
          prNumber: detail.status.pr_number,
          repo: `${detail.status.owner}/${detail.status.repo}`,
          prTitle: detail.status.title,
          actor: 'tim',
          summary: NOTIFICATION_SUMMARIES[flag],
        });
        if (projectId !== null) {
          affectedProjectIds.add(projectId);
        }
      }

      const sortedFlags = [...flags].sort();
      if (sortedFlags.join(',') !== [...previousFlags].sort().join(',')) {
        setPrShepherdNotifiedFlags(db, status.id, sortedFlags);
      }
    } catch (err) {
      console.warn(`[pr_shepherd] Failed to evaluate ${status.pr_url}`, err);
    }
  }

  const projectIds = [...affectedProjectIds].sort((a, b) => a - b);
  if (projectIds.length > 0 && options.sessionManager?.hasInboxUpdateListeners()) {
    options.sessionManager.emitInboxUpdate(projectIds);
  }
  return projectIds;
}

/**
 * Shepherd work that runs after every webhook ingest: auto-enroll PRs that became ready for
 * review, then send notifications for the PRs that changed.
 */
export async function processPrShepherdAfterIngest(
  db: Database,
  ingestResult: Pick<IngestResult, 'prsReadyForReview' | 'prsUpdated'>,
  options: PrShepherdOptions = {}
): Promise<void> {
  const enrolledIds = await autoEnrollReadyPrs(db, ingestResult.prsReadyForReview, options);

  const updatedIds = ingestResult.prsUpdated.flatMap((prUrl) => {
    const detail = getPrStatusByUrl(db, prUrl);
    return detail ? [detail.status.id] : [];
  });
  const prStatusIds = [...new Set([...enrolledIds, ...updatedIds])];
  if (prStatusIds.length === 0) {
    return;
  }

  updatePrShepherdNotifications(db, { ...options, prStatusIds });
}

function statusSignature(status: PrStatusRow | undefined | null): string {
  if (!status) {
    return '';
  }
  return [
    status.state,
    status.draft,
    status.mergeable,
    status.review_decision,
    status.check_rollup_state,
    status.behind_by,
    status.head_sha,
    status.merge_queue_enqueued_at,
  ].join('|');
}

export interface PrShepherdMonitorOptions {
  getSessionManager?: () => PrShepherdSessionManager | null;
  intervalMs?: number;
  initialDelayMs?: number;
}

/**
 * Fallback refresh for shepherded PRs. Webhooks report most changes, so with webhooks
 * enabled this loop only uses a cheap mergeable query. A full refresh runs only when that
 * query shows a change. Without webhooks, the loop does a full refresh each time.
 */
export class PrShepherdMonitor {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly db: Database,
    private readonly options: PrShepherdMonitorOptions = {}
  ) {}

  start(): void {
    this.stopped = false;
    this.schedule(this.options.initialDelayMs ?? INITIAL_DELAY_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private getIntervalMs(): number {
    if (this.options.intervalMs !== undefined) {
      return this.options.intervalMs;
    }
    return getWebhookServerUrl() ? WEBHOOK_MODE_INTERVAL_MS : POLLING_MODE_INTERVAL_MS;
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().finally(() => this.schedule(this.getIntervalMs()));
    }, delayMs);
    this.timer.unref?.();
  }

  async tick(): Promise<void> {
    if (this.running || !resolveGitHubToken()) {
      return;
    }

    this.running = true;
    try {
      const shepherded = listOpenShepherdedPrs(this.db);
      if (shepherded.length === 0) {
        return;
      }

      const changedUrls: string[] = [];
      const webhookMode = Boolean(getWebhookServerUrl());
      for (const pr of shepherded) {
        if (this.stopped) {
          return;
        }
        if (await this.refreshPr(pr, webhookMode)) {
          changedUrls.push(pr.status.pr_url);
        }
      }

      const sessionManager = this.options.getSessionManager?.() ?? undefined;
      updatePrShepherdNotifications(this.db, {
        sessionManager,
        prStatusIds: shepherded.map((pr) => pr.status.id),
      });

      if (changedUrls.length > 0 && sessionManager?.hasPrUpdateListeners()) {
        sessionManager.emitPrUpdate(changedUrls, getProjectIdsForPrUrls(this.db, changedUrls));
      }
    } catch (err) {
      console.warn('[pr_shepherd] Monitor tick failed', err);
    } finally {
      this.running = false;
    }
  }

  /** Returns true when the PR changed. */
  private async refreshPr(pr: ShepherdedPr, webhookMode: boolean): Promise<boolean> {
    const before = statusSignature(pr.status);
    try {
      if (webhookMode) {
        await fetchAndUpdatePrMergeableStatus(
          this.db,
          pr.status.owner,
          pr.status.repo,
          pr.status.pr_number
        );
        const afterCheap = statusSignature(getPrStatusByUrl(this.db, pr.status.pr_url)?.status);
        if (afterCheap === before) {
          return false;
        }
      }

      const refreshed = await refreshPrStatus(this.db, pr.status.pr_url);
      return statusSignature(refreshed.status) !== before;
    } catch (err) {
      console.warn(`[pr_shepherd] Failed to refresh ${pr.status.pr_url}`, err);
      return false;
    }
  }
}
