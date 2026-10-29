import type { Database } from 'bun:sqlite';

import { tryCanonicalizePrUrl } from '$common/github/identifier_urls.js';
import { fetchAndUpdatePrMergeableStatus } from '$common/github/pr_status_service.js';
import { getGitHubUsername } from '$common/github/user.js';
import type { TimConfig } from '$tim/configSchema.js';
import { upsertInboxItem } from '$tim/db/inbox_item.js';
import { getPrShepherd, setPrShepherdBotEnabled } from '$tim/db/pr_shepherd.js';
import { getPrStatusByUrl, type PrStatusDetail, type PrStatusRow } from '$tim/db/pr_status.js';
import {
  countLaunchedShepherdBotActions,
  countShepherdBotRunsSince,
  finishShepherdBotRun,
  getActiveShepherdBotRun,
  hasShepherdBotTriggerSince,
  insertShepherdBotTrigger,
  isShepherdBotRunning,
  listPendingShepherdBotTriggers,
  listRequestedShepherdBotActions,
  listRunningShepherdBotProjectIds,
  listRunningShepherdBotRuns,
  pruneShepherdBotTriggers,
  setShepherdBotRunning,
  startShepherdBotRun,
  updateShepherdBotAction,
  type ShepherdBotActionRow,
  type ShepherdBotTriggerRow,
} from '$tim/db/shepherd_bot.js';
import { resolveShepherdBotSettings } from '$tim/shepherd_bot/settings.js';
import { findOpenStackForPr, getStackPathToPr } from '$tim/shepherd_bot/stack.js';
import {
  computeShepherdBotSnapshotForPr,
  enqueueShepherdBotSessionEnded,
  getProjectIdForPrStatus,
  SHEPHERD_BOT_FIX_COMMANDS,
} from '$tim/shepherd_bot/triggers.js';
import { isPrRebaseEligible } from '$lib/utils/pr_rebase_eligibility.js';

import { isCiFixEligibleForUsername } from './ci_fix_eligibility.js';
import { getPrimaryWorkspacePath } from './db_queries.js';
import { clearPrLaunchLock, isPrLaunching, setPrLaunchLock } from './launch_lock.js';
import {
  spawnCiFixForPrProcess,
  spawnPrFixForPrProcess,
  spawnPrRebaseForPrProcess,
  spawnShepherdBotRunProcess,
  type SpawnTargetProcessResult,
} from './plan_actions.js';
import type { SessionData, SessionManager } from './session_manager.js';

const TICK_INTERVAL_MS = 15_000;
const INITIAL_DELAY_MS = 10_000;
/** The bot command writes a heartbeat every 30 seconds. */
const STALE_HEARTBEAT_MS = 3 * 60 * 1000;
/** A run that takes longer than this is stopped. */
const MAX_RUN_DURATION_MS = 30 * 60 * 1000;
/** Debounced triggers never wait longer than this before a run. */
const MAX_TRIGGER_WAIT_MS = 10 * 60 * 1000;
/** Do not add a backup session-end trigger when the job log already added one this recently. */
const SESSION_END_BACKUP_WINDOW_MS = 2 * 60 * 1000;
/** A fix of the same kind for the same head SHA is started at most this many times. */
const MAX_FIX_ATTEMPTS_PER_SHA = 2;
const TRIGGER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Check again this much later when GitHub has not finished computing the mergeable state. */
const MERGEABLE_UNKNOWN_RECHECK_MS = 2 * 60 * 1000;

export type ShepherdBotFixKind = 'ci_fix' | 'pr_fix' | 'pr_rebase';

export type ShepherdBotSessionManager = Pick<
  SessionManager,
  'hasActiveSessionForPr' | 'subscribe' | 'emitInboxUpdate' | 'hasInboxUpdateListeners'
>;

export interface ShepherdBotRunnerOptions {
  config: Pick<TimConfig, 'shepherdBot' | 'githubUsername'>;
  getSessionManager?: () => ShepherdBotSessionManager | null;
  spawnRun?: (runId: number, cwd: string) => Promise<SpawnTargetProcessResult>;
  launchFix?: (
    kind: ShepherdBotFixKind,
    prUrl: string,
    cwd: string
  ) => Promise<SpawnTargetProcessResult>;
  resolveUsername?: () => Promise<string | null>;
  /** Get the mergeable state of the PR from GitHub and store it in the DB. */
  refreshMergeable?: (status: Pick<PrStatusRow, 'owner' | 'repo' | 'pr_number'>) => Promise<void>;
  isProcessAlive?: (pid: number) => boolean;
  killProcess?: (pid: number) => void;
  getWorkspacePath?: (projectId: number) => string | null;
  now?: () => Date;
  intervalMs?: number;
  initialDelayMs?: number;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function defaultKillProcess(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // The process is already gone.
  }
}

async function defaultLaunchFix(
  kind: ShepherdBotFixKind,
  prUrl: string,
  cwd: string
): Promise<SpawnTargetProcessResult> {
  switch (kind) {
    case 'ci_fix':
      return spawnCiFixForPrProcess(prUrl, cwd);
    case 'pr_fix':
      return spawnPrFixForPrProcess(prUrl, cwd);
    case 'pr_rebase':
      return spawnPrRebaseForPrProcess(prUrl, cwd);
    default: {
      const unknownKind: never = kind;
      throw new Error(`Unknown shepherd bot fix kind: ${String(unknownKind)}`);
    }
  }
}

function isFixKind(kind: string): kind is ShepherdBotFixKind {
  return kind === 'ci_fix' || kind === 'pr_fix' || kind === 'pr_rebase';
}

/** The PR URLs of the open stack that contains the PR, or only the PR when it is not open. */
function stackUrlsForPr(db: Database, detail: PrStatusDetail): string[] {
  const stack = findOpenStackForPr(db, detail.status);
  return stack.length > 0 ? stack.map((entry) => entry.pr.status.pr_url) : [detail.status.pr_url];
}

function unresolvedThreadKey(detail: PrStatusDetail): string {
  return (detail.reviewThreads ?? [])
    .filter((thread) => !thread.thread.is_resolved)
    .map((thread) => thread.thread.thread_id)
    .sort()
    .join(',');
}

/**
 * Starts shepherd bot runs from the trigger queue, checks the guardrails for the fix sessions
 * that runs ask for, and starts those sessions. All of its state is in the DB, so it can stop
 * and start again at any time.
 */
export class ShepherdBotRunner {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private stopped = false;
  private unsubscribeDisconnect: (() => void) | null = null;
  private subscribedManager: ShepherdBotSessionManager | null = null;

  constructor(
    private readonly db: Database,
    private readonly options: ShepherdBotRunnerOptions
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
    this.unsubscribeDisconnect?.();
    this.unsubscribeDisconnect = null;
    this.subscribedManager = null;
  }

  /** Run a tick soon, for example after the user started the bot. */
  kick(): void {
    if (this.stopped) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.schedule(0);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private getSessionManager(): ShepherdBotSessionManager | null {
    try {
      return this.options.getSessionManager?.() ?? null;
    } catch {
      return null;
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().finally(() => this.schedule(this.options.intervalMs ?? TICK_INTERVAL_MS));
    }, delayMs);
    this.timer.unref?.();
  }

  /** The session manager may start after the runner, so subscribe when it exists. */
  private ensureDisconnectListener(sessionManager: ShepherdBotSessionManager | null): void {
    if (!sessionManager || this.subscribedManager === sessionManager) {
      return;
    }
    this.unsubscribeDisconnect?.();
    this.subscribedManager = sessionManager;
    this.unsubscribeDisconnect = sessionManager.subscribe('session:disconnect', ({ session }) => {
      this.handleSessionDisconnect(session);
    });
  }

  /**
   * Backup for sessions that ended without a job-log entry, for example after a crash. The
   * job log normally adds the trigger first, because a session marks its job as finished
   * before it disconnects.
   */
  handleSessionDisconnect(session: Pick<SessionData, 'sessionInfo'>): void {
    const { command, linkedPrUrl } = session.sessionInfo;
    if (!linkedPrUrl || !SHEPHERD_BOT_FIX_COMMANDS.includes(command)) {
      return;
    }
    const prUrl = tryCanonicalizePrUrl(linkedPrUrl);
    if (!prUrl) {
      return;
    }
    try {
      const now = this.now();
      const since = new Date(now.getTime() - SESSION_END_BACKUP_WINDOW_MS).toISOString();
      if (hasShepherdBotTriggerSince(this.db, { prUrl, kind: 'session_ended', sinceIso: since })) {
        return;
      }
      enqueueShepherdBotSessionEnded(this.db, { command, prUrl, outcome: 'unknown' }, now);
    } catch (err) {
      console.warn(`[shepherd_bot] Failed to handle the end of a session for ${prUrl}`, err);
    }
  }

  async tick(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const sessionManager = this.getSessionManager();
      this.ensureDisconnectListener(sessionManager);
      this.reconcileRuns();
      await this.executeRequestedActions(sessionManager);
      for (const projectId of listRunningShepherdBotProjectIds(this.db)) {
        if (this.stopped) {
          return;
        }
        await this.maybeStartRun(projectId, sessionManager);
      }
      pruneShepherdBotTriggers(
        this.db,
        new Date(this.now().getTime() - TRIGGER_RETENTION_MS).toISOString()
      );
    } catch (err) {
      console.warn('[shepherd_bot] Tick failed', err);
    } finally {
      this.running = false;
    }
  }

  /** Mark runs as interrupted when their process is gone, hangs, or runs too long. */
  private reconcileRuns(): void {
    const now = this.now();
    const isAlive = this.options.isProcessAlive ?? defaultIsProcessAlive;
    const kill = this.options.killProcess ?? defaultKillProcess;
    const staleBefore = new Date(now.getTime() - STALE_HEARTBEAT_MS).toISOString();
    const tooOldBefore = new Date(now.getTime() - MAX_RUN_DURATION_MS).toISOString();

    for (const run of listRunningShepherdBotRuns(this.db)) {
      let reason: string | null = null;
      if (run.started_at < tooOldBefore) {
        if (run.pid !== null) {
          kill(run.pid);
        }
        reason = 'The run took too long and was stopped';
      } else if (run.heartbeat_at < staleBefore) {
        reason = 'The run stopped sending heartbeats';
      } else if (run.pid !== null && !isAlive(run.pid)) {
        reason = 'The run process exited without finishing';
      }
      if (reason) {
        console.warn(`[shepherd_bot] Run ${run.id} interrupted: ${reason}`);
        finishShepherdBotRun(this.db, run.id, 'interrupted', { error: reason, now });
      }
    }
  }

  private isStackBusy(
    urls: readonly string[],
    sessionManager: ShepherdBotSessionManager | null
  ): boolean {
    return urls.some(
      (url) =>
        isPrLaunching(url) ||
        sessionManager?.hasActiveSessionForPr(url, [...SHEPHERD_BOT_FIX_COMMANDS]).active === true
    );
  }

  /** Hold a trigger while a fix session runs in its PR's stack. The session end wakes the bot. */
  private isTriggerHeld(
    trigger: ShepherdBotTriggerRow,
    sessionManager: ShepherdBotSessionManager | null
  ): boolean {
    if (!trigger.pr_url) {
      return false;
    }
    const detail = getPrStatusByUrl(this.db, trigger.pr_url);
    if (!detail) {
      return false;
    }
    return this.isStackBusy(stackUrlsForPr(this.db, detail), sessionManager);
  }

  private async maybeStartRun(
    projectId: number,
    sessionManager: ShepherdBotSessionManager | null
  ): Promise<void> {
    if (getActiveShepherdBotRun(this.db, projectId)) {
      return;
    }

    const now = this.now();
    const nowIso = now.toISOString();
    const pending = listPendingShepherdBotTriggers(this.db, projectId).filter(
      (trigger) => !this.isTriggerHeld(trigger, sessionManager)
    );
    const due = pending.filter((trigger) => trigger.due_at <= nowIso);
    if (due.length === 0) {
      return;
    }

    // Wait until the debounce windows close, so that a burst of changes becomes one run.
    // A steady stream of changes must not delay the run forever.
    const stillQuiet = pending.some(
      (trigger) => trigger.kind !== 'recheck' && trigger.due_at > nowIso
    );
    const oldestDue = due.reduce((oldest, trigger) =>
      trigger.created_at < oldest.created_at ? trigger : oldest
    );
    const waitedTooLong =
      oldestDue.created_at <= new Date(now.getTime() - MAX_TRIGGER_WAIT_MS).toISOString();
    if (stillQuiet && !waitedTooLong) {
      return;
    }

    const { maxRunsPerHour } = resolveShepherdBotSettings(this.options.config);
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    if (countShepherdBotRunsSince(this.db, projectId, hourAgo) >= maxRunsPerHour) {
      return;
    }

    const cwd = (this.options.getWorkspacePath ?? ((id) => getPrimaryWorkspacePath(this.db, id)))(
      projectId
    );
    if (!cwd) {
      console.warn(`[shepherd_bot] Project ${projectId} has no primary workspace`);
      return;
    }

    // Future rechecks stay in the queue. All other pending triggers go into this run.
    const claimed = pending.filter(
      (trigger) => trigger.kind !== 'recheck' || trigger.due_at <= nowIso
    );
    const runId = startShepherdBotRun(
      this.db,
      projectId,
      claimed.map((trigger) => trigger.id)
    );
    if (runId === null) {
      return;
    }

    try {
      const result = await (this.options.spawnRun ?? spawnShepherdBotRunProcess)(runId, cwd);
      if (!result.success) {
        finishShepherdBotRun(this.db, runId, 'failed', { error: result.error, now: this.now() });
      }
    } catch (err) {
      finishShepherdBotRun(this.db, runId, 'failed', {
        error: err instanceof Error ? err.message : String(err),
        now: this.now(),
      });
    }
  }

  private async executeRequestedActions(
    sessionManager: ShepherdBotSessionManager | null
  ): Promise<void> {
    const actions = listRequestedShepherdBotActions(this.db);
    if (actions.length === 0) {
      return;
    }

    let username: string | null | undefined;
    const resolveUsername = async (): Promise<string | null> => {
      if (username === undefined) {
        username = await (
          this.options.resolveUsername ??
          (() => getGitHubUsername({ githubUsername: this.options.config.githubUsername }))
        )();
      }
      return username;
    };

    const inboxProjectIds = new Set<number>();
    for (const action of actions) {
      try {
        const projectId = await this.executeAction(action, sessionManager, resolveUsername);
        if (projectId !== null) {
          inboxProjectIds.add(projectId);
        }
      } catch (err) {
        console.warn(`[shepherd_bot] Failed to execute action ${action.id}`, err);
        updateShepherdBotAction(this.db, action.id, {
          status: 'failed',
          result: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (inboxProjectIds.size > 0 && sessionManager?.hasInboxUpdateListeners()) {
      sessionManager.emitInboxUpdate([...inboxProjectIds].sort((a, b) => a - b));
    }
  }

  /** Returns the project ID when the action wrote an inbox item. */
  private async executeAction(
    action: ShepherdBotActionRow,
    sessionManager: ShepherdBotSessionManager | null,
    resolveUsername: () => Promise<string | null>
  ): Promise<number | null> {
    const reject = (result: string): null => {
      updateShepherdBotAction(this.db, action.id, { status: 'rejected', result });
      return null;
    };

    if (!isFixKind(action.kind)) {
      return reject(`Unknown action kind ${action.kind}`);
    }
    if (!isShepherdBotRunning(this.db, action.project_id)) {
      return reject('The bot was stopped');
    }
    const detail = action.pr_url
      ? getPrStatusByUrl(this.db, action.pr_url, { includeReviewThreads: true })
      : null;
    if (!detail || detail.status.state !== 'open') {
      return reject('The PR is not open');
    }
    const shepherd = getPrShepherd(this.db, detail.status.id);
    if (!shepherd || shepherd.removed_at !== null || shepherd.bot_enabled_at === null) {
      return reject('The bot does not watch the PR');
    }

    // One session for each stack at a time. Fixes in different levels of one stack at the
    // same time would make the branches diverge.
    if (this.isStackBusy(stackUrlsForPr(this.db, detail), sessionManager)) {
      return reject('A session is already running in this stack');
    }

    if (
      countLaunchedShepherdBotActions(this.db, {
        prStatusId: detail.status.id,
        kind: action.kind,
        headSha: detail.status.head_sha,
      }) >= MAX_FIX_ATTEMPTS_PER_SHA
    ) {
      return reject(
        `This fix was already started ${MAX_FIX_ATTEMPTS_PER_SHA} times for the current head SHA`
      );
    }

    let dedupeKey: string | null = null;
    switch (action.kind) {
      case 'ci_fix':
        if (!isCiFixEligibleForUsername(this.db, detail, await resolveUsername())) {
          return reject('The PR has no failing checks that a CI fix can handle');
        }
        break;
      case 'pr_rebase': {
        if (!isPrRebaseEligible(detail)) {
          return reject('The PR has no merge conflicts');
        }
        // The cached state can be from before a recent push, for example while an earlier
        // session was still pushing the stack. Ask GitHub again before a rebase starts.
        await (
          this.options.refreshMergeable ??
          ((status) =>
            fetchAndUpdatePrMergeableStatus(this.db, status.owner, status.repo, status.pr_number))
        )(detail.status);
        const fresh = getPrStatusByUrl(this.db, detail.status.pr_url);
        if (!fresh?.status.mergeable || fresh.status.mergeable === 'UNKNOWN') {
          insertShepherdBotTrigger(this.db, {
            projectId: action.project_id,
            prStatusId: detail.status.id,
            prUrl: detail.status.pr_url,
            kind: 'recheck',
            details: {
              reason: `GitHub was still computing the merge conflicts of #${detail.status.pr_number}`,
            },
            dueAt: new Date(this.now().getTime() + MERGEABLE_UNKNOWN_RECHECK_MS),
          });
          return reject(
            'GitHub is still computing whether the PR has merge conflicts. The bot will check again.'
          );
        }
        if (!isPrRebaseEligible(fresh)) {
          return reject('GitHub no longer reports merge conflicts for the PR');
        }
        break;
      }
      case 'pr_fix':
        dedupeKey = unresolvedThreadKey(detail);
        if (!dedupeKey) {
          return reject('The PR has no unresolved review threads');
        }
        if (
          countLaunchedShepherdBotActions(this.db, {
            prStatusId: detail.status.id,
            kind: 'pr_fix',
            dedupeKey,
          }) > 0
        ) {
          return reject('A PR fix was already started for the same unresolved threads');
        }
        break;
    }

    const cwd = (this.options.getWorkspacePath ?? ((id) => getPrimaryWorkspacePath(this.db, id)))(
      action.project_id
    );
    if (!cwd) {
      return reject('The project has no primary workspace');
    }

    const prUrl = detail.status.pr_url;
    setPrLaunchLock(prUrl);
    let result: SpawnTargetProcessResult;
    try {
      result = await (this.options.launchFix ?? defaultLaunchFix)(action.kind, prUrl, cwd);
    } catch (err) {
      clearPrLaunchLock(prUrl);
      throw err;
    }
    if (!result.success) {
      clearPrLaunchLock(prUrl);
      updateShepherdBotAction(this.db, action.id, { status: 'failed', result: result.error });
      return null;
    }
    if (result.earlyExit) {
      clearPrLaunchLock(prUrl);
    }
    updateShepherdBotAction(this.db, action.id, {
      status: 'launched',
      result: 'Session started',
      dedupeKey,
    });

    if (action.kind !== 'pr_fix') {
      return null;
    }
    // The PR fix session asks the user about each comment, so the user must know about it.
    upsertInboxItem(this.db, {
      projectId: action.project_id,
      kind: 'shepherd_bot',
      prUrl,
      prNumber: detail.status.pr_number,
      repo: `${detail.status.owner}/${detail.status.repo}`,
      prTitle: detail.status.title,
      actor: 'tim',
      summary: `The shepherd bot started a PR fix session for #${detail.status.pr_number}. It is waiting for your input on the review comments.`,
    });
    return action.project_id;
  }
}

// ---------------------------------------------------------------------------
// User operations

/** Start or stop the bot for a project. Starting it queues a run that reviews all stacks. */
export function setShepherdBotRunningForProject(
  db: Database,
  projectId: number,
  running: boolean,
  now: Date = new Date()
): void {
  const wasRunning = isShepherdBotRunning(db, projectId);
  setShepherdBotRunning(db, projectId, running);
  if (running && !wasRunning) {
    insertShepherdBotTrigger(db, { projectId, kind: 'bot_started', dueAt: now });
  }
}

/**
 * Add the PRs from the root of the stack up to and including `prNumber` to the bot.
 * Returns the PR numbers that were added.
 */
export function addStackPathToShepherdBot(
  db: Database,
  detail: PrStatusDetail,
  now: Date = new Date()
): number[] {
  const stack = findOpenStackForPr(db, detail.status);
  const path = stack.length > 0 ? getStackPathToPr(stack, detail.status.pr_number) : [];
  const targets = path.length > 0 ? path : [detail];

  const added: number[] = [];
  for (const pr of targets) {
    const shepherd = getPrShepherd(db, pr.status.id);
    if (shepherd && shepherd.removed_at === null && shepherd.bot_enabled_at !== null) {
      continue;
    }
    setPrShepherdBotEnabled(
      db,
      pr.status.id,
      true,
      computeShepherdBotSnapshotForPr(db, pr.status.pr_url)
    );
    added.push(pr.status.pr_number);
  }

  const projectId = getProjectIdForPrStatus(db, detail.status);
  if (added.length > 0 && projectId !== null && isShepherdBotRunning(db, projectId)) {
    insertShepherdBotTrigger(db, {
      projectId,
      kind: 'prs_added',
      details: { prNumbers: added },
      dueAt: now,
    });
  }
  return added;
}

/** Remove every PR in the PR's open stack from the bot. Returns the PR numbers removed. */
export function removeStackFromShepherdBot(db: Database, detail: PrStatusDetail): number[] {
  const stack = findOpenStackForPr(db, detail.status);
  const targets = stack.length > 0 ? stack.map((entry) => entry.pr) : [detail];
  const removed: number[] = [];
  for (const pr of targets) {
    if (getPrShepherd(db, pr.status.id)?.bot_enabled_at != null) {
      setPrShepherdBotEnabled(db, pr.status.id, false);
      removed.push(pr.status.pr_number);
    }
  }
  return removed;
}
