import type { Database } from 'bun:sqlite';

import { tryCanonicalizePrUrl } from '../../common/github/identifiers.js';
import { getReviewerPredicate } from '../../common/github/pr_relevance.js';
import { constructGitHubRepositoryId } from '../../common/github/pull_requests.js';
import { isBotLogin, normalizeGitHubUsername } from '../../common/github/username.js';
import { getGitHubUsername, type GitHubUsernameOptions } from '../../common/github/user.js';
import { isWebhookSideEffectAllowed } from '../../common/github/webhook_side_effects.js';
import type { InboxSignal } from '../../common/github/webhook_event_handlers.js';
import { loadEffectiveConfig } from '../../tim/configLoader.js';
import type { TimConfig } from '../../tim/configSchema.js';
import { getProject } from '../../tim/db/project.js';
import { getPrStatusByProjectAndNumber } from '../../tim/db/pr_status.js';
import {
  pruneOldInboxItems,
  upsertInboxItem,
  type InboxItemKind,
} from '../../tim/db/inbox_item.js';
import { getPrimaryWorkspacePath } from './db_queries.js';
import type { SessionManager } from './session_manager.js';

const INBOX_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

let lastPrunedAt: number | null = null;

export interface InboxProducerOptions {
  now?: () => number;
  loadConfig?: typeof loadEffectiveConfig;
  resolveUsername?: typeof getGitHubUsername;
  pruneInboxItems?: typeof pruneOldInboxItems;
  sessionManager?: Pick<SessionManager, 'emitInboxUpdate' | 'hasInboxUpdateListeners'>;
}

interface ProjectInboxContext {
  config: TimConfig;
  username: string;
  ignoredUsers: ReadonlySet<string>;
}

function parseRepositoryFullName(repository: string): { owner: string; repo: string } | null {
  const parts = repository.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }

  return { owner: parts[0], repo: parts[1] };
}

function isBotOrIgnoredActor(
  signal: InboxSignal,
  kind: InboxItemKind,
  ignoredUsers: ReadonlySet<string>
): boolean {
  if (kind !== 'pr_comment' && kind !== 'reviewed_pr_comment' && kind !== 'pr_approved') {
    return false;
  }

  return (
    isBotLogin(signal.actor) ||
    signal.actorType?.toLowerCase() === 'bot' ||
    ignoredUsers.has(normalizeGitHubUsername(signal.actor))
  );
}

function isSelfAction(signal: InboxSignal, kind: InboxItemKind, username: string): boolean {
  if (kind === 'review_requested' || kind === 'pr_merged') {
    return false;
  }

  return normalizeGitHubUsername(signal.actor) === username;
}

function isMergedPr(status: ReturnType<typeof getPrStatusByProjectAndNumber>): boolean {
  return (
    status !== null &&
    (status.status.merged_at !== null || status.status.state.toLowerCase() === 'merged')
  );
}

function getSignalAuthor(
  signal: InboxSignal,
  status: ReturnType<typeof getPrStatusByProjectAndNumber>
): string | null {
  return status?.status.author ?? signal.prAuthor ?? null;
}

function isUserAuthor(
  signal: InboxSignal,
  status: ReturnType<typeof getPrStatusByProjectAndNumber>,
  username: string
): boolean {
  const author = getSignalAuthor(signal, status);
  return author !== null && normalizeGitHubUsername(author) === username;
}

function hasUserSubmittedReview(
  status: ReturnType<typeof getPrStatusByProjectAndNumber>,
  username: string
): boolean {
  if (!status) {
    return false;
  }

  return getReviewerPredicate([], [], status.reviews, username).hasSubmittedReview;
}

function getInboxKind(
  signal: InboxSignal,
  status: ReturnType<typeof getPrStatusByProjectAndNumber>,
  username: string
): InboxItemKind | null {
  switch (signal.kind) {
    case 'review_requested':
      return normalizeGitHubUsername(signal.requestedReviewer) === username
        ? 'review_requested'
        : null;
    case 'pr_comment':
      if (isUserAuthor(signal, status, username)) {
        return 'pr_comment';
      }
      return hasUserSubmittedReview(status, username) ? 'reviewed_pr_comment' : null;
    case 'pr_approved':
    case 'pr_merged':
    case 'ci_failure':
    case 'merge_queue_removed':
      return isUserAuthor(signal, status, username) ? signal.kind : null;
  }
}

async function resolveProjectInboxContext(
  db: Database,
  projectId: number,
  options: InboxProducerOptions
): Promise<ProjectInboxContext | null> {
  const primaryWorkspacePath = getPrimaryWorkspacePath(db, projectId);
  if (!primaryWorkspacePath) {
    console.warn(`[inbox] No primary workspace for project ${projectId}; skipping signals`);
    return null;
  }

  const configLoader = options.loadConfig ?? loadEffectiveConfig;
  const config = await configLoader(undefined, { cwd: primaryWorkspacePath });
  if (config.inbox?.prs?.enabled === false) {
    return null;
  }

  const usernameResolver = options.resolveUsername ?? getGitHubUsername;
  const username = await usernameResolver({
    githubUsername: config.githubUsername,
  } satisfies GitHubUsernameOptions);
  if (!username) {
    return null;
  }

  return {
    config,
    username: normalizeGitHubUsername(username),
    ignoredUsers: new Set(
      (config.inbox?.prs?.ignoreUsers ?? []).map((ignoredUser) =>
        normalizeGitHubUsername(ignoredUser)
      )
    ),
  };
}

function shouldPruneInboxItems(now: number): boolean {
  return lastPrunedAt === null || now - lastPrunedAt >= INBOX_PRUNE_INTERVAL_MS;
}

async function maybePruneInboxItems(db: Database, options: InboxProducerOptions): Promise<void> {
  const now = options.now?.() ?? Date.now();
  if (!shouldPruneInboxItems(now)) {
    return;
  }

  try {
    const prune = options.pruneInboxItems ?? pruneOldInboxItems;
    const deletedCount = prune(db, 30);
    lastPrunedAt = now;
    if (deletedCount > 0) {
      console.info(`[inbox] Pruned ${deletedCount} old inbox items`);
    }
  } catch (error) {
    console.error('[inbox] Failed to prune old inbox items', error);
  }
}

/** Reset the daily prune throttle. Intended for isolated tests and HMR cleanup. */
export function resetInboxPruneThrottle(): void {
  lastPrunedAt = null;
}

/** Convert relevant webhook signals into persistent inbox rows and emit one live update. */
export async function processInboxSignals(
  db: Database,
  signals: readonly InboxSignal[],
  options: InboxProducerOptions = {}
): Promise<number[]> {
  const mergedPrUrls = new Set(
    signals
      .filter((signal) => signal.kind === 'pr_merged')
      .map((signal) => tryCanonicalizePrUrl(signal.prUrl))
      .filter((prUrl): prUrl is string => prUrl !== null)
  );
  const contextCache = new Map<number, Promise<ProjectInboxContext | null>>();
  const affectedProjectIds = new Set<number>();

  for (const signal of signals) {
    try {
      const repository = parseRepositoryFullName(signal.repo);
      if (!repository) {
        continue;
      }

      const project = getProject(
        db,
        constructGitHubRepositoryId(repository.owner, repository.repo)
      );
      if (!project) {
        continue;
      }

      let contextPromise = contextCache.get(project.id);
      if (!contextPromise) {
        contextPromise = resolveProjectInboxContext(db, project.id, options);
        contextCache.set(project.id, contextPromise);
      }
      const context = await contextPromise;
      if (!context || !isWebhookSideEffectAllowed(context.config, signal.eventAt)) {
        continue;
      }

      const canonicalPrUrl = tryCanonicalizePrUrl(signal.prUrl);
      if (!canonicalPrUrl) {
        continue;
      }

      const status =
        signal.kind === 'review_requested'
          ? null
          : getPrStatusByProjectAndNumber(db, project.id, signal.prNumber);

      if (
        signal.kind === 'merge_queue_removed' &&
        (mergedPrUrls.has(canonicalPrUrl) || isMergedPr(status))
      ) {
        continue;
      }

      const kind = getInboxKind(signal, status, context.username);
      if (!kind || isBotOrIgnoredActor(signal, kind, context.ignoredUsers)) {
        continue;
      }
      if (isSelfAction(signal, kind, context.username)) {
        continue;
      }

      upsertInboxItem(db, {
        projectId: project.id,
        kind,
        prUrl: canonicalPrUrl,
        prNumber: signal.prNumber,
        repo: signal.repo,
        prTitle: signal.prTitle,
        actor: signal.actor,
        summary: signal.summary,
        dedupeKey: `${kind}:${canonicalPrUrl}`,
        eventAt: signal.eventAt,
      });
      affectedProjectIds.add(project.id);
    } catch (error) {
      console.error(
        `[inbox] Failed to process ${signal.kind} for ${signal.repo}#${signal.prNumber}`,
        error
      );
    }
  }

  await maybePruneInboxItems(db, options);

  const projectIds = [...affectedProjectIds].sort((left, right) => left - right);
  if (projectIds.length > 0 && options.sessionManager?.hasInboxUpdateListeners()) {
    options.sessionManager.emitInboxUpdate(projectIds);
  }

  return projectIds;
}
