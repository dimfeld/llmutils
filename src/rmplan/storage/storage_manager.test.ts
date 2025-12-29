import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ModuleMocker } from '../../testing.js';
import {
  collectExternalStorageDirectories,
  formatByteSize,
  matchStorageDirectory,
  removeStorageDirectory,
} from './storage_manager.js';
import { writeRepositoryStorageMetadata } from '../external_storage_utils.js';

const STORAGE_BASE_SUBPATH = path.join('.config', 'rmplan', 'repositories');

async function createStorageRepository(
  homeDir: string,
  name: string,
  options: { plans?: number; remoteLabel?: string; lastGitRoot?: string } = {}
) {
  const plans = options.plans ?? 0;
  const baseDir = path.join(homeDir, STORAGE_BASE_SUBPATH, name);
  const configDir = path.join(baseDir, '.rmfilter', 'config');
  const tasksDir = path.join(baseDir, 'tasks');

  await fs.mkdir(configDir, { recursive: true });
  await fs.mkdir(tasksDir, { recursive: true });
  await fs.writeFile(path.join(configDir, 'rmplan.yml'), 'defaultExecutor: direct-call\n');

  for (let index = 0; index < plans; index += 1) {
    const planPath = path.join(tasksDir, `${index + 1}-example.plan.md`);
    await fs.writeFile(planPath, '---\ngoal: Example\n');
  }

  await writeRepositoryStorageMetadata(baseDir, {
    repositoryName: name,
    remoteLabel: options.remoteLabel ?? null,
    lastGitRoot: options.lastGitRoot ?? null,
    externalConfigPath: path.join(configDir, 'rmplan.yml'),
    externalTasksDir: tasksDir,
  });

  return baseDir;
}

describe('storage manager', () => {
  const moduleMocker = new ModuleMocker(import.meta);
  let fakeHomeDir: string;

  beforeEach(async () => {
    fakeHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-storage-manager-'));

    const realOs = await import('node:os');
    await moduleMocker.mock('node:os', () => ({
      ...realOs,
      homedir: () => fakeHomeDir,
    }));
  });

  afterEach(async () => {
    moduleMocker.clear();
    await fs.rm(fakeHomeDir, { recursive: true, force: true });
  });

  test('collectExternalStorageDirectories gathers metadata and respects includeSize flag', async () => {
    await createStorageRepository(fakeHomeDir, 'alpha-repo', {
      plans: 2,
      remoteLabel: 'github.example.com/owner/alpha-repo',
    });
    await createStorageRepository(fakeHomeDir, 'beta-repo', {
      plans: 1,
    });

    const withoutSize = await collectExternalStorageDirectories();
    expect(withoutSize).toHaveLength(2);
    expect(withoutSize[0].repositoryName).toBe('alpha-repo');
    expect(withoutSize[0].planCount).toBe(2);
    expect(withoutSize[0].totalSizeBytes).toBe(0);
    expect(withoutSize[0].remoteLabel).toBe('github.example.com/owner/alpha-repo');

    const withSize = await collectExternalStorageDirectories({ includeSize: true });
    const alpha = withSize.find((entry) => entry.repositoryName === 'alpha-repo');
    expect(alpha?.planCount).toBe(2);
    expect(alpha?.totalSizeBytes ?? 0).toBeGreaterThan(0);
  });

  test('collectExternalStorageDirectories honours metadata tasks directory overrides', async () => {
    const repositoryName = 'custom-tasks-repo';
    const baseDir = path.join(fakeHomeDir, STORAGE_BASE_SUBPATH, repositoryName);
    const configDir = path.join(baseDir, '.rmfilter', 'config');
    const customTasksDir = path.join(baseDir, 'external', 'plans');

    await fs.mkdir(configDir, { recursive: true });
    await fs.mkdir(customTasksDir, { recursive: true });
    await fs.writeFile(path.join(configDir, 'rmplan.yml'), 'defaultExecutor: direct-call\n');
    await fs.writeFile(path.join(customTasksDir, '1-example.plan.md'), '---\ngoal: Example\n');

    await writeRepositoryStorageMetadata(baseDir, {
      repositoryName,
      remoteLabel: null,
      lastGitRoot: null,
      externalConfigPath: path.join(configDir, 'rmplan.yml'),
      externalTasksDir: customTasksDir,
    });

    const entries = await collectExternalStorageDirectories();
    const customEntry = entries.find((entry) => entry.repositoryName === repositoryName);
    expect(customEntry?.planCount).toBe(1);
    expect(customEntry?.tasksPath).toBe(customTasksDir);
  });

  test('matchStorageDirectory recognises repository metadata fields', () => {
    const entry = {
      repositoryName: 'alpha-repo',
      repositoryPath: '/tmp/storage/alpha-repo',
      configPath: '/tmp/storage/alpha-repo/.rmfilter/config/rmplan.yml',
      tasksPath: '/tmp/storage/alpha-repo/tasks',
      planCount: 0,
      totalSizeBytes: 0,
      metadata: {
        repositoryName: 'alpha-repo',
        remoteLabel: 'github.example.com/owner/alpha-repo',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastGitRoot: '/Users/example/project',
        externalConfigPath: '/tmp/storage/alpha-repo/.rmfilter/config/rmplan.yml',
        externalTasksDir: '/tmp/storage/alpha-repo/tasks',
      },
      remoteLabel: 'github.example.com/owner/alpha-repo',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    expect(matchStorageDirectory(entry, 'alpha-repo')).toBe(true);
    expect(matchStorageDirectory(entry, 'OWNER/ALPHA-REPO')).toBe(true);
    expect(matchStorageDirectory(entry, 'example/project')).toBe(true);
    expect(matchStorageDirectory(entry, '/tmp/storage/alpha')).toBe(true);
    expect(matchStorageDirectory(entry, 'unknown-repo')).toBe(false);
  });

  test('removeStorageDirectory deletes repository directory recursively', async () => {
    const repositoryDir = await createStorageRepository(fakeHomeDir, 'alpha-repo');

    await removeStorageDirectory(repositoryDir);

    await expect(fs.stat(repositoryDir)).rejects.toThrow();
  });

  test('formatByteSize returns human readable sizes', () => {
    expect(formatByteSize(0)).toBe('0 B');
    expect(formatByteSize(512)).toBe('512 B');
    expect(formatByteSize(1536)).toBe('1.5 KB');
  });
});
