import { describe, expect, test, vi } from 'vitest';

import {
  focusTerminalPane,
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
