import path from 'node:path';
import { error, log, warn, writeStderr, writeStdout } from '../logging.js';
import type { LifecycleCommand } from './configSchema.js';
import type { WorkspaceType } from './db/workspace.js';
import { isShuttingDown } from './shutdown_state.js';

type LifecycleMode = 'run' | 'daemon';
type StartupState = 'pending' | 'skipped' | 'succeeded' | 'failed' | 'running';

interface LifecycleCommandState {
  command: LifecycleCommand;
  mode: LifecycleMode;
  startupState: StartupState;
  shouldRunShutdown: boolean;
  daemon?: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  killedByCleanup?: boolean;
  intentionallyTerminated?: boolean;
}

function getShellCommand(command: string): string[] {
  return ['sh', '-c', command];
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DAEMON_STARTUP_CHECK_DELAY_MS = 75;
const DAEMON_SIGTERM_TIMEOUT_MS = 5000;
const DAEMON_SIGKILL_WAIT_MS = 1000;

async function readOutput(
  stream: ReadableStream<Uint8Array> | null,
  writer: (text: string) => void
): Promise<void> {
  if (!stream) {
    return;
  }

  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    writer(decoder.decode(chunk, { stream: true }));
  }
  // Flush any remaining bytes from the decoder
  const remaining = decoder.decode();
  if (remaining) {
    writer(remaining);
  }
}

export class LifecycleManager {
  private readonly states: LifecycleCommandState[];
  private shutdownStarted = false;

  constructor(
    commands: LifecycleCommand[] | undefined,
    private readonly baseDir: string,
    private readonly workspaceType: WorkspaceType | undefined
  ) {
    this.states = (commands ?? []).map((command) => ({
      command,
      mode: command.mode ?? 'run',
      startupState: 'pending',
      shouldRunShutdown: false,
    }));
  }

  async startup(): Promise<void> {
    for (const state of this.states) {
      if (isShuttingDown()) {
        break;
      }

      const { command, mode } = state;

      if (command.onlyWorkspaceType && command.onlyWorkspaceType !== this.workspaceType) {
        state.startupState = 'skipped';
        log(
          `Skipping lifecycle command "${command.title}" because it only runs in ${command.onlyWorkspaceType} workspaces.`
        );
        continue;
      }

      if (this.shouldRunCheck(command, mode)) {
        let checkPassed = false;
        try {
          const checkExitCode = await this.runShellCommand(command, {
            command: command.check!,
          });
          checkPassed = checkExitCode === 0;
        } catch (err) {
          // Check failed to run — treat as "could not determine, proceed with command"
          warn(
            `Lifecycle check for "${command.title}" failed to run, proceeding with command: ${err as Error}`
          );
        }

        if (checkPassed) {
          state.startupState = 'skipped';
          log(`Skipping lifecycle command "${command.title}" because its check command succeeded.`);
          continue;
        }

        if (isShuttingDown()) {
          break;
        }
      }

      if (mode === 'daemon') {
        log(`Starting lifecycle daemon "${command.title}"...`);
        let daemon: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
        try {
          daemon = this.spawnDaemon(command);
        } catch (err) {
          state.startupState = 'failed';
          if (command.allowFailure) {
            warn(
              `Lifecycle daemon "${command.title}" failed to start, but failure is allowed: ${err as Error}`
            );
            continue;
          }
          throw err;
        }
        state.daemon = daemon;
        // Set shouldRunShutdown immediately so killDaemons() can reach the daemon
        // if a signal arrives during the early exit check window
        state.shouldRunShutdown = true;
        const exitedTooSoon = await this.handleEarlyDaemonExit(state);
        if (!exitedTooSoon) {
          state.startupState = 'running';
          void daemon.exited.then((exitCode) => {
            if (
              exitCode !== null &&
              !state.intentionallyTerminated &&
              !state.killedByCleanup &&
              !this.shutdownStarted
            ) {
              warn(
                `Lifecycle daemon "${command.title}" exited unexpectedly with code ${exitCode}.`
              );
            }
          });
        }
        continue;
      }

      log(`Running lifecycle command "${command.title}"...`);
      state.shouldRunShutdown = Boolean(command.shutdown);
      let exitCode: number;
      try {
        exitCode = await this.runShellCommand(command, {
          command: command.command,
        });
      } catch (err) {
        state.startupState = 'failed';
        if (command.allowFailure) {
          warn(
            `Lifecycle command "${command.title}" failed to start, but failure is allowed: ${err as Error}`
          );
          continue;
        }
        throw err;
      }

      if (exitCode === 0) {
        state.startupState = 'succeeded';
        continue;
      }

      state.startupState = 'failed';
      if (!command.allowFailure) {
        throw new Error(`Lifecycle command "${command.title}" failed with exit code ${exitCode}.`);
      }

      warn(
        `Lifecycle command "${command.title}" failed with exit code ${exitCode}, but failure is allowed.`
      );
    }
  }

  async shutdown(): Promise<void> {
    if (this.shutdownStarted) {
      return;
    }
    this.shutdownStarted = true;

    const errors: Error[] = [];

    for (const state of [...this.states].reverse()) {
      if (!state.shouldRunShutdown) {
        continue;
      }

      const { command, mode } = state;

      try {
        if (mode === 'daemon') {
          if (command.shutdown) {
            state.intentionallyTerminated = true;
            log(`Running lifecycle shutdown command "${command.title}"...`);
            const exitCode = await this.runShellCommand(command, {
              command: command.shutdown,
            });
            if (exitCode !== 0) {
              errors.push(
                new Error(
                  `Lifecycle shutdown command "${command.title}" failed with exit code ${exitCode}.`
                )
              );
            }
          }

          await this.stopDaemon(state);
          continue;
        }

        if (command.shutdown) {
          log(`Running lifecycle shutdown command "${command.title}"...`);
          const exitCode = await this.runShellCommand(command, {
            command: command.shutdown,
          });
          if (exitCode !== 0) {
            errors.push(
              new Error(
                `Lifecycle shutdown command "${command.title}" failed with exit code ${exitCode}.`
              )
            );
          }
        }
      } catch (err) {
        error(`Error while shutting down lifecycle command "${command.title}": ${err as Error}`);
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }

    if (errors.length > 0) {
      throw new Error(
        `Lifecycle shutdown had ${errors.length} failure(s):\n${errors.map((e) => `  - ${e.message}`).join('\n')}`
      );
    }
  }

  /** Synchronous emergency fallback — kills ALL running daemons regardless of
   *  whether they have explicit shutdown commands. This runs via CleanupRegistry
   *  on signal, and on forced exit (second signal) the async shutdown() path
   *  won't get a chance to run, so we must not leave any daemons orphaned. */
  killDaemons(): void {
    for (const state of this.states) {
      if (state.mode !== 'daemon' || !state.shouldRunShutdown || !state.daemon) {
        continue;
      }

      if (!this.isProcessRunning(state.daemon)) {
        continue;
      }

      state.intentionallyTerminated = true;

      if (!this.tryKillProcessGroup(state.daemon.pid, 'SIGTERM')) {
        try {
          state.daemon.kill('SIGTERM');
          state.killedByCleanup = true;
        } catch (err) {
          state.killedByCleanup = true;
          warn(`Failed to terminate lifecycle daemon "${state.command.title}": ${err as Error}`);
        }
      } else {
        state.killedByCleanup = true;
      }
    }
  }

  private tryKillProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  private tryKillProcess(
    proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>,
    signal: NodeJS.Signals,
    title: string,
    failureMessage: string
  ): boolean {
    if (this.tryKillProcessGroup(proc.pid, signal)) {
      return true;
    }

    try {
      proc.kill(signal);
      return true;
    } catch (err) {
      warn(`${failureMessage} "${title}": ${err as Error}`);
      return false;
    }
  }

  private async waitForProcessExit(
    proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>,
    timeoutMs: number
  ): Promise<boolean> {
    if (!this.isProcessRunning(proc)) {
      return true;
    }

    return await this.raceWithTimeout(
      proc.exited.then(() => true),
      timeoutMs,
      false
    );
  }

  private handleDaemonFailure(state: LifecycleCommandState, exitCode: number): void {
    state.startupState = 'failed';
    state.shouldRunShutdown = false;

    if (!state.command.allowFailure) {
      const exitDescription =
        exitCode === 0
          ? 'exited immediately with code 0. Consider using mode: "run" if this is not a long-running process.'
          : `exited immediately with exit code ${exitCode}.`;
      throw new Error(`Lifecycle daemon "${state.command.title}" ${exitDescription}`);
    }

    const exitDescription =
      exitCode === 0
        ? 'exited immediately with code 0. Consider using mode: "run" if this is not a long-running process.'
        : `exited immediately with exit code ${exitCode}, but failure is allowed.`;
    warn(`Lifecycle daemon "${state.command.title}" ${exitDescription}`);
  }

  private shouldRunCheck(command: LifecycleCommand, mode: LifecycleMode): boolean {
    return Boolean(command.check && (command.shutdown || mode === 'daemon'));
  }

  private resolveCwd(command: Pick<LifecycleCommand, 'workingDirectory'>): string {
    return command.workingDirectory
      ? path.resolve(this.baseDir, command.workingDirectory)
      : this.baseDir;
  }

  private spawnDaemon(command: LifecycleCommand): Bun.Subprocess<'ignore', 'pipe', 'pipe'> {
    const proc = Bun.spawn(getShellCommand(command.command), {
      cwd: this.resolveCwd(command),
      detached: true,
      env: {
        ...process.env,
        ...(command.env ?? {}),
      },
      // Process-group signaling here uses Unix semantics. tim does not target Windows.
      // Lifecycle hooks are fully automated and must not compete with the agent loop for stdin.
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    void readOutput(proc.stdout, writeStdout).catch((err) => {
      warn(`Failed to read stdout for lifecycle daemon "${command.title}": ${err as Error}`);
    });
    void readOutput(proc.stderr, writeStderr).catch((err) => {
      warn(`Failed to read stderr for lifecycle daemon "${command.title}": ${err as Error}`);
    });

    return proc;
  }

  private async handleEarlyDaemonExit(state: LifecycleCommandState): Promise<boolean> {
    const daemon = state.daemon;
    if (!daemon) {
      return false;
    }

    await wait(DAEMON_STARTUP_CHECK_DELAY_MS);
    const exitCode = daemon.exitCode;
    if (exitCode === null) {
      return false;
    }

    this.handleDaemonFailure(state, exitCode);
    return true;
  }

  private async runShellCommand(
    commandConfig: Pick<LifecycleCommand, 'workingDirectory' | 'env'>,
    command: {
      command: string;
    }
  ): Promise<number> {
    const proc = Bun.spawn(getShellCommand(command.command), {
      cwd: this.resolveCwd(commandConfig),
      env: {
        ...process.env,
        ...(commandConfig.env ?? {}),
      },
      // Lifecycle hooks are fully automated and must not compete with the agent loop for stdin.
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    await Promise.all([readOutput(proc.stdout, writeStdout), readOutput(proc.stderr, writeStderr)]);
    return await proc.exited;
  }

  private isProcessRunning(proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>): boolean {
    return proc.exitCode === null;
  }

  private async raceWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    timeoutValue: T
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      return await Promise.race([
        promise,
        new Promise<T>((resolve) => {
          timer = setTimeout(() => resolve(timeoutValue), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  private async stopDaemon(state: LifecycleCommandState): Promise<void> {
    const proc = state.daemon;
    if (!proc || !this.isProcessRunning(proc)) {
      return;
    }

    state.intentionallyTerminated = true;

    if (!state.killedByCleanup) {
      if (
        !this.tryKillProcess(
          proc,
          'SIGTERM',
          state.command.title,
          'Failed to send SIGTERM to lifecycle daemon (tried process group and direct signal)'
        )
      ) {
        if (!this.isProcessRunning(proc)) {
          return;
        }
        throw new Error(
          `Failed to terminate lifecycle daemon "${state.command.title}" with SIGTERM.`
        );
      }
    }

    const exitedAfterSigterm = await this.waitForProcessExit(proc, DAEMON_SIGTERM_TIMEOUT_MS);
    if (exitedAfterSigterm) {
      return;
    }

    warn(`Lifecycle daemon "${state.command.title}" did not exit after SIGTERM; sending SIGKILL.`);
    if (!this.isProcessRunning(proc)) {
      return;
    }
    if (
      !this.tryKillProcess(proc, 'SIGKILL', state.command.title, 'Failed to kill lifecycle daemon')
    ) {
      throw new Error(`Failed to kill lifecycle daemon "${state.command.title}" with SIGKILL.`);
    }

    const exitedAfterSigkill = await this.raceWithTimeout(
      proc.exited.then(() => true),
      DAEMON_SIGKILL_WAIT_MS,
      false
    );
    if (!exitedAfterSigkill && this.isProcessRunning(proc)) {
      throw new Error(`Lifecycle daemon "${state.command.title}" did not exit after SIGKILL.`);
    }
  }
}
