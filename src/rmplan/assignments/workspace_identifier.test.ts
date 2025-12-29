import { $ } from 'bun';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  deriveRepositoryName,
  fallbackRepositoryNameFromGitRoot,
  parseGitRemoteUrl,
} from '../../common/git_url_parser.js';
import {
  getCurrentWorkspacePath,
  getRepositoryIdentity,
  getUserIdentity,
} from './workspace_identifier.js';

describe('workspace_identifier', () => {
  let tempDir: string;
  const originalEnv: Partial<Record<string, string>> = {};

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-identifier-'));
    originalEnv.RMPLAN_USER = process.env.RMPLAN_USER;
    originalEnv.USER = process.env.USER;
    originalEnv.USERNAME = process.env.USERNAME;
    originalEnv.LOGNAME = process.env.LOGNAME;
    delete process.env.RMPLAN_USER;
    delete process.env.USER;
    delete process.env.USERNAME;
    delete process.env.LOGNAME;
  });

  afterEach(async () => {
    if (originalEnv.RMPLAN_USER === undefined) {
      delete process.env.RMPLAN_USER;
    } else {
      process.env.RMPLAN_USER = originalEnv.RMPLAN_USER;
    }
    if (originalEnv.USER === undefined) {
      delete process.env.USER;
    } else {
      process.env.USER = originalEnv.USER;
    }
    if (originalEnv.USERNAME === undefined) {
      delete process.env.USERNAME;
    } else {
      process.env.USERNAME = originalEnv.USERNAME;
    }
    if (originalEnv.LOGNAME === undefined) {
      delete process.env.LOGNAME;
    } else {
      process.env.LOGNAME = originalEnv.LOGNAME;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('getCurrentWorkspacePath resolves symlinks and normalizes paths', async () => {
    const repoDir = path.join(tempDir, 'RepoSource');
    await fs.mkdir(repoDir, { recursive: true });
    await $`git init`.cwd(repoDir).quiet();

    const linkDir = path.join(tempDir, 'linked');
    await fs.symlink(repoDir, linkDir);

    const workspace = await getCurrentWorkspacePath({ cwd: linkDir });
    expect(workspace).toBe(realpathSync(repoDir));
  });

  test('getCurrentWorkspacePath returns git root when invoked from subdirectories', async () => {
    const repoDir = path.join(tempDir, 'CaseSensitiveRepo');
    await fs.mkdir(path.join(repoDir, 'nested', 'level'), { recursive: true });
    await $`git init`.cwd(repoDir).quiet();

    const workspace = await getCurrentWorkspacePath({ cwd: path.join(repoDir, 'nested', 'level') });
    expect(workspace).toBe(realpathSync(repoDir));
  });

  test('getRepositoryIdentity derives ID from remote url', async () => {
    const repoDir = path.join(tempDir, 'RemoteRepo');
    await fs.mkdir(repoDir, { recursive: true });
    await $`git init`.cwd(repoDir).quiet();

    const remote = 'git@github.com:Owner Space/Client Repo.git';
    await $`git remote add origin ${remote}`.cwd(repoDir).quiet();

    const identity = await getRepositoryIdentity({ cwd: repoDir });
    const workspacePath = realpathSync(repoDir);
    const parsed = parseGitRemoteUrl(remote);
    const fallback = fallbackRepositoryNameFromGitRoot(workspacePath);
    const expectedId = deriveRepositoryName(parsed, {
      fallbackName: fallback,
      uniqueSalt: workspacePath,
    });

    expect(identity.remoteUrl).toBe(remote);
    expect(identity.repositoryId).toBe(expectedId);
    expect(identity.gitRoot).toBe(workspacePath);
  });

  test('getRepositoryIdentity falls back to git root name when remote missing', async () => {
    const repoDir = path.join(tempDir, 'NoRemoteRepo');
    await fs.mkdir(repoDir, { recursive: true });
    await $`git init`.cwd(repoDir).quiet();

    const identity = await getRepositoryIdentity({ cwd: repoDir });
    const workspacePath = realpathSync(repoDir);
    const fallback = fallbackRepositoryNameFromGitRoot(workspacePath);
    const expectedId = deriveRepositoryName(null, {
      fallbackName: fallback,
      uniqueSalt: workspacePath,
    });

    expect(identity.remoteUrl).toBeNull();
    expect(identity.repositoryId).toBe(expectedId);
  });

  test('getRepositoryIdentity falls back to workspace name for jj repositories', async () => {
    const repoDir = path.join(tempDir, 'JjOnlyRepo');
    await fs.mkdir(path.join(repoDir, '.jj'), { recursive: true });

    const identity = await getRepositoryIdentity({ cwd: repoDir });
    const workspacePath = realpathSync(repoDir);
    const fallback = fallbackRepositoryNameFromGitRoot(workspacePath);
    const expectedId = deriveRepositoryName(null, {
      fallbackName: fallback,
      uniqueSalt: workspacePath,
    });

    expect(identity.remoteUrl).toBeNull();
    expect(identity.repositoryId).toBe(expectedId);
    expect(identity.gitRoot).toBe(workspacePath);
  });

  test('getUserIdentity prefers RMPLAN_USER over other environment variables', () => {
    process.env.USER = 'bob';
    process.env.USERNAME = 'charlie';
    process.env.RMPLAN_USER = ' alice ';

    expect(getUserIdentity()).toBe('alice');
  });

  test('getUserIdentity falls back through USERNAME and LOGNAME', () => {
    process.env.USER = '';
    process.env.USERNAME = 'dora';

    expect(getUserIdentity()).toBe('dora');

    delete process.env.USERNAME;
    process.env.LOGNAME = 'eve';
    expect(getUserIdentity()).toBe('eve');
  });

  test('getUserIdentity returns null when no identifiers available', () => {
    expect(getUserIdentity()).toBeNull();
  });
});
