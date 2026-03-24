import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { LifecycleManager } from './lifecycle.js';
import type { LifecycleCommand } from './configSchema.js';
import type { WorkspaceType } from './db/workspace.js';

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

describe('LifecycleManager', () => {
  let tempDir: string;
  let logFile: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-lifecycle-test-'));
    logFile = path.join(tempDir, 'events.log');
  });

  afterEach(async () => {
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

  test('shutdown continues after shutdown command failures', async () => {
    const events = await startupAndShutdown([
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
    ]);

    expect(events).toEqual(['first', 'second', 'second-stop']);
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
});
