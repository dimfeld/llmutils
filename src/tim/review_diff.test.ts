import { $ } from 'bun';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { generateDiffForReview } from './review_diff.ts';

describe('generateDiffForReview', () => {
  test('reviews the full branch diff, including staged and unstaged changes', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'tim-review-diff-'));
    await $`git init -q`.cwd(repoRoot);
    await $`git config user.email test@example.com`.cwd(repoRoot);
    await $`git config user.name Test`.cwd(repoRoot);
    await writeFile(join(repoRoot, 'baseline.ts'), 'export const baseline = 1;\n', 'utf8');
    await writeFile(join(repoRoot, 'staged.ts'), 'export const staged = false;\n', 'utf8');
    await writeFile(join(repoRoot, 'unstaged.ts'), 'export const unstaged = false;\n', 'utf8');
    await $`git add baseline.ts staged.ts unstaged.ts`.cwd(repoRoot);
    await $`git commit -qm initial`.cwd(repoRoot);
    await $`git branch -M main`.cwd(repoRoot);
    const initialCommit = (await $`git rev-parse HEAD`.cwd(repoRoot).text()).trim();
    await $`git checkout -qb feature/review`.cwd(repoRoot);

    await writeFile(join(repoRoot, 'committed.ts'), 'export const committed = true;\n', 'utf8');
    await $`git add committed.ts`.cwd(repoRoot);
    await $`git commit -qm feature`.cwd(repoRoot);
    await writeFile(join(repoRoot, 'staged.ts'), 'export const staged = true;\n', 'utf8');
    await $`git add staged.ts`.cwd(repoRoot);
    await writeFile(join(repoRoot, 'unstaged.ts'), 'export const unstaged = true;\n', 'utf8');

    const result = await generateDiffForReview(repoRoot, { baseBranch: 'main' });

    expect(result.changedFiles).toEqual(['committed.ts', 'staged.ts', 'unstaged.ts']);
    expect(result.diffContent).toContain('export const committed = true');
    expect(result.diffContent).toContain('export const staged = true');
    expect(result.diffContent).toContain('export const unstaged = true');

    const sinceResult = await generateDiffForReview(repoRoot, {
      baseBranch: 'main',
      sinceCommit: initialCommit,
    });
    expect(sinceResult.changedFiles).toEqual(result.changedFiles);
    expect(sinceResult.mergeBaseCommit).toBe(initialCommit);
  });

  test('rejects a malformed explicit since commit descriptively', async () => {
    await expect(
      generateDiffForReview('/tmp/not-used', { sinceCommit: 'not-a-commit' })
    ).rejects.toThrow(
      'Invalid value for --since: "not-a-commit". Expected a 7- to 40-character hexadecimal commit hash.'
    );

    await expect(
      generateDiffForReview('/tmp/not-used', { sinceCommit: ' abc1234 ' })
    ).rejects.toThrow(
      'Invalid value for --since: " abc1234 ". Expected a 7- to 40-character hexadecimal commit hash.'
    );
  });
});
