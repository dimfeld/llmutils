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

function createLogFile(command: string, planId: number): LogFileInfo {
  const logDir = getLogDir();
  fs.mkdirSync(logDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${command}-plan${planId}-${timestamp}.log`;
  const logPath = path.join(logDir, filename);

  return { fd: fs.openSync(logPath, 'a'), path: logPath };
}

async function spawnTimProcess(
  planId: number,
  args: string[],
  cwd: string
): Promise<SpawnProcessResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  let logFile: LogFileInfo | undefined;

  try {
    const command = args[0];
    logFile = createLogFile(command, planId);
    const env = await buildWorkspaceCommandEnv(cwd);

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
    return {
      success: false,
      error: `Failed to start tim ${args[0]}: ${err as Error}`,
    };
  }

  // The child process owns the fd now, so we can close our copy.
  fs.closeSync(logFile.fd);

  await waitForSpawnWindow();

  if (proc.exitCode !== null) {
    // exitCode 0 means the command completed successfully (e.g. a fast rebase with no conflicts).
    if (proc.exitCode === 0) {
      return { success: true, planId, earlyExit: true };
    }
    const logContents = fs.readFileSync(logFile.path, 'utf-8').trim();
    return {
      success: false,
      error: logContents || `tim ${args[0]} exited early with code ${proc.exitCode}`,
    };
  }

  proc.unref();
  return { success: true, planId };
}

export async function spawnGenerateProcess(
  planId: number,
  cwd: string
): Promise<SpawnProcessResult> {
  return spawnTimProcess(
    planId,
    ['generate', String(planId), '--auto-workspace', '--no-terminal-input'],
    cwd
  );
}

export async function spawnAgentProcess(planId: number, cwd: string): Promise<SpawnProcessResult> {
  return spawnTimProcess(
    planId,
    ['agent', String(planId), '--auto-workspace', '--no-terminal-input'],
    cwd
  );
}

export async function spawnChatProcess(
  planId: number,
  cwd: string,
  executor: 'claude' | 'codex'
): Promise<SpawnProcessResult> {
  return spawnTimProcess(
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
    planId,
    ['rebase', String(planId), '--auto-workspace', '--no-terminal-input'],
    cwd
  );
}

export async function spawnPrFixProcess(planId: number, cwd: string): Promise<SpawnProcessResult> {
  return spawnTimProcess(
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
    planId,
    ['pr', 'create', String(planId), '--auto-workspace', '--no-terminal-input'],
    cwd
  );
}

export async function spawnUpdateDocsProcess(
  planId: number,
  cwd: string
): Promise<SpawnProcessResult> {
  return spawnTimProcess(
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
    prNumber,
    ['pr', 'review-guide', String(prNumber), '--auto-workspace'],
    cwd
  );
}
