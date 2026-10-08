import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { parsePatchFiles, type PatchFile } from '../../common/review_guide_patch.js';
import {
  collectReviewFiles,
  MAX_CONTEXT_FILES,
  MAX_STORED_FILE_BYTES,
  patchFilesFromDiffCatalog,
  readGitObjects,
} from './review_files.js';
import { buildReviewGuideDiffCatalog } from './review_workflow.js';

function runGit(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

function numbered(count: number, prefix = 'line'): string[] {
  return Array.from({ length: count }, (_value, index) => `${prefix} ${index + 1}`);
}

const MULTI_OLD = `${numbered(40).join('\n')}\n`;
const MULTI_NEW = `${numbered(40)
  .flatMap((line) => {
    if (line === 'line 5') return ['LINE 5'];
    if (line === 'line 20') return [];
    if (line === 'line 35') return ['line 35', 'extra 35a', 'extra 35b'];
    return [line];
  })
  .join('\n')}\n`;
const RENAME_OLD = `${numbered(20, 'r').join('\n')}\n`;
const RENAME_NEW = RENAME_OLD.replace('r 10\n', 'r ten\n');

describe('review_files', () => {
  let tempDir: string;
  let repoDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-review-files-test-'));
    repoDir = path.join(tempDir, 'repo');
    await fs.mkdir(repoDir);
    runGit(repoDir, ['init', '-q', '-b', 'main']);
    runGit(repoDir, ['config', 'user.email', 'test@test.com']);
    runGit(repoDir, ['config', 'user.name', 'Test User']);
    runGit(repoDir, ['config', 'commit.gpgsign', 'false']);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  async function writeFiles(files: Record<string, string | Uint8Array>): Promise<void> {
    for (const [relativePath, content] of Object.entries(files)) {
      const fullPath = path.join(repoDir, relativePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content);
    }
  }

  function commitAll(message: string): string {
    runGit(repoDir, ['add', '-A']);
    runGit(repoDir, ['commit', '-q', '-m', message]);
    return runGit(repoDir, ['rev-parse', 'HEAD']).trim();
  }

  function diff(...args: string[]): string {
    return runGit(repoDir, ['diff', '--no-color', '--find-renames', ...args]);
  }

  /**
   * Base commit: multi.txt, gone.txt, old-name.txt, keep.txt, docs/notes.md.
   * Head commit: multi.txt modified in three hunks, gone.txt deleted,
   * old-name.txt renamed to new-name.txt with one change, added.txt added.
   */
  async function createStandardHistory(): Promise<{ baseSha: string; headSha: string }> {
    await writeFiles({
      'multi.txt': MULTI_OLD,
      'gone.txt': 'one\ntwo\nthree\n',
      'old-name.txt': RENAME_OLD,
      'keep.txt': 'unchanged\n',
      'docs/notes.md': '# Notes\n',
    });
    const baseSha = commitAll('base');
    await fs.rm(path.join(repoDir, 'gone.txt'));
    await fs.rm(path.join(repoDir, 'old-name.txt'));
    await writeFiles({
      'multi.txt': MULTI_NEW,
      'new-name.txt': RENAME_NEW,
      'added.txt': 'brand new\n',
    });
    const headSha = commitAll('head');
    return { baseSha, headSha };
  }

  function patchFilesFor(baseSha: string, headSha: string): PatchFile[] {
    return parsePatchFiles(diff(baseSha, headSha));
  }

  describe('readGitObjects', () => {
    test('reads blobs and maps missing, binary, tree, and oversized objects to null', async () => {
      await writeFiles({
        'a.txt': 'hello\nworld\n',
        'dir/b.txt': 'b\n',
        'bin.dat': new Uint8Array([0, 1, 2, 3]),
        'big.txt': 'x'.repeat(MAX_STORED_FILE_BYTES + 1),
        'empty.txt': '',
      });
      const sha = commitAll('init');

      const results = await readGitObjects(repoDir, [
        `${sha}:a.txt`,
        'HEAD:dir/b.txt',
        `${sha}:missing.txt`,
        `${sha}:bin.dat`,
        `${sha}:dir`,
        `${sha}:big.txt`,
        `${sha}:empty.txt`,
        `${sha}:a.txt`,
      ]);

      expect(results.size).toBe(7);
      expect(results.get(`${sha}:a.txt`)).toBe('hello\nworld\n');
      expect(results.get('HEAD:dir/b.txt')).toBe('b\n');
      expect(results.get(`${sha}:missing.txt`)).toBeNull();
      expect(results.get(`${sha}:bin.dat`)).toBeNull();
      expect(results.get(`${sha}:dir`)).toBeNull();
      expect(results.get(`${sha}:big.txt`)).toBeNull();
      expect(results.get(`${sha}:empty.txt`)).toBe('');
    });

    test('keeps reading after a missing object', async () => {
      await writeFiles({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
      const sha = commitAll('init');
      const results = await readGitObjects(repoDir, [
        `${sha}:a.txt`,
        `${sha}:nope`,
        `${sha}:b.txt`,
      ]);
      expect([...results.entries()]).toEqual([
        [`${sha}:a.txt`, 'a\n'],
        [`${sha}:nope`, null],
        [`${sha}:b.txt`, 'b\n'],
      ]);
    });

    test('decodes UTF-8 contents', async () => {
      await writeFiles({ 'u.txt': 'héllo ✓\n' });
      const sha = commitAll('init');
      expect((await readGitObjects(repoDir, [`${sha}:u.txt`])).get(`${sha}:u.txt`)).toBe(
        'héllo ✓\n'
      );
    });

    test('returns an empty map for no specs and skips specs with newlines', async () => {
      await writeFiles({ 'a.txt': 'a\n' });
      const sha = commitAll('init');
      expect((await readGitObjects(repoDir, [])).size).toBe(0);
      const results = await readGitObjects(repoDir, [`${sha}:a.txt\nHEAD:a.txt`]);
      expect(results.size).toBe(0);
    });
  });

  describe('patchFilesFromDiffCatalog', () => {
    test('round trips a real diff to the same files and hunks as parsePatchFiles', async () => {
      // The binary file and the pure-rename source are part of the base commit.
      await writeFiles({
        'bin.dat': new Uint8Array([0, 1, 2]),
        'pure-rename-src.txt': `${numbered(10, 'p').join('\n')}\n`,
      });
      const { baseSha } = await createStandardHistory();
      await writeFiles({ 'bin.dat': new Uint8Array([0, 1, 3]) });
      runGit(repoDir, ['mv', 'pure-rename-src.txt', 'pure-rename-dst.txt']);
      const headSha = commitAll('binary change and pure rename');

      const diffText = diff(baseSha, headSha);
      const direct = parsePatchFiles(diffText);
      const fromCatalog = patchFilesFromDiffCatalog(buildReviewGuideDiffCatalog(diffText));

      const summary = (files: PatchFile[]) =>
        files.map((file) => ({
          path: file.path,
          oldPath: file.oldPath,
          changeType: file.changeType,
          binary: file.binary,
          hunks: file.hunks,
        }));
      expect(summary(fromCatalog)).toEqual(summary(direct));

      const multi = fromCatalog.find((file) => file.path === 'multi.txt');
      expect(multi?.hunks).toHaveLength(3);
      expect(fromCatalog.map((file) => [file.path, file.changeType]).sort()).toEqual(
        [
          ['added.txt', 'added'],
          ['bin.dat', 'modified'],
          ['gone.txt', 'deleted'],
          ['multi.txt', 'modified'],
          ['new-name.txt', 'renamed'],
          ['pure-rename-dst.txt', 'renamed'],
        ].sort()
      );
    });

    test('returns [] for an empty catalog', () => {
      expect(patchFilesFromDiffCatalog([])).toEqual([]);
    });

    // Known bug: buildReviewGuideDiffCatalog trims each entry's diffText, which
    // drops a trailing blank context line (" ") from a hunk. The shortened hunk
    // then swallows the next hunk's "@@" header when patchFilesFromDiffCatalog
    // joins the entries. Remove `.fails` when fixed.
    test('keeps hunks whose last context line is blank', async () => {
      const lines = ['a', 'b', 'c', 'd', '', ...numbered(13, 'tail')];
      await writeFiles({ 'f.txt': `${lines.join('\n')}\n` });
      const baseSha = commitAll('base');
      const changed = [...lines];
      changed[1] = 'B';
      changed[15] = 'TAIL';
      await writeFiles({ 'f.txt': `${changed.join('\n')}\n` });
      const headSha = commitAll('head');

      const diffText = diff(baseSha, headSha);
      const direct = parsePatchFiles(diffText);
      expect(direct[0].hunks).toHaveLength(2);
      expect(direct[0].hunks[0].lines.at(-1)).toBe(' ');
      const fromCatalog = patchFilesFromDiffCatalog(buildReviewGuideDiffCatalog(diffText));
      expect(fromCatalog[0].hunks).toEqual(direct[0].hunks);
    });
  });

  describe('collectReviewFiles', () => {
    test('loads old and new contents for modified, added, deleted, and renamed files', async () => {
      const { baseSha, headSha } = await createStandardHistory();
      const patchFiles = patchFilesFor(baseSha, headSha);

      const { files, lookup } = await collectReviewFiles({
        baseDir: repoDir,
        baseSha,
        reviewedSha: headSha,
        patchFiles,
        contextRequests: [],
      });

      const byPath = new Map(files.map((file) => [file.path, file]));
      expect(files).toHaveLength(4);
      expect(byPath.get('multi.txt')).toMatchObject({
        kind: 'changed',
        changeType: 'modified',
        oldPath: null,
        oldContent: MULTI_OLD,
        newContent: MULTI_NEW,
      });
      expect(byPath.get('added.txt')).toMatchObject({
        changeType: 'added',
        oldContent: null,
        newContent: 'brand new\n',
      });
      expect(byPath.get('gone.txt')).toMatchObject({
        changeType: 'deleted',
        oldContent: 'one\ntwo\nthree\n',
        newContent: null,
      });
      expect(byPath.get('new-name.txt')).toMatchObject({
        changeType: 'renamed',
        oldPath: 'old-name.txt',
        oldContent: RENAME_OLD,
        newContent: RENAME_NEW,
      });
      for (const file of files) {
        const patchFile = patchFiles.find((candidate) => candidate.path === file.path)!;
        expect(parsePatchFiles(file.patch!)[0].hunks).toEqual(patchFile.hunks);
      }

      expect(lookup.getContent('multi.txt', 'head')).toBe(MULTI_NEW);
      expect(lookup.getContent('multi.txt', 'base')).toBe(MULTI_OLD);
      expect(lookup.getContent('new-name.txt', 'head')).toBe(RENAME_NEW);
      expect(lookup.getContent('old-name.txt', 'base')).toBe(RENAME_OLD);
      expect(lookup.getContent('new-name.txt', 'base')).toBeNull();
      expect(lookup.getContent('gone.txt', 'base')).toBe('one\ntwo\nthree\n');
      expect(lookup.getContent('gone.txt', 'head')).toBeNull();
      expect(lookup.getContent('added.txt', 'base')).toBeNull();
      expect(lookup.getContent('keep.txt', 'head')).toBeNull();
    });

    test('without a base SHA only added files keep their contents', async () => {
      const { baseSha, headSha } = await createStandardHistory();
      const { files } = await collectReviewFiles({
        baseDir: repoDir,
        baseSha: null,
        reviewedSha: headSha,
        patchFiles: patchFilesFor(baseSha, headSha),
        contextRequests: [{ path: 'keep.txt', rev: 'base' }],
      });
      const byPath = new Map(files.map((file) => [file.path, file]));
      expect(byPath.get('added.txt')).toMatchObject({ newContent: 'brand new\n' });
      expect(byPath.get('multi.txt')).toMatchObject({ oldContent: null, newContent: null });
      expect(byPath.has('keep.txt')).toBe(false);
    });

    test('falls back to the working tree for uncommitted changes', async () => {
      await writeFiles({ 'multi.txt': MULTI_OLD, 'keep.txt': 'unchanged\n' });
      const headSha = commitAll('base');
      await writeFiles({ 'multi.txt': MULTI_NEW, 'staged-new.txt': 'staged\n' });
      runGit(repoDir, ['add', 'staged-new.txt']);
      // Plan reviews diff the reviewed commit against the working tree.
      const patchFiles = parsePatchFiles(diff(headSha));
      expect(patchFiles.map((file) => file.path).sort()).toEqual(['multi.txt', 'staged-new.txt']);

      const { files, lookup } = await collectReviewFiles({
        baseDir: repoDir,
        baseSha: headSha,
        reviewedSha: headSha,
        patchFiles,
        contextRequests: [],
      });
      const byPath = new Map(files.map((file) => [file.path, file]));
      expect(byPath.get('multi.txt')).toMatchObject({
        oldContent: MULTI_OLD,
        newContent: MULTI_NEW,
      });
      expect(byPath.get('staged-new.txt')).toMatchObject({
        changeType: 'added',
        oldContent: null,
        newContent: 'staged\n',
      });
      expect(lookup.getContent('multi.txt', 'head')).toBe(MULTI_NEW);
    });

    test('drops contents that do not match the patch', async () => {
      const { baseSha, headSha } = await createStandardHistory();
      const patchFiles = patchFilesFor(baseSha, headSha);
      // A later commit changes multi.txt again, so neither the reviewed SHA nor
      // the working tree matches the base..head patch.
      const changedAgain = MULTI_NEW.replace('extra 35a', 'extra 35a changed');
      await writeFiles({ 'multi.txt': changedAgain });
      const laterSha = commitAll('later');

      const { files, lookup } = await collectReviewFiles({
        baseDir: repoDir,
        baseSha,
        reviewedSha: laterSha,
        patchFiles,
        contextRequests: [],
      });
      const multi = files.find((file) => file.path === 'multi.txt');
      expect(multi).toMatchObject({ kind: 'changed', oldContent: null, newContent: null });
      expect(multi?.patch).toContain('+extra 35a');
      expect(lookup.getContent('multi.txt', 'head')).toBeNull();
      expect(lookup.getContent('multi.txt', 'base')).toBeNull();
      // Files that still match keep their contents.
      expect(files.find((file) => file.path === 'added.txt')?.newContent).toBe('brand new\n');
    });

    test('drops contents for binary files', async () => {
      await writeFiles({ 'bin.dat': new Uint8Array([0, 1, 2]) });
      const baseSha = commitAll('base');
      await writeFiles({ 'bin.dat': new Uint8Array([0, 1, 3]) });
      const headSha = commitAll('head');
      const { files } = await collectReviewFiles({
        baseDir: repoDir,
        baseSha,
        reviewedSha: headSha,
        patchFiles: patchFilesFor(baseSha, headSha),
        contextRequests: [],
      });
      expect(files).toEqual([
        expect.objectContaining({ path: 'bin.dat', oldContent: null, newContent: null }),
      ]);
    });

    test('stores context files for head and base requests', async () => {
      const { baseSha, headSha } = await createStandardHistory();
      // keep.txt has a different working-tree copy; the committed copy wins.
      await writeFiles({ 'keep.txt': 'dirty\n', 'untracked.txt': 'only on disk\n' });

      const { files, lookup } = await collectReviewFiles({
        baseDir: repoDir,
        baseSha,
        reviewedSha: headSha,
        patchFiles: patchFilesFor(baseSha, headSha),
        contextRequests: [
          { path: 'keep.txt', rev: 'head' },
          { path: 'keep.txt', rev: 'base' },
          { path: 'docs/notes.md', rev: 'base' },
          { path: 'untracked.txt', rev: 'head' },
          { path: 'does-not-exist.txt', rev: 'head' },
          { path: 'does-not-exist.txt', rev: 'base' },
          { path: '../outside.txt', rev: 'head' },
        ],
      });

      const context = files.filter((file) => file.kind === 'context');
      expect(context).toEqual([
        { path: 'keep.txt', kind: 'context', oldContent: 'unchanged\n', newContent: 'unchanged\n' },
        { path: 'docs/notes.md', kind: 'context', oldContent: '# Notes\n', newContent: null },
        { path: 'untracked.txt', kind: 'context', oldContent: null, newContent: 'only on disk\n' },
      ]);
      expect(lookup.getContent('keep.txt', 'head')).toBe('unchanged\n');
      expect(lookup.getContent('docs/notes.md', 'base')).toBe('# Notes\n');
      expect(lookup.getContent('docs/notes.md', 'head')).toBeNull();
      expect(lookup.getContent('does-not-exist.txt', 'head')).toBeNull();
    });

    test('does not duplicate changed files as context files', async () => {
      const { baseSha, headSha } = await createStandardHistory();
      const { files, lookup } = await collectReviewFiles({
        baseDir: repoDir,
        baseSha,
        reviewedSha: headSha,
        patchFiles: patchFilesFor(baseSha, headSha),
        contextRequests: [
          { path: 'multi.txt', rev: 'head' },
          { path: 'multi.txt', rev: 'base' },
          { path: 'old-name.txt', rev: 'base' },
          { path: 'old-name.txt', rev: 'head' },
          { path: 'gone.txt', rev: 'base' },
        ],
      });
      expect(files.filter((file) => file.kind === 'context')).toEqual([]);
      expect(files.filter((file) => file.path === 'multi.txt')).toHaveLength(1);
      expect(lookup.getContent('old-name.txt', 'base')).toBe(RENAME_OLD);
    });

    test('base context for a changed file whose contents did not match still feeds the lookup', async () => {
      const { baseSha, headSha } = await createStandardHistory();
      await writeFiles({ 'multi.txt': 'rewritten\n' });
      const laterSha = commitAll('later');
      const { files, lookup } = await collectReviewFiles({
        baseDir: repoDir,
        baseSha,
        reviewedSha: laterSha,
        patchFiles: patchFilesFor(baseSha, headSha),
        contextRequests: [{ path: 'multi.txt', rev: 'base' }],
      });
      expect(files.filter((file) => file.kind === 'context')).toEqual([]);
      expect(lookup.getContent('multi.txt', 'base')).toBe(MULTI_OLD);
    });

    test(`stores at most MAX_CONTEXT_FILES (${MAX_CONTEXT_FILES}) context requests`, async () => {
      const total = MAX_CONTEXT_FILES + 5;
      const contextFiles: Record<string, string> = {};
      for (let i = 0; i < total; i++) {
        contextFiles[`ctx/file-${String(i).padStart(3, '0')}.txt`] = `content ${i}\n`;
      }
      await writeFiles(contextFiles);
      const sha = commitAll('init');

      const requests = Object.keys(contextFiles).map((filePath) => ({
        path: filePath,
        rev: 'head' as const,
      }));
      const { files, lookup } = await collectReviewFiles({
        baseDir: repoDir,
        baseSha: sha,
        reviewedSha: sha,
        patchFiles: [],
        contextRequests: requests,
      });

      expect(files).toHaveLength(MAX_CONTEXT_FILES);
      expect(files.map((file) => file.path)).toEqual(
        requests.slice(0, MAX_CONTEXT_FILES).map((request) => request.path)
      );
      expect(lookup.getContent(requests[MAX_CONTEXT_FILES].path, 'head')).toBeNull();
    });

    test('changed-file requests do not count toward the context limit', async () => {
      const contextFiles: Record<string, string> = { 'changed.txt': 'v1\n' };
      for (let i = 0; i < MAX_CONTEXT_FILES; i++) {
        contextFiles[`ctx/file-${String(i).padStart(3, '0')}.txt`] = `content ${i}\n`;
      }
      await writeFiles(contextFiles);
      const baseSha = commitAll('base');
      await writeFiles({ 'changed.txt': 'v2\n' });
      const headSha = commitAll('head');

      const requests = [
        { path: 'changed.txt', rev: 'head' as const },
        ...Object.keys(contextFiles)
          .filter((filePath) => filePath !== 'changed.txt')
          .map((filePath) => ({ path: filePath, rev: 'head' as const })),
      ];
      const { files } = await collectReviewFiles({
        baseDir: repoDir,
        baseSha,
        reviewedSha: headSha,
        patchFiles: patchFilesFor(baseSha, headSha),
        contextRequests: requests,
      });
      expect(files.filter((file) => file.kind === 'context')).toHaveLength(MAX_CONTEXT_FILES);
      expect(files.filter((file) => file.kind === 'changed')).toHaveLength(1);
    });
  });
});
