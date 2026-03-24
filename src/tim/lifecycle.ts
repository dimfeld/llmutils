import path from 'node:path';
import { error, log, warn, writeStderr, writeStdout } from '../logging.js';
import type { LifecycleCommand } from './configSchema.js';
import type { WorkspaceType } from './db/workspace.js';

type LifecycleMode = 'run' | 'daemon';
type StartupState = 'pending' | 'skipped' | 'succeeded' | 'failed' | 'running';

interface LifecycleCommandState {
  command: LifecycleCommand;
  mode: LifecycleMode;
  startupState: StartupState;
  shouldRunShutdown: boolean;
  daemon?: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
}

function getShellCommand(command: string): string[] {
  const isWindows = process.platform === 'win32';
  return isWindows ? ['cmd', '/c', command] : ['sh', '-c', command];
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
      const { command, mode } = state;

      if (command.onlyWorkspaceType && command.onlyWorkspaceType !== this.workspaceType) {
        state.startupState = 'skipped';
        log(
          `Skipping lifecycle command "${command.title}" because it only runs in ${command.onlyWorkspaceType} workspaces.`
        );
        continue;
      }

      if (this.shouldRunCheck(command, mode)) {
        const checkExitCode = await this.runShellCommand(command, {
          command: command.check!,
        });

        if (checkExitCode === 0) {
          state.startupState = 'skipped';
          log(`Skipping lifecycle command "${command.title}" because its check command succeeded.`);
          continue;
        }
      }

      if (mode === 'daemon') {
        log(`Starting lifecycle daemon "${command.title}"...`);
        const daemon = this.spawnDaemon(command);
        state.daemon = daemon;
        state.startupState = 'running';
        state.shouldRunShutdown = true;
        continue;
      }

      log(`Running lifecycle command "${command.title}"...`);
      const exitCode = await this.runShellCommand(command, {
        command: command.command,
      });
      state.shouldRunShutdown = Boolean(command.shutdown);

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

    for (const state of [...this.states].reverse()) {
      if (!state.shouldRunShutdown || state.startupState === 'skipped') {
        continue;
      }

      const { command, mode } = state;

      try {
        if (mode === 'daemon') {
          if (command.shutdown) {
            log(`Running lifecycle shutdown command "${command.title}"...`);
            const exitCode = await this.runShellCommand(command, {
              command: command.shutdown,
            });
            if (exitCode !== 0) {
              warn(
                `Lifecycle shutdown command "${command.title}" failed with exit code ${exitCode}.`
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
            warn(
              `Lifecycle shutdown command "${command.title}" failed with exit code ${exitCode}.`
            );
          }
        }
      } catch (err) {
        error(`Error while shutting down lifecycle command "${command.title}": ${err as Error}`);
      }
    }
  }

  killDaemons(): void {
    for (const state of this.states) {
      if (state.mode !== 'daemon' || !state.shouldRunShutdown || !state.daemon) {
        continue;
      }

      if (!this.isProcessRunning(state.daemon)) {
        continue;
      }

      try {
        state.daemon.kill('SIGTERM');
      } catch (err) {
        warn(`Failed to terminate lifecycle daemon "${state.command.title}": ${err as Error}`);
      }
    }
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
      env: {
        ...process.env,
        ...(command.env ?? {}),
      },
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
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    await Promise.all([readOutput(proc.stdout, writeStdout), readOutput(proc.stderr, writeStderr)]);
    return await proc.exited;
  }

  private isProcessRunning(proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>): boolean {
    return proc.exitCode === null;
  }

  private async stopDaemon(state: LifecycleCommandState): Promise<void> {
    const proc = state.daemon;
    if (!proc || !this.isProcessRunning(proc)) {
      return;
    }

    try {
      proc.kill('SIGTERM');
    } catch (err) {
      warn(`Failed to terminate lifecycle daemon "${state.command.title}": ${err as Error}`);
      return;
    }

    const exitedAfterSigterm = await Promise.race([
      proc.exited.then(() => true),
      wait(5000).then(() => false),
    ]);
    if (exitedAfterSigterm) {
      return;
    }

    warn(`Lifecycle daemon "${state.command.title}" did not exit after SIGTERM; sending SIGKILL.`);
    try {
      proc.kill('SIGKILL');
      await Promise.race([proc.exited, wait(1000)]);
    } catch (err) {
      warn(`Failed to kill lifecycle daemon "${state.command.title}": ${err as Error}`);
    }
  }
}
