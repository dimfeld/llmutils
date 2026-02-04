import { $ } from 'bun';
import { realpathSync } from 'node:fs';
import * as path from 'node:path';

import { getGitRoot } from '../../common/git.js';
import {
  deriveRepositoryName,
  fallbackRepositoryNameFromGitRoot,
  parseGitRemoteUrl,
} from '../../common/git_url_parser.js';

export interface RepositoryIdentity {
  repositoryId: string;
  remoteUrl: string | null;
  gitRoot: string;
}

export interface WorkspacePathOptions {
  cwd?: string;
}

export async function getCurrentWorkspacePath(options: WorkspacePathOptions = {}): Promise<string> {
  const gitRoot = await getGitRoot(options.cwd);
  const resolved =
    typeof realpathSync.native === 'function'
      ? realpathSync.native(gitRoot)
      : realpathSync(gitRoot);
  return normalizeWorkspacePath(resolved);
}

export interface RepositoryIdOptions {
  cwd?: string;
}

export async function getRepositoryIdentity(
  options: RepositoryIdOptions = {}
): Promise<RepositoryIdentity> {
  const workspacePath = await getCurrentWorkspacePath(options);
  const remoteUrl = await resolveOriginRemote(workspacePath);
  const parsedRemote = remoteUrl ? parseGitRemoteUrl(remoteUrl) : null;
  const fallbackName = fallbackRepositoryNameFromGitRoot(workspacePath);

  const repositoryId = deriveRepositoryName(parsedRemote, {
    fallbackName,
    uniqueSalt: workspacePath,
  });

  return {
    repositoryId,
    remoteUrl,
    gitRoot: workspacePath,
  };
}

export function getUserIdentity(): string | null {
  const candidates = [
    process.env.TIM_USER,
    process.env.USER,
    process.env.USERNAME,
    process.env.LOGNAME,
  ];

  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value) {
      return value;
    }
  }

  return null;
}

function normalizeWorkspacePath(input: string): string {
  const normalized = path.resolve(input);
  if (process.platform === 'win32') {
    const withBackslashes = normalized.replace(/\//g, '\\');
    return normalizeDriveLetter(withBackslashes);
  }

  return normalized;
}

function normalizeDriveLetter(p: string): string {
  if (!/^[a-zA-Z]:/.test(p)) {
    return p;
  }
  return p.charAt(0).toUpperCase() + p.slice(1);
}

async function resolveOriginRemote(gitRoot: string): Promise<string | null> {
  const result = await $`git remote get-url origin`.cwd(gitRoot).quiet().nothrow();
  if (result.exitCode !== 0) {
    return null;
  }

  const remote = result.stdout.toString().trim();
  return remote.length > 0 ? remote : null;
}
