import { $ } from 'bun';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { ensureLocalJjBookmark } from '../../common/git.js';
import { tryCleanStackRebase } from './pr_stack_rebase.js';

const target = { headBranch: 'feature-x', baseBranch: 'main' };
const stacked = [{ headBranch: 'feature-y', baseBranch: 'feature-x' }];

let tempDir: string;
let originDir: string;

async function configureGit(dir: string): Promise<void> {
  await $`git config user.email test@test.com`.cwd(dir).quiet();
  await $`git config user.name "Test User"`.cwd(dir).quiet();
}

async function commitFile(dir: string, file: string, content: string): Promise<void> {
  await fs.writeFile(path.join(dir, file), content);
  await $`git add ${file}`.cwd(dir).quiet();
  await $`git commit -m ${`Change ${file}`}`.cwd(dir).quiet();
}

async function originSha(ref: string): Promise<string> {
  return (await $`git rev-parse ${ref}`.cwd(originDir).quiet().text()).trim();
}

async function isAncestorOnOrigin(ancestor: string, descendant: string): Promise<boolean> {
  const result = await $`git merge-base --is-ancestor ${ancestor} ${descendant}`
    .cwd(originDir)
    .quiet()
    .nothrow();
  return result.exitCode === 0;
}

/**
 * Create an origin with `main`, `feature-x` based on `main`, and `feature-y` based on
 * `feature-x`. Then add a commit to `main` that changes `mainFile`.
 */
async function createStackOnOrigin(mainFile: string): Promise<void> {
  originDir = path.join(tempDir, 'origin.git');
  await $`git init --bare -b main ${originDir}`.quiet();

  const seedDir = path.join(tempDir, 'seed');
  await $`git clone ${originDir} ${seedDir}`.quiet();
  await configureGit(seedDir);
  await commitFile(seedDir, 'base.txt', 'base\n');
  await $`git push origin main`.cwd(seedDir).quiet();

  await $`git checkout -b feature-x`.cwd(seedDir).quiet();
  await commitFile(seedDir, 'x.txt', 'x\n');
  await $`git checkout -b feature-y`.cwd(seedDir).quiet();
  await commitFile(seedDir, 'y.txt', 'y\n');
  await $`git push origin feature-x feature-y`.cwd(seedDir).quiet();

  await $`git checkout main`.cwd(seedDir).quiet();
  await commitFile(seedDir, mainFile, 'main change\n');
  await $`git push origin main`.cwd(seedDir).quiet();
}

async function cloneGitWorkspace(): Promise<string> {
  const workspaceDir = path.join(tempDir, 'workspace');
  await $`git clone ${originDir} ${workspaceDir}`.quiet();
  await configureGit(workspaceDir);
  await $`git checkout feature-x`.cwd(workspaceDir).quiet();
  return workspaceDir;
}

async function cloneJjWorkspace(): Promise<string> {
  const workspaceDir = path.join(tempDir, 'workspace');
  await $`jj git clone ${originDir} ${workspaceDir}`.quiet();
  await $`jj config set --repo user.email test@test.com`.cwd(workspaceDir).quiet();
  await $`jj config set --repo user.name "Test User"`.cwd(workspaceDir).quiet();
  await ensureLocalJjBookmark(workspaceDir, 'feature-x');
  await ensureLocalJjBookmark(workspaceDir, 'feature-y');
  await $`jj new feature-x`.cwd(workspaceDir).quiet();
  return workspaceDir;
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-stack-rebase-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('tryCleanStackRebase with git', () => {
  test('rebases and pushes the branch and the stacked branches', async () => {
    await createStackOnOrigin('main.txt');
    const workspaceDir = await cloneGitWorkspace();

    const result = await tryCleanStackRebase(workspaceDir, target, stacked, false);

    expect(result).toEqual({ status: 'pushed', branches: ['feature-x', 'feature-y'] });
    expect(await isAncestorOnOrigin('main', 'feature-x')).toBe(true);
    expect(await isAncestorOnOrigin('feature-x', 'feature-y')).toBe(true);
    const yFiles = await $`git ls-tree --name-only feature-y`.cwd(originDir).quiet().text();
    expect(yFiles.split('\n').toSorted()).toEqual(
      ['', 'base.txt', 'main.txt', 'x.txt', 'y.txt'].toSorted()
    );
  });

  test('restores the branches and does not push when the rebase has conflicts', async () => {
    await createStackOnOrigin('x.txt');
    const workspaceDir = await cloneGitWorkspace();
    const originalX = await originSha('feature-x');
    const originalY = await originSha('feature-y');

    const result = await tryCleanStackRebase(workspaceDir, target, stacked, false);

    expect(result.status).toBe('needs_agent');
    expect(await originSha('feature-x')).toBe(originalX);
    expect(await originSha('feature-y')).toBe(originalY);
    const localX = (await $`git rev-parse feature-x`.cwd(workspaceDir).quiet().text()).trim();
    expect(localX).toBe(originalX);
    const branch = (await $`git branch --show-current`.cwd(workspaceDir).quiet().text()).trim();
    expect(branch).toBe('feature-x');
  });
});

describe('tryCleanStackRebase with jj', () => {
  test('rebases and pushes the branch and the stacked branches', async () => {
    await createStackOnOrigin('main.txt');
    const workspaceDir = await cloneJjWorkspace();

    const result = await tryCleanStackRebase(workspaceDir, target, stacked, true);

    expect(result).toEqual({ status: 'pushed', branches: ['feature-x', 'feature-y'] });
    expect(await isAncestorOnOrigin('main', 'feature-x')).toBe(true);
    expect(await isAncestorOnOrigin('feature-x', 'feature-y')).toBe(true);
  });

  test('restores the repository and does not push when the rebase has conflicts', async () => {
    await createStackOnOrigin('x.txt');
    const workspaceDir = await cloneJjWorkspace();
    const originalX = await originSha('feature-x');
    const originalY = await originSha('feature-y');

    const result = await tryCleanStackRebase(workspaceDir, target, stacked, true);

    expect(result).toEqual({ status: 'needs_agent', reason: 'The rebase has conflicts' });
    expect(await originSha('feature-x')).toBe(originalX);
    expect(await originSha('feature-y')).toBe(originalY);
    const localX = (
      await $`jj log -r feature-x --no-graph -T commit_id`.cwd(workspaceDir).quiet().text()
    ).trim();
    expect(localX).toBe(originalX);
  });

  test('asks for an agent when a stacked branch is not on top of its base branch', async () => {
    await createStackOnOrigin('main.txt');
    const workspaceDir = await cloneJjWorkspace();
    // Move feature-y so that it is a sibling of feature-x, not a descendant.
    await $`jj rebase -r feature-y -d main@origin`.cwd(workspaceDir).quiet();
    const originalY = await originSha('feature-y');

    const result = await tryCleanStackRebase(workspaceDir, target, stacked, true);

    expect(result).toEqual({
      status: 'needs_agent',
      reason: 'feature-y is not on top of feature-x',
    });
    expect(await originSha('feature-y')).toBe(originalY);
  });
});
