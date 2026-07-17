import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

import { resolveTimExecutable } from '../../common/tim_executable.js';
import {
  readDaemonProcessStatus,
  TIM_DAEMON_PAYLOAD_ENV,
  type DaemonProcessPayload,
} from '../../common/daemon_process.js';
import { buildWorkspaceCommandEnv } from '$common/env.js';
import {
  createLogFile as createLogFileImpl,
  formatLogFileName as formatLogFileNameImpl,
  type LogFileInfo,
} from '../../common/log_files.js';

export const createLogFile = createLogFileImpl;
export const formatLogFileName = formatLogFileNameImpl;

const EARLY_EXIT_CHECK_DELAY_MS = 2000;

export interface SpawnProcessSuccess {
  success: true;
  planId: number;
  /** True when the process exited with code 0 within the early-exit check window. */
  earlyExit?: boolean;
}

export interface SpawnTargetProcessSuccess {
  success: true;
  planId?: number;
  /** True when the process exited with code 0 within the early-exit check window. */
  earlyExit?: boolean;
}

export interface SpawnProcessFailure {
  success: false;
  error: string;
}

export type SpawnProcessResult = SpawnProcessSuccess | SpawnProcessFailure;
export type SpawnTargetProcessResult = SpawnTargetProcessSuccess | SpawnProcessFailure;

function waitForSpawnWindow(delayMs = EARLY_EXIT_CHECK_DELAY_MS): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function removeStatusFile(statusPath: string): void {
  try {
    fs.unlinkSync(statusPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[web-ui] Failed to remove daemon status file ${statusPath}`, error);
    }
  }
}

function describeCommand(args: string[]): string {
  return ['tim', ...args].join(' ');
}

function describeTarget(kind: 'plan' | 'pr', id: number | string): string {
  return `${kind} ${id}`;
}

async function spawnTimProcess(
  targetLabel: string,
  planId: number | null,
  args: string[],
  cwd: string,
  envOverrides?: Record<string, string>
): Promise<SpawnTargetProcessResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  let logFile: LogFileInfo | undefined;
  let logFileIsOpen = false;
  let statusPath: string | undefined;

  const closeLogFile = (): void => {
    if (logFile && logFileIsOpen) {
      fs.closeSync(logFile.fd);
      logFileIsOpen = false;
    }
  };

  try {
    const command = args[0];
    console.info(`[web-ui] Starting ${describeCommand(args)} for ${targetLabel} in ${cwd}`);
    logFile = createLogFile(command, planId ?? 0);
    logFileIsOpen = true;
    const env = { ...(await buildWorkspaceCommandEnv(cwd, envOverrides)) };

    const executable = resolveTimExecutable();
    statusPath = `${logFile.path}.${randomUUID()}.daemon-status`;
    const payload: DaemonProcessPayload = {
      launcherCommand: [executable],
      workerCommand: [executable, ...args],
      statusPath,
      startupCheckDelayMs: EARLY_EXIT_CHECK_DELAY_MS,
    };
    env[TIM_DAEMON_PAYLOAD_ENV] = JSON.stringify(payload);

    proc = Bun.spawn([executable, '__daemon-launch'], {
      cwd,
      env,
      stdin: 'ignore',
      stdout: logFile.fd,
      stderr: logFile.fd,
      detached: true,
    });

    // The launcher exits only after the monitor has spawned the real command.
    // At that point the monitor/worker subtree has been reparented away from us.
    const launcherExitCode = await proc.exited;
    if (launcherExitCode !== 0) {
      const logContents = fs.readFileSync(logFile.path, 'utf-8').trim();
      removeStatusFile(statusPath);
      closeLogFile();
      return {
        success: false,
        error: logContents || `Failed to daemonize tim ${args[0]} (exit code ${launcherExitCode})`,
      };
    }

    closeLogFile();
    await waitForSpawnWindow();
    const status = readDaemonProcessStatus(statusPath);
    removeStatusFile(statusPath);

    if (status?.state === 'failed') {
      const logContents = fs.readFileSync(logFile.path, 'utf-8').trim();
      return { success: false, error: logContents || status.error };
    }
    if (status?.state === 'exited') {
      if (status.exitCode === 0) {
        console.info(
          `[web-ui] ${describeCommand(args)} for ${targetLabel} exited successfully during startup`
        );
        return { success: true, ...(planId == null ? {} : { planId }), earlyExit: true };
      }
      const logContents = fs.readFileSync(logFile.path, 'utf-8').trim();
      return {
        success: false,
        error:
          logContents ||
          (status.exitCode === null
            ? `tim ${args[0]} exited early from signal ${status.signalCode ?? 'unknown'}`
            : `tim ${args[0]} exited early with code ${status.exitCode}`),
      };
    }
  } catch (err) {
    closeLogFile();
    if (statusPath) {
      removeStatusFile(statusPath);
    }
    console.error(`[web-ui] Failed to start ${describeCommand(args)} for ${targetLabel}`, err);
    return {
      success: false,
      error: `Failed to start tim ${args[0]}: ${err as Error}`,
    };
  }

  console.info(`[web-ui] ${describeCommand(args)} for ${targetLabel} is running detached`);
  return { success: true, ...(planId == null ? {} : { planId }) };
}

async function spawnPlanTimProcess(
  targetLabel: string,
  planId: number,
  args: string[],
  cwd: string,
  envOverrides?: Record<string, string>
): Promise<SpawnProcessResult> {
  const result = await spawnTimProcess(targetLabel, planId, args, cwd, envOverrides);
  return result.success ? { ...result, planId } : result;
}

export async function spawnGenerateProcess(
  planId: number,
  cwd: string
): Promise<SpawnProcessResult> {
  return spawnPlanTimProcess(
    describeTarget('plan', planId),
    planId,
    ['generate', String(planId), '--auto-workspace', '--no-terminal-input'],
    cwd
  );
}

export async function spawnAgentProcess(planId: number, cwd: string): Promise<SpawnProcessResult> {
  return spawnPlanTimProcess(
    describeTarget('plan', planId),
    planId,
    ['agent', String(planId), '--auto-workspace', '--no-terminal-input'],
    cwd
  );
}

export async function spawnAgentMultiProcess(
  epicPlanId: number,
  planIds: number[],
  cwd: string
): Promise<SpawnProcessResult> {
  if (planIds.length === 0) {
    return { success: false, error: 'At least one plan ID is required.' };
  }

  return spawnPlanTimProcess(
    `epic ${epicPlanId} plans ${planIds.join(', ')}`,
    epicPlanId,
    [
      'agent-multi',
      ...planIds.map((planId) => String(planId)),
      '--epic',
      String(epicPlanId),
      '--no-terminal-input',
      '--non-interactive',
    ],
    cwd
  );
}

export async function spawnChatProcess(
  planId: number,
  cwd: string,
  executor: 'claude' | 'codex'
): Promise<SpawnProcessResult> {
  return spawnPlanTimProcess(
    describeTarget('plan', planId),
    planId,
    [
      'chat',
      '--plan',
      String(planId),
      '--executor',
      executor,
      '--auto-workspace',
      '--no-terminal-input',
    ],
    cwd
  );
}

export async function spawnRebaseProcess(planId: number, cwd: string): Promise<SpawnProcessResult> {
  return spawnPlanTimProcess(
    describeTarget('plan', planId),
    planId,
    ['rebase', String(planId), '--auto-workspace', '--no-terminal-input'],
    cwd
  );
}

export async function spawnPrFixProcess(planId: number, cwd: string): Promise<SpawnProcessResult> {
  return spawnPlanTimProcess(
    describeTarget('plan', planId),
    planId,
    ['pr', 'fix', String(planId), '--auto-workspace', '--no-terminal-input'],
    cwd
  );
}

export async function spawnPrFixForPrProcess(
  prUrlOrNumber: string,
  cwd: string
): Promise<SpawnTargetProcessResult> {
  return spawnTimProcess(
    describeTarget('pr', prUrlOrNumber),
    null,
    ['pr', 'fix', '--pr', prUrlOrNumber, '--auto-workspace', '--no-terminal-input'],
    cwd
  );
}

export async function spawnAutoreviewProcess(
  planId: number,
  cwd: string
): Promise<SpawnProcessResult> {
  return spawnPlanTimProcess(
    describeTarget('plan', planId),
    planId,
    ['autoreview', String(planId), '--no-terminal-input'],
    cwd,
    { TIM_HIDE_PLAN_DETAILS: '1' }
  );
}

export async function spawnAutoreviewForPrProcess(
  prUrlOrNumber: string,
  cwd: string
): Promise<SpawnTargetProcessResult> {
  return spawnTimProcess(
    describeTarget('pr', prUrlOrNumber),
    null,
    ['autoreview', '--pr', prUrlOrNumber, '--no-terminal-input'],
    cwd,
    { TIM_HIDE_PLAN_DETAILS: '1' }
  );
}

export async function spawnShellProcess(planId: number, cwd: string): Promise<SpawnProcessResult> {
  return spawnPlanTimProcess(
    describeTarget('plan', planId),
    planId,
    ['shell', String(planId), '--auto-workspace', '--non-interactive'],
    cwd,
    { TIM_HIDE_PLAN_DETAILS: '1' }
  );
}

export async function spawnShellForPrProcess(
  prUrlOrNumber: string,
  cwd: string
): Promise<SpawnTargetProcessResult> {
  return spawnTimProcess(
    describeTarget('pr', prUrlOrNumber),
    null,
    ['shell', '--pr', prUrlOrNumber, '--auto-workspace', '--non-interactive'],
    cwd,
    { TIM_HIDE_PLAN_DETAILS: '1' }
  );
}

export async function spawnPrCreateProcess(
  planId: number,
  cwd: string
): Promise<SpawnProcessResult> {
  return spawnPlanTimProcess(
    describeTarget('plan', planId),
    planId,
    ['pr', 'create', String(planId), '--auto-workspace', '--no-terminal-input'],
    cwd
  );
}

export async function spawnReviewProcess(planId: number, cwd: string): Promise<SpawnProcessResult> {
  return spawnPlanTimProcess(
    describeTarget('plan', planId),
    planId,
    [
      'review',
      String(planId),
      '--auto-workspace',
      '--no-terminal-input',
      '--save-issues',
      '--no-autofix',
    ],
    cwd
  );
}

export async function spawnProofProcess(planId: number, cwd: string): Promise<SpawnProcessResult> {
  return spawnPlanTimProcess(
    describeTarget('plan', planId),
    planId,
    ['proof', String(planId), '--auto-workspace', '--no-terminal-input'],
    cwd
  );
}

export async function spawnUploadArtifactsProcess(
  planId: number,
  cwd: string
): Promise<SpawnProcessResult> {
  return spawnPlanTimProcess(
    describeTarget('plan', planId),
    planId,
    ['pr', 'upload-artifacts', String(planId), '--auto-workspace', '--no-terminal-input'],
    cwd
  );
}

export async function spawnUpdateDocsProcess(
  planId: number,
  cwd: string
): Promise<SpawnProcessResult> {
  return spawnPlanTimProcess(
    describeTarget('plan', planId),
    planId,
    ['update-docs', String(planId), '--auto-workspace', '--no-terminal-input'],
    cwd
  );
}

export async function spawnPrReviewGuideProcess(
  prNumber: number,
  cwd: string
): Promise<SpawnProcessResult> {
  return spawnPlanTimProcess(
    describeTarget('pr', prNumber),
    prNumber,
    ['pr', 'review-guide', String(prNumber), '--auto-workspace'],
    cwd
  );
}

export async function spawnPlanReviewGuideProcess(
  planId: number,
  cwd: string,
  options: { guideOnly?: boolean } = {}
): Promise<SpawnProcessResult> {
  const args = ['review-guide', 'generate', String(planId), '--auto-workspace'];
  if (options.guideOnly === true) {
    args.push('--guide-only');
  }

  return spawnPlanTimProcess(describeTarget('plan', planId), planId, args, cwd);
}

export async function spawnPrReviewGuideCommentProcess(
  prNumber: number,
  cwd: string
): Promise<SpawnProcessResult> {
  return spawnPlanTimProcess(
    describeTarget('pr', prNumber),
    prNumber,
    [
      'pr',
      'review-guide-comment',
      String(prNumber),
      '--auto-workspace',
      '--no-terminal-input',
      '--non-interactive',
    ],
    cwd
  );
}
