import { $ } from 'bun';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { buildSquashCommitMessage, squashPlanBranch } from './squash_plan_branch.ts';

describe('buildSquashCommitMessage', () => {
  test('lists the original subjects under the title', () => {
    expect(buildSquashCommitMessage('Add feature', ['First step', 'Second step'])).toBe(
      'Add feature\n\nSquashed commits:\n- First step\n- Second step'
    );
  });

  test('leaves out empty, placeholder, duplicate, and title subjects', () => {
    expect(
      buildSquashCommitMessage('Add feature', ['', '.', 'Add feature', 'Step', 'Step', '  '])
    ).toBe('Add feature\n\nSquashed commits:\n- Step');
  });

  test('uses only the title when no subjects remain', () => {
    expect(buildSquashCommitMessage('Add feature', ['.', ''])).toBe('Add feature');
  });
});

describe('squashPlanBranch', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'tim-squash-plan-branch-'));
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  describe('jj', () => {
    async function jjLog(revset: string, template: string): Promise<string> {
      return (await $`jj log -r ${revset} --no-graph -T ${template}`.cwd(repo).text()).trim();
    }

    async function setUpJjRepo(commitCount: number): Promise<void> {
      await $`jj git init --colocate`.cwd(repo).quiet();
      await $`jj config set --repo user.email test@example.com`.cwd(repo).quiet();
      await $`jj config set --repo user.name Test`.cwd(repo).quiet();
      await $`jj metaedit --update-author`.cwd(repo).quiet();
      await writeFile(join(repo, 'base.txt'), 'base\n');
      await $`jj commit -m base`.cwd(repo).quiet();
      await $`jj bookmark set main -r @-`.cwd(repo).quiet();
      for (let i = 1; i <= commitCount; i++) {
        await writeFile(join(repo, `file${i}.txt`), `content ${i}\n`);
        await $`jj commit -m ${`Step ${i}`}`.cwd(repo).quiet();
      }
      await $`jj bookmark set feature -r @-`.cwd(repo).quiet();
    }

    test('squashes the branch and uncommitted changes into one commit', async () => {
      await setUpJjRepo(3);
      await writeFile(join(repo, 'pending.txt'), 'pending\n');
      await $`jj bookmark set feature -r @ --allow-backwards`.cwd(repo).quiet();
      await $`jj new`.cwd(repo).quiet();
      await writeFile(join(repo, 'uncommitted.txt'), 'uncommitted\n');

      const result = await squashPlanBranch({
        workspacePath: repo,
        refName: 'feature',
        baseRevision: 'main',
        title: 'Plan title',
      });

      expect(result).toEqual({ squashed: true, commitCount: 5 });
      expect(await jjLog('main..feature', 'commit_id ++ "\\n"')).toHaveLength(40);
      expect(await jjLog('feature', 'description')).toBe(
        'Plan title\n\nSquashed commits:\n- Step 1\n- Step 2\n- Step 3'
      );
      expect(await jjLog('@-', 'commit_id')).toBe(await jjLog('feature', 'commit_id'));
      expect(await jjLog('@', 'empty')).toBe('true');
      const files = (await $`jj file list -r feature`.cwd(repo).text()).trim().split('\n');
      expect(files.toSorted()).toEqual([
        'base.txt',
        'file1.txt',
        'file2.txt',
        'file3.txt',
        'pending.txt',
        'uncommitted.txt',
      ]);
    });

    test('does not squash a branch with one commit', async () => {
      await setUpJjRepo(1);
      const before = await jjLog('feature', 'commit_id');

      const result = await squashPlanBranch({
        workspacePath: repo,
        refName: 'feature',
        baseRevision: 'main',
        title: 'Plan title',
      });

      expect(result).toEqual({ squashed: false, reason: 'The branch has 1 commit(s).' });
      expect(await jjLog('feature', 'commit_id')).toBe(before);
    });

    test('does not squash when the working copy is not on the bookmark', async () => {
      await setUpJjRepo(2);
      await $`jj new main`.cwd(repo).quiet();
      const before = await jjLog('feature', 'commit_id');

      const result = await squashPlanBranch({
        workspacePath: repo,
        refName: 'feature',
        baseRevision: 'main',
        title: 'Plan title',
      });

      expect(result.squashed).toBe(false);
      expect(await jjLog('feature', 'commit_id')).toBe(before);
    });
  });

  describe('git', () => {
    async function git(...args: string[]): Promise<string> {
      return (await $`git ${args}`.cwd(repo).text()).trim();
    }

    async function setUpGitRepo(commitCount: number): Promise<string> {
      await $`git init -q -b main`.cwd(repo);
      await $`git config user.email test@example.com`.cwd(repo);
      await $`git config user.name Test`.cwd(repo);
      await writeFile(join(repo, 'base.txt'), 'base\n');
      await $`git add -A`.cwd(repo);
      await $`git commit -qm base`.cwd(repo);
      const base = await git('rev-parse', 'HEAD');
      await $`git checkout -qb feature`.cwd(repo);
      for (let i = 1; i <= commitCount; i++) {
        await writeFile(join(repo, `file${i}.txt`), `content ${i}\n`);
        await $`git add -A`.cwd(repo);
        await $`git commit -qm ${`Step ${i}`}`.cwd(repo);
      }
      return base;
    }

    test('squashes the branch and uncommitted changes into one commit', async () => {
      const base = await setUpGitRepo(3);
      await writeFile(join(repo, 'uncommitted.txt'), 'uncommitted\n');

      const result = await squashPlanBranch({
        workspacePath: repo,
        refName: 'feature',
        baseRevision: base,
        title: 'Plan title',
      });

      expect(result).toEqual({ squashed: true, commitCount: 4 });
      expect(await git('rev-list', '--count', `${base}..HEAD`)).toBe('1');
      expect(await git('log', '-1', '--format=%B')).toBe(
        'Plan title\n\nSquashed commits:\n- Step 1\n- Step 2\n- Step 3'
      );
      expect(await git('status', '--porcelain')).toBe('');
      expect((await git('ls-files')).split('\n').toSorted()).toEqual([
        'base.txt',
        'file1.txt',
        'file2.txt',
        'file3.txt',
        'uncommitted.txt',
      ]);
    });

    test('does not squash when another branch is checked out', async () => {
      const base = await setUpGitRepo(2);
      await $`git checkout -q main`.cwd(repo);
      const before = await git('rev-parse', 'feature');

      const result = await squashPlanBranch({
        workspacePath: repo,
        refName: 'feature',
        baseRevision: base,
        title: 'Plan title',
      });

      expect(result.squashed).toBe(false);
      expect(await git('rev-parse', 'feature')).toBe(before);
    });

    test('does not squash a branch that contains a merge commit', async () => {
      const base = await setUpGitRepo(1);
      await $`git checkout -qb side ${base}`.cwd(repo);
      await writeFile(join(repo, 'side.txt'), 'side\n');
      await $`git add -A`.cwd(repo);
      await $`git commit -qm side`.cwd(repo);
      await $`git checkout -q feature`.cwd(repo);
      await $`git merge -q --no-edit side`.cwd(repo);
      const before = await git('rev-parse', 'HEAD');

      const result = await squashPlanBranch({
        workspacePath: repo,
        refName: 'feature',
        baseRevision: base,
        title: 'Plan title',
      });

      expect(result).toEqual({ squashed: false, reason: 'The branch history is not linear.' });
      expect(await git('rev-parse', 'HEAD')).toBe(before);
    });
  });
});
