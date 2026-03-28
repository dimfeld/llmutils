import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { access, constants as fsConstants, readdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import yaml from 'yaml';
import { getMaterializedPlanPath, MATERIALIZED_DIR } from '../plan_materialize.js';

const PLAN_EXTENSION = '.plan.md';

function getPlansDir(repoRoot: string): string {
  return path.join(repoRoot, MATERIALIZED_DIR);
}

function isPlanFilename(filename: string): boolean {
  return filename.endsWith(PLAN_EXTENSION);
}

function parsePlanIdFromContents(content: string): number | null {
  const normalizedLineEndings = content.replaceAll('\r\n', '\n');
  const normalizedContent = normalizedLineEndings.startsWith('# yaml-language-server:')
    ? normalizedLineEndings.slice(normalizedLineEndings.indexOf('\n') + 1 || 0)
    : normalizedLineEndings;

  if (!normalizedContent.startsWith('---\n')) {
    return null;
  }

  const endDelimiterIndex = normalizedContent.indexOf('\n---\n', 4);
  if (endDelimiterIndex === -1) {
    return null;
  }

  const frontMatter = normalizedContent.substring(4, endDelimiterIndex);
  let parsed: unknown;
  try {
    parsed = yaml.parse(frontMatter, { uniqueKeys: false });
  } catch {
    return null;
  }
  const id = parsed && typeof parsed === 'object' ? (parsed as { id?: unknown }).id : undefined;
  if (typeof id === 'number' && Number.isInteger(id)) {
    return id;
  }
  if (typeof id === 'string' && /^\d+$/.test(id)) {
    return Number(id);
  }
  return null;
}

function scanPlanDirEntries(entries: string[], planId: number): string | null {
  const prefixRegex = new RegExp(`^${planId}[.-].*\\.plan\\.md$`);
  for (const entry of entries) {
    if (prefixRegex.test(entry)) {
      return entry;
    }
  }

  return null;
}

function hasMatchingPlanIdSync(filePath: string, planId: number): boolean {
  try {
    return parsePlanIdFromContents(readFileSync(filePath, 'utf8')) === planId;
  } catch {
    return false;
  }
}

async function hasMatchingPlanIdAsync(filePath: string, planId: number): Promise<boolean> {
  try {
    return parsePlanIdFromContents(await readFile(filePath, 'utf8')) === planId;
  } catch {
    return false;
  }
}

function resolvePlanFileFromEntriesSync(
  plansDir: string,
  entries: string[],
  planId: number
): string | null {
  const prefixMatch = scanPlanDirEntries(entries, planId);
  if (prefixMatch && hasMatchingPlanIdSync(path.join(plansDir, prefixMatch), planId)) {
    return path.join(plansDir, prefixMatch);
  }

  for (const entry of entries) {
    if (entry === prefixMatch) continue;
    const entryPath = path.join(plansDir, entry);
    try {
      if (hasMatchingPlanIdSync(entryPath, planId)) {
        return entryPath;
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function resolvePlanFileFromEntriesAsync(
  plansDir: string,
  entries: string[],
  planId: number
): Promise<string | null> {
  const prefixMatch = scanPlanDirEntries(entries, planId);
  if (prefixMatch && (await hasMatchingPlanIdAsync(path.join(plansDir, prefixMatch), planId))) {
    return path.join(plansDir, prefixMatch);
  }

  for (const entry of entries) {
    if (entry === prefixMatch) continue;
    const entryPath = path.join(plansDir, entry);
    try {
      if (await hasMatchingPlanIdAsync(entryPath, planId)) {
        return entryPath;
      }
    } catch {
      continue;
    }
  }

  return null;
}

export function findPlanFileOnDisk(planId: number, repoRoot: string): string | null {
  const materializedPath = getMaterializedPlanPath(repoRoot, planId);
  if (existsSync(materializedPath) && hasMatchingPlanIdSync(materializedPath, planId)) {
    return materializedPath;
  }

  const plansDir = getPlansDir(repoRoot);
  if (!existsSync(plansDir)) {
    return null;
  }

  const entries = readdirSync(plansDir).filter(isPlanFilename);
  return resolvePlanFileFromEntriesSync(plansDir, entries, planId);
}

export async function findPlanFileOnDiskAsync(
  planId: number,
  repoRoot: string
): Promise<string | null> {
  const materializedPath = getMaterializedPlanPath(repoRoot, planId);
  try {
    await access(materializedPath, fsConstants.F_OK);
    if (await hasMatchingPlanIdAsync(materializedPath, planId)) {
      return materializedPath;
    }
  } catch {
    // fall through to directory scan
  }

  const plansDir = getPlansDir(repoRoot);
  try {
    await access(plansDir, fsConstants.F_OK);
  } catch {
    return null;
  }

  const entries = (await readdir(plansDir)).filter(isPlanFilename);
  return resolvePlanFileFromEntriesAsync(plansDir, entries, planId);
}
