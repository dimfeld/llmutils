import { $ } from 'bun';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  deriveRepositoryName,
  fallbackRepositoryNameFromGitRoot,
  parseGitRemoteUrl,
} from '../common/git_url_parser.js';
import { ModuleMocker } from '../testing.js';
import { RepositoryConfigResolver } from './repository_config_resolver.js';
import {
  describeRemoteForLogging,
  readRepositoryStorageMetadata,
} from './external_storage_utils.js';

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
      'rmplan',
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

    const metadata = await readRepositoryStorageMetadata(expectedRepositoryDir);
    expect(metadata?.repositoryName).toBe(repositoryName);
    expect(metadata?.remoteLabel).toBeUndefined();
    expect(metadata?.externalConfigPath).toBe(path.join(expectedConfigDir, 'rmplan.yml'));
    expect(metadata?.externalTasksDir).toBe(path.join(expectedRepositoryDir, 'tasks'));
  });

  test('derives repository metadata from remote origin when available', async () => {
    await $`git init`.cwd(gitRoot).quiet();
    const remote = 'example.com:Owner Space/Client Repo.git';
    await $`git remote add origin ${remote}`.cwd(gitRoot).quiet();

    const resolver = await RepositoryConfigResolver.create();
    const resolution = await resolver.resolve();

    const parsedRemote = parseGitRemoteUrl(remote);
    const fallbackName = fallbackRepositoryNameFromGitRoot(gitRoot);
    const expectedRepositoryName = deriveRepositoryName(parsedRemote, {
      fallbackName,
      uniqueSalt: gitRoot,
    });

    const expectedRepositoryDir = path.join(
      fakeHomeDir,
      '.config',
      'rmplan',
      'repositories',
      expectedRepositoryName
    );

    expect(resolution.remoteUrl).toBe(remote);
    expect(resolution.repositoryName).toBe(expectedRepositoryName);
    expect(resolution.repositoryConfigDir).toBe(expectedRepositoryDir);

    const configDirStats = await fs.stat(path.join(expectedRepositoryDir, '.rmfilter', 'config'));
    expect(configDirStats.isDirectory()).toBe(true);
    const tasksDirStats = await fs.stat(path.join(expectedRepositoryDir, 'tasks'));
    expect(tasksDirStats.isDirectory()).toBe(true);

    const metadata = await readRepositoryStorageMetadata(expectedRepositoryDir);
    expect(metadata?.repositoryName).toBe(expectedRepositoryName);
    expect(metadata?.remoteLabel).toBe(describeRemoteForLogging(remote));
    expect(metadata?.externalConfigPath).toBe(
      path.join(expectedRepositoryDir, '.rmfilter', 'config', 'rmplan.yml')
    );
    expect(metadata?.externalTasksDir).toBe(path.join(expectedRepositoryDir, 'tasks'));
  });

  test('sanitizes credentials and query fragments when constructing repository directories', async () => {
    await $`git init`.cwd(gitRoot).quiet();
    const remote =
      'https://user:super-secret-token@github.example.com/Owner/Repo.git?token=abc#frag';
    await $`git remote add origin ${remote}`.cwd(gitRoot).quiet();

    const resolver = await RepositoryConfigResolver.create();
    const resolution = await resolver.resolve();

    expect(resolution.repositoryName).toBe('github.example.com__Owner__Repo');
    expect(resolution.repositoryConfigDir).toContain('github.example.com__Owner__Repo');
    expect(resolution.repositoryName?.includes('token')).toBe(false);
    expect(resolution.repositoryName?.includes('super-secret-token')).toBe(false);

    const metadata = await readRepositoryStorageMetadata(
      path.join(
        fakeHomeDir,
        '.config',
        'rmplan',
        'repositories',
        'github.example.com__Owner__Repo'
      )
    );
    expect(metadata?.remoteLabel).toBe(describeRemoteForLogging(remote));
  });
});
