import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { parseGitRemoteUrl } from '../common/git_url_parser.js';

export const STORAGE_METADATA_FILENAME = 'metadata.json';

export interface RepositoryStorageMetadata {
  repositoryName: string;
  remoteLabel?: string;
  createdAt: string;
  updatedAt: string;
  lastGitRoot?: string;
  externalConfigPath?: string;
  externalTasksDir?: string;
}

export interface RepositoryStorageMetadataInput {
  repositoryName: string;
  remoteLabel?: string | null;
  lastGitRoot?: string | null;
  externalConfigPath?: string | null;
  externalTasksDir?: string | null;
}

export function getExternalStorageBaseDir(): string {
  return path.join(os.homedir(), '.config', 'rmfilter', 'repositories');
}

export function trimQueryAndFragment(value: string): string {
  return value.replace(/[?#].*$/, '');
}

export function stripRemoteCredentials(remote: string): string {
  if (remote.includes('://')) {
    try {
      const parsedUrl = new URL(remote);
      return `${parsedUrl.host}${parsedUrl.pathname}` || parsedUrl.host;
    } catch {
      // Fall through to best-effort sanitisation below when URL parsing fails.
    }
  }

  const atIndex = remote.indexOf('@');
  if (atIndex !== -1) {
    return remote.slice(atIndex + 1);
  }

  return remote;
}

export function describeRemoteForLogging(remoteUrl?: string | null): string {
  if (!remoteUrl) {
    return 'none detected';
  }

  const parsed = parseGitRemoteUrl(remoteUrl);
  if (parsed) {
    if (parsed.host && parsed.fullName) {
      return trimQueryAndFragment(`${parsed.host}/${parsed.fullName}`);
    }

    if (parsed.host && parsed.path) {
      return trimQueryAndFragment(`${parsed.host}/${parsed.path}`);
    }

    if (parsed.fullName) {
      return trimQueryAndFragment(parsed.fullName);
    }

    if (parsed.host) {
      return trimQueryAndFragment(parsed.host);
    }
  }

  return trimQueryAndFragment(stripRemoteCredentials(remoteUrl));
}

function normaliseUpdatedValue<T>(
  value: T | null | undefined,
  fallback: T | undefined
): T | undefined {
  if (value === null) {
    return undefined;
  }
  return value === undefined ? fallback : value;
}

export async function readRepositoryStorageMetadata(
  repositoryDir: string
): Promise<RepositoryStorageMetadata | null> {
  const metadataPath = path.join(repositoryDir, STORAGE_METADATA_FILENAME);
  try {
    const content = await fs.readFile(metadataPath, 'utf8');
    const parsed = JSON.parse(content) as Partial<RepositoryStorageMetadata>;
    if (!parsed.repositoryName || !parsed.createdAt || !parsed.updatedAt) {
      return null;
    }

    return {
      repositoryName: parsed.repositoryName,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
      remoteLabel: parsed.remoteLabel,
      lastGitRoot: parsed.lastGitRoot,
      externalConfigPath: parsed.externalConfigPath,
      externalTasksDir: parsed.externalTasksDir,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    return null;
  }
}

export async function writeRepositoryStorageMetadata(
  repositoryDir: string,
  update: RepositoryStorageMetadataInput
): Promise<RepositoryStorageMetadata> {
  const metadataPath = path.join(repositoryDir, STORAGE_METADATA_FILENAME);
  const existing = await readRepositoryStorageMetadata(repositoryDir);
  const now = new Date().toISOString();

  const metadata: RepositoryStorageMetadata = {
    repositoryName:
      update.repositoryName || existing?.repositoryName || path.basename(repositoryDir),
    remoteLabel: normaliseUpdatedValue(update.remoteLabel, existing?.remoteLabel),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastGitRoot: normaliseUpdatedValue(update.lastGitRoot, existing?.lastGitRoot),
    externalConfigPath: normaliseUpdatedValue(
      update.externalConfigPath,
      existing?.externalConfigPath
    ),
    externalTasksDir: normaliseUpdatedValue(update.externalTasksDir, existing?.externalTasksDir),
  };

  const serialised = JSON.stringify(metadata, null, 2);
  await fs.writeFile(metadataPath, `${serialised}\n`, 'utf8');
  return metadata;
}
