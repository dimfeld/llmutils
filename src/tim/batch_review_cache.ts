import { mkdir, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import type { ReviewIssue } from './formatters/review_formatter.js';
import { ensureMaterializeDir, TMP_DIR } from './plan_materialize.js';

export interface BatchReviewCache {
  gitSha: string;
  issues: ReviewIssue[];
  timestamp: string;
  planId: string | number;
  taskScope: string;
}

export function normalizeTaskIndexes(taskIndexes?: readonly number[]): number[] {
  if (!taskIndexes || taskIndexes.length === 0) {
    return [];
  }

  return [...new Set(taskIndexes)].sort((a, b) => a - b);
}

function isValidIssue(issue: unknown): issue is ReviewIssue {
  if (!issue || typeof issue !== 'object') return false;
  const obj = issue as Record<string, unknown>;
  return (
    typeof obj.severity === 'string' &&
    typeof obj.category === 'string' &&
    typeof obj.content === 'string'
  );
}

export function getCacheFilename(
  planId: string | number,
  resolvedTaskIndexes?: readonly number[]
): string {
  const normalizedIndexes = normalizeTaskIndexes(resolvedTaskIndexes);
  const taskScope = normalizedIndexes.length > 0 ? normalizedIndexes.join('_') : 'all';
  return `review-${planId}-${taskScope}.json`;
}

function getCachePath(
  repoRoot: string,
  planId: string | number,
  resolvedTaskIndexes?: readonly number[]
): string {
  return path.join(repoRoot, TMP_DIR, getCacheFilename(planId, resolvedTaskIndexes));
}

export async function ensureTmpDir(repoRoot: string): Promise<string> {
  await ensureMaterializeDir(repoRoot);

  const tmpDir = path.join(repoRoot, TMP_DIR);
  await mkdir(tmpDir, { recursive: true });
  return tmpDir;
}

export async function clearTmpDir(repoRoot: string): Promise<void> {
  const tmpDir = await ensureTmpDir(repoRoot);
  const entries = await readdir(tmpDir, { withFileTypes: true });

  await Promise.all(
    entries.map((entry) =>
      rm(path.join(tmpDir, entry.name), {
        recursive: true,
        force: true,
      })
    )
  );
}

export async function readBatchReviewCache(
  repoRoot: string,
  planId: string | number,
  resolvedTaskIndexes?: readonly number[]
): Promise<BatchReviewCache | null> {
  const cachePath = getCachePath(repoRoot, planId, resolvedTaskIndexes);

  let raw: string;
  try {
    raw = await readFile(cachePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed.gitSha !== 'string' ||
      !Array.isArray(parsed.issues) ||
      !parsed.issues.every(isValidIssue)
    ) {
      return null;
    }
    return parsed as BatchReviewCache;
  } catch {
    // Malformed JSON - treat as cache miss
    return null;
  }
}

export async function writeBatchReviewCache(
  repoRoot: string,
  planId: string | number,
  resolvedTaskIndexes: readonly number[] | undefined,
  data: Omit<BatchReviewCache, 'taskScope'>
): Promise<void> {
  await ensureTmpDir(repoRoot);
  const normalizedIndexes = normalizeTaskIndexes(resolvedTaskIndexes);
  const taskScope = normalizedIndexes.length > 0 ? normalizedIndexes.join('_') : 'all';
  const cacheData: BatchReviewCache = { ...data, taskScope };
  const filename = `review-${planId}-${taskScope}.json`;
  const cachePath = path.join(repoRoot, TMP_DIR, filename);
  await writeFile(cachePath, `${JSON.stringify(cacheData, null, 2)}\n`, 'utf8');
}

export async function deleteBatchReviewCache(
  repoRoot: string,
  planId: string | number,
  resolvedTaskIndexes?: readonly number[]
): Promise<void> {
  const cachePath = getCachePath(repoRoot, planId, resolvedTaskIndexes);

  try {
    await unlink(cachePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}
