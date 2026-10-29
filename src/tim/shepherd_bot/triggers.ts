import type { Database } from 'bun:sqlite';

import { constructGitHubRepositoryId } from '../../common/github/pull_requests.js';
import { withRequiredCheckRollupState } from '../../common/github/required_check_rollup.js';
import { tryCanonicalizePrUrl } from '../../common/github/identifier_urls.js';
import type { JobRow } from '../db/job.js';
import {
  getPrShepherd,
  listBotEnabledShepherdPrs,
  setPrShepherdBotSnapshot,
} from '../db/pr_shepherd.js';
import { getPrStatusByUrl, type PrStatusRow } from '../db/pr_status.js';
import { getProject } from '../db/project.js';
import { insertShepherdBotTrigger, isShepherdBotRunning } from '../db/shepherd_bot.js';
import {
  buildShepherdBotSnapshot,
  describeShepherdBotSnapshotChanges,
  parseShepherdBotSnapshot,
  serializeShepherdBotSnapshot,
} from './snapshot.js';

/**
 * Session commands whose end wakes the bot. Interactive `chat` and `shell` sessions are not
 * included, and neither is the bot's own `shepherd-bot` session.
 */
export const SHEPHERD_BOT_FIX_COMMANDS: readonly string[] = [
  'pr-fix',
  'ci-fix',
  'pr-rebase',
  'autoreview',
];

/** Wait for this long without new PR changes before a run, so that bursts become one run. */
export const SHEPHERD_BOT_PR_CHANGE_DEBOUNCE_MS = 60_000;
/** A short wait so that webhooks from the session's last push can arrive first. */
export const SHEPHERD_BOT_SESSION_END_DEBOUNCE_MS = 10_000;

export function getProjectIdForPrStatus(
  db: Database,
  status: Pick<PrStatusRow, 'owner' | 'repo'>
): number | null {
  return getProject(db, constructGitHubRepositoryId(status.owner, status.repo))?.id ?? null;
}

/** The snapshot of a PR as stored by the trigger logic, from the current cached state. */
export function computeShepherdBotSnapshotForPr(db: Database, prUrl: string): string | null {
  const detail = getPrStatusByUrl(db, prUrl, { includeReviewThreads: true });
  if (!detail) {
    return null;
  }
  return serializeShepherdBotSnapshot(
    buildShepherdBotSnapshot(withRequiredCheckRollupState(db, detail))
  );
}

/**
 * Compare the cached state of the PRs that the bot watches with the last snapshot that the
 * trigger logic saw. Store the new snapshots, and add a `pr_changed` trigger for each PR that
 * changed in a way the bot cares about, when the bot runs for that PR's project.
 *
 * Snapshots are updated also while the bot is stopped, so that starting it again does not
 * replay old changes. The start trigger gives the bot the full state instead.
 *
 * Returns the IDs of the projects that got new triggers.
 */
export function updateShepherdBotSnapshots(
  db: Database,
  options: { prStatusIds?: readonly number[]; now?: Date } = {}
): number[] {
  const filterIds = options.prStatusIds ? new Set(options.prStatusIds) : null;
  const now = options.now ?? new Date();
  const projectIds = new Set<number>();

  for (const { status, shepherd } of listBotEnabledShepherdPrs(db)) {
    if (filterIds && !filterIds.has(status.id)) {
      continue;
    }

    try {
      const detail = getPrStatusByUrl(db, status.pr_url, { includeReviewThreads: true });
      if (!detail) {
        continue;
      }
      const next = buildShepherdBotSnapshot(withRequiredCheckRollupState(db, detail));
      const serialized = serializeShepherdBotSnapshot(next);
      if (serialized === shepherd.bot_snapshot) {
        continue;
      }
      setPrShepherdBotSnapshot(db, status.id, serialized);

      // Without an earlier snapshot there is nothing to compare. This one is the baseline.
      const previous = parseShepherdBotSnapshot(shepherd.bot_snapshot);
      if (!previous) {
        continue;
      }
      const changes = describeShepherdBotSnapshotChanges(previous, next);
      if (changes.length === 0) {
        continue;
      }

      const projectId = getProjectIdForPrStatus(db, status);
      if (projectId === null || !isShepherdBotRunning(db, projectId)) {
        continue;
      }
      insertShepherdBotTrigger(db, {
        projectId,
        prStatusId: status.id,
        prUrl: status.pr_url,
        kind: 'pr_changed',
        details: { changes },
        dueAt: new Date(now.getTime() + SHEPHERD_BOT_PR_CHANGE_DEBOUNCE_MS),
      });
      projectIds.add(projectId);
    } catch (err) {
      console.warn(`[shepherd_bot] Failed to update the snapshot for ${status.pr_url}`, err);
    }
  }

  return [...projectIds].sort((a, b) => a - b);
}

export interface ShepherdBotSessionEnd {
  command: string;
  prUrl: string | null;
  /** `completed` and `failed` come from the job log. `unknown` is for crashed sessions. */
  outcome: 'completed' | 'failed' | 'unknown';
  jobId?: number;
  startedAt?: string | null;
  finishedAt?: string | null;
}

/**
 * Add a `session_ended` trigger when a fix-type session for a PR that the bot watches ends.
 * Returns true when a trigger was added.
 */
export function enqueueShepherdBotSessionEnded(
  db: Database,
  sessionEnd: ShepherdBotSessionEnd,
  now: Date = new Date()
): boolean {
  if (!SHEPHERD_BOT_FIX_COMMANDS.includes(sessionEnd.command) || !sessionEnd.prUrl) {
    return false;
  }
  const prUrl = tryCanonicalizePrUrl(sessionEnd.prUrl);
  if (!prUrl) {
    return false;
  }
  const detail = getPrStatusByUrl(db, prUrl);
  if (!detail) {
    return false;
  }
  const shepherd = getPrShepherd(db, detail.status.id);
  if (!shepherd || shepherd.removed_at !== null || shepherd.bot_enabled_at === null) {
    return false;
  }
  const projectId = getProjectIdForPrStatus(db, detail.status);
  if (projectId === null || !isShepherdBotRunning(db, projectId)) {
    return false;
  }

  insertShepherdBotTrigger(db, {
    projectId,
    prStatusId: detail.status.id,
    prUrl: detail.status.pr_url,
    kind: 'session_ended',
    details: {
      command: sessionEnd.command,
      outcome: sessionEnd.outcome,
      ...(sessionEnd.jobId !== undefined ? { jobId: sessionEnd.jobId } : {}),
      ...(sessionEnd.startedAt ? { startedAt: sessionEnd.startedAt } : {}),
      ...(sessionEnd.finishedAt ? { finishedAt: sessionEnd.finishedAt } : {}),
    },
    dueAt: new Date(now.getTime() + SHEPHERD_BOT_SESSION_END_DEBOUNCE_MS),
  });
  return true;
}

/** Add a `session_ended` trigger from a finished job row. */
export function enqueueShepherdBotTriggerForJob(db: Database, job: JobRow): boolean {
  if (job.status === 'running') {
    return false;
  }
  return enqueueShepherdBotSessionEnded(db, {
    command: job.job_type,
    prUrl: job.pr_url,
    outcome: job.status,
    jobId: job.id,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
  });
}
