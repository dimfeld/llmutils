import { getLoggerAdapter, runWithLogger } from '../logging/adapter.js';
import { HeadlessAdapter } from '../logging/headless_adapter.js';
import type { HeadlessSessionInfo } from '../logging/headless_protocol.js';
import { warn } from '../logging.js';
import type { TimConfig } from './configSchema.js';
import { getRepositoryIdentity } from './assignments/workspace_identifier.js';
import { describeRemoteForLogging } from './external_storage_utils.js';

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
  | 'review'
  | 'run-prompt'
  | 'generate'
  | 'chat'
  | 'rebase'
  | 'finish'
  | 'pr-create';

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
    planId: plan?.id,
    planUuid: plan?.uuid,
    planTitle: plan?.title,
    workspacePath,
    gitRemote,
    terminalPaneId: weztermPaneId || undefined,
    terminalType: weztermPaneId ? 'wezterm' : undefined,
  };
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
  const headlessAdapter = createHeadlessAdapter(sessionInfo);

  try {
    return await runWithLogger(headlessAdapter, callback);
  } finally {
    await headlessAdapter.destroy();
  }
}

export async function createHeadlessAdapterForCommand({
  command,
  interactive,
  plan,
}: CreateHeadlessAdapterOptions): Promise<HeadlessAdapter> {
  const sessionInfo = await buildHeadlessSessionInfo(command, interactive, plan);
  return createHeadlessAdapter(sessionInfo);
}

export function updateHeadlessSessionInfo(patch: Partial<HeadlessSessionInfo>): void {
  const adapter = getLoggerAdapter();
  if (!(adapter instanceof HeadlessAdapter)) {
    return;
  }

  adapter.updateSessionInfo(patch);
}

function createHeadlessAdapter(sessionInfo: HeadlessSessionInfo): HeadlessAdapter {
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
  const bearerToken = process.env.TIM_WS_BEARER_TOKEN?.trim() || undefined;
  const serverHostname = process.env.TIM_SERVER_HOSTNAME?.trim() || undefined;
  const options = {
    serverPort,
    serverHostname,
    bearerToken,
  };

  return wrappedAdapter
    ? new HeadlessAdapter(sessionInfo, wrappedAdapter, options)
    : new HeadlessAdapter(sessionInfo, undefined, options);
}
