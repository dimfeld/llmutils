import { describe, expect, test, vi } from 'vitest';

import {
  focusTerminalPane,
  openTerminalInDirectory,
  type TerminalControlDeps,
  type TerminalSessionTarget,
} from './terminal_control.js';

function createResult(
  overrides: Partial<Awaited<ReturnType<TerminalControlDeps['spawnAndLogOutput']>>> = {}
) {
  return {
    exitCode: 0,
    killedByInactivity: false,
    signal: null,
    stderr: '',
    stdout: '',
    ...overrides,
  };
}

function createDeps(spawnImpl: TerminalControlDeps['spawnAndLogOutput']): TerminalControlDeps & {
  spawnAndLogOutput: ReturnType<typeof vi.fn<TerminalControlDeps['spawnAndLogOutput']>>;
} {
  return {
    directoryExists: vi.fn(async () => false),
    fileExists: vi.fn(async () => false),
    platform: 'darwin',
    spawnAndLogOutput: vi.fn(spawnImpl),
    which: vi.fn(async () => '/opt/homebrew/bin/wezterm'),
  };
}

const weztermTarget: TerminalSessionTarget = {
  terminalPaneId: '42',
  terminalType: 'wezterm',
};

describe('terminal_control', () => {
  test('openTerminalInDirectory uses wezterm start --cwd by default', async () => {
    const deps = createDeps(async () => createResult());
    deps.directoryExists.mockResolvedValue(true);

    await openTerminalInDirectory('/tmp/workspace', undefined, deps);

    expect(deps.spawnAndLogOutput).toHaveBeenCalledWith(
      ['/opt/homebrew/bin/wezterm', 'start', '--cwd', '/tmp/workspace'],
      { quiet: true }
    );
  });

  test('openTerminalInDirectory uses wezterm start --cwd for lowercase wezterm config', async () => {
    const deps = createDeps(async () => createResult());
    deps.directoryExists.mockResolvedValue(true);

    await openTerminalInDirectory('/tmp/workspace', 'wezterm', deps);

    expect(deps.spawnAndLogOutput).toHaveBeenCalledWith(
      ['/opt/homebrew/bin/wezterm', 'start', '--cwd', '/tmp/workspace'],
      { quiet: true }
    );
  });

  test('openTerminalInDirectory uses open -a for custom terminal apps', async () => {
    const deps = createDeps(async () => createResult());
    deps.directoryExists.mockResolvedValue(true);

    await openTerminalInDirectory('/tmp/workspace', 'iTerm', deps);

    expect(deps.spawnAndLogOutput).toHaveBeenCalledWith(['open', '-a', 'iTerm', '/tmp/workspace'], {
      quiet: true,
    });
  });

  test('openTerminalInDirectory rejects missing directories', async () => {
    const deps = createDeps(async () => createResult());

    await expect(openTerminalInDirectory('/tmp/missing', undefined, deps)).rejects.toThrow(
      'Directory does not exist: /tmp/missing'
    );
    expect(deps.spawnAndLogOutput).not.toHaveBeenCalled();
  });

  test('openTerminalInDirectory rejects non-directory paths', async () => {
    const deps = createDeps(async () => createResult());
    // directoryExists defaults to false — simulates a file path

    await expect(openTerminalInDirectory('/tmp/somefile.txt', undefined, deps)).rejects.toThrow(
      'Directory does not exist: /tmp/somefile.txt'
    );
    expect(deps.spawnAndLogOutput).not.toHaveBeenCalled();
  });

  test('openTerminalInDirectory rejects unsupported platforms', async () => {
    const deps = createDeps(async () => createResult());
    deps.directoryExists.mockResolvedValue(true);
    deps.platform = 'linux';

    await expect(openTerminalInDirectory('/tmp/workspace', undefined, deps)).rejects.toThrow(
      'Opening terminal windows is only supported on macOS'
    );
    expect(deps.spawnAndLogOutput).not.toHaveBeenCalled();
  });

  test('openTerminalInDirectory surfaces spawn failures', async () => {
    const deps = createDeps(async () =>
      createResult({
        exitCode: 1,
        stderr: 'spawn failed',
      })
    );
    deps.directoryExists.mockResolvedValue(true);

    await expect(openTerminalInDirectory('/tmp/workspace', 'Terminal', deps)).rejects.toThrow(
      'spawn failed'
    );
  });

  test('focusTerminalPane switches workspace and activates the pane', async () => {
    const deps = createDeps(async (args: string[]) => {
      if (args[1] === 'cli' && args[2] === 'list') {
        return createResult({
          stdout: JSON.stringify([{ pane_id: 42, workspace: 'proj-workspace' }]),
        });
      }

      return createResult();
    });

    await focusTerminalPane(weztermTarget, deps);

    expect(deps.spawnAndLogOutput.mock.calls).toEqual([
      [['/opt/homebrew/bin/wezterm', 'cli', 'list', '--format', 'json'], { quiet: true }],
      [
        [
          '/opt/homebrew/bin/wezterm',
          'cli',
          'spawn',
          '--',
          '/bin/sh',
          '-c',
          expect.stringContaining('switch-workspace='),
        ],
        { quiet: true },
      ],
      [['/opt/homebrew/bin/wezterm', 'cli', 'activate-pane', '--pane-id', '42'], { quiet: true }],
      [['open', '-a', 'WezTerm'], { quiet: true }],
    ]);
  });

  test('focusTerminalPane rejects sessions without wezterm pane metadata', async () => {
    const deps = createDeps(async () => createResult());

    await expect(
      focusTerminalPane(
        {
          terminalPaneId: undefined,
          terminalType: 'wezterm',
        },
        deps
      )
    ).rejects.toThrow('Session does not have a focusable wezterm pane');
  });

  test('focusTerminalPane fails when the pane cannot be found', async () => {
    const deps = createDeps(async (args: string[]) => {
      if (args[1] === 'cli' && args[2] === 'list') {
        return createResult({
          stdout: JSON.stringify([{ pane_id: 7, workspace: 'other-workspace' }]),
        });
      }

      return createResult();
    });

    await expect(focusTerminalPane(weztermTarget, deps)).rejects.toThrow(
      'WezTerm pane 42 not found'
    );
  });
});
