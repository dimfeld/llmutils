import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { fallbackRepositoryNameFromGitRoot } from '../common/git_url_parser.js';
import { ModuleMocker } from '../testing.js';
import { RepositoryConfigResolver } from './repository_config_resolver.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('RepositoryConfigResolver', () => {
  let gitRoot: string;
  let fakeHomeDir: string;

  beforeEach(async () => {
    gitRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'repo-config-resolver-'));
    fakeHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'resolver-home-'));

    const realOs = await import('node:os');
    await moduleMocker.mock('node:os', () => ({
      ...realOs,
      homedir: () => fakeHomeDir,
    }));

    await moduleMocker.mock('../common/git.js', () => ({
      getGitRoot: async () => gitRoot,
    }));
  });

  afterEach(async () => {
    moduleMocker.clear();
    await fs.rm(gitRoot, { recursive: true, force: true });
    await fs.rm(fakeHomeDir, { recursive: true, force: true });
  });

  test('returns local config path when repository config exists', async () => {
    const localConfigDir = path.join(gitRoot, '.rmfilter', 'config');
    await fs.mkdir(localConfigDir, { recursive: true });
    const localConfigPath = path.join(localConfigDir, 'rmplan.yml');
    await fs.writeFile(localConfigPath, 'defaultExecutor: direct-call');

    const resolver = await RepositoryConfigResolver.create();
    const resolution = await resolver.resolve();

    expect(resolution.usingExternalStorage).toBe(false);
    expect(resolution.configPath).toBe(localConfigPath);
    expect(resolution.gitRoot).toBe(gitRoot);
  });

  test('falls back to external configuration directory when local config is missing', async () => {
    const resolver = await RepositoryConfigResolver.create();
    const resolution = await resolver.resolve();

    const repositoryName = fallbackRepositoryNameFromGitRoot(gitRoot);
    const expectedRepositoryDir = path.join(
      fakeHomeDir,
      '.config',
      'rmfilter',
      'repositories',
      repositoryName
    );
    const expectedConfigDir = path.join(expectedRepositoryDir, '.rmfilter', 'config');

    expect(resolution.usingExternalStorage).toBe(true);
    expect(resolution.repositoryConfigDir).toBe(expectedRepositoryDir);
    expect(resolution.externalConfigPath).toBe(path.join(expectedConfigDir, 'rmplan.yml'));
    expect(resolution.externalTasksDir).toBe(path.join(expectedRepositoryDir, 'tasks'));

    const configDirStats = await fs.stat(expectedConfigDir);
    expect(configDirStats.isDirectory()).toBe(true);
    const tasksDirStats = await fs.stat(path.join(expectedRepositoryDir, 'tasks'));
    expect(tasksDirStats.isDirectory()).toBe(true);
  });
});
