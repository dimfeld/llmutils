import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ModuleMocker } from '../../testing.js';
import { writeRepositoryStorageMetadata } from '../external_storage_utils.js';

const moduleMocker = new ModuleMocker(import.meta);

const mockLog = mock(() => {});
const mockWarn = mock(() => {});

const STORAGE_BASE_SUBPATH = path.join('.config', 'rmplan', 'repositories');

async function createStorageRepository(
  homeDir: string,
  name: string,
  options: { plans?: number; remoteLabel?: string; tasksPath?: string } = {}
) {
  const plans = options.plans ?? 0;
  const baseDir = path.join(homeDir, STORAGE_BASE_SUBPATH, name);
  const configDir = path.join(baseDir, '.rmfilter', 'config');
  const tasksDir = options.tasksPath ?? path.join(baseDir, 'tasks');

  await fs.mkdir(configDir, { recursive: true });
  await fs.mkdir(tasksDir, { recursive: true });
  await fs.writeFile(path.join(configDir, 'rmplan.yml'), 'defaultExecutor: direct-call\n');

  for (let i = 0; i < plans; i += 1) {
    const planPath = path.join(tasksDir, `${i + 1}-example.plan.md`);
    await fs.writeFile(planPath, '---\ngoal: Example\n');
  }

  await writeRepositoryStorageMetadata(baseDir, {
    repositoryName: name,
    remoteLabel: options.remoteLabel ?? null,
    lastGitRoot: null,
    externalConfigPath: path.join(configDir, 'rmplan.yml'),
    externalTasksDir: tasksDir,
  });
}

describe('storage commands', () => {
  let fakeHomeDir: string;

  beforeEach(async () => {
    mockLog.mockClear();
    mockWarn.mockClear();

    fakeHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-storage-cmd-'));

    const realOs = await import('node:os');
    await moduleMocker.mock('node:os', () => ({
      ...realOs,
      homedir: () => fakeHomeDir,
    }));

    await moduleMocker.mock('../../logging.js', () => ({
      log: mockLog,
      warn: mockWarn,
      error: mockWarn,
    }));
  });

  afterEach(async () => {
    moduleMocker.clear();
    await fs.rm(fakeHomeDir, { recursive: true, force: true });
  });

  test('handleStorageListCommand outputs JSON with size data', async () => {
    await createStorageRepository(fakeHomeDir, 'alpha-repo', {
      plans: 2,
      remoteLabel: 'github.example.com/owner/alpha-repo',
    });
    await createStorageRepository(fakeHomeDir, 'beta-repo');

    const { handleStorageListCommand } = await import('./storage.js');
    await handleStorageListCommand({ json: true, size: true });

    expect(mockLog).toHaveBeenCalledTimes(1);
    const payload = mockLog.mock.calls[0][0];
    const parsed = JSON.parse(payload as string);

    expect(parsed).toHaveLength(2);
    const alpha = parsed.find((entry: any) => entry.name === 'alpha-repo');
    expect(alpha).toBeTruthy();
    expect(alpha.remote).toBe('github.example.com/owner/alpha-repo');
    expect(alpha.planCount).toBe(2);
    expect(typeof alpha.totalSizeBytes).toBe('number');
  });

  test('handleStorageListCommand reports tasks path overrides from metadata', async () => {
    const repositoryName = 'custom-repo';
    const baseDir = path.join(fakeHomeDir, STORAGE_BASE_SUBPATH, repositoryName);
    const customTasksDir = path.join(baseDir, 'external', 'plans');

    await createStorageRepository(fakeHomeDir, repositoryName, {
      plans: 1,
      tasksPath: customTasksDir,
    });

    const { handleStorageListCommand } = await import('./storage.js');
    await handleStorageListCommand({ json: true });

    expect(mockLog).toHaveBeenCalledTimes(1);
    const payload = mockLog.mock.calls[0][0];
    const parsed = JSON.parse(payload as string);
    const entry = parsed.find((item: any) => item.name === repositoryName);

    expect(entry).toBeTruthy();
    expect(entry.tasksPath).toBe(customTasksDir);
    expect(entry.planCount).toBe(1);
  });

  test('handleStorageCleanCommand supports dry runs and matching by name', async () => {
    await createStorageRepository(fakeHomeDir, 'alpha-repo');
    await createStorageRepository(fakeHomeDir, 'beta-repo');

    const { handleStorageCleanCommand } = await import('./storage.js');
    await handleStorageCleanCommand(['alpha-repo'], { dryRun: true });

    expect(mockLog.mock.calls.some((call) => call[0].includes('[dry-run]'))).toBe(true);

    const storagePath = path.join(fakeHomeDir, STORAGE_BASE_SUBPATH, 'alpha-repo');
    const exists = await fs.stat(storagePath);
    expect(exists.isDirectory()).toBe(true);
  });

  test('handleStorageCleanCommand skips directories with plans unless forced', async () => {
    await createStorageRepository(fakeHomeDir, 'alpha-repo', { plans: 1 });

    const { handleStorageCleanCommand } = await import('./storage.js');
    await handleStorageCleanCommand(['alpha-repo']);

    expect(mockWarn.mock.calls.some((call) => call[0].includes('Skipping alpha-repo'))).toBe(true);

    const storagePath = path.join(fakeHomeDir, STORAGE_BASE_SUBPATH, 'alpha-repo');
    const exists = await fs.stat(storagePath);
    expect(exists.isDirectory()).toBe(true);

    await handleStorageCleanCommand(['alpha-repo'], { force: true });

    await expect(fs.stat(storagePath)).rejects.toThrow();
  });

  test('handleStorageCleanCommand respects metadata tasks directory overrides', async () => {
    const repositoryName = 'custom-repo';
    const baseDir = path.join(fakeHomeDir, STORAGE_BASE_SUBPATH, repositoryName);
    const customTasksDir = path.join(baseDir, 'external', 'plans');

    await createStorageRepository(fakeHomeDir, repositoryName, {
      plans: 1,
      tasksPath: customTasksDir,
    });

    const { handleStorageCleanCommand } = await import('./storage.js');
    await handleStorageCleanCommand([repositoryName]);

    expect(mockWarn.mock.calls.some((call) => call[0].includes(`Skipping ${repositoryName}`))).toBe(
      true
    );

    const storagePath = path.join(fakeHomeDir, STORAGE_BASE_SUBPATH, repositoryName);
    const exists = await fs.stat(storagePath);
    expect(exists.isDirectory()).toBe(true);
  });

  test('handleStorageCleanCommand removes selected directories via prompt', async () => {
    await createStorageRepository(fakeHomeDir, 'alpha-repo');

    await moduleMocker.mock('@inquirer/prompts', () => ({
      checkbox: async () => ['alpha-repo'],
    }));

    const { handleStorageCleanCommand } = await import('./storage.js');
    await handleStorageCleanCommand(undefined, { force: true });

    const storagePath = path.join(fakeHomeDir, STORAGE_BASE_SUBPATH, 'alpha-repo');
    await expect(fs.stat(storagePath)).rejects.toThrow();

    expect(mockLog.mock.calls.some((call) => call[0].includes('Removed alpha-repo'))).toBe(true);
  });

  test('handleStorageCleanCommand removes all directories when --all is provided', async () => {
    await createStorageRepository(fakeHomeDir, 'alpha-repo');
    await createStorageRepository(fakeHomeDir, 'beta-repo');

    const { handleStorageCleanCommand } = await import('./storage.js');
    await handleStorageCleanCommand(undefined, { all: true, force: true });

    await expect(
      fs.stat(path.join(fakeHomeDir, STORAGE_BASE_SUBPATH, 'alpha-repo'))
    ).rejects.toThrow();
    await expect(
      fs.stat(path.join(fakeHomeDir, STORAGE_BASE_SUBPATH, 'beta-repo'))
    ).rejects.toThrow();

    expect(
      mockLog.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('Removed ')
      )
    ).toHaveLength(2);
  });

  test('handleStorageCleanCommand matches remote labels and warns for unknown names', async () => {
    await createStorageRepository(fakeHomeDir, 'alpha-repo', {
      remoteLabel: 'github.example.com/owners/alpha-repo',
    });
    await createStorageRepository(fakeHomeDir, 'beta-repo');

    const { handleStorageCleanCommand } = await import('./storage.js');
    await handleStorageCleanCommand(['OWNERS/ALPHA-REPO', 'missing-repo'], { force: true });

    await expect(
      fs.stat(path.join(fakeHomeDir, STORAGE_BASE_SUBPATH, 'alpha-repo'))
    ).rejects.toThrow();

    const betaPath = path.join(fakeHomeDir, STORAGE_BASE_SUBPATH, 'beta-repo');
    const betaStats = await fs.stat(betaPath);
    expect(betaStats.isDirectory()).toBe(true);

    expect(mockWarn.mock.calls.some((call) => call[0].includes('missing-repo'))).toBe(true);
  });
});
