import * as path from 'node:path';
import { expandTilde } from '../common/fs.js';
import { getGitRoot } from '../common/git.js';
import { spawnAndLogOutput } from '../common/process.js';
import { debugLog, warn } from '../logging.js';
import type { NotificationCommand, TimConfig } from './configSchema.js';
import { buildDescriptionFromPlan, getCombinedTitleFromSummary } from './display_utils.js';
import type { PlanSchema } from './planSchema.js';

export type NotificationCommandName = 'agent' | 'review';
export type NotificationEvent = 'agent_done' | 'review_done' | 'review_input';
export type NotificationStatus = 'success' | 'error' | 'input';

export interface NotificationPayload {
  source: 'tim';
  command: NotificationCommandName;
  event: NotificationEvent;
  status: NotificationStatus;
  cwd: string;
  planId: string;
  planFile: string;
  planSummary: string;
  planDescription: string;
  message: string;
  errorMessage?: string;
}

export interface NotificationInput {
  command: NotificationCommandName;
  event: NotificationEvent;
  status: NotificationStatus;
  message: string;
  errorMessage?: string;
  cwd?: string;
  plan?: PlanSchema & { filename?: string | undefined };
  planFile?: string;
  planId?: string;
  planSummary?: string;
  planDescription?: string;
}

export function buildNotificationPayload(input: NotificationInput): NotificationPayload {
  const planSummary =
    input.planSummary ?? (input.plan ? getCombinedTitleFromSummary(input.plan) : '');
  const planDescription =
    input.planDescription ??
    (input.plan ? buildDescriptionFromPlan(input.plan) : planSummary || '');
  const planId =
    input.planId ??
    (input.plan?.id !== undefined && input.plan?.id !== null ? String(input.plan.id) : '');
  const planFile =
    input.planFile ??
    (input.plan && 'filename' in input.plan && input.plan.filename ? input.plan.filename : '');

  return {
    source: 'tim',
    command: input.command,
    event: input.event,
    status: input.status,
    cwd: input.cwd ?? process.cwd(),
    planId,
    planFile,
    planSummary,
    planDescription,
    message: input.message,
    errorMessage: input.errorMessage,
  };
}

function notificationsEnabled(
  config: NotificationCommand | undefined
): config is NotificationCommand & { command: string } {
  if (!config) return false;
  if (!config.command) return false;
  if (config.enabled === false) return false;
  if (process.env.TIM_NOTIFY_SUPPRESS === '1') return false;
  return true;
}

export async function sendNotification(
  config: TimConfig,
  input: NotificationInput
): Promise<boolean> {
  const notificationConfig = config.notifications;
  if (!notificationsEnabled(notificationConfig)) {
    debugLog('Notification suppressed or not configured.');
    return false;
  }

  let baseDir = input.cwd;
  if (!baseDir) {
    try {
      baseDir = (await getGitRoot()) || process.cwd();
    } catch (err) {
      baseDir = process.cwd();
      debugLog('Failed to resolve git root for notifications:', err);
    }
  }

  const commandCwd = notificationConfig.workingDirectory
    ? path.resolve(baseDir, notificationConfig.workingDirectory)
    : baseDir;

  const env: Record<string, string> = Object.fromEntries(
    Object.entries({ ...process.env, ...(notificationConfig.env ?? {}) }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  );

  const payload = buildNotificationPayload({ ...input, cwd: baseDir });
  const payloadJson = `${JSON.stringify(payload)}\n`;

  const isWindows = process.platform === 'win32';
  const shellCommand = isWindows ? 'cmd' : 'sh';
  const shellFlag = isWindows ? '/c' : '-c';

  // Expand tilde in command path for Unix-like systems
  const expandedCommand = isWindows
    ? notificationConfig.command
    : expandTilde(notificationConfig.command);

  try {
    const result = await spawnAndLogOutput([shellCommand, shellFlag, expandedCommand], {
      cwd: commandCwd,
      env,
      stdin: payloadJson,
      quiet: true,
    });

    if (result.exitCode !== 0) {
      warn(
        `Notification command failed with exit code ${result.exitCode}.` +
          (result.stderr ? `\n${result.stderr.trim()}` : '')
      );
      return false;
    }
  } catch (err) {
    warn(`Notification command failed: ${err as Error}`);
    return false;
  }

  return true;
}
