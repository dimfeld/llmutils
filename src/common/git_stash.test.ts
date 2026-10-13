import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { clearAllGitCaches, hasUncommittedChanges, stashUncommittedGitChanges } from './git.js';

async function runGit(dir: string, args: string[]): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout] = await Promise.all([
    proc.exited,
    new Response(proc.stdout as ReadableStream).text(),
  ]);
  return { exitCode, stdout };
}

describe('stashUncommittedGitChanges', () => {
  let repoDir: string;

  beforeEach(async () => {
    clearAllGitCaches();
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-stash-test-'));
    await runGit(repoDir, ['init', '-b', 'main']);
    await runGit(repoDir, ['config', 'user.email', 'test@example.com']);
    await runGit(repoDir, ['config', 'user.name', 'Test User']);
    await fs.writeFile(path.join(repoDir, 'file.txt'), 'base\n');
    await fs.writeFile(path.join(repoDir, '.gitignore'), 'ignored.txt\n');
    await runGit(repoDir, ['add', '.']);
    await runGit(repoDir, ['commit', '-m', 'base']);
  });

  afterEach(async () => {
    clearAllGitCaches();
    await fs.rm(repoDir, { recursive: true, force: true });
  });

  test('returns null when there is nothing to stash', async () => {
    expect(await stashUncommittedGitChanges(repoDir, 'test reuse')).toBeNull();
    expect((await runGit(repoDir, ['stash', 'list'])).stdout).toBe('');
  });

  test('stashes tracked and untracked changes but keeps ignored files', async () => {
    await fs.appendFile(path.join(repoDir, 'file.txt'), 'edit\n');
    await fs.writeFile(path.join(repoDir, 'new.txt'), 'new\n');
    await fs.writeFile(path.join(repoDir, 'ignored.txt'), 'ignored\n');

    const message = await stashUncommittedGitChanges(repoDir, 'test reuse');

    expect(message).toMatch(/^tim: test reuse \(/);
    expect(await hasUncommittedChanges(repoDir)).toBe(false);
    expect(await fs.readFile(path.join(repoDir, 'ignored.txt'), 'utf8')).toBe('ignored\n');
    expect((await runGit(repoDir, ['stash', 'list'])).stdout).toContain(message!);

    expect((await runGit(repoDir, ['stash', 'pop'])).exitCode).toBe(0);
    expect(await fs.readFile(path.join(repoDir, 'new.txt'), 'utf8')).toBe('new\n');
    expect(await fs.readFile(path.join(repoDir, 'file.txt'), 'utf8')).toBe('base\nedit\n');
  });

  test('aborts a conflicted merge and then stashes the remaining changes', async () => {
    await runGit(repoDir, ['checkout', '-b', 'other']);
    await fs.writeFile(path.join(repoDir, 'file.txt'), 'other\n');
    await runGit(repoDir, ['commit', '-am', 'other']);
    await runGit(repoDir, ['checkout', 'main']);
    await fs.writeFile(path.join(repoDir, 'file.txt'), 'main\n');
    await runGit(repoDir, ['commit', '-am', 'main']);
    expect((await runGit(repoDir, ['merge', 'other'])).exitCode).not.toBe(0);
    await fs.writeFile(path.join(repoDir, 'leftover.txt'), 'leftover\n');

    const message = await stashUncommittedGitChanges(repoDir, 'test reuse');

    expect(message).not.toBeNull();
    expect(await hasUncommittedChanges(repoDir)).toBe(false);
    await expect(fs.access(path.join(repoDir, '.git', 'MERGE_HEAD'))).rejects.toThrow();
    expect(await fs.readFile(path.join(repoDir, 'file.txt'), 'utf8')).toBe('main\n');
  });
});
