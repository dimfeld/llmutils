import { $ } from 'bun';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, test } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  cleanupAiCommentMarkers,
  createAddressCommentsPrompt,
  findFilesWithAiComments,
  handleCleanupCommentsCommand,
  smartCleanupAiCommentMarkers,
  commitAddressedComments,
} from './addressComments.js';

describe('createAddressCommentsPrompt', () => {
  test('includes base branch, validation commands, and scoped paths', () => {
    const prompt = createAddressCommentsPrompt({
      baseBranch: 'trunk',
      paths: ['src/components/Button.tsx'],
      filePathPrefix: '@/',
    });

    expect(prompt).toContain('trunk');
    expect(prompt).toContain('bun run check');
    expect(prompt).toContain('git diff trunk -- <path>');
    expect(prompt).toContain('jj diff --from trunk -- <path>');
    expect(prompt).toContain('- @/src/components/Button.tsx');
    expect(prompt).toContain('rg --line-number --fixed-strings');
  });

  test('omits scope section when no paths provided', () => {
    const prompt = createAddressCommentsPrompt({
      baseBranch: 'main',
      paths: [],
    });

    expect(prompt).not.toContain('## Search Scope');
    expect(prompt).toContain('rg --line-number --fixed-strings');
  });
});

describe('handleCleanupCommentsCommand', () => {
  it('removes markers from the git root when confirmations are skipped', async () => {
    const repoDir = await mkdtemp(path.join(tmpdir(), 'address-comments-cleanup-'));
    const srcDir = path.join(repoDir, 'src');
    await mkdir(srcDir, { recursive: true });
    await $`git init -b main`.cwd(repoDir).quiet();

    const filePath = path.join(srcDir, 'cleanup_target.ts');
    await writeFile(
      filePath,
      `export function compute() {
  // AI: tighten the validation
  return 1;
}
`
    );

    const originalCwd = process.cwd();
    process.chdir(repoDir);
    try {
      await handleCleanupCommentsCommand([], { yes: true }, {} as any);
    } finally {
      process.chdir(originalCwd);
    }

    const updated = await readFile(filePath, 'utf-8');
    expect(updated).not.toContain('AI:');

    await rm(repoDir, { recursive: true, force: true });
  });

  it('throws when provided paths outside of the repository', async () => {
    const repoDir = await mkdtemp(path.join(tmpdir(), 'address-comments-outside-'));
    await $`git init -b main`.cwd(repoDir).quiet();

    const originalCwd = process.cwd();
    const outsidePath = path.join(repoDir, '..', 'address-comments-outside-marker.ts');

    process.chdir(repoDir);
    try {
      await expect(
        handleCleanupCommentsCommand([outsidePath], { yes: true }, {} as any)
      ).rejects.toThrow('outside of the repository root');
    } finally {
      process.chdir(originalCwd);
      await rm(outsidePath, { force: true });
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});

describe('address-comments helpers', () => {
  let tempDir: string;
  let srcDir: string;
  let docsDir: string;

  async function seedFixtures() {
    await writeFile(
      path.join(srcDir, 'needs_fix.ts'),
      `export function greet() {
  // AI: Please update the greeting logic
  return 'hi';
}
`
    );

    await writeFile(
      path.join(srcDir, 'block_comment.ts'),
      `function handler() {
  // AI_COMMENT_START
  // AI (id: comment-123): Guard against undefined input
  // AI_COMMENT_END
  return true;
}
`
    );

    await writeFile(
      path.join(docsDir, 'notes.md'),
      `# Notes
<!-- AI: Rewrite this section for clarity -->
`
    );

    await writeFile(path.join(srcDir, 'clean.ts'), `export const value = 42;\n`);
  }

  beforeAll(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'address-comments-test-'));
    srcDir = path.join(tempDir, 'src');
    docsDir = path.join(tempDir, 'docs');
    await mkdir(srcDir, { recursive: true });
    await mkdir(docsDir, { recursive: true });

    await seedFixtures();
  });

  beforeEach(async () => {
    await seedFixtures();
  });

  afterAll(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('finds files with AI comments across repository', async () => {
    const files = await findFilesWithAiComments(tempDir, []);
    expect(files).toEqual(['docs/notes.md', 'src/block_comment.ts', 'src/needs_fix.ts']);
  });

  it('respects path filters when searching for AI comments', async () => {
    const files = await findFilesWithAiComments(tempDir, ['src']);
    expect(files).toEqual(['src/block_comment.ts', 'src/needs_fix.ts']);
  });

  it('smart cleanup removes AI comment markers when forced', async () => {
    await smartCleanupAiCommentMarkers(tempDir, ['src'], { yes: true });
    const updatedNeedsFix = await readFile(path.join(srcDir, 'needs_fix.ts'), 'utf-8');
    expect(updatedNeedsFix).not.toContain('AI:');
  });

  it('removes AI comment markers from matching files', async () => {
    const cleanedCount = await cleanupAiCommentMarkers(tempDir, ['src']);
    expect(cleanedCount).toBe(2);

    const updatedNeedsFix = await readFile(path.join(srcDir, 'needs_fix.ts'), 'utf-8');
    expect(updatedNeedsFix).not.toContain('AI:');

    const updatedBlock = await readFile(path.join(srcDir, 'block_comment.ts'), 'utf-8');
    expect(updatedBlock).not.toContain('AI_COMMENT_START');
    expect(updatedBlock).not.toContain('AI_COMMENT_END');
    expect(updatedBlock).not.toContain('AI (id:');
  });

  it('skips cleanup when there are no remaining markers', async () => {
    await cleanupAiCommentMarkers(tempDir, ['src']);
    const cleaned = await cleanupAiCommentMarkers(tempDir, ['src']);
    expect(cleaned).toBe(0);
  });

  it('smart cleanup exits cleanly when no markers remain', async () => {
    await cleanupAiCommentMarkers(tempDir, ['src']);
    await expect(
      smartCleanupAiCommentMarkers(tempDir, ['src'], { yes: true })
    ).resolves.toBeUndefined();
  });
});

describe('commitAddressedComments', () => {
  let repoDir: string;
  let targetFile: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(path.join(tmpdir(), 'address-comments-commit-'));
    await $`git init -b main`.cwd(repoDir).quiet();
    await $`git config user.email tester@example.com`.cwd(repoDir).quiet();
    await $`git config user.name Tester`.cwd(repoDir).quiet();

    targetFile = path.join(repoDir, 'example.ts');
    await writeFile(targetFile, 'export const value = 1;\n');
    await $`git add .`.cwd(repoDir).quiet();
    await $`git commit -m "initial"`.cwd(repoDir).quiet();
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
  });

  it('skips committing when no changes are present', async () => {
    await commitAddressedComments(repoDir);
    const commitCount = parseInt(
      (await $`git rev-list --count HEAD`.cwd(repoDir).quiet().text()).trim(),
      10
    );
    expect(commitCount).toBe(1);
  });

  it('commits changes with the expected message', async () => {
    await writeFile(targetFile, 'export const value = 2;\n');
    await commitAddressedComments(repoDir);

    const commitCount = parseInt(
      (await $`git rev-list --count HEAD`.cwd(repoDir).quiet().text()).trim(),
      10
    );
    expect(commitCount).toBe(2);

    const message = (await $`git log -1 --pretty=%B`.cwd(repoDir).quiet().text()).trim();
    expect(message).toBe('Address review comments');
  });
});
