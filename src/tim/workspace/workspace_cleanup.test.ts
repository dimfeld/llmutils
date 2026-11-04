import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { $ } from 'bun';

import { closeDatabaseForTesting, getDatabase } from '../db/database.js';
import { getOrCreateProject } from '../db/project.js';
import { getWorkspaceByPath, recordWorkspace, type WorkspaceType } from '../db/workspace.js';
import type { TimConfig } from '../configSchema.js';
import {
  cleanupWorkspaces,
  resolveWorkspaceCleanupSettings,
  type WorkspaceCleanupSettings,
} from './workspace_cleanup.js';
import { findWorkspaceInfosByRepositoryId } from './workspace_info.js';
import { WorkspaceLock } from './workspace_lock.js';

const REPO_ID = 'github.com/test/cleanup-repo';
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-04T12:00:00.000Z');

const DEFAULT_SETTINGS: WorkspaceCleanupSettings = {
  enabled: true,
  disableAfterDays: 7,
  deleteAfterDays: 3,
};

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString();
}

describe('resolveWorkspaceCleanupSettings', () => {
  test('uses one week and three days by default', () => {
    expect(resolveWorkspaceCleanupSettings({} as TimConfig)).toEqual({
      enabled: true,
      disableAfterDays: 7,
      deleteAfterDays: 3,
    });
  });

  test('uses configured values', () => {
    expect(
      resolveWorkspaceCleanupSettings({
        workspaceCleanup: { enabled: false, disableAfterDays: 14, deleteAfterDays: 0 },
      } as TimConfig)
    ).toEqual({ enabled: false, disableAfterDays: 14, deleteAfterDays: 0 });
  });
});

describe('cleanupWorkspaces', () => {
  let testDir: string;
  let originalEnv: { XDG_CONFIG_HOME?: string; APPDATA?: string };

  async function createGitRepo(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    await $`git init -q`.cwd(dir).quiet();
    await fs.writeFile(path.join(dir, 'README.md'), 'hello\n');
    await $`git add README.md`.cwd(dir).quiet();
    await $`git -c user.email=test@example.com -c user.name=Test commit -q -m init`
      .cwd(dir)
      .quiet();
  }

  async function seed(
    name: string,
    options: {
      type?: WorkspaceType;
      createdDaysAgo: number;
      disabledDaysAgo?: number;
      createDir?: boolean;
    }
  ): Promise<string> {
    const workspacePath = path.join(testDir, name);
    if (options.createDir !== false) {
      await createGitRepo(workspacePath);
    }

    const db = getDatabase();
    const project = getOrCreateProject(db, REPO_ID);
    recordWorkspace(db, {
      projectId: project.id,
      workspacePath,
      taskId: name,
      workspaceType: options.type ?? 'auto',
    });
    db.prepare('UPDATE workspace SET created_at = ?, disabled_at = ? WHERE workspace_path = ?').run(
      daysAgo(options.createdDaysAgo),
      options.disabledDaysAgo === undefined ? null : daysAgo(options.disabledDaysAgo),
      workspacePath
    );
    return workspacePath;
  }

  async function exists(p: string): Promise<boolean> {
    return fs
      .stat(p)
      .then(() => true)
      .catch(() => false);
  }

  function workspaces() {
    return findWorkspaceInfosByRepositoryId(REPO_ID);
  }

  beforeEach(async () => {
    testDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-cleanup-test-'))
    );
    originalEnv = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, APPDATA: process.env.APPDATA };
    process.env.XDG_CONFIG_HOME = path.join(testDir, 'config');
    delete process.env.APPDATA;
    closeDatabaseForTesting();
  });

  afterEach(async () => {
    closeDatabaseForTesting();
    if (originalEnv.XDG_CONFIG_HOME === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalEnv.XDG_CONFIG_HOME;
    }
    if (originalEnv.APPDATA !== undefined) {
      process.env.APPDATA = originalEnv.APPDATA;
    }
    await fs.rm(testDir, { recursive: true, force: true });
  });

  test('disables auto workspaces older than disableAfterDays', async () => {
    const oldPath = await seed('old', { createdDaysAgo: 8 });
    const youngPath = await seed('young', { createdDaysAgo: 6 });

    const result = await cleanupWorkspaces(workspaces(), DEFAULT_SETTINGS, { now: NOW });

    expect(result.disabled).toEqual([oldPath]);
    expect(result.deleted).toEqual([]);
    const db = getDatabase();
    expect(getWorkspaceByPath(db, oldPath)?.disabled_at).toBe(NOW.toISOString());
    expect(getWorkspaceByPath(db, youngPath)?.disabled_at).toBeNull();
  });

  test('does not touch standard or primary workspaces', async () => {
    const standardPath = await seed('standard', {
      type: 'standard',
      createdDaysAgo: 30,
      disabledDaysAgo: 20,
    });
    const primaryPath = await seed('primary', { type: 'primary', createdDaysAgo: 30 });

    const result = await cleanupWorkspaces(workspaces(), DEFAULT_SETTINGS, { now: NOW });

    expect(result).toEqual({ disabled: [], deleted: [], skipped: [] });
    expect(await exists(standardPath)).toBe(true);
    expect(await exists(primaryPath)).toBe(true);
    expect(getWorkspaceByPath(getDatabase(), primaryPath)?.disabled_at).toBeNull();
  });

  test('deletes workspaces disabled longer than deleteAfterDays', async () => {
    const duePath = await seed('due', { createdDaysAgo: 11, disabledDaysAgo: 4 });
    const recentPath = await seed('recent', { createdDaysAgo: 9, disabledDaysAgo: 2 });

    const result = await cleanupWorkspaces(workspaces(), DEFAULT_SETTINGS, { now: NOW });

    expect(result.deleted).toEqual([duePath]);
    expect(result.skipped).toEqual([]);
    expect(await exists(duePath)).toBe(false);
    expect(getWorkspaceByPath(getDatabase(), duePath)).toBeNull();
    expect(await exists(recentPath)).toBe(true);
    expect(getWorkspaceByPath(getDatabase(), recentPath)).not.toBeNull();
  });

  test('measures the delete delay from the disable time, not the creation time', async () => {
    // Created long ago, but disabled only now: it gets the full delete delay.
    const workspacePath = await seed('late', { createdDaysAgo: 60 });

    const result = await cleanupWorkspaces(workspaces(), DEFAULT_SETTINGS, { now: NOW });

    expect(result.disabled).toEqual([workspacePath]);
    expect(result.deleted).toEqual([]);
    expect(await exists(workspacePath)).toBe(true);
  });

  test('uses configured day counts', async () => {
    const workspacePath = await seed('custom', { createdDaysAgo: 2 });

    const result = await cleanupWorkspaces(
      workspaces(),
      { enabled: true, disableAfterDays: 1, deleteAfterDays: 0 },
      { now: NOW }
    );

    expect(result.disabled).toEqual([workspacePath]);
    expect(result.deleted).toEqual([workspacePath]);
    expect(await exists(workspacePath)).toBe(false);
  });

  test('does nothing when disabled in settings', async () => {
    const workspacePath = await seed('due', { createdDaysAgo: 30, disabledDaysAgo: 10 });

    const result = await cleanupWorkspaces(
      workspaces(),
      { ...DEFAULT_SETTINGS, enabled: false },
      { now: NOW }
    );

    expect(result).toEqual({ disabled: [], deleted: [], skipped: [] });
    expect(await exists(workspacePath)).toBe(true);
  });

  test('keeps a locked workspace', async () => {
    const workspacePath = await seed('locked', { createdDaysAgo: 30, disabledDaysAgo: 10 });
    await WorkspaceLock.acquireLock(workspacePath, 'tim agent');

    const result = await cleanupWorkspaces(workspaces(), DEFAULT_SETTINGS, { now: NOW });

    expect(result.deleted).toEqual([]);
    expect(result.skipped).toEqual([{ workspacePath, reason: 'workspace is locked' }]);
    expect(await exists(workspacePath)).toBe(true);
  });

  test('keeps a workspace with uncommitted changes', async () => {
    const workspacePath = await seed('dirty', { createdDaysAgo: 30, disabledDaysAgo: 10 });
    await fs.writeFile(path.join(workspacePath, 'new-file.txt'), 'work in progress\n');

    const result = await cleanupWorkspaces(workspaces(), DEFAULT_SETTINGS, { now: NOW });

    expect(result.skipped).toEqual([
      { workspacePath, reason: 'workspace has uncommitted changes' },
    ]);
    expect(await exists(workspacePath)).toBe(true);
  });

  test('keeps a workspace when the change check fails', async () => {
    const workspacePath = path.join(testDir, 'not-a-repo');
    await fs.mkdir(workspacePath, { recursive: true });
    await seed('not-a-repo', { createdDaysAgo: 30, disabledDaysAgo: 10, createDir: false });

    const result = await cleanupWorkspaces(workspaces(), DEFAULT_SETTINGS, { now: NOW });

    expect(result.skipped).toEqual([
      { workspacePath, reason: 'could not check for uncommitted changes' },
    ]);
    expect(await exists(workspacePath)).toBe(true);
  });

  test('keeps a workspace that contains a protected path', async () => {
    const workspacePath = await seed('protected', { createdDaysAgo: 30, disabledDaysAgo: 10 });
    const nested = path.join(workspacePath, 'sub');
    await fs.mkdir(nested);

    const result = await cleanupWorkspaces(workspaces(), DEFAULT_SETTINGS, {
      now: NOW,
      protectedPaths: [nested],
    });

    expect(result.skipped).toEqual([
      { workspacePath, reason: 'workspace contains the current directory or repository' },
    ]);
    expect(await exists(workspacePath)).toBe(true);
  });

  test('keeps a workspace whose path is a symbolic link', async () => {
    const targetPath = path.join(testDir, 'link-target');
    await createGitRepo(targetPath);
    const linkPath = path.join(testDir, 'link');
    await fs.symlink(targetPath, linkPath);
    await seed('link', { createdDaysAgo: 30, disabledDaysAgo: 10, createDir: false });

    const result = await cleanupWorkspaces(workspaces(), DEFAULT_SETTINGS, { now: NOW });

    expect(result.skipped).toEqual([
      { workspacePath: linkPath, reason: 'workspace path is a symbolic link' },
    ]);
    expect(await exists(targetPath)).toBe(true);
  });

  test('removes the record when the directory is already gone', async () => {
    const workspacePath = await seed('gone', {
      createdDaysAgo: 30,
      disabledDaysAgo: 10,
      createDir: false,
    });

    const result = await cleanupWorkspaces(workspaces(), DEFAULT_SETTINGS, { now: NOW });

    expect(result.deleted).toEqual([workspacePath]);
    expect(getWorkspaceByPath(getDatabase(), workspacePath)).toBeNull();
  });

  test('dry run reports changes without making them', async () => {
    const toDisablePath = await seed('to-disable', { createdDaysAgo: 8 });
    const toDeletePath = await seed('to-delete', { createdDaysAgo: 30, disabledDaysAgo: 10 });

    const result = await cleanupWorkspaces(workspaces(), DEFAULT_SETTINGS, {
      now: NOW,
      dryRun: true,
    });

    expect(result.disabled).toEqual([toDisablePath]);
    expect(result.deleted).toEqual([toDeletePath]);
    const db = getDatabase();
    expect(getWorkspaceByPath(db, toDisablePath)?.disabled_at).toBeNull();
    expect(getWorkspaceByPath(db, toDeletePath)).not.toBeNull();
    expect(await exists(toDeletePath)).toBe(true);
  });
});
