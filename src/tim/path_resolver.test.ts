import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  getLegacyAwareSearchDir,
  getPlanStorageDir,
  resolveConfiguredPath,
  resolvePlanPathContext,
} from './path_resolver.js';
import { getDefaultConfig } from './configSchema.js';
import { ModuleMocker } from '../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('path_resolver helpers', () => {
  let gitRoot: string;
  let externalDir: string;

  beforeEach(async () => {
    gitRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'path-resolver-git-'));
    externalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'path-resolver-external-'));

    await moduleMocker.mock('../common/git.js', () => ({
      getGitRoot: mock(async () => gitRoot),
    }));
  });

  afterEach(async () => {
    moduleMocker.clear();
    await fs.rm(gitRoot, { recursive: true, force: true });
    await fs.rm(externalDir, { recursive: true, force: true });
  });

  test('resolvePlanPathContext uses git root for local storage', async () => {
    const config = getDefaultConfig();

    const context = await resolvePlanPathContext(config);

    expect(context.gitRoot).toBe(gitRoot);
    expect(context.repositoryConfigDir).toBeUndefined();
    expect(context.configBaseDir).toBe(gitRoot);
  });

  test('resolvePlanPathContext returns external storage paths', async () => {
    const repositoryConfigDir = path.join(externalDir, 'repositories', 'sample');
    const config = {
      ...getDefaultConfig(),
      paths: undefined,
      isUsingExternalStorage: true,
      externalRepositoryConfigDir: repositoryConfigDir,
      resolvedConfigPath: path.join(repositoryConfigDir, '.rmfilter', 'config', 'tim.yml'),
      repositoryConfigName: 'sample',
      repositoryRemoteUrl: null,
    };

    const context = await resolvePlanPathContext(config);

    expect(context.gitRoot).toBe(gitRoot);
    expect(context.repositoryConfigDir).toBe(repositoryConfigDir);
    expect(context.configBaseDir).toBe(repositoryConfigDir);
  });

  test('resolveConfiguredPath handles undefined and absolute inputs', () => {
    const context = {
      gitRoot,
      repositoryConfigDir: undefined,
      configBaseDir: gitRoot,
    };

    expect(resolveConfiguredPath(context, undefined)).toBeUndefined();

    const absolutePath = path.join(gitRoot, 'absolute.conf');
    expect(resolveConfiguredPath(context, absolutePath)).toBe(absolutePath);
  });

  test('resolveConfiguredPath resolves relative paths against config base dir', () => {
    const repositoryConfigDir = path.join(externalDir, 'repositories', 'sample');
    const context = {
      gitRoot,
      repositoryConfigDir,
      configBaseDir: repositoryConfigDir,
    };

    const relativePath = path.join('configs', 'settings.yml');
    expect(resolveConfiguredPath(context, relativePath)).toBe(
      path.join(repositoryConfigDir, relativePath)
    );
  });

  test('getPlanStorageDir returns the materialized plans directory', () => {
    expect(getPlanStorageDir(gitRoot)).toBe(path.join(gitRoot, '.tim', 'plans'));
  });

  test('getLegacyAwareSearchDir returns the materialized plans directory', async () => {
    const configBaseDir = path.join(gitRoot, 'external-storage');
    const tasksDir = path.join(configBaseDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    expect(getLegacyAwareSearchDir(gitRoot, configBaseDir)).toBe(
      path.join(gitRoot, '.tim', 'plans')
    );
  });
});
