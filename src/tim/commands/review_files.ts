import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  formatPatchFile,
  parsePatchFiles,
  patchMatchesContents,
  type PatchFile,
} from '../../common/review_guide_patch.js';
import { debugLog } from '../../logging.js';
import type { ReviewFileInput } from '../db/review_file.js';
import type { ReviewGuideDiffCatalogEntry } from './review_workflow.js';
import type { ExcerptRevision, FileContentLookup } from './review_guide_references.js';

/** Files larger than this are stored without contents (patch only). */
export const MAX_STORED_FILE_BYTES = 1024 * 1024;
/** Upper bound on unchanged files stored because the guide mentions them. */
export const MAX_CONTEXT_FILES = 60;

/**
 * Rebuild per-file patches from the hunk catalog. Each catalog entry holds the
 * file header plus one hunk, so the header is kept from the first entry of a
 * file and only hunk lines are taken from the rest.
 */
export function patchFilesFromDiffCatalog(catalog: ReviewGuideDiffCatalogEntry[]): PatchFile[] {
  const sections: string[] = [];
  let currentKey: string | null = null;
  let current: string[] = [];

  const flush = (): void => {
    if (current.length > 0) sections.push(current.join('\n'));
    current = [];
  };

  for (const entry of catalog) {
    const key = entry.filePath ?? entry.ref.replace(/#.*$/, '');
    const lines = entry.diffText.split('\n');
    if (key !== currentKey) {
      flush();
      currentKey = key;
      current = lines;
      continue;
    }
    const firstHunk = lines.findIndex((line) => line.startsWith('@@ '));
    if (firstHunk >= 0) current.push(...lines.slice(firstHunk));
  }
  flush();

  return parsePatchFiles(sections.join('\n'));
}

function isBinaryContent(buffer: Uint8Array): boolean {
  const limit = Math.min(buffer.length, 8000);
  for (let i = 0; i < limit; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function decodeText(buffer: Uint8Array): string | null {
  if (buffer.length > MAX_STORED_FILE_BYTES || isBinaryContent(buffer)) return null;
  return new TextDecoder('utf-8').decode(buffer);
}

/**
 * Read many `rev:path` objects with one `git cat-file --batch` process. Missing
 * objects, binary files, and files over the size limit map to null.
 */
export async function readGitObjects(
  baseDir: string,
  specs: string[]
): Promise<Map<string, string | null>> {
  const results = new Map<string, string | null>();
  const unique = [...new Set(specs)].filter((spec) => !spec.includes('\n'));
  if (unique.length === 0) return results;

  const proc = Bun.spawn(['git', 'cat-file', '--batch'], {
    cwd: baseDir,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  });
  // Start reading before writing so a large batch cannot fill both pipes and
  // block git and this process on each other.
  const outputPromise = new Response(proc.stdout).arrayBuffer();
  await proc.stdin.write(unique.map((spec) => `${spec}\n`).join(''));
  await proc.stdin.end();
  const output = new Uint8Array(await outputPromise);
  await proc.exited;

  let offset = 0;
  for (const spec of unique) {
    const headerEnd = output.indexOf(10, offset);
    if (headerEnd < 0) break;
    const header = new TextDecoder().decode(output.subarray(offset, headerEnd));
    offset = headerEnd + 1;
    const match = /^\S+ (\S+) (\d+)$/.exec(header);
    if (!match) {
      // "<spec> missing" or "<spec> ambiguous": no body follows.
      results.set(spec, null);
      continue;
    }
    const size = Number(match[2]);
    const body = output.subarray(offset, offset + size);
    offset += size + 1;
    results.set(spec, match[1] === 'blob' ? decodeText(body) : null);
  }
  return results;
}

async function readWorktreeFile(baseDir: string, relativePath: string): Promise<string | null> {
  const resolved = path.resolve(baseDir, relativePath);
  const root = path.resolve(baseDir);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;
  try {
    const stat = await fs.lstat(resolved);
    if (!stat.isFile() || stat.size > MAX_STORED_FILE_BYTES) return null;
    return decodeText(new Uint8Array(await fs.readFile(resolved)));
  } catch {
    return null;
  }
}

export interface CollectedReviewFiles {
  files: ReviewFileInput[];
  lookup: FileContentLookup;
}

/**
 * Load the old and new contents of every changed file, plus the reviewed-side
 * contents of unchanged files that the guide refers to. New-side contents are
 * read from `reviewedSha`, falling back to the working tree (plan reviews can
 * include uncommitted changes). Contents that do not agree with the patch are
 * dropped so the viewer never shows lines from the wrong revision.
 */
export async function collectReviewFiles(options: {
  baseDir: string;
  baseSha: string | null;
  reviewedSha: string;
  patchFiles: PatchFile[];
  /** Unchanged files to store, with the revision each one needs. */
  contextRequests: Array<{ path: string; rev: ExcerptRevision }>;
}): Promise<CollectedReviewFiles> {
  const { baseDir, baseSha, reviewedSha, patchFiles } = options;
  const oldSpec = (file: PatchFile): string | null =>
    baseSha && file.changeType !== 'added' ? `${baseSha}:${file.oldPath ?? file.path}` : null;
  const newSpec = (file: PatchFile): string | null =>
    file.changeType !== 'deleted' ? `${reviewedSha}:${file.path}` : null;

  const changedPaths = new Set<string>();
  for (const file of patchFiles) {
    changedPaths.add(file.path);
    if (file.oldPath) changedPaths.add(file.oldPath);
  }
  const contextRequests = options.contextRequests
    .filter((request) => !changedPaths.has(request.path) || request.rev === 'base')
    .slice(0, MAX_CONTEXT_FILES);

  const specs: string[] = [];
  for (const file of patchFiles) {
    const oldS = oldSpec(file);
    const newS = newSpec(file);
    if (oldS) specs.push(oldS);
    if (newS) specs.push(newS);
  }
  for (const request of contextRequests) {
    if (request.rev === 'base' && baseSha) specs.push(`${baseSha}:${request.path}`);
    else if (request.rev === 'head') specs.push(`${reviewedSha}:${request.path}`);
  }

  let objects = new Map<string, string | null>();
  try {
    objects = await readGitObjects(baseDir, specs);
  } catch (err) {
    debugLog(`Failed to read review file contents from git: ${String(err)}`);
  }

  const files: ReviewFileInput[] = [];
  const headContents = new Map<string, string>();
  const baseContents = new Map<string, string>();

  for (const file of patchFiles) {
    const oldS = oldSpec(file);
    const newS = newSpec(file);
    const oldContent = file.changeType === 'added' ? '' : oldS ? (objects.get(oldS) ?? null) : null;
    let newContent = file.changeType === 'deleted' ? '' : newS ? (objects.get(newS) ?? null) : null;

    let matches =
      oldContent != null &&
      newContent != null &&
      patchMatchesContents(file, oldContent, newContent);
    if (!matches && oldContent != null && file.changeType !== 'deleted') {
      const worktreeContent = await readWorktreeFile(baseDir, file.path);
      if (worktreeContent != null && patchMatchesContents(file, oldContent, worktreeContent)) {
        newContent = worktreeContent;
        matches = true;
      }
    }

    const storedOld = matches && file.changeType !== 'added' ? oldContent : null;
    const storedNew = matches && file.changeType !== 'deleted' ? newContent : null;
    if (storedOld != null) baseContents.set(file.oldPath ?? file.path, storedOld);
    if (storedNew != null) headContents.set(file.path, storedNew);

    files.push({
      path: file.path,
      oldPath: file.oldPath,
      kind: 'changed',
      changeType: file.changeType,
      patch: formatPatchFile(file),
      oldContent: storedOld,
      newContent: storedNew,
    });
  }

  const contextFiles = new Map<string, ReviewFileInput>();
  for (const request of contextRequests) {
    if (request.rev === 'base') {
      if (!baseSha || baseContents.has(request.path)) continue;
      const content = objects.get(`${baseSha}:${request.path}`) ?? null;
      if (content == null) continue;
      baseContents.set(request.path, content);
      if (changedPaths.has(request.path)) continue;
      const existing = contextFiles.get(request.path);
      contextFiles.set(request.path, {
        path: request.path,
        kind: 'context',
        oldContent: content,
        newContent: existing?.newContent ?? null,
      });
      continue;
    }

    if (headContents.has(request.path)) continue;
    const content =
      objects.get(`${reviewedSha}:${request.path}`) ??
      (await readWorktreeFile(baseDir, request.path));
    if (content == null) continue;
    headContents.set(request.path, content);
    const existing = contextFiles.get(request.path);
    contextFiles.set(request.path, {
      path: request.path,
      kind: 'context',
      oldContent: existing?.oldContent ?? null,
      newContent: content,
    });
  }
  files.push(...contextFiles.values());

  return {
    files,
    lookup: {
      getContent(filePath: string, rev: ExcerptRevision): string | null {
        return (rev === 'base' ? baseContents : headContents).get(filePath) ?? null;
      },
    },
  };
}
