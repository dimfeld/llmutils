const EARLY_EXIT_CHECK_DELAY_MS = 500;

export interface SpawnProcessSuccess {
  success: true;
  planId: number;
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

async function readStderr(stderr: ReadableStream<Uint8Array> | null | undefined): Promise<string> {
  if (!stderr) {
    return '';
  }

  return (await new Response(stderr).text()).trim();
}

async function spawnTimProcess(
  planId: number,
  args: string[],
  cwd: string
): Promise<SpawnProcessResult> {
  let proc: ReturnType<typeof Bun.spawn>;

  try {
    proc = Bun.spawn(['tim', ...args], {
      cwd,
      env: process.env,
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'pipe',
      detached: true,
    });
  } catch (err) {
    return {
      success: false,
      error: `Failed to start tim ${args[0]}: ${err as Error}`,
    };
  }

  await waitForSpawnWindow();

  if (proc.exitCode !== null) {
    const stderr = await readStderr(proc.stderr instanceof ReadableStream ? proc.stderr : null);
    return {
      success: false,
      error: stderr || `tim ${args[0]} exited early with code ${proc.exitCode}`,
    };
  }

  if (proc.stderr instanceof ReadableStream) {
    proc.stderr.cancel().catch(() => {});
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
