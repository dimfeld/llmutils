import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  resolveConfiguredPath,
  resolveConfiguredTasksPath,
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

  test('resolveConfiguredTasksPath prefers external repository directory', () => {
    const config = {
      ...getDefaultConfig(),
      paths: undefined,
      isUsingExternalStorage: true,
      externalRepositoryConfigDir: path.join(externalDir, 'repositories', 'sample'),
      resolvedConfigPath: path.join(
        externalDir,
        'repositories',
        'sample',
        '.rmfilter',
        'config',
        'tim.yml'
      ),
      repositoryConfigName: 'sample',
      repositoryRemoteUrl: null,
    };

    const tasksPath = resolveConfiguredTasksPath(config, gitRoot);
    expect(tasksPath).toBe(path.join(config.externalRepositoryConfigDir!, 'tasks'));
  });

  test('resolveConfiguredTasksPath returns absolute paths unchanged', () => {
    const absoluteTasksDir = path.join(gitRoot, 'abs-tasks');
    const config = {
      ...getDefaultConfig(),
      paths: {
        tasks: absoluteTasksDir,
      },
    };

    const tasksPath = resolveConfiguredTasksPath(config, gitRoot);
    expect(tasksPath).toBe(absoluteTasksDir);
  });

  test('resolvePlanPathContext uses git root for local storage', async () => {
    const config = {
      ...getDefaultConfig(),
      paths: {
        tasks: 'plans',
      },
    };

    const context = await resolvePlanPathContext(config);

    expect(context.gitRoot).toBe(gitRoot);
    expect(context.tasksDir).toBe(path.join(gitRoot, 'plans'));
    expect(context.repositoryConfigDir).toBeUndefined();
    expect(context.configBaseDir).toBe(gitRoot);

    const stats = await fs.stat(context.tasksDir);
    expect(stats.isDirectory()).toBe(true);
  });

  test('resolvePlanPathContext returns external storage paths and creates directories', async () => {
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
    expect(context.tasksDir).toBe(path.join(repositoryConfigDir, 'tasks'));
    expect(context.repositoryConfigDir).toBe(repositoryConfigDir);
    expect(context.configBaseDir).toBe(repositoryConfigDir);

    const tasksExists = await fs
      .stat(context.tasksDir)
      .then((stats) => stats.isDirectory())
      .catch(() => false);
    expect(tasksExists).toBe(true);
  });

  test('resolveConfiguredPath handles undefined and absolute inputs', () => {
    const context = {
      gitRoot,
      tasksDir: path.join(gitRoot, 'tasks'),
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
      tasksDir: path.join(repositoryConfigDir, 'tasks'),
      repositoryConfigDir,
      configBaseDir: repositoryConfigDir,
    };

    const relativePath = path.join('configs', 'settings.yml');
    expect(resolveConfiguredPath(context, relativePath)).toBe(
      path.join(repositoryConfigDir, relativePath)
    );
  });
});
