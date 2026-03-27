import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
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
