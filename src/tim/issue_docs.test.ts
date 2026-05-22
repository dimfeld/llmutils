import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import type { IssueDocument } from '../common/issue_tracker/types.js';
import { getIssueDocsDir, writeIssueDocuments } from './issue_docs.js';

function makeDoc(overrides: Partial<IssueDocument>): IssueDocument {
  return {
    id: 'doc-id',
    title: 'Doc Title',
    url: 'https://linear.app/doc/doc-id',
    content: '# Doc\n',
    source: 'issue',
    ...overrides,
  };
}

describe('issue_docs', () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-issue-docs-test-'));
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  test('builds the issue document cache directory for a plan', () => {
    expect(getIssueDocsDir(repoRoot, 356)).toBe(path.join(repoRoot, '.tim', 'issue-docs', '356'));
  });

  test('sanitizes document titles and writes markdown in input order', async () => {
    const docs = [
      makeDoc({ id: 'doc-1', title: '../API/Spec: v1?', content: '# API\n' }),
      makeDoc({ id: 'doc-2', title: 'Implementation Notes', content: '# Notes\n' }),
    ];

    const result = await writeIssueDocuments(repoRoot, 356, docs);

    expect(result.docPaths).toEqual([
      path.join('.tim', 'issue-docs', '356', 'API-Spec-v1.md'),
      path.join('.tim', 'issue-docs', '356', 'Implementation-Notes.md'),
    ]);
    await expect(fs.readFile(path.join(repoRoot, result.docPaths[0]), 'utf8')).resolves.toBe(
      '# API\n'
    );
    await expect(fs.readFile(path.join(repoRoot, result.docPaths[1]), 'utf8')).resolves.toBe(
      '# Notes\n'
    );
  });

  test('dedupes colliding sanitized filenames', async () => {
    const docs = [
      makeDoc({ id: 'doc-1', title: 'API Spec', content: 'first' }),
      makeDoc({ id: 'doc-2', title: 'API/Spec', content: 'second' }),
      makeDoc({ id: 'doc-3', title: 'API: Spec', content: 'third' }),
    ];

    const result = await writeIssueDocuments(repoRoot, 356, docs);

    expect(result.docPaths).toEqual([
      path.join('.tim', 'issue-docs', '356', 'API-Spec.md'),
      path.join('.tim', 'issue-docs', '356', 'API-Spec-2.md'),
      path.join('.tim', 'issue-docs', '356', 'API-Spec-3.md'),
    ]);
  });

  test('falls back to document id for blank titles', async () => {
    const docs = [
      makeDoc({ id: 'linear-doc-1', title: '   ', content: 'untitled' }),
      makeDoc({ id: 'linear/doc/1', title: '', content: 'colliding-ish' }),
    ];

    const result = await writeIssueDocuments(repoRoot, 356, docs);

    expect(result.docPaths).toEqual([
      path.join('.tim', 'issue-docs', '356', 'linear-doc-1.md'),
      path.join('.tim', 'issue-docs', '356', 'linear-doc-1-2.md'),
    ]);
    await expect(fs.readFile(path.join(repoRoot, result.docPaths[0]), 'utf8')).resolves.toBe(
      'untitled'
    );
    await expect(fs.readFile(path.join(repoRoot, result.docPaths[1]), 'utf8')).resolves.toBe(
      'colliding-ish'
    );
  });

  test('falls back to document id when title is non-empty but sanitizes to empty (all non-ASCII/special chars)', async () => {
    // A title like "ñóñ" or "日本語" sanitizes to empty because all chars are non-ASCII.
    // The expected fallback is the document id, not the generic 'document.md'.
    const docs = [makeDoc({ id: 'my-doc-id', title: '日本語', content: 'non-ascii title' })];

    const result = await writeIssueDocuments(repoRoot, 356, docs);

    expect(result.docPaths).toEqual([path.join('.tim', 'issue-docs', '356', 'my-doc-id.md')]);
    await expect(fs.readFile(path.join(repoRoot, result.docPaths[0]), 'utf8')).resolves.toBe(
      'non-ascii title'
    );
  });

  test('falls back to "document" when both title and id are empty', async () => {
    const docs = [makeDoc({ id: '', title: '', content: 'no-id-no-title' })];

    const result = await writeIssueDocuments(repoRoot, 356, docs);

    expect(result.docPaths).toEqual([path.join('.tim', 'issue-docs', '356', 'document.md')]);
    await expect(fs.readFile(path.join(repoRoot, result.docPaths[0]), 'utf8')).resolves.toBe(
      'no-id-no-title'
    );
  });

  test('collision files all land on disk with correct content', async () => {
    const docs = [
      makeDoc({ id: 'doc-1', title: 'API Spec', content: 'first' }),
      makeDoc({ id: 'doc-2', title: 'API/Spec', content: 'second' }),
      makeDoc({ id: 'doc-3', title: 'API: Spec', content: 'third' }),
    ];

    const result = await writeIssueDocuments(repoRoot, 356, docs);

    await expect(fs.readFile(path.join(repoRoot, result.docPaths[0]), 'utf8')).resolves.toBe(
      'first'
    );
    await expect(fs.readFile(path.join(repoRoot, result.docPaths[1]), 'utf8')).resolves.toBe(
      'second'
    );
    await expect(fs.readFile(path.join(repoRoot, result.docPaths[2]), 'utf8')).resolves.toBe(
      'third'
    );
  });

  test('sanitizes backslashes in titles', async () => {
    const docs = [makeDoc({ id: 'doc-1', title: 'path\\to\\doc', content: 'content' })];

    const result = await writeIssueDocuments(repoRoot, 356, docs);

    expect(result.docPaths).toEqual([path.join('.tim', 'issue-docs', '356', 'path-to-doc.md')]);
    await expect(fs.readFile(path.join(repoRoot, result.docPaths[0]), 'utf8')).resolves.toBe(
      'content'
    );
  });

  test('strips leading and trailing dots and dashes from titles', async () => {
    const docs = [makeDoc({ id: 'doc-1', title: '...API Spec---', content: 'content' })];

    const result = await writeIssueDocuments(repoRoot, 356, docs);

    expect(result.docPaths).toEqual([path.join('.tim', 'issue-docs', '356', 'API-Spec.md')]);
  });

  test('returns empty docPaths for empty input without creating the directory', async () => {
    const result = await writeIssueDocuments(repoRoot, 356, []);

    expect(result.docPaths).toEqual([]);
    await expect(fs.access(getIssueDocsDir(repoRoot, 356))).rejects.toThrow();
  });

  test('case-insensitive collision: titles "API" and "api" produce distinct files with correct content', async () => {
    const docs = [
      makeDoc({ id: 'doc-1', title: 'API', content: 'uppercase content' }),
      makeDoc({ id: 'doc-2', title: 'api', content: 'lowercase content' }),
    ];

    const result = await writeIssueDocuments(repoRoot, 356, docs);

    expect(result.docPaths).toHaveLength(2);
    expect(result.docPaths[0]).toBe(path.join('.tim', 'issue-docs', '356', 'API.md'));
    expect(result.docPaths[1]).toBe(path.join('.tim', 'issue-docs', '356', 'api-2.md'));
    // Both files must exist on disk with their own content
    await expect(fs.readFile(path.join(repoRoot, result.docPaths[0]), 'utf8')).resolves.toBe(
      'uppercase content'
    );
    await expect(fs.readFile(path.join(repoRoot, result.docPaths[1]), 'utf8')).resolves.toBe(
      'lowercase content'
    );
  });

  test('length cap: very long titles produce a filename base of at most 100 chars without trailing dot or dash', async () => {
    const longTitle = 'A'.repeat(300);
    const docs = [makeDoc({ id: 'doc-1', title: longTitle, content: 'long title content' })];

    const result = await writeIssueDocuments(repoRoot, 356, docs);

    expect(result.docPaths).toHaveLength(1);
    const filename = path.basename(result.docPaths[0]);
    // Remove the .md extension to get the base
    const base = filename.replace(/\.md$/, '');
    expect(base.length).toBeLessThanOrEqual(100);
    expect(base).not.toMatch(/[.-]$/);
    // File should be written successfully
    await expect(fs.readFile(path.join(repoRoot, result.docPaths[0]), 'utf8')).resolves.toBe(
      'long title content'
    );
  });

  test('accepts string plan ID', async () => {
    const docs = [makeDoc({ id: 'doc-1', title: 'My Doc', content: 'content' })];

    const result = await writeIssueDocuments(repoRoot, '356', docs);

    expect(result.docPaths).toEqual([path.join('.tim', 'issue-docs', '356', 'My-Doc.md')]);
    expect(getIssueDocsDir(repoRoot, '356')).toBe(path.join(repoRoot, '.tim', 'issue-docs', '356'));
  });

  test('returned paths are relative to repoRoot and inside the plan subdirectory', async () => {
    const docs = [makeDoc({ id: 'doc-1', title: 'My Doc', content: 'content' })];

    const result = await writeIssueDocuments(repoRoot, 42, docs);

    for (const docPath of result.docPaths) {
      expect(path.isAbsolute(docPath)).toBe(false);
      expect(docPath.startsWith(path.join('.tim', 'issue-docs', '42'))).toBe(true);
      await expect(fs.access(path.join(repoRoot, docPath))).resolves.toBeFalsy();
    }
  });
});
