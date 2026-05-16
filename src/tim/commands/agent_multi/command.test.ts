import fs from 'node:fs';

import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../common/env.js', () => ({
  buildWorkspaceCommandEnv: vi.fn(async () => ({ PATH: '/usr/bin' })),
}));

vi.mock('../../../lib/server/plan_actions.js', () => ({
  createLogFile: vi.fn(() => ({ fd: 7, path: '/tmp/agent-multi-child.log' })),
}));

import { createBunSpawnAgent } from './command.js';

describe('agent-multi command', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('createBunSpawnAgent adds safe child flags for plain CLI defaults', async () => {
    const spawnSpy = vi.spyOn(Bun, 'spawn').mockReturnValue({
      exited: Promise.resolve(0),
      pid: 1234,
    } as never);
    const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation(() => {});

    const plainCliDefaults = {
      autoWorkspace: true,
      terminalInput: true,
      cwd: '/tmp/repo',
    };
    const spawnAgent = await createBunSpawnAgent(plainCliDefaults);

    const result = spawnAgent(101, '/tmp/repo');

    expect(result.pid).toBe(1234);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const [args, options] = spawnSpy.mock.calls[0];
    expect(args).toEqual(['tim', 'agent', '101', '--auto-workspace', '--no-terminal-input']);
    expect(options).toMatchObject({
      cwd: '/tmp/repo',
      env: { PATH: '/usr/bin' },
      stdin: 'ignore',
      stdout: 7,
      stderr: 7,
      detached: true,
    });
    expect(closeSpy).toHaveBeenCalledWith(7);
  });
});
