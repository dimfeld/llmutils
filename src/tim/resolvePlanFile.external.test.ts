import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { $ } from 'bun';
import { mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import yaml from 'yaml';

import { resolvePlanFile, clearPlanCache, readAllPlans } from './plans.js';
import { resolveTasksDir } from './configSchema.js';
import { loadEffectiveConfig, clearConfigCache } from './configLoader.ts';
import { ModuleMocker } from '../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

const assertPathWithinFakeHome = (targetPath: string, fakeHome: string | undefined): string => {
  if (!fakeHome) {
    throw new Error('fakeHomeDir has not been initialized');
  }

  const resolvedHome = resolve(fakeHome);
  const resolvedTarget = resolve(targetPath);
  const relativeToHome = relative(resolvedHome, resolvedTarget);
  const isInsideHome =
    relativeToHome === '' || (!relativeToHome.startsWith('..') && !isAbsolute(relativeToHome));

  if (!isInsideHome) {
    throw new Error(`Refusing to operate on path outside fake home: ${resolvedTarget}`);
  }

  return resolvedTarget;
};

describe('resolvePlanFile external storage integration', () => {
  let repoRoot: string;
  let fakeHomeDir: string;
  let originalXdgConfigHome: string | undefined;
  let originalCwd: string;
  let externalRepositoryDir: string;
  let externalConfigPath: string | null;
  let defaultTasksDir: string;

  beforeAll(async () => {
    clearPlanCache();
    clearConfigCache();

    originalCwd = process.cwd();
    repoRoot = await realpath(await mkdtemp(join(tmpdir(), 'tim-external-repo-')));
    await $`git init`.cwd(repoRoot).quiet();

    fakeHomeDir = await mkdtemp(join(tmpdir(), 'tim-fake-home-'));
    originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = join(fakeHomeDir, '.config');
    const realOs = await import('node:os');
    await moduleMocker.mock('node:os', () => ({
      ...realOs,
      homedir: () => fakeHomeDir,
    }));

    process.chdir(repoRoot);
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    moduleMocker.clear();
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
    }
    await rm(repoRoot, { recursive: true, force: true });
    await rm(fakeHomeDir, { recursive: true, force: true });
    clearPlanCache();
    clearConfigCache();
  });

  beforeEach(async () => {
    clearPlanCache();
    clearConfigCache();

    const config = await loadEffectiveConfig();
    externalRepositoryDir = assertPathWithinFakeHome(
      config.externalRepositoryConfigDir!,
      fakeHomeDir
    );
    externalConfigPath = config.resolvedConfigPath ?? null;
    if (externalConfigPath) {
      externalConfigPath = assertPathWithinFakeHome(externalConfigPath, fakeHomeDir);
    }

    defaultTasksDir = assertPathWithinFakeHome(await resolveTasksDir(config), fakeHomeDir);

    await rm(defaultTasksDir, { recursive: true, force: true });
    await mkdir(defaultTasksDir, { recursive: true });
    const customTasksDir = assertPathWithinFakeHome(
      join(externalRepositoryDir, 'custom-tasks'),
      fakeHomeDir
    );
    await rm(customTasksDir, { recursive: true, force: true }).catch(() => {});
    if (externalConfigPath) {
      externalConfigPath = assertPathWithinFakeHome(externalConfigPath, fakeHomeDir);
      await rm(externalConfigPath, { force: true }).catch(() => {});
    }
  });

  it('resolves plans stored in the default external tasks directory', async () => {
    const planPath = assertPathWithinFakeHome(
      join(defaultTasksDir, 'external-plan.yml'),
      fakeHomeDir
    );
    await writeFile(
      planPath,
      `---\n${yaml.stringify({
        id: 9001,
        title: 'External Plan',
        goal: 'Verify external storage ID resolution',
        details: 'Plan stored in external tasks directory',
        tasks: [],
      })}---\n`
    );

    clearPlanCache();

    const resolvedById = await resolvePlanFile('9001');
    expect(resolvedById).toBe(planPath);

    const resolvedByName = await resolvePlanFile('external-plan.yml');
    expect(resolvedByName).toBe(planPath);

    const { plans } = await readAllPlans(defaultTasksDir, false);
    expect(plans.has(9001)).toBe(true);
  });

  it('respects relative task paths defined in external storage config', async () => {
    const relativeDirName = 'custom-tasks';
    const relativeTasksDir = assertPathWithinFakeHome(
      join(externalRepositoryDir, relativeDirName),
      fakeHomeDir
    );
    await mkdir(relativeTasksDir, { recursive: true });

    const relativePlanPath = assertPathWithinFakeHome(
      join(relativeTasksDir, 'relative-plan.yml'),
      fakeHomeDir
    );
    await writeFile(
      relativePlanPath,
      `---\n${yaml.stringify({
        id: 42,
        title: 'Relative Plan',
        goal: 'Verify relative path resolution',
        details: 'Plan stored under custom relative directory',
        tasks: [],
      })}---\n`
    );

    if (externalConfigPath) {
      externalConfigPath = assertPathWithinFakeHome(externalConfigPath, fakeHomeDir);
      await writeFile(externalConfigPath, yaml.stringify({ paths: { tasks: relativeDirName } }));
    } else {
      const configDir = assertPathWithinFakeHome(
        join(externalRepositoryDir, '.rmfilter', 'config'),
        fakeHomeDir
      );
      await mkdir(configDir, { recursive: true });
      externalConfigPath = assertPathWithinFakeHome(join(configDir, 'tim.yml'), fakeHomeDir);
      await writeFile(externalConfigPath, yaml.stringify({ paths: { tasks: relativeDirName } }));
    }

    clearConfigCache();
    clearPlanCache();

    const config = await loadEffectiveConfig();
    expect(config.isUsingExternalStorage).toBe(true);
    expect(config.paths?.tasks).toBe(relativeDirName);

    const tasksDir = await resolveTasksDir(config);
    expect(tasksDir).toBe(relativeTasksDir);

    const resolvedByName = await resolvePlanFile('relative-plan.yml');
    expect(resolvedByName).toBe(relativePlanPath);

    const resolvedById = await resolvePlanFile('42');
    expect(resolvedById).toBe(relativePlanPath);

    const { plans } = await readAllPlans(relativeTasksDir, false);
    expect(plans.has(42)).toBe(true);
  });
});
