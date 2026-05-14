import fs from 'node:fs';
import path from 'node:path';
import { getLogDir } from '$common/config_paths.js';
import { buildWorkspaceCommandEnv } from '$common/env.js';

const EARLY_EXIT_CHECK_DELAY_MS = 500;

export interface SpawnProcessSuccess {
  success: true;
  planId: number;
  /** True when the process exited with code 0 within the early-exit check window. */
  earlyExit?: boolean;
}

export interface SpawnProcessFailure {
  success: false;
  error: string;
}

export type SpawnProcessResult = SpawnProcessSuccess | SpawnProcessFailure;

function waitForSpawnWindow(delayMs = EARLY_EXIT_CHECK_DELAY_MS): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

interface LogFileInfo {
  fd: number;
  path: string;
}

function describeCommand(args: string[]): string {
  return ['tim', ...args].join(' ');
}

function describeTarget(kind: 'plan' | 'pr', id: number): string {
  return `${kind} ${id}`;
}

export function formatLogFileName(planId: number, command: string, timestamp = new Date()): string {
  const isoTimestamp = timestamp.toISOString().replace(/[:.]/g, '-');
  return `${planId}-${isoTimestamp}-${command}.log`;
}

export function createLogFile(command: string, planId: number): LogFileInfo {
  const logDir = getLogDir();
  fs.mkdirSync(logDir, { recursive: true });

  const filename = formatLogFileName(planId, command);
  const logPath = path.join(logDir, filename);

  return { fd: fs.openSync(logPath, 'a'), path: logPath };
}

async function spawnTimProcess(
  targetLabel: string,
  planId: number,
  args: string[],
  cwd: string,
  envOverrides?: Record<string, string>
): Promise<SpawnProcessResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  let logFile: LogFileInfo | undefined;

  try {
    const command = args[0];
    console.info(`[web-ui] Starting ${describeCommand(args)} for ${targetLabel} in ${cwd}`);
    logFile = createLogFile(command, planId);
    const env = await buildWorkspaceCommandEnv(cwd, envOverrides);

    proc = Bun.spawn(['tim', ...args], {
      cwd,
      env,
      stdin: 'ignore',
      stdout: logFile.fd,
      stderr: logFile.fd,
      detached: true,
    });
  } catch (err) {
    if (logFile) {
      fs.closeSync(logFile.fd);
    }
    console.error(`[web-ui] Failed to start ${describeCommand(args)} for ${targetLabel}`, err);
    return {
      success: false,
      error: `Failed to start tim ${args[0]}: ${err as Error}`,
    };
  }

  // The child process owns the fd now, so we can close our copy.
  fs.closeSync(logFile.fd);
  console.info(
    `[web-ui] Started ${describeCommand(args)} for ${targetLabel}; waiting ${EARLY_EXIT_CHECK_DELAY_MS}ms for early exit`
  );

  await waitForSpawnWindow();

  if (proc.exitCode !== null) {
    // exitCode 0 means the command completed successfully (e.g. a fast rebase with no conflicts).
    if (proc.exitCode === 0) {
      console.info(
        `[web-ui] ${describeCommand(args)} for ${targetLabel} exited successfully during startup`
      );
      return { success: true, planId, earlyExit: true };
    }
    const logContents = fs.readFileSync(logFile.path, 'utf-8').trim();
    console.warn(
      `[web-ui] ${describeCommand(args)} for ${targetLabel} exited early with code ${proc.exitCode}; log file: ${logFile.path}`
    );
    return {
      success: false,
      error: logContents || `tim ${args[0]} exited early with code ${proc.exitCode}`,
    };
  }

  proc.unref();
  console.info(`[web-ui] ${describeCommand(args)} for ${targetLabel} is running detached`);
  return { success: true, planId };
}

export async function spawnGenerateProcess(
  planId: number,
  cwd: string
): Promise<SpawnProcessResult> {
  return spawnTimProcess(
    describeTarget('plan', planId),
    planId,
    ['generate', String(planId), '--auto-workspace', '--no-terminal-input'],
    cwd
  );
}

export async function spawnAgentProcess(planId: number, cwd: string): Promise<SpawnProcessResult> {
  return spawnTimProcess(
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

  return spawnTimProcess(
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
  return spawnTimProcess(
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
  return spawnTimProcess(
    describeTarget('plan', planId),
    planId,
    ['rebase', String(planId), '--auto-workspace', '--no-terminal-input'],
    cwd
  );
}

export async function spawnPrFixProcess(planId: number, cwd: string): Promise<SpawnProcessResult> {
  return spawnTimProcess(
    describeTarget('plan', planId),
    planId,
    ['pr', 'fix', String(planId), '--all', '--auto-workspace', '--no-terminal-input'],
    cwd
  );
}

export async function spawnPrCreateProcess(
  planId: number,
  cwd: string
): Promise<SpawnProcessResult> {
  return spawnTimProcess(
    describeTarget('plan', planId),
    planId,
    ['pr', 'create', String(planId), '--auto-workspace', '--no-terminal-input'],
    cwd
  );
}

export async function spawnReviewProcess(planId: number, cwd: string): Promise<SpawnProcessResult> {
  return spawnTimProcess(
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
  return spawnTimProcess(
    describeTarget('plan', planId),
    planId,
    ['proof', String(planId), '--auto-workspace', '--no-terminal-input'],
    cwd
  );
}

export async function spawnUpdateDocsProcess(
  planId: number,
  cwd: string
): Promise<SpawnProcessResult> {
  return spawnTimProcess(
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
  return spawnTimProcess(
    describeTarget('pr', prNumber),
    prNumber,
    ['pr', 'review-guide', String(prNumber), '--auto-workspace'],
    cwd
  );
}

export async function spawnPlanReviewGuideProcess(
  planId: number,
  cwd: string
): Promise<SpawnProcessResult> {
  return spawnTimProcess(
    describeTarget('plan', planId),
    planId,
    ['review-guide', String(planId), '--auto-workspace'],
    cwd
  );
}
