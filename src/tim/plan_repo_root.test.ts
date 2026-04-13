import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveRepoRoot } from './plan_repo_root.js';

describe('resolveRepoRoot', () => {
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

    const result = await resolveRepoRoot(configPath, tempDir);
    expect(result).toBe(targetRepo);
  });

  test('resolves repo root from .rmfilter/tim.local.yml config path', async () => {
    const targetRepo = path.join(tempDir, 'target-repo');
    const configDir = path.join(targetRepo, '.rmfilter');
    const configPath = path.join(configDir, 'tim.local.yml');

    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(configPath, 'branchPrefix: di/\n');

    const result = await resolveRepoRoot(configPath, tempDir);
    expect(result).toBe(targetRepo);
  });

  test('prefers configPath repo over fallback dir', async () => {
    const cwdRepo = path.join(tempDir, 'cwd-repo');
    const targetRepo = path.join(tempDir, 'target-repo');
    const targetConfigPath = path.join(targetRepo, '.tim.yml');

    await fs.mkdir(cwdRepo, { recursive: true });
    await fs.mkdir(targetRepo, { recursive: true });
    await fs.writeFile(targetConfigPath, 'paths: {}\n');

    process.chdir(cwdRepo);

    await expect(resolveRepoRoot(targetConfigPath)).resolves.toBe(targetRepo);
  });
});
