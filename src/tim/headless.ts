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
  title?: string;
}

interface RunWithHeadlessOptions<T> {
  enabled: boolean;
  command: 'agent' | 'review' | 'run-prompt' | 'generate' | 'chat';
  config: Pick<TimConfig, 'headless'>;
  plan?: HeadlessPlanSummary;
  callback: () => Promise<T>;
}

interface CreateHeadlessAdapterOptions {
  command: 'agent' | 'review' | 'run-prompt' | 'generate' | 'chat';
  config: Pick<TimConfig, 'headless'>;
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
  command: 'agent' | 'review' | 'run-prompt' | 'generate' | 'chat',
  plan?: HeadlessPlanSummary
): Promise<HeadlessSessionInfo> {
  let workspacePath: string | undefined;
  let gitRemote: string | undefined;

  try {
    const repository = await getRepositoryIdentity();
    workspacePath = repository.gitRoot;
    gitRemote = repository.remoteUrl ? describeRemoteForLogging(repository.remoteUrl) : undefined;
  } catch {
    // No-op: headless session metadata is best-effort.
  }

  return {
    command,
    planId: plan?.id,
    planTitle: plan?.title,
    workspacePath,
    gitRemote,
  };
}

export async function runWithHeadlessAdapterIfEnabled<T>({
  enabled,
  command,
  config,
  plan,
  callback,
}: RunWithHeadlessOptions<T>): Promise<T> {
  if (!enabled) {
    return callback();
  }

  const sessionInfo = await buildHeadlessSessionInfo(command, plan);
  const url = resolveHeadlessUrl(config);
  const headlessAdapter = createHeadlessAdapter(url, sessionInfo);

  try {
    return await runWithLogger(headlessAdapter, callback);
  } finally {
    await headlessAdapter.destroy();
  }
}

export async function createHeadlessAdapterForCommand({
  command,
  config,
  plan,
}: CreateHeadlessAdapterOptions): Promise<HeadlessAdapter> {
  const sessionInfo = await buildHeadlessSessionInfo(command, plan);
  const url = resolveHeadlessUrl(config);
  return createHeadlessAdapter(url, sessionInfo);
}

function createHeadlessAdapter(url: string, sessionInfo: HeadlessSessionInfo): HeadlessAdapter {
  const wrappedAdapter = getLoggerAdapter();
  return wrappedAdapter
    ? new HeadlessAdapter(url, sessionInfo, wrappedAdapter)
    : new HeadlessAdapter(url, sessionInfo);
}
