import { Glob } from 'bun';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getExternalStorageBaseDir } from '../external_storage_utils.js';
import type { RepositoryStorageMetadata } from '../external_storage_utils.js';
import { getDatabase } from '../db/database.js';
import { listProjects } from '../db/project.js';

export interface ExternalStorageDirectoryInfo {
  repositoryName: string;
  repositoryPath: string;
  configPath: string;
  tasksPath: string;
  planCount: number;
  totalSizeBytes: number;
  metadata: RepositoryStorageMetadata | null;
  updatedAt?: string;
  createdAt?: string;
  remoteLabel?: string;
}

export interface CollectStorageOptions {
  includeSize?: boolean;
}

async function directoryExists(targetPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(targetPath);
    return stats.isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function countPlanFiles(tasksPath: string): Promise<number> {
  try {
    const exists = await directoryExists(tasksPath);
    if (!exists) {
      return 0;
    }

    const glob = new Glob('**/*.{plan.md,yml,yaml}');
    let count = 0;
    for await (const _ of glob.scan({ cwd: tasksPath, dot: false })) {
      count += 1;
    }
    return count;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }
    throw error;
  }
}

async function calculateDirectorySize(directoryPath: string): Promise<number> {
  try {
    const entries = await fs.readdir(directoryPath, { withFileTypes: true });
    let total = 0;

    for (const entry of entries) {
      const entryPath = path.join(directoryPath, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        total += await calculateDirectorySize(entryPath);
        continue;
      }
      if (entry.isFile()) {
        try {
          const stats = await fs.stat(entryPath);
          total += stats.size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            continue;
          }
          throw error;
        }
      }
    }

    return total;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }
    throw error;
  }
}

export async function collectExternalStorageDirectories(
  options: CollectStorageOptions = {}
): Promise<ExternalStorageDirectoryInfo[]> {
  const baseDir = getExternalStorageBaseDir();
  const db = getDatabase();
  const projects = listProjects(db).filter(
    (project) => project.external_config_path !== null || project.external_tasks_dir !== null
  );
  const results: ExternalStorageDirectoryInfo[] = [];

  for (const project of projects) {
    const repositoryName = project.repository_id;
    const repositoryPath = path.join(baseDir, repositoryName);
    if (!(await directoryExists(repositoryPath))) {
      continue;
    }

    const metadata: RepositoryStorageMetadata = {
      repositoryName,
      createdAt: project.created_at,
      updatedAt: project.updated_at,
      remoteLabel: project.remote_label ?? undefined,
      lastGitRoot: project.last_git_root ?? undefined,
      externalConfigPath: project.external_config_path ?? undefined,
      externalTasksDir: project.external_tasks_dir ?? undefined,
    };

    let configPath: string;
    if (metadata?.externalConfigPath) {
      configPath = path.isAbsolute(metadata.externalConfigPath)
        ? metadata.externalConfigPath
        : path.resolve(repositoryPath, metadata.externalConfigPath);
    } else {
      // Check for tim.yml first, then fall back to the old rmplan.yml name
      const configDir = path.join(repositoryPath, '.rmfilter', 'config');
      const timPath = path.join(configDir, 'tim.yml');
      const rmplanPath = path.join(configDir, 'rmplan.yml');
      configPath = (await Bun.file(timPath).exists()) ? timPath : rmplanPath;
    }
    const tasksPath = metadata.externalTasksDir
      ? path.isAbsolute(metadata.externalTasksDir)
        ? metadata.externalTasksDir
        : path.resolve(repositoryPath, metadata.externalTasksDir)
      : path.join(repositoryPath, 'tasks');
    const planCount = await countPlanFiles(tasksPath);
    const totalSizeBytes = options.includeSize ? await calculateDirectorySize(repositoryPath) : 0;

    results.push({
      repositoryName,
      repositoryPath,
      configPath,
      tasksPath,
      metadata,
      planCount,
      totalSizeBytes,
      updatedAt: metadata.updatedAt,
      createdAt: metadata.createdAt,
      remoteLabel: metadata?.remoteLabel,
    });
  }

  results.sort((a, b) => a.repositoryName.localeCompare(b.repositoryName));
  return results;
}

export function matchStorageDirectory(entry: ExternalStorageDirectoryInfo, query: string): boolean {
  const normalisedQuery = query.trim().toLowerCase();
  if (!normalisedQuery) {
    return false;
  }

  if (entry.repositoryName.toLowerCase() === normalisedQuery) {
    return true;
  }

  if (entry.remoteLabel && entry.remoteLabel.toLowerCase().includes(normalisedQuery)) {
    return true;
  }

  if (
    entry.metadata?.lastGitRoot &&
    entry.metadata.lastGitRoot.toLowerCase().includes(normalisedQuery)
  ) {
    return true;
  }

  if (entry.repositoryPath.toLowerCase().includes(normalisedQuery)) {
    return true;
  }

  return false;
}

export function formatByteSize(bytes: number): string {
  if (bytes <= 0) {
    return '0 B';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  if (unitIndex === 0) {
    return `${bytes} ${units[unitIndex]}`;
  }

  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

export async function removeStorageDirectory(directoryPath: string): Promise<void> {
  await fs.rm(directoryPath, { recursive: true, force: true });
}
