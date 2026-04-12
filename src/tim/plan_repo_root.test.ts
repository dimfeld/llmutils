import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveRepoRootForPlanArg } from './plan_repo_root.js';

describe('resolveRepoRootForPlanArg', () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-repo-root-test-'));
    originalCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('resolves repo root from tim.local.yml config path', async () => {
    const targetRepo = path.join(tempDir, 'target-repo');
    const configDir = path.join(targetRepo, '.rmfilter', 'config');
    const configPath = path.join(configDir, 'tim.local.yml');

    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(configPath, 'branchPrefix: di/\n');

    const result = await resolveRepoRootForPlanArg('', tempDir, configPath);
    expect(result).toBe(targetRepo);
  });

  test('resolves repo root from .rmfilter/tim.local.yml config path', async () => {
    const targetRepo = path.join(tempDir, 'target-repo');
    const configDir = path.join(targetRepo, '.rmfilter');
    const configPath = path.join(configDir, 'tim.local.yml');

    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(configPath, 'branchPrefix: di/\n');

    const result = await resolveRepoRootForPlanArg('', tempDir, configPath);
    expect(result).toBe(targetRepo);
  });

  test('finds repo root via tim.local.yml when walking up from plan directory', async () => {
    const targetRepo = path.join(tempDir, 'target-repo');
    const configDir = path.join(targetRepo, '.rmfilter', 'config');
    const planDir = path.join(targetRepo, '.tim', 'plans');
    const planFile = path.join(planDir, '1.plan.md');

    await fs.mkdir(configDir, { recursive: true });
    await fs.mkdir(planDir, { recursive: true });
    await fs.writeFile(path.join(configDir, 'tim.local.yml'), 'branchPrefix: di/\n');
    await fs.writeFile(planFile, '---\nid: 1\ntitle: test\n---\n');

    const result = await resolveRepoRootForPlanArg(planFile, tempDir);
    expect(result).toBe(targetRepo);
  });

  test('prefers configPath repo over a matching CWD-relative file', async () => {
    const cwdRepo = path.join(tempDir, 'cwd-repo');
    const targetRepo = path.join(tempDir, 'target-repo');
    const targetConfigPath = path.join(targetRepo, '.tim.yml');

    await fs.mkdir(path.join(cwdRepo, 'tasks'), { recursive: true });
    await fs.mkdir(targetRepo, { recursive: true });
    await fs.writeFile(path.join(cwdRepo, 'tasks', '1.plan.md'), 'local');
    await fs.writeFile(targetConfigPath, 'paths: {}\n');

    process.chdir(cwdRepo);

    await expect(
      resolveRepoRootForPlanArg(path.join('tasks', '1.plan.md'), undefined, targetConfigPath)
    ).resolves.toBe(targetRepo);
  });
});
