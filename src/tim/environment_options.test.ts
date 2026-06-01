import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Database } from 'bun:sqlite';
import {
  buildTimWorkspaceCommandEnvironmentOptions,
  buildTimWorkspaceCommandEnvironmentOptionsForPath,
} from './environment_options.js';
import { DATABASE_FILENAME, getDatabase, openDatabase } from './db/database.js';
import { getOrCreateProject } from './db/project.js';
import { recordWorkspace } from './db/workspace.js';

vi.mock('./db/database.js', async (importActual) => ({
  ...(await importActual<typeof import('./db/database.js')>()),
  getDatabase: vi.fn(),
}));

describe('environment options', () => {
  beforeEach(() => {
    vi.mocked(getDatabase).mockReset();
  });

  test('falls back to explicit context when workspace database is unavailable', () => {
    vi.mocked(getDatabase).mockReturnValue({} as never);

    const options = buildTimWorkspaceCommandEnvironmentOptions({
      config: {
        environment: {
          TIM_MARKER: '{{workspaceId}}:{{planId}}',
        },
      },
      cwd: '/repo',
      workspace: {
        workspaceId: 'workspace-1',
        workspaceName: 'Workspace 1',
        workspacePath: '/repo/workspace-1',
      },
      plan: {
        planId: 374,
        planUuid: 'plan-uuid',
        branch: 'plan-374',
      },
    });

    expect(options.context).toMatchObject({
      workspaceId: 'workspace-1',
      workspaceName: 'Workspace 1',
      workspacePath: '/repo/workspace-1',
      repoPath: '/repo',
      planId: '374',
      planUuid: 'plan-uuid',
      branch: 'plan-374',
    });
  });

  test('does not inspect workspace metadata when database handle is not usable', () => {
    vi.mocked(getDatabase).mockReturnValue({} as never);

    const options = buildTimWorkspaceCommandEnvironmentOptionsForPath(
      { environment: undefined },
      '/repo/workspace',
      {
        branch: 'review-head',
      }
    );

    expect(options.context).toMatchObject({
      repoPath: '/repo/workspace',
      workspacePath: '/repo/workspace',
      branch: 'review-head',
    });
    expect(options.context.workspaceId).toBeUndefined();
  });

  describe('workspace detection for cwd paths', () => {
    let tempDir: string;
    let db: Database;
    let projectId: number;

    beforeEach(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-env-options-test-'));
      db = openDatabase(path.join(tempDir, DATABASE_FILENAME));
      projectId = getOrCreateProject(db, 'github.com/test/repo').id;
      vi.mocked(getDatabase).mockReturnValue(db);
    });

    afterEach(async () => {
      db.close(false);
      await fs.rm(tempDir, { recursive: true, force: true });
    });

    test('detects the nearest registered workspace when cwd is a child directory', async () => {
      const workspacePath = path.join(tempDir, 'workspace');
      const childPath = path.join(workspacePath, 'src', 'feature');
      await fs.mkdir(childPath, { recursive: true });

      recordWorkspace(db, {
        projectId,
        taskId: 'task-374',
        workspacePath,
        name: 'Task 374 Workspace',
      });

      const options = buildTimWorkspaceCommandEnvironmentOptionsForPath(
        { environment: undefined },
        childPath,
        {
          planId: 374,
          branch: 'plan-374',
        },
        tempDir
      );

      expect(options.context).toMatchObject({
        workspaceId: 'task-374',
        workspaceName: 'Task 374 Workspace',
        workspacePath,
        repoPath: tempDir,
        planId: '374',
        branch: 'plan-374',
      });
    });

    test('falls back to cwd workspacePath for an unregistered primary checkout', async () => {
      const primaryPath = path.join(tempDir, 'primary');
      await fs.mkdir(primaryPath, { recursive: true });

      const options = buildTimWorkspaceCommandEnvironmentOptionsForPath(
        { environment: undefined },
        primaryPath,
        {
          branch: 'main',
        }
      );

      expect(options.context).toMatchObject({
        repoPath: primaryPath,
        workspacePath: primaryPath,
        branch: 'main',
      });
      expect(options.context.workspaceId).toBeUndefined();
      expect(options.context.workspaceName).toBeUndefined();
    });
  });
});
