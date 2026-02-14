import * as path from 'node:path';

import { getTimConfigRoot } from '../common/config_paths.js';
import { parseGitRemoteUrl } from '../common/git_url_parser.js';
import { getDatabase } from './db/database.js';
import { getOrCreateProject, getProject, updateProject } from './db/project.js';

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
  return path.join(getTimConfigRoot(), 'repositories');
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

export async function readRepositoryStorageMetadata(
  repositoryDir: string
): Promise<RepositoryStorageMetadata | null> {
  const repositoryName = path.basename(repositoryDir);
  const db = getDatabase();
  const project = getProject(db, repositoryName);
  if (!project) {
    return null;
  }

  return {
    repositoryName,
    createdAt: project.created_at,
    updatedAt: project.updated_at,
    remoteLabel: project.remote_label ?? undefined,
    lastGitRoot: project.last_git_root ?? undefined,
    externalConfigPath: project.external_config_path ?? undefined,
    externalTasksDir: project.external_tasks_dir ?? undefined,
  };
}

export async function writeRepositoryStorageMetadata(
  repositoryDir: string,
  update: RepositoryStorageMetadataInput
): Promise<RepositoryStorageMetadata> {
  const repositoryName = update.repositoryName || path.basename(repositoryDir);
  const db = getDatabase();
  const existing = getProject(db, repositoryName);
  const project =
    existing ??
    getOrCreateProject(db, repositoryName, {
      remoteLabel: update.remoteLabel ?? null,
      lastGitRoot: update.lastGitRoot ?? null,
      externalConfigPath: update.externalConfigPath ?? null,
      externalTasksDir: update.externalTasksDir ?? null,
    });

  const updates: {
    remoteLabel?: string | null;
    lastGitRoot?: string | null;
    externalConfigPath?: string | null;
    externalTasksDir?: string | null;
  } = {};
  if ('remoteLabel' in update) {
    updates.remoteLabel = update.remoteLabel ?? null;
  }
  if ('lastGitRoot' in update) {
    updates.lastGitRoot = update.lastGitRoot ?? null;
  }
  if ('externalConfigPath' in update) {
    updates.externalConfigPath = update.externalConfigPath ?? null;
  }
  if ('externalTasksDir' in update) {
    updates.externalTasksDir = update.externalTasksDir ?? null;
  }

  const persisted =
    Object.keys(updates).length > 0 ? (updateProject(db, project.id, updates) ?? project) : project;

  return {
    repositoryName,
    createdAt: persisted.created_at,
    updatedAt: persisted.updated_at,
    remoteLabel: persisted.remote_label ?? undefined,
    lastGitRoot: persisted.last_git_root ?? undefined,
    externalConfigPath: persisted.external_config_path ?? undefined,
    externalTasksDir: persisted.external_tasks_dir ?? undefined,
  };
}
