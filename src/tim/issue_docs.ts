import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';

import { secureWrite, validatePath } from '../common/fs.js';
import type { IssueDocument } from '../common/issue_tracker/types.js';

export const ISSUE_DOCS_DIR = path.join('.tim', 'issue-docs');

type WriteIssueDocumentsResult = {
  docPaths: string[];
};

export function getIssueDocsDir(repoRoot: string, planId: number | string): string {
  return path.join(repoRoot, ISSUE_DOCS_DIR, String(planId));
}

export async function writeIssueDocuments(
  repoRoot: string,
  planId: number | string,
  selectedDocs: IssueDocument[]
): Promise<WriteIssueDocumentsResult> {
  if (selectedDocs.length === 0) {
    return { docPaths: [] };
  }

  const dir = getIssueDocsDir(repoRoot, planId);
  validatePath(repoRoot, path.relative(repoRoot, dir));
  await mkdir(dir, { recursive: true });

  const usedFilenames = new Set<string>();
  const docPaths: string[] = [];

  for (const doc of selectedDocs) {
    const filename = uniqueMarkdownFilename(safeFilenameBase(doc.title, doc.id), usedFilenames);
    const relativePath = path.join(ISSUE_DOCS_DIR, String(planId), filename);

    validatePath(repoRoot, relativePath);
    await secureWrite(repoRoot, relativePath, doc.content);
    docPaths.push(relativePath);
  }

  return { docPaths };
}

// Cap the sanitized filename base so external (Linear-controlled) titles can never
// exceed the filesystem's per-component byte limit and abort the write with ENAMETOOLONG.
const MAX_FILENAME_BASE_LENGTH = 100;

function safeFilenameBase(title: string, id: string): string {
  // Fall back to the document id when the title is empty OR sanitizes to empty
  // (e.g. a title composed entirely of non-ASCII/special characters), then to a
  // generic 'document' name as a last resort.
  return sanitizeForFilename(title) || sanitizeForFilename(id) || 'document';
}

function sanitizeForFilename(value: string): string {
  return (
    value
      .trim()
      .replace(/[/\\]+/g, '-')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[.-]+|[.-]+$/g, '')
      .slice(0, MAX_FILENAME_BASE_LENGTH)
      // slice can re-introduce a trailing dot/dash; strip it again.
      .replace(/[.-]+$/g, '')
  );
}

function uniqueMarkdownFilename(base: string, usedFilenames: Set<string>): string {
  let suffix = 1;
  let filename = `${base}.md`;

  // Track collisions case-insensitively: on case-insensitive filesystems (e.g. the
  // default macOS APFS) `API.md` and `api.md` are the same file, so an exact-match
  // check alone would silently overwrite earlier documents.
  while (usedFilenames.has(filename.toLowerCase())) {
    suffix += 1;
    filename = `${base}-${suffix}.md`;
  }

  usedFilenames.add(filename.toLowerCase());
  return filename;
}
