import { checkbox } from '@inquirer/prompts';

import { log, warn } from '../../logging.js';
import {
  collectExternalStorageDirectories,
  formatByteSize,
  matchStorageDirectory,
  removeStorageDirectory,
} from '../storage/storage_manager.js';

interface StorageListOptions {
  json?: boolean;
  size?: boolean;
}

interface StorageCleanOptions {
  force?: boolean;
  dryRun?: boolean;
  all?: boolean;
}

export async function handleStorageListCommand(options: StorageListOptions = {}) {
  const includeSize = Boolean(options.size);
  const directories = await collectExternalStorageDirectories({ includeSize });

  if (directories.length === 0) {
    log('No external rmplan storage directories found.');
    return;
  }

  if (options.json) {
    const payload = directories.map((directory) => ({
      name: directory.repositoryName,
      path: directory.repositoryPath,
      configPath: directory.configPath,
      tasksPath: directory.tasksPath,
      planCount: directory.planCount,
      totalSizeBytes: includeSize ? directory.totalSizeBytes : undefined,
      remote: directory.remoteLabel ?? null,
      createdAt: directory.createdAt ?? null,
      updatedAt: directory.updatedAt ?? null,
    }));
    log(JSON.stringify(payload, null, 2));
    return;
  }

  log(`External rmplan storage directories (${directories.length}):`);
  for (const directory of directories) {
    const lines = [
      `- ${directory.repositoryName}`,
      `  Path: ${directory.repositoryPath}`,
      `  Config: ${directory.configPath}`,
      `  Tasks: ${directory.tasksPath}`,
      `  Plans: ${directory.planCount}`,
    ];

    if (directory.remoteLabel) {
      lines.splice(2, 0, `  Remote: ${directory.remoteLabel}`);
    }

    if (includeSize) {
      lines.push(`  Size: ${formatByteSize(directory.totalSizeBytes)}`);
    }

    if (directory.updatedAt) {
      lines.push(`  Updated: ${directory.updatedAt}`);
    }

    log(lines.join('\n'));
  }
}

function deduplicateEntries(entries: string[]): string[] {
  return Array.from(new Set(entries));
}

export async function handleStorageCleanCommand(
  names: string[] | undefined,
  options: StorageCleanOptions = {}
) {
  const directories = await collectExternalStorageDirectories({ includeSize: true });
  if (directories.length === 0) {
    log('No external rmplan storage directories found.');
    return;
  }

  const resolvedEntries: typeof directories = [];

  if (names && names.length > 0) {
    const uniqueNames = deduplicateEntries(names);
    for (const name of uniqueNames) {
      const match = directories.find((entry) => matchStorageDirectory(entry, name));
      if (match) {
        resolvedEntries.push(match);
      } else {
        warn(`No external storage directory matches "${name}".`);
      }
    }
  } else if (options.all) {
    resolvedEntries.push(...directories);
  } else {
    const choices = directories.map((entry) => ({
      name: `${entry.repositoryName}${entry.remoteLabel ? ` (${entry.remoteLabel})` : ''} [${entry.planCount} plan${
        entry.planCount === 1 ? '' : 's'
      }]`,
      value: entry.repositoryName,
    }));

    const selectedNames = await checkbox({
      message: 'Select external storage directories to remove',
      choices,
    });

    const uniqueSelected = deduplicateEntries(selectedNames);
    for (const name of uniqueSelected) {
      const match = directories.find((entry) => entry.repositoryName === name);
      if (match) {
        resolvedEntries.push(match);
      }
    }
  }

  if (resolvedEntries.length === 0) {
    log('No storage directories selected for removal.');
    return;
  }

  const dryRun = Boolean(options.dryRun);
  const force = Boolean(options.force);

  for (const entry of resolvedEntries) {
    if (!force && entry.planCount > 0) {
      warn(
        `Skipping ${entry.repositoryName}: contains ${entry.planCount} plan file(s). Use --force to override.`
      );
      continue;
    }

    if (dryRun) {
      log(`[dry-run] Would remove ${entry.repositoryName} (${entry.repositoryPath})`);
      continue;
    }

    try {
      await removeStorageDirectory(entry.repositoryPath);
      log(`Removed ${entry.repositoryName} (${entry.repositoryPath})`);
    } catch (error) {
      warn(`Failed to remove ${entry.repositoryName}: ${error as Error}`);
    }
  }
}
