import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as logging from '../logging.js';
import { LifecycleManager } from './lifecycle.js';
import type { LifecycleCommand } from './configSchema.js';
import type { WorkspaceType } from './db/workspace.js';
import { resetShutdownState, setShuttingDown } from './shutdown_state.js';

async function readLines(filePath: string): Promise<string[]> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}

async function waitForLine(
  filePath: string,
  expectedLine: string,
  timeoutMs = 1000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lines = await readLines(filePath);
    if (lines.includes(expectedLine)) {
      return;
    }

    await Bun.sleep(25);
  }

  throw new Error(`Timed out waiting for line "${expectedLine}" in ${filePath}`);
}

function appendLineCommand(filePath: string, line: string): string {
  return `printf '${line}\\n' >> ${JSON.stringify(filePath)}`;
}

async function createDaemonCommand(
  filePath: string,
  startLine: string,
  termLine: string
): Promise<string> {
  const scriptPath = path.join(path.dirname(filePath), `${startLine}.cjs`);
  await fs.writeFile(
    scriptPath,
    [
      `const fs = require('node:fs');`,
      `fs.appendFileSync(${JSON.stringify(filePath)}, ${JSON.stringify(startLine + '\n')});`,
      `process.on('SIGTERM', () => {`,
      `  fs.appendFileSync(${JSON.stringify(filePath)}, ${JSON.stringify(termLine + '\n')});`,
      `  process.exit(0);`,
      `});`,
      `setInterval(() => {}, 1000);`,
    ].join('\n'),
    'utf8'
  );
  return `exec node ${JSON.stringify(scriptPath)}`;
}

async function createStubbornDaemonCommand(
  filePath: string,
  pidFilePath: string,
  startLine: string,
  termLine: string
): Promise<string> {
  const scriptPath = path.join(path.dirname(filePath), `${startLine}.cjs`);
  await fs.writeFile(
    scriptPath,
    [
      `const fs = require('node:fs');`,
      `fs.writeFileSync(${JSON.stringify(pidFilePath)}, String(process.pid));`,
      `fs.appendFileSync(${JSON.stringify(filePath)}, ${JSON.stringify(startLine + '\n')});`,
      `process.on('SIGTERM', () => {`,
      `  fs.appendFileSync(${JSON.stringify(filePath)}, ${JSON.stringify(termLine + '\n')});`,
      `});`,
      `setInterval(() => {}, 1000);`,
    ].join('\n'),
    'utf8'
  );
  return `exec node ${JSON.stringify(scriptPath)}`;
}

async function createNonExecDaemonWithChildCommand(
  filePath: string,
  launcherPidFilePath: string,
  childPidFilePath: string,
  launcherStartLine: string,
  childStartLine: string
): Promise<string> {
  const childScriptPath = path.join(path.dirname(filePath), `${childStartLine}.cjs`);
  await fs.writeFile(
    childScriptPath,
    [
      `const fs = require('node:fs');`,
      `fs.writeFileSync(${JSON.stringify(childPidFilePath)}, String(process.pid));`,
      `fs.appendFileSync(${JSON.stringify(filePath)}, ${JSON.stringify(childStartLine + '\n')});`,
      `setInterval(() => {}, 1000);`,
    ].join('\n'),
    'utf8'
  );

  const launcherScriptPath = path.join(path.dirname(filePath), `${launcherStartLine}.cjs`);
  await fs.writeFile(
    launcherScriptPath,
    [
      `const fs = require('node:fs');`,
      `const { spawn } = require('node:child_process');`,
      `fs.writeFileSync(${JSON.stringify(launcherPidFilePath)}, String(process.pid));`,
      `fs.appendFileSync(${JSON.stringify(filePath)}, ${JSON.stringify(launcherStartLine + '\n')});`,
      `spawn(process.execPath, [${JSON.stringify(childScriptPath)}], { stdio: 'ignore' });`,
      `setInterval(() => {}, 1000);`,
    ].join('\n'),
    'utf8'
  );

  return `node ${JSON.stringify(launcherScriptPath)}`;
}

async function createImmediateExitDaemonCommand(
  filePath: string,
  exitCode: number,
  line?: string
): Promise<string> {
  const scriptPath = path.join(path.dirname(filePath), `immediate-exit-${exitCode}.cjs`);
  await fs.writeFile(
    scriptPath,
    [
      `const fs = require('node:fs');`,
      ...(line
        ? [`fs.appendFileSync(${JSON.stringify(filePath)}, ${JSON.stringify(line + '\n')});`]
        : []),
      `process.exit(${exitCode});`,
    ].join('\n'),
    'utf8'
  );
  return `exec node ${JSON.stringify(scriptPath)}`;
}

async function createDelayedExitDaemonCommand(
  filePath: string,
  exitCode: number,
  delayMs: number,
  startLine: string
): Promise<string> {
  const scriptPath = path.join(path.dirname(filePath), `delayed-exit-${exitCode}-${delayMs}.cjs`);
  await fs.writeFile(
    scriptPath,
    [
      `const fs = require('node:fs');`,
      `fs.appendFileSync(${JSON.stringify(filePath)}, ${JSON.stringify(startLine + '\n')});`,
      `setTimeout(() => process.exit(${exitCode}), ${delayMs});`,
      `setInterval(() => {}, 1000);`,
    ].join('\n'),
    'utf8'
  );
  return `exec node ${JSON.stringify(scriptPath)}`;
}

async function createHangingShutdownCommand(
  filePath: string,
  pidFilePath: string,
  startLine: string,
  termLine: string
): Promise<string> {
  const scriptPath = path.join(path.dirname(filePath), `${startLine}.cjs`);
  await fs.writeFile(
    scriptPath,
    [
      `const fs = require('node:fs');`,
      `fs.writeFileSync(${JSON.stringify(pidFilePath)}, String(process.pid));`,
      `fs.appendFileSync(${JSON.stringify(filePath)}, ${JSON.stringify(startLine + '\n')});`,
      `process.on('SIGTERM', () => {`,
      `  fs.appendFileSync(${JSON.stringify(filePath)}, ${JSON.stringify(termLine + '\n')});`,
      `});`,
      `setInterval(() => {}, 1000);`,
    ].join('\n'),
    'utf8'
  );
  return `exec node ${JSON.stringify(scriptPath)}`;
}

async function createHangingShutdownWithChildCommand(
  filePath: string,
  launcherPidFilePath: string,
  childPidFilePath: string,
  launcherStartLine: string,
  childStartLine: string
): Promise<string> {
  const childScriptPath = path.join(path.dirname(filePath), `${childStartLine}.cjs`);
  await fs.writeFile(
    childScriptPath,
    [
      `const fs = require('node:fs');`,
      `fs.writeFileSync(${JSON.stringify(childPidFilePath)}, String(process.pid));`,
      `fs.appendFileSync(${JSON.stringify(filePath)}, ${JSON.stringify(childStartLine + '\n')});`,
      `setInterval(() => {}, 1000);`,
    ].join('\n'),
    'utf8'
  );

  const launcherScriptPath = path.join(path.dirname(filePath), `${launcherStartLine}.cjs`);
  await fs.writeFile(
    launcherScriptPath,
    [
      `const fs = require('node:fs');`,
      `const { spawn } = require('node:child_process');`,
      `fs.writeFileSync(${JSON.stringify(launcherPidFilePath)}, String(process.pid));`,
      `fs.appendFileSync(${JSON.stringify(filePath)}, ${JSON.stringify(launcherStartLine + '\n')});`,
      `spawn(process.execPath, [${JSON.stringify(childScriptPath)}], { stdio: 'ignore' });`,
      `setInterval(() => {}, 1000);`,
    ].join('\n'),
    'utf8'
  );

  // Intentionally NOT using `exec` — the test needs a shell wrapper + child process
  // tree to verify that process group cleanup kills the entire tree, not just the shell.
  return `node ${JSON.stringify(launcherScriptPath)}`;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const errorWithCode = err as NodeJS.ErrnoException;
    if (errorWithCode.code === 'ESRCH') {
      return false;
    }
    throw err;
  }
}

describe('LifecycleManager', () => {
  let tempDir: string;
  let logFile: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-lifecycle-test-'));
    logFile = path.join(tempDir, 'events.log');
  });

  afterEach(async () => {
    resetShutdownState();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function startupAndShutdown(
    commands: LifecycleCommand[],
    workspaceType?: WorkspaceType
  ): Promise<string[]> {
    const manager = new LifecycleManager(commands, tempDir, workspaceType);
    await manager.startup();
    await manager.shutdown();
    return await readLines(logFile);
  }

  test('run commands execute in config order and shutdown runs in reverse order', async () => {
    const events = await startupAndShutdown([
      {
        title: 'first',
        command: appendLineCommand(logFile, 'start-1'),
        shutdown: appendLineCommand(logFile, 'stop-1'),
      },
      {
        title: 'second',
        command: appendLineCommand(logFile, 'start-2'),
        shutdown: appendLineCommand(logFile, 'stop-2'),
      },
    ]);

    expect(events).toEqual(['start-1', 'start-2', 'stop-2', 'stop-1']);
  });

  test('daemon commands are spawned and terminated during shutdown', async () => {
    const manager = new LifecycleManager(
      [
        {
          title: 'daemon',
          command: await createDaemonCommand(logFile, 'daemon-start', 'daemon-term'),
          mode: 'daemon',
        },
      ],
      tempDir,
      undefined
    );

    await manager.startup();
    await Bun.sleep(100);
    expect(await readLines(logFile)).toContain('daemon-start');

    await manager.shutdown();
    const events = await readLines(logFile);
    expect(events).toContain('daemon-term');
  });

  test('daemon startup fails when the process exits immediately with a non-zero code', async () => {
    const manager = new LifecycleManager(
      [
        {
          title: 'failing daemon',
          command: await createImmediateExitDaemonCommand(logFile, 7),
          mode: 'daemon',
        },
      ],
      tempDir,
      undefined
    );

    await expect(manager.startup()).rejects.toThrow(
      'Lifecycle daemon "failing daemon" exited immediately with exit code 7.'
    );
  });

  test('daemon immediate exit is tolerated when allowFailure is true', async () => {
    const events = await startupAndShutdown([
      {
        title: 'allowed daemon failure',
        command: await createImmediateExitDaemonCommand(logFile, 9),
        mode: 'daemon',
        allowFailure: true,
        shutdown: appendLineCommand(logFile, 'daemon-stop'),
      },
      {
        title: 'after',
        command: appendLineCommand(logFile, 'after'),
      },
    ]);

    expect(events).toEqual(['after']);
  });

  test('daemon that fails immediately does not trigger shutdown', async () => {
    const manager = new LifecycleManager(
      [
        {
          title: 'failing daemon',
          command: await createImmediateExitDaemonCommand(logFile, 5),
          mode: 'daemon',
          allowFailure: true,
          shutdown: appendLineCommand(logFile, 'daemon-stop'),
        },
      ],
      tempDir,
      undefined
    );

    await manager.startup();
    await manager.shutdown();

    expect(await readLines(logFile)).toEqual([]);
  });

  test('daemon exit with code 0 is treated as a startup failure and does not trigger shutdown', async () => {
    const warnSpy = spyOn(logging, 'warn').mockImplementation(() => {});

    try {
      const manager = new LifecycleManager(
        [
          {
            title: 'short daemon',
            command: await createImmediateExitDaemonCommand(logFile, 0),
            mode: 'daemon',
            shutdown: appendLineCommand(logFile, 'daemon-stop'),
          },
        ],
        tempDir,
        undefined
      );

      await expect(manager.startup()).rejects.toThrow(
        'Lifecycle daemon "short daemon" exited immediately with code 0. Consider using mode: "run" if this is not a long-running process.'
      );
      await manager.shutdown();

      expect(await readLines(logFile)).toEqual([]);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('daemon exit with code 0 respects allowFailure and still suppresses shutdown', async () => {
    const warnSpy = spyOn(logging, 'warn').mockImplementation(() => {});

    try {
      const manager = new LifecycleManager(
        [
          {
            title: 'short daemon',
            command: await createImmediateExitDaemonCommand(logFile, 0),
            mode: 'daemon',
            allowFailure: true,
            shutdown: appendLineCommand(logFile, 'daemon-stop'),
          },
          {
            title: 'after',
            command: appendLineCommand(logFile, 'after'),
          },
        ],
        tempDir,
        undefined
      );

      await manager.startup();
      await manager.shutdown();

      expect(await readLines(logFile)).toEqual(['after']);
      expect(warnSpy).toHaveBeenCalledWith(
        'Lifecycle daemon "short daemon" exited immediately with code 0. Consider using mode: "run" if this is not a long-running process.'
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('run command failures are tolerated when allowFailure is true', async () => {
    const events = await startupAndShutdown([
      {
        title: 'allowed failure',
        command: `sh -c "exit 3"`,
        allowFailure: true,
      },
      {
        title: 'after',
        command: appendLineCommand(logFile, 'after'),
      },
    ]);

    expect(events).toEqual(['after']);
  });

  test('run command failures abort startup when allowFailure is false', async () => {
    const manager = new LifecycleManager(
      [
        {
          title: 'before',
          command: appendLineCommand(logFile, 'before'),
          shutdown: appendLineCommand(logFile, 'before-stop'),
        },
        {
          title: 'failing',
          command: 'exit 2',
        },
      ],
      tempDir,
      undefined
    );

    await expect(manager.startup()).rejects.toThrow('Lifecycle command "failing" failed');
    await manager.shutdown();

    expect(await readLines(logFile)).toEqual(['before', 'before-stop']);
  });

  test('run command with shutdown that fails still runs shutdown when failure is not allowed', async () => {
    const manager = new LifecycleManager(
      [
        {
          title: 'seed',
          command: 'exit 2',
          shutdown: appendLineCommand(logFile, 'seed-stop'),
        },
      ],
      tempDir,
      undefined
    );

    await expect(manager.startup()).rejects.toThrow('Lifecycle command "seed" failed');
    await manager.shutdown();

    expect(await readLines(logFile)).toEqual(['seed-stop']);
  });

  test('run command with shutdown that fails still runs shutdown when failure is allowed', async () => {
    const manager = new LifecycleManager(
      [
        {
          title: 'seed',
          command: 'exit 2',
          shutdown: appendLineCommand(logFile, 'seed-stop'),
          allowFailure: true,
        },
        {
          title: 'after',
          command: appendLineCommand(logFile, 'after'),
        },
      ],
      tempDir,
      undefined
    );

    await manager.startup();
    await manager.shutdown();

    expect(await readLines(logFile)).toEqual(['after', 'seed-stop']);
  });

  test('run command shutdown still runs if shutdown starts while the startup command is in flight', async () => {
    const manager = new LifecycleManager(
      [
        {
          title: 'seed',
          command: `${appendLineCommand(logFile, 'seed-start')}; sleep 0.2; ${appendLineCommand(logFile, 'seed-end')}`,
          shutdown: appendLineCommand(logFile, 'seed-stop'),
        },
      ],
      tempDir,
      undefined
    );

    const startupPromise = manager.startup();
    await waitForLine(logFile, 'seed-start');
    setShuttingDown(130);
    await manager.shutdown();
    await startupPromise;

    expect(await readLines(logFile)).toEqual(['seed-start', 'seed-stop', 'seed-end']);
  });

  test('workingDirectory is resolved relative to the lifecycle base directory', async () => {
    const subdir = path.join(tempDir, 'subdir');
    await fs.mkdir(subdir);
    const realSubdir = await fs.realpath(subdir);

    await startupAndShutdown([
      {
        title: 'pwd',
        command: `pwd >> ${JSON.stringify(logFile)}`,
        workingDirectory: 'subdir',
      },
    ]);

    expect(await readLines(logFile)).toEqual([realSubdir]);
  });

  test('env variables are passed to lifecycle commands', async () => {
    await startupAndShutdown([
      {
        title: 'env',
        command: `echo "$MY_VAR" >> ${JSON.stringify(logFile)}`,
        env: {
          MY_VAR: 'test-value',
        },
      },
    ]);

    expect(await readLines(logFile)).toEqual(['test-value']);
  });

  test('spawn-time startup failures respect allowFailure for run commands', async () => {
    const missingDir = path.join(tempDir, 'missing-dir');
    const events = await startupAndShutdown([
      {
        title: 'allowed missing cwd',
        command: appendLineCommand(logFile, 'should-not-run'),
        workingDirectory: missingDir,
        allowFailure: true,
      },
      {
        title: 'after',
        command: appendLineCommand(logFile, 'after'),
      },
    ]);

    expect(events).toEqual(['after']);
  });

  test('spawn-time startup failures still throw when allowFailure is false', async () => {
    const manager = new LifecycleManager(
      [
        {
          title: 'missing cwd',
          command: appendLineCommand(logFile, 'never'),
          workingDirectory: path.join(tempDir, 'missing-dir'),
        },
      ],
      tempDir,
      undefined
    );

    await expect(manager.startup()).rejects.toThrow();
  });

  test('spawn-time startup failures respect allowFailure for daemon commands', async () => {
    const events = await startupAndShutdown([
      {
        title: 'allowed missing cwd daemon',
        command: 'node -e "setInterval(() => {}, 1000)"',
        mode: 'daemon',
        workingDirectory: path.join(tempDir, 'missing-daemon-dir'),
        allowFailure: true,
        shutdown: appendLineCommand(logFile, 'daemon-stop'),
      },
      {
        title: 'after',
        command: appendLineCommand(logFile, 'after'),
      },
    ]);

    expect(events).toEqual(['after']);
  });

  test('shutdown still cleans up previously started daemons after startup aborts', async () => {
    const manager = new LifecycleManager(
      [
        {
          title: 'daemon',
          command: await createDaemonCommand(logFile, 'daemon-start', 'daemon-term'),
          mode: 'daemon',
        },
        {
          title: 'failing',
          command: 'exit 2',
        },
      ],
      tempDir,
      undefined
    );

    await expect(manager.startup()).rejects.toThrow('Lifecycle command "failing" failed');
    await waitForLine(logFile, 'daemon-start');
    await manager.shutdown();

    expect(await readLines(logFile)).toEqual(['daemon-start', 'daemon-term']);
  });

  test('successful check skips daemon startup and suppresses shutdown', async () => {
    const events = await startupAndShutdown([
      {
        title: 'daemon',
        command: await createDaemonCommand(logFile, 'daemon-start', 'daemon-term'),
        mode: 'daemon',
        check: 'exit 0',
        shutdown: appendLineCommand(logFile, 'daemon-stop'),
      },
    ]);

    expect(events).toEqual([]);
  });

  test('successful check skips daemon startup even without an explicit shutdown command', async () => {
    const events = await startupAndShutdown([
      {
        title: 'daemon',
        command: await createDaemonCommand(logFile, 'daemon-start', 'daemon-term'),
        mode: 'daemon',
        check: 'exit 0',
      },
    ]);

    expect(events).toEqual([]);
  });

  test('successful check skips run startup and shutdown when shutdown exists', async () => {
    const events = await startupAndShutdown([
      {
        title: 'seed',
        command: appendLineCommand(logFile, 'seed'),
        check: 'exit 0',
        shutdown: appendLineCommand(logFile, 'seed-reset'),
      },
    ]);

    expect(events).toEqual([]);
  });

  test('failed check allows command execution to proceed', async () => {
    const events = await startupAndShutdown([
      {
        title: 'seed',
        command: appendLineCommand(logFile, 'seed'),
        check: 'exit 1',
        shutdown: appendLineCommand(logFile, 'seed-reset'),
      },
    ]);

    expect(events).toEqual(['seed', 'seed-reset']);
  });

  test('shutdown requested during a check prevents the startup command from running', async () => {
    const manager = new LifecycleManager(
      [
        {
          title: 'seed',
          command: appendLineCommand(logFile, 'seed'),
          check: `${appendLineCommand(logFile, 'check-start')}; sleep 0.2`,
          shutdown: appendLineCommand(logFile, 'seed-reset'),
        },
      ],
      tempDir,
      undefined
    );

    const startupPromise = manager.startup();
    await waitForLine(logFile, 'check-start');
    setShuttingDown(130);
    await startupPromise;
    await manager.shutdown();

    expect(await readLines(logFile)).toEqual(['check-start']);
  });

  test('check is ignored for run commands without shutdown behavior', async () => {
    const events = await startupAndShutdown([
      {
        title: 'plain run',
        command: appendLineCommand(logFile, 'plain-run'),
        check: 'exit 0',
      },
    ]);

    expect(events).toEqual(['plain-run']);
  });

  test('onlyWorkspaceType skips commands when workspace type does not match', async () => {
    const events = await startupAndShutdown(
      [
        {
          title: 'auto only',
          command: appendLineCommand(logFile, 'auto'),
          shutdown: appendLineCommand(logFile, 'auto-stop'),
          onlyWorkspaceType: 'auto',
        },
      ],
      'primary'
    );

    expect(events).toEqual([]);
  });

  test('onlyWorkspaceType skips commands when there is no workspace', async () => {
    const events = await startupAndShutdown([
      {
        title: 'primary only',
        command: appendLineCommand(logFile, 'primary'),
        shutdown: appendLineCommand(logFile, 'primary-stop'),
        onlyWorkspaceType: 'primary',
      },
    ]);

    expect(events).toEqual([]);
  });

  test('onlyWorkspaceType allows matching workspaces', async () => {
    const events = await startupAndShutdown(
      [
        {
          title: 'auto only',
          command: appendLineCommand(logFile, 'auto'),
          shutdown: appendLineCommand(logFile, 'auto-stop'),
          onlyWorkspaceType: 'auto',
        },
      ],
      'auto'
    );

    expect(events).toEqual(['auto', 'auto-stop']);
  });

  test('daemon shutdown command runs before the daemon is terminated', async () => {
    const manager = new LifecycleManager(
      [
        {
          title: 'daemon',
          command: await createDaemonCommand(logFile, 'daemon-start', 'daemon-term'),
          mode: 'daemon',
          shutdown: appendLineCommand(logFile, 'daemon-stop'),
        },
      ],
      tempDir,
      undefined
    );

    await manager.startup();
    await Bun.sleep(100);
    await manager.shutdown();

    expect(await readLines(logFile)).toEqual(['daemon-start', 'daemon-stop', 'daemon-term']);
  });

  test('daemon shutdown sends SIGKILL after timeout when SIGTERM does not stop the process', async () => {
    const pidFile = path.join(tempDir, 'stubborn.pid');
    const manager = new LifecycleManager(
      [
        {
          title: 'stubborn daemon',
          command: await createStubbornDaemonCommand(
            logFile,
            pidFile,
            'stubborn-start',
            'stubborn-sigterm'
          ),
          mode: 'daemon',
        },
      ],
      tempDir,
      undefined
    );

    await manager.startup();
    await waitForLine(logFile, 'stubborn-start');
    const pid = Number.parseInt(await fs.readFile(pidFile, 'utf8'), 10);

    await manager.shutdown();

    const events = await readLines(logFile);
    expect(events).toContain('stubborn-start');
    expect(events).toContain('stubborn-sigterm');
    expect(processExists(pid)).toBeFalse();
  }, 10000);

  test('warns when a running daemon exits unexpectedly later', async () => {
    const warnSpy = spyOn(logging, 'warn').mockImplementation(() => {});

    try {
      const manager = new LifecycleManager(
        [
          {
            title: 'flaky daemon',
            command: await createDelayedExitDaemonCommand(logFile, 12, 150, 'flaky-start'),
            mode: 'daemon',
            shutdown: appendLineCommand(logFile, 'flaky-stop'),
          },
        ],
        tempDir,
        undefined
      );

      await manager.startup();
      await waitForLine(logFile, 'flaky-start');
      await Bun.sleep(300);
      await manager.shutdown();

      expect(warnSpy).toHaveBeenCalledWith(
        'Lifecycle daemon "flaky daemon" exited unexpectedly with code 12.'
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('warns when a running daemon exits unexpectedly later with code 0', async () => {
    const warnSpy = spyOn(logging, 'warn').mockImplementation(() => {});

    try {
      const manager = new LifecycleManager(
        [
          {
            title: 'clean-exit daemon',
            command: await createDelayedExitDaemonCommand(logFile, 0, 150, 'clean-start'),
            mode: 'daemon',
            shutdown: appendLineCommand(logFile, 'clean-stop'),
          },
        ],
        tempDir,
        undefined
      );

      await manager.startup();
      await waitForLine(logFile, 'clean-start');
      await Bun.sleep(300);
      await manager.shutdown();

      expect(warnSpy).toHaveBeenCalledWith(
        'Lifecycle daemon "clean-exit daemon" exited unexpectedly with code 0.'
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  test('daemon shutdown kills non-exec child processes via the daemon process group', async () => {
    const launcherPidFile = path.join(tempDir, 'launcher.pid');
    const childPidFile = path.join(tempDir, 'child.pid');
    const manager = new LifecycleManager(
      [
        {
          title: 'daemon with child',
          command: await createNonExecDaemonWithChildCommand(
            logFile,
            launcherPidFile,
            childPidFile,
            'launcher-start',
            'child-start'
          ),
          mode: 'daemon',
        },
      ],
      tempDir,
      undefined
    );

    await manager.startup();
    await waitForLine(logFile, 'launcher-start');
    await waitForLine(logFile, 'child-start');

    const launcherPid = Number.parseInt(await fs.readFile(launcherPidFile, 'utf8'), 10);
    const childPid = Number.parseInt(await fs.readFile(childPidFile, 'utf8'), 10);

    await manager.shutdown();
    await Bun.sleep(200);

    expect(processExists(launcherPid)).toBeFalse();
    expect(processExists(childPid)).toBeFalse();
  }, 10000);

  test('shutdown continues after shutdown command failures and reports errors', async () => {
    const manager = new LifecycleManager(
      [
        {
          title: 'first',
          command: appendLineCommand(logFile, 'first'),
          shutdown: 'exit 4',
        },
        {
          title: 'second',
          command: appendLineCommand(logFile, 'second'),
          shutdown: appendLineCommand(logFile, 'second-stop'),
        },
      ],
      tempDir,
      undefined
    );
    await manager.startup();

    // shutdown() should throw with the aggregated errors but still run all shutdown commands
    await expect(manager.shutdown()).rejects.toThrow('Lifecycle shutdown had 1 failure(s)');

    const events = await readLines(logFile);
    // second-stop still ran despite first's shutdown failing
    expect(events).toEqual(['first', 'second', 'second-stop']);
  });

  test('shutdown command timeout kills the hanging shutdown process and continues cleanup', async () => {
    const hangingPidFile = path.join(tempDir, 'hanging-shutdown.pid');
    const manager = new LifecycleManager(
      [
        {
          title: 'before',
          command: appendLineCommand(logFile, 'before'),
          shutdown: appendLineCommand(logFile, 'before-stop'),
        },
        {
          title: 'hanging',
          command: appendLineCommand(logFile, 'hanging-startup'),
          shutdown: await createHangingShutdownCommand(
            logFile,
            hangingPidFile,
            'hanging-stop-start',
            'hanging-stop-sigterm'
          ),
        },
      ],
      tempDir,
      undefined,
      100
    );
    await manager.startup();

    await expect(manager.shutdown()).rejects.toThrow('Lifecycle shutdown had 1 failure(s)');

    const hangingPid = Number.parseInt(await fs.readFile(hangingPidFile, 'utf8'), 10);
    expect(processExists(hangingPid)).toBeFalse();
    expect(await readLines(logFile)).toEqual([
      'before',
      'hanging-startup',
      'hanging-stop-start',
      'hanging-stop-sigterm',
      'before-stop',
    ]);
  }, 10000);

  test('shutdown timeout kills both the shutdown wrapper and its child process', async () => {
    const launcherPidFile = path.join(tempDir, 'hanging-shutdown-launcher.pid');
    const childPidFile = path.join(tempDir, 'hanging-shutdown-child.pid');
    const manager = new LifecycleManager(
      [
        {
          title: 'hanging with child',
          command: appendLineCommand(logFile, 'start'),
          shutdown: await createHangingShutdownWithChildCommand(
            logFile,
            launcherPidFile,
            childPidFile,
            'shutdown-launcher-start',
            'shutdown-child-start'
          ),
        },
      ],
      tempDir,
      undefined,
      200
    );
    await manager.startup();

    await expect(manager.shutdown()).rejects.toThrow('Lifecycle shutdown had 1 failure(s)');

    const launcherPid = Number.parseInt(await fs.readFile(launcherPidFile, 'utf8'), 10);
    const childPid = Number.parseInt(await fs.readFile(childPidFile, 'utf8'), 10);
    await Bun.sleep(200);

    expect(processExists(launcherPid)).toBeFalse();
    expect(processExists(childPid)).toBeFalse();
    expect(await readLines(logFile)).toEqual([
      'start',
      'shutdown-launcher-start',
      'shutdown-child-start',
    ]);
  }, 10000);

  test('killDaemons kills the active shutdown command process', async () => {
    const hangingPidFile = path.join(tempDir, 'active-shutdown.pid');
    const manager = new LifecycleManager(
      [
        {
          title: 'hanging',
          command: appendLineCommand(logFile, 'start'),
          shutdown: await createHangingShutdownCommand(
            logFile,
            hangingPidFile,
            'shutdown-start',
            'shutdown-sigterm'
          ),
        },
      ],
      tempDir,
      undefined,
      5000
    );
    await manager.startup();

    const shutdownPromise = manager.shutdown();
    await waitForLine(logFile, 'shutdown-start');
    manager.killDaemons();

    await expect(shutdownPromise).rejects.toThrow('Lifecycle shutdown had 1 failure(s)');

    const hangingPid = Number.parseInt(await fs.readFile(hangingPidFile, 'utf8'), 10);
    expect(processExists(hangingPid)).toBeFalse();
    expect(await readLines(logFile)).toEqual(['start', 'shutdown-start']);
  }, 10000);

  test('killDaemons kills both the active shutdown wrapper and its child process', async () => {
    const launcherPidFile = path.join(tempDir, 'active-shutdown-launcher.pid');
    const childPidFile = path.join(tempDir, 'active-shutdown-child.pid');
    const manager = new LifecycleManager(
      [
        {
          title: 'hanging with child',
          command: appendLineCommand(logFile, 'start'),
          shutdown: await createHangingShutdownWithChildCommand(
            logFile,
            launcherPidFile,
            childPidFile,
            'shutdown-launcher-start',
            'shutdown-child-start'
          ),
        },
      ],
      tempDir,
      undefined,
      5000
    );
    await manager.startup();

    const shutdownPromise = manager.shutdown();
    await waitForLine(logFile, 'shutdown-launcher-start');
    await waitForLine(logFile, 'shutdown-child-start');
    manager.killDaemons();

    await expect(shutdownPromise).rejects.toThrow('Lifecycle shutdown had 1 failure(s)');

    const launcherPid = Number.parseInt(await fs.readFile(launcherPidFile, 'utf8'), 10);
    const childPid = Number.parseInt(await fs.readFile(childPidFile, 'utf8'), 10);
    await Bun.sleep(200);

    expect(processExists(launcherPid)).toBeFalse();
    expect(processExists(childPid)).toBeFalse();
  }, 10000);

  test('killDaemons coordinates cleanly when it races the shutdown timeout', async () => {
    const launcherPidFile = path.join(tempDir, 'race-shutdown-launcher.pid');
    const childPidFile = path.join(tempDir, 'race-shutdown-child.pid');
    // Use a long timeout so killDaemons() always fires before the timeout,
    // making the race deterministic rather than timing-dependent.
    const manager = new LifecycleManager(
      [
        {
          title: 'hanging with child',
          command: appendLineCommand(logFile, 'start'),
          shutdown: await createHangingShutdownWithChildCommand(
            logFile,
            launcherPidFile,
            childPidFile,
            'shutdown-launcher-start',
            'shutdown-child-start'
          ),
        },
      ],
      tempDir,
      undefined,
      5000
    );
    await manager.startup();

    const shutdownPromise = manager.shutdown();
    await waitForLine(logFile, 'shutdown-launcher-start');
    await waitForLine(logFile, 'shutdown-child-start');
    manager.killDaemons();

    await expect(shutdownPromise).rejects.toThrow('Lifecycle shutdown had 1 failure(s)');

    const launcherPid = Number.parseInt(await fs.readFile(launcherPidFile, 'utf8'), 10);
    const childPid = Number.parseInt(await fs.readFile(childPidFile, 'utf8'), 10);
    await Bun.sleep(200);

    expect(processExists(launcherPid)).toBeFalse();
    expect(processExists(childPid)).toBeFalse();
  }, 10000);

  test('shutdown timeout override still allows normal shutdown commands to complete', async () => {
    const manager = new LifecycleManager(
      [
        {
          title: 'seed',
          command: appendLineCommand(logFile, 'seed'),
          shutdown: `${appendLineCommand(logFile, 'seed-stop')}; sleep 0.05`,
        },
      ],
      tempDir,
      undefined,
      200
    );

    await manager.startup();
    await manager.shutdown();

    expect(await readLines(logFile)).toEqual(['seed', 'seed-stop']);
  });

  test('shutdown reports daemon termination failures', async () => {
    const manager = new LifecycleManager(
      [
        {
          title: 'daemon',
          command: await createDaemonCommand(logFile, 'daemon-start', 'daemon-term'),
          mode: 'daemon',
        },
      ],
      tempDir,
      undefined
    );
    const tryKillProcessSpy = spyOn(manager as any, 'tryKillProcess').mockReturnValue(false);

    try {
      await manager.startup();
      await waitForLine(logFile, 'daemon-start');

      await expect(manager.shutdown()).rejects.toThrow(
        'Failed to terminate lifecycle daemon "daemon" with SIGTERM.'
      );
    } finally {
      tryKillProcessSpy.mockRestore();
      manager.killDaemons();
    }
  });

  test('shutdown is idempotent', async () => {
    const manager = new LifecycleManager(
      [
        {
          title: 'seed',
          command: appendLineCommand(logFile, 'seed'),
          shutdown: appendLineCommand(logFile, 'seed-stop'),
        },
      ],
      tempDir,
      undefined
    );

    await manager.startup();
    await manager.shutdown();
    await manager.shutdown();

    expect(await readLines(logFile)).toEqual(['seed', 'seed-stop']);
  });

  test('mixed command types execute together correctly', async () => {
    const manager = new LifecycleManager(
      [
        {
          title: 'setup',
          command: appendLineCommand(logFile, 'setup'),
          shutdown: appendLineCommand(logFile, 'setup-stop'),
        },
        {
          title: 'daemon',
          command: await createDaemonCommand(logFile, 'daemon-start', 'daemon-term'),
          mode: 'daemon',
        },
        {
          title: 'workspace filtered',
          command: appendLineCommand(logFile, 'workspace-only'),
          shutdown: appendLineCommand(logFile, 'workspace-only-stop'),
          onlyWorkspaceType: 'auto',
        },
      ],
      tempDir,
      'auto'
    );

    await manager.startup();
    await Bun.sleep(100);
    await manager.shutdown();

    const events = await readLines(logFile);
    expect(events).toContain('setup');
    expect(events).toContain('daemon-start');
    expect(events).toContain('workspace-only');
    expect(events).toContain('workspace-only-stop');
    expect(events).toContain('daemon-term');
    expect(events).toContain('setup-stop');
    expect(events.indexOf('workspace-only-stop')).toBeLessThan(events.indexOf('daemon-term'));
    expect(events.indexOf('daemon-term')).toBeLessThan(events.indexOf('setup-stop'));
  });

  test('killDaemons sends SIGTERM to active daemons', async () => {
    const manager = new LifecycleManager(
      [
        {
          title: 'daemon',
          command: await createDaemonCommand(logFile, 'daemon-start', 'daemon-term'),
          mode: 'daemon',
        },
      ],
      tempDir,
      undefined
    );

    await manager.startup();
    await Bun.sleep(100);
    manager.killDaemons();
    await Bun.sleep(200);

    expect(await readLines(logFile)).toContain('daemon-term');
  });

  test('killDaemons coordinates cleanly with async shutdown', async () => {
    const manager = new LifecycleManager(
      [
        {
          title: 'daemon',
          command: await createDaemonCommand(logFile, 'daemon-start', 'daemon-term'),
          mode: 'daemon',
        },
      ],
      tempDir,
      undefined
    );

    await manager.startup();
    await waitForLine(logFile, 'daemon-start');

    manager.killDaemons();
    await manager.shutdown();

    expect(await readLines(logFile)).toEqual(['daemon-start', 'daemon-term']);
  });

  test('empty command lists are a no-op', async () => {
    const manager = new LifecycleManager([], tempDir, undefined);

    await expect(manager.startup()).resolves.toBeUndefined();
    manager.killDaemons();
    await expect(manager.shutdown()).resolves.toBeUndefined();
  });

  test('check spawn failure with good command still runs the command', async () => {
    const manager = new LifecycleManager(
      [
        {
          title: 'seed',
          command: appendLineCommand(logFile, 'seed'),
          // check references a nonexistent binary that will cause spawn to fail or return non-zero
          check: '/nonexistent-binary-zzz 2>/dev/null',
          shutdown: appendLineCommand(logFile, 'seed-reset'),
        },
      ],
      tempDir,
      undefined
    );

    await manager.startup();
    await manager.shutdown();

    // Check returned non-zero (command not found), so command proceeds
    const events = await readLines(logFile);
    expect(events).toEqual(['seed', 'seed-reset']);
  });
});
