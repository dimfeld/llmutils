import { getLoggerAdapter, runWithLogger } from '../logging/adapter.js';
import { HeadlessAdapter } from '../logging/headless_adapter.js';
import type { HeadlessSessionInfo } from '../logging/headless_protocol.js';
import { debugLog, warn } from '../logging.js';
import type { TimConfig } from './configSchema.js';
import { getRepositoryIdentity } from './assignments/workspace_identifier.js';
import { describeRemoteForLogging } from './external_storage_utils.js';
import { getDatabase } from './db/database.js';
import { getProject } from './db/project.js';
import { markJobFinished, recordJobStart } from './db/job.js';

export const DEFAULT_HEADLESS_URL = 'ws://localhost:8123/tim-agent';
const warnedInvalidHeadlessUrls = new Set<string>();

export function resetHeadlessWarningStateForTests(): void {
  warnedInvalidHeadlessUrls.clear();
}

export interface HeadlessPlanSummary {
  id?: number;
  uuid?: string;
  title?: string;
}

export type HeadlessCommand =
  | 'agent'
  | 'agent-multi'
  | 'review'
  | 'review-issues'
  | 'review-guide'
  | 'review-guide-comment'
  | 'run-prompt'
  | 'generate'
  | 'chat'
  | 'autoreview'
  | 'rebase'
  | 'update-docs'
  | 'proof'
  | 'pr-create'
  | 'pr-fix'
  | 'shell';

interface RunWithHeadlessOptions<T> {
  enabled: boolean;
  command: HeadlessCommand;
  interactive: boolean;
  plan?: HeadlessPlanSummary;
  callback: () => Promise<T>;
}

interface CreateHeadlessAdapterOptions {
  command: HeadlessCommand;
  interactive: boolean;
  plan?: HeadlessPlanSummary;
  sessionInfo?: Partial<HeadlessSessionInfo>;
  /**
   * When true, the embedded server starts without a bearer token even if
   * TIM_WS_BEARER_TOKEN is set. `tim shell` needs this because
   * SessionDiscoveryClient skips token-authenticated sessions, so the PTY
   * agent must be discoverable without a token.
   */
  disableBearerToken?: boolean;
}

export function resolveHeadlessUrl(config: Pick<TimConfig, 'headless'>): string {
  const envUrl = process.env.TIM_HEADLESS_URL?.trim();
  if (envUrl) {
    if (!isValidHeadlessUrl(envUrl)) {
      warnIfInvalidHeadlessUrl(envUrl);
      return DEFAULT_HEADLESS_URL;
    }
    return envUrl;
  }

  const configUrl = config.headless?.url?.trim();
  if (configUrl) {
    if (!isValidHeadlessUrl(configUrl)) {
      warnIfInvalidHeadlessUrl(configUrl);
      return DEFAULT_HEADLESS_URL;
    }
    return configUrl;
  }

  return DEFAULT_HEADLESS_URL;
}

function isValidHeadlessUrl(url: string): boolean {
  return url.startsWith('ws://') || url.startsWith('wss://');
}

function warnIfInvalidHeadlessUrl(url: string): void {
  if (isValidHeadlessUrl(url)) {
    return;
  }

  if (warnedInvalidHeadlessUrls.has(url)) {
    return;
  }

  warnedInvalidHeadlessUrls.add(url);
  warn(
    `Invalid headless URL "${url}". Headless streaming expects a ws:// or wss:// URL (TIM_HEADLESS_URL or headless.url); falling back to ${DEFAULT_HEADLESS_URL}.`
  );
}

export async function buildHeadlessSessionInfo(
  command: HeadlessCommand,
  interactive: boolean,
  plan?: HeadlessPlanSummary
): Promise<HeadlessSessionInfo> {
  let workspacePath: string | undefined;
  let gitRemote: string | undefined;
  const weztermPaneId = process.env.WEZTERM_PANE?.trim();

  try {
    const repository = await getRepositoryIdentity();
    workspacePath = repository.gitRoot;
    gitRemote = repository.remoteUrl ? describeRemoteForLogging(repository.remoteUrl) : undefined;
  } catch {
    // No-op: headless session metadata is best-effort.
  }

  return {
    command,
    interactive,
    hidePlanDetails: process.env.TIM_HIDE_PLAN_DETAILS === '1' || undefined,
    planId: plan?.id,
    planUuid: plan?.uuid,
    planTitle: plan?.title,
    workspacePath,
    gitRemote,
    terminalPaneId: weztermPaneId || undefined,
    terminalType: weztermPaneId ? 'wezterm' : undefined,
  };
}

/**
 * Whether starting this command's session should be written to the job log.
 *
 * A job is recorded for commands that create a (non-tunneled) session, start
 * an embedded server, and represent standalone plan/project work worth
 * surfacing in the activity feed.
 */
function shouldRecordJob(command: HeadlessCommand): boolean {
  if (
    command === 'agent-multi' ||
    command === 'review' ||
    command === 'chat' ||
    command === 'run-prompt' ||
    command === 'shell' ||
    command === 'review-guide-comment'
  ) {
    return false;
  }
  // No server means no discoverable session, so there is nothing to log.
  return process.env.TIM_NO_SERVER !== '1';
}

export function shouldRecordHeadlessJobForTests(command: HeadlessCommand): boolean {
  return shouldRecordJob(command);
}

/**
 * Records the start of a job for a session, resolving the project from the
 * current repository. Best-effort: never throws, so job logging cannot break a
 * command. Returns the new job id, or undefined if nothing was recorded.
 */
async function recordJobStartFromSession(
  command: HeadlessCommand,
  sessionInfo: HeadlessSessionInfo
): Promise<number | undefined> {
  try {
    const db = getDatabase();
    let projectId: number | null = null;
    try {
      const identity = await getRepositoryIdentity();
      projectId = getProject(db, identity.repositoryId)?.id ?? null;
    } catch {
      // Best-effort project resolution; record the job without a project id.
    }

    return recordJobStart(db, {
      projectId,
      jobType: command,
      planId: sessionInfo.planId ?? null,
      planUuid: sessionInfo.planUuid ?? null,
      planTitle: sessionInfo.planTitle ?? null,
      prUrl: sessionInfo.linkedPrUrl ?? null,
      prNumber: sessionInfo.linkedPrNumber ?? null,
      workspacePath: sessionInfo.workspacePath ?? null,
      gitRemote: sessionInfo.gitRemote ?? null,
    });
  } catch (err) {
    debugLog(`Failed to record job start for ${command}: ${err as Error}`);
    return undefined;
  }
}

function markJobFinishedSafely(jobId: number, status: 'completed' | 'failed'): void {
  try {
    markJobFinished(getDatabase(), jobId, status);
  } catch (err) {
    debugLog(`Failed to mark job ${jobId} as ${status}: ${err as Error}`);
  }
}

export async function runWithHeadlessAdapterIfEnabled<T>({
  enabled,
  command,
  interactive,
  plan,
  callback,
}: RunWithHeadlessOptions<T>): Promise<T> {
  if (!enabled) {
    return callback();
  }

  const sessionInfo = await buildHeadlessSessionInfo(command, interactive, plan);
  const jobId = shouldRecordJob(command)
    ? await recordJobStartFromSession(command, sessionInfo)
    : undefined;
  const headlessAdapter = createHeadlessAdapter(sessionInfo);

  try {
    const result = await runWithLogger(headlessAdapter, callback);
    if (jobId != null) {
      markJobFinishedSafely(jobId, 'completed');
    }
    return result;
  } catch (err) {
    if (jobId != null) {
      markJobFinishedSafely(jobId, 'failed');
    }
    throw err;
  } finally {
    await headlessAdapter.destroy();
  }
}

export async function createHeadlessAdapterForCommand({
  command,
  interactive,
  plan,
  sessionInfo: sessionInfoPatch,
  disableBearerToken,
}: CreateHeadlessAdapterOptions): Promise<HeadlessAdapter> {
  const sessionInfo = await buildHeadlessSessionInfo(command, interactive, plan);
  Object.assign(sessionInfo, sessionInfoPatch);

  // Commands that manage the adapter lifecycle themselves (review, shell) don't
  // give us a success/failure signal, so mark the job completed when the
  // session is torn down.
  let onDestroy: (() => void) | undefined;
  if (shouldRecordJob(command)) {
    const jobId = await recordJobStartFromSession(command, sessionInfo);
    if (jobId != null) {
      onDestroy = () => markJobFinishedSafely(jobId, 'completed');
    }
  }

  return createHeadlessAdapter(sessionInfo, { disableBearerToken, onDestroy });
}

export function updateHeadlessSessionInfo(patch: Partial<HeadlessSessionInfo>): void {
  const adapter = getLoggerAdapter();
  if (!(adapter instanceof HeadlessAdapter)) {
    return;
  }

  adapter.updateSessionInfo(patch);
}

function createHeadlessAdapter(
  sessionInfo: HeadlessSessionInfo,
  {
    disableBearerToken = false,
    onDestroy,
  }: { disableBearerToken?: boolean; onDestroy?: () => void } = {}
): HeadlessAdapter {
  const wrappedAdapter = getLoggerAdapter();
  const noServer = process.env.TIM_NO_SERVER === '1';
  const portStr = process.env.TIM_SERVER_PORT?.trim();
  let serverPort: number | undefined;
  if (!noServer) {
    if (portStr) {
      const parsed = Number.parseInt(portStr, 10);
      if (Number.isNaN(parsed) || parsed < 0 || parsed > 65535 || String(parsed) !== portStr) {
        throw new Error(
          `Invalid TIM_SERVER_PORT "${portStr}". Must be an integer between 0 and 65535.`
        );
      }
      serverPort = parsed;
    } else {
      serverPort = 0;
    }
  }
  const bearerToken = disableBearerToken
    ? undefined
    : process.env.TIM_WS_BEARER_TOKEN?.trim() || undefined;
  const serverHostname = process.env.TIM_SERVER_HOSTNAME?.trim() || undefined;
  const options = {
    serverPort,
    serverHostname,
    bearerToken,
    onDestroy,
  };

  return wrappedAdapter
    ? new HeadlessAdapter(sessionInfo, wrappedAdapter, options)
    : new HeadlessAdapter(sessionInfo, undefined, options);
}
