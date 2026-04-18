import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import yaml from 'yaml';

vi.mock('../../logging.js', () => ({
  writeStdout: vi.fn(),
}));

vi.mock('../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(),
}));

import { writeStdout } from '../../logging.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { handleShowConfigCommand } from './show-config.js';

describe('handleShowConfigCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('prints the effective config as YAML', async () => {
    vi.mocked(loadEffectiveConfig).mockResolvedValue({
      githubUsername: 'global-user',
      paths: {
        tasks: '/repo/tasks',
      },
      postApplyCommands: [
        {
          title: 'Format',
          command: 'bun run format',
        },
      ],
      isUsingExternalStorage: true,
      externalRepositoryConfigDir: '/tmp/repo-config',
      resolvedConfigPath: '/repo/.tim/config/tim.yml',
      repositoryConfigName: 'repo',
      repositoryRemoteUrl: 'https://example.com/repo.git',
    } as any);

    const command = {
      parent: {
        opts: () => ({ config: '/tmp/config.yml' }),
      },
    };

    await handleShowConfigCommand({}, command);

    expect(loadEffectiveConfig).toHaveBeenCalledWith('/tmp/config.yml', {
      cwd: process.cwd(),
      quiet: true,
    });

    expect(writeStdout).toHaveBeenCalledTimes(1);
    const output = vi.mocked(writeStdout).mock.calls[0][0];
    expect(yaml.parse(output)).toEqual({
      githubUsername: 'global-user',
      paths: {
        tasks: '/repo/tasks',
      },
      postApplyCommands: [
        {
          title: 'Format',
          command: 'bun run format',
        },
      ],
      isUsingExternalStorage: true,
      externalRepositoryConfigDir: '/tmp/repo-config',
      resolvedConfigPath: '/repo/.tim/config/tim.yml',
      repositoryConfigName: 'repo',
      repositoryRemoteUrl: 'https://example.com/repo.git',
    });
  });
});
