import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ModuleMocker } from '../../testing.js';
import { closeDatabaseForTesting, getDatabase } from '../db/database.js';
import { getOrCreateProject, getProjectById, listProjects } from '../db/project.js';
import {
  findWorkspacesByProjectId,
  getWorkspaceIssues,
  recordWorkspace,
  setWorkspaceIssues,
  type WorkspaceRow,
} from '../db/workspace.js';

let moduleMocker: ModuleMocker;
let tempDir: string;
let tasksDir: string;
let originalCwd: string;
let originalEnv: { XDG_CONFIG_HOME?: string; APPDATA?: string };

const logSpy = mock(() => {});
const warnSpy = mock(() => {});

interface WorkspaceInfo {
  taskId: string;
  workspacePath: string;
  repositoryId?: string;
  originalPlanFilePath?: string;
  branch?: string;
  createdAt?: string;
  name?: string;
  description?: string;
  planId?: string;
  planTitle?: string;
  issueUrls?: string[];
  isPrimary?: boolean;
}

async function writeTrackingData(data: Record<string, WorkspaceInfo>) {
  const db = getDatabase();
  for (const workspace of Object.values(data)) {
    const project = getOrCreateProject(db, workspace.repositoryId ?? 'example-repo');
    const row = recordWorkspace(db, {
      projectId: project.id,
      taskId: workspace.taskId,
      workspacePath: workspace.workspacePath,
      originalPlanFilePath: workspace.originalPlanFilePath,
      branch: workspace.branch,
      name: workspace.name,
      description: workspace.description,
      planId: workspace.planId,
      planTitle: workspace.planTitle,
    });
    if (workspace.isPrimary) {
      db.prepare('UPDATE workspace SET is_primary = 1 WHERE id = ?').run(row.id);
    }
    setWorkspaceIssues(db, row.id, workspace.issueUrls ?? []);
  }
}

async function readTrackingData(): Promise<Record<string, WorkspaceInfo>> {
  const db = getDatabase();
  const result: Record<string, WorkspaceInfo> = {};
  for (const project of listProjects(db)) {
    const rows = findWorkspacesByProjectId(db, project.id);
    for (const row of rows) {
      const info = rowToWorkspaceInfo(db, row);
      result[info.workspacePath] = info;
    }
  }
  return result;
}

function rowToWorkspaceInfo(db: ReturnType<typeof getDatabase>, row: WorkspaceRow): WorkspaceInfo {
  const project = getProjectById(db, row.project_id);
  const issueUrls = getWorkspaceIssues(db, row.id);
  return {
    taskId: row.task_id ?? path.basename(row.workspace_path),
    workspacePath: row.workspace_path,
    repositoryId: project?.repository_id,
    originalPlanFilePath: row.original_plan_file_path ?? undefined,
    branch: row.branch ?? undefined,
    name: row.name ?? undefined,
    description: row.description ?? undefined,
    planId: row.plan_id ?? undefined,
    planTitle: row.plan_title ?? undefined,
    issueUrls: issueUrls.length ? issueUrls : undefined,
    isPrimary: row.is_primary === 1 ? true : undefined,
    createdAt: row.created_at,
  };
}

describe('workspace update command', () => {
  beforeEach(async () => {
    moduleMocker = new ModuleMocker(import.meta);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-update-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    originalCwd = process.cwd();
    originalEnv = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      APPDATA: process.env.APPDATA,
    };
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'config');
    delete process.env.APPDATA;
    closeDatabaseForTesting();

    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
      warn: warnSpy,
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: {
          tasksDir,
        },
      }),
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => tempDir,
    }));

    await moduleMocker.mock('../assignments/workspace_identifier.js', () => ({
      getRepositoryIdentity: async () => ({
        repositoryId: 'example-repo',
        remoteUrl: 'https://example.com/repo.git',
        gitRoot: tempDir,
      }),
      getUserIdentity: () => 'tester',
    }));

    await moduleMocker.mock('../assignments/workspace_identifier.js', () => ({
      getRepositoryIdentity: async () => ({
        repositoryId: 'example-repo',
        remoteUrl: 'https://example.com/repo.git',
        gitRoot: tempDir,
      }),
      getUserIdentity: () => 'tester',
    }));
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    moduleMocker.clear();
    closeDatabaseForTesting();
    if (originalEnv.XDG_CONFIG_HOME === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalEnv.XDG_CONFIG_HOME;
    }
    if (originalEnv.APPDATA === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalEnv.APPDATA;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
    logSpy.mockClear();
    warnSpy.mockClear();
  });

  test('updates workspace name and description by path', async () => {
    const workspaceDir = path.join(tempDir, 'workspace-1');
    await fs.mkdir(workspaceDir, { recursive: true });

    const workspaceEntry: WorkspaceInfo = {
      taskId: 'task-1',
      workspacePath: workspaceDir,
      branch: 'feature-branch',
      createdAt: new Date().toISOString(),
      repositoryId: 'example-repo',
    };

    await writeTrackingData({ [workspaceDir]: workspaceEntry });

    const { handleWorkspaceUpdateCommand } = await import('./workspace.js');

    await handleWorkspaceUpdateCommand(
      workspaceDir,
      { name: 'My Workspace', description: 'Working on feature X' },
      {
        parent: {
          parent: {
            opts: () => ({ config: undefined }),
          },
        },
      } as any
    );

    const data = await readTrackingData();
    expect(data[workspaceDir].name).toBe('My Workspace');
    expect(data[workspaceDir].description).toBe('Working on feature X');
    // Original fields should be preserved
    expect(data[workspaceDir].taskId).toBe('task-1');
    expect(data[workspaceDir].branch).toBe('feature-branch');
  });

  test('updates workspace by task ID', async () => {
    const workspaceDir = path.join(tempDir, 'workspace-task-456');
    await fs.mkdir(workspaceDir, { recursive: true });

    const workspaceEntry: WorkspaceInfo = {
      taskId: 'task-456',
      workspacePath: workspaceDir,
      createdAt: new Date().toISOString(),
      repositoryId: 'example-repo',
    };

    await writeTrackingData({ [workspaceDir]: workspaceEntry });

    const { handleWorkspaceUpdateCommand } = await import('./workspace.js');

    await handleWorkspaceUpdateCommand('task-456', { description: 'Updated via task ID' }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    const data = await readTrackingData();
    expect(data[workspaceDir].description).toBe('Updated via task ID');
  });

  test('updates current workspace when no identifier provided', async () => {
    const workspaceDirRaw = path.join(tempDir, 'current-workspace');
    await fs.mkdir(workspaceDirRaw, { recursive: true });
    const workspaceDir = await fs.realpath(workspaceDirRaw);

    const workspaceEntry: WorkspaceInfo = {
      taskId: 'task-current',
      workspacePath: workspaceDir,
      createdAt: new Date().toISOString(),
      repositoryId: 'example-repo',
    };

    await writeTrackingData({ [workspaceDir]: workspaceEntry });

    // Change to the workspace directory
    process.chdir(workspaceDir);

    // Re-import to get the module with process.cwd() in the new directory
    const workspace = await import('./workspace.js');

    await workspace.handleWorkspaceUpdateCommand(
      undefined,
      { name: 'Current Workspace', description: 'Updated current workspace' },
      {
        parent: {
          parent: {
            opts: () => ({ config: undefined }),
          },
        },
      } as any
    );

    const data = await readTrackingData();
    // The workspace path used is process.cwd() which is now workspaceDir
    // patchWorkspaceMetadata creates or updates the entry at the workspace path
    const currentDir = process.cwd();
    expect(data[currentDir]).toBeDefined();
    expect(data[currentDir].name).toBe('Current Workspace');
    expect(data[currentDir].description).toBe('Updated current workspace');
  });

  test('errors for untracked workspace directory', async () => {
    const workspaceDir = path.join(tempDir, 'untracked-workspace');
    await fs.mkdir(workspaceDir, { recursive: true });

    // Start with empty tracking data
    await writeTrackingData({});

    const { handleWorkspaceUpdateCommand } = await import('./workspace.js');

    await expect(
      handleWorkspaceUpdateCommand(
        workspaceDir,
        { name: 'New Workspace', description: 'Newly tracked workspace' },
        {
          parent: {
            parent: {
              opts: () => ({ config: undefined }),
            },
          },
        } as any
      )
    ).rejects.toThrow(`Workspace not found: ${workspaceDir}`);
  });

  test('clears name with empty string', async () => {
    const workspaceDir = path.join(tempDir, 'workspace-clear');
    await fs.mkdir(workspaceDir, { recursive: true });

    const workspaceEntry: WorkspaceInfo = {
      taskId: 'task-clear',
      workspacePath: workspaceDir,
      createdAt: new Date().toISOString(),
      name: 'Old Name',
      description: 'Old Description',
    };

    await writeTrackingData({ [workspaceDir]: workspaceEntry });

    const { handleWorkspaceUpdateCommand } = await import('./workspace.js');

    await handleWorkspaceUpdateCommand(workspaceDir, { name: '' }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    const data = await readTrackingData();
    expect(data[workspaceDir].name).toBeUndefined();
    // Description should be preserved
    expect(data[workspaceDir].description).toBe('Old Description');
  });

  test('marks workspace as primary when requested', async () => {
    const workspaceDir = path.join(tempDir, 'workspace-primary');
    await fs.mkdir(workspaceDir, { recursive: true });

    await writeTrackingData({
      [workspaceDir]: {
        taskId: 'task-primary',
        workspacePath: workspaceDir,
        createdAt: new Date().toISOString(),
      },
    });

    const { handleWorkspaceUpdateCommand } = await import('./workspace.js');

    await handleWorkspaceUpdateCommand(workspaceDir, { primary: true }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    const data = await readTrackingData();
    expect(data[workspaceDir].isPrimary).toBe(true);
  });

  test('removes primary designation when --no-primary is used', async () => {
    const workspaceDir = path.join(tempDir, 'workspace-no-primary');
    await fs.mkdir(workspaceDir, { recursive: true });

    await writeTrackingData({
      [workspaceDir]: {
        taskId: 'task-no-primary',
        workspacePath: workspaceDir,
        createdAt: new Date().toISOString(),
        isPrimary: true,
      },
    });

    const { handleWorkspaceUpdateCommand } = await import('./workspace.js');

    await handleWorkspaceUpdateCommand(workspaceDir, { primary: false }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    const data = await readTrackingData();
    expect(data[workspaceDir].isPrimary).toBeUndefined();
  });

  test('throws error when no update options provided', async () => {
    const workspaceDir = path.join(tempDir, 'workspace-no-opts');
    await fs.mkdir(workspaceDir, { recursive: true });

    const { handleWorkspaceUpdateCommand } = await import('./workspace.js');

    await expect(
      handleWorkspaceUpdateCommand(workspaceDir, {}, {
        parent: {
          parent: {
            opts: () => ({ config: undefined }),
          },
        },
      } as any)
    ).rejects.toThrow(
      'At least one of --name, --description, --from-plan, or --primary/--no-primary must be provided'
    );
  });

  test('throws error when target path does not exist and not a valid task ID', async () => {
    const nonExistentDir = path.join(tempDir, 'non-existent');

    await writeTrackingData({});

    const { handleWorkspaceUpdateCommand } = await import('./workspace.js');

    // When the directory doesn't exist, it falls through to task ID lookup
    // Since no task matches, it throws "No workspace found for task ID"
    await expect(
      handleWorkspaceUpdateCommand(nonExistentDir, { name: 'Test' }, {
        parent: {
          parent: {
            opts: () => ({ config: undefined }),
          },
        },
      } as any)
    ).rejects.toThrow('No workspace found for task ID');
  });

  test('throws error when task ID not found', async () => {
    await writeTrackingData({});

    const { handleWorkspaceUpdateCommand } = await import('./workspace.js');

    await expect(
      handleWorkspaceUpdateCommand('nonexistent-task', { name: 'Test' }, {
        parent: {
          parent: {
            opts: () => ({ config: undefined }),
          },
        },
      } as any)
    ).rejects.toThrow('No workspace found for task ID');
  });

  test('throws error when multiple workspaces found for task ID', async () => {
    const workspace1 = path.join(tempDir, 'workspace-dup-1');
    const workspace2 = path.join(tempDir, 'workspace-dup-2');
    await fs.mkdir(workspace1, { recursive: true });
    await fs.mkdir(workspace2, { recursive: true });

    const entry1: WorkspaceInfo = {
      taskId: 'duplicate-task',
      workspacePath: workspace1,
      createdAt: new Date().toISOString(),
    };
    const entry2: WorkspaceInfo = {
      taskId: 'duplicate-task',
      workspacePath: workspace2,
      createdAt: new Date().toISOString(),
    };

    await writeTrackingData({
      [workspace1]: entry1,
      [workspace2]: entry2,
    });

    const { handleWorkspaceUpdateCommand } = await import('./workspace.js');

    await expect(
      handleWorkspaceUpdateCommand('duplicate-task', { name: 'Test' }, {
        parent: {
          parent: {
            opts: () => ({ config: undefined }),
          },
        },
      } as any)
    ).rejects.toThrow('Multiple workspaces found for task ID');
  });

  test('updates from plan file with --from-plan', async () => {
    const workspaceDir = path.join(tempDir, 'workspace-from-plan');
    await fs.mkdir(workspaceDir, { recursive: true });

    const workspaceEntry: WorkspaceInfo = {
      taskId: 'task-plan',
      workspacePath: workspaceDir,
      createdAt: new Date().toISOString(),
    };

    await writeTrackingData({ [workspaceDir]: workspaceEntry });

    // Create a plan file
    const planContent = `---
id: 789
title: Implement Authentication
goal: Add OAuth2 support
issue:
  - https://github.com/example/repo/issues/789
---

## Details
Authentication implementation plan
`;
    const planFile = path.join(tasksDir, '789-implement-auth.plan.md');
    await fs.writeFile(planFile, planContent);

    // Re-mock to include plan resolution
    await moduleMocker.mock('../plans.js', () => ({
      resolvePlanFile: async (identifier: string) => {
        if (identifier === '789') {
          return planFile;
        }
        throw new Error(`Plan not found: ${identifier}`);
      },
      readPlanFile: async (filePath: string) => {
        if (filePath === planFile) {
          return {
            id: 789,
            title: 'Implement Authentication',
            goal: 'Add OAuth2 support',
            issue: ['https://github.com/example/repo/issues/789'],
          };
        }
        throw new Error(`Plan file not found: ${filePath}`);
      },
    }));

    const { handleWorkspaceUpdateCommand } = await import('./workspace.js');

    await handleWorkspaceUpdateCommand(workspaceDir, { fromPlan: '789' }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    const data = await readTrackingData();
    // Description should include issue number and title
    expect(data[workspaceDir].description).toBe('789 - #789 Implement Authentication');
    expect(data[workspaceDir].planId).toBe('789');
    expect(data[workspaceDir].planTitle).toBe('Implement Authentication');
    expect(data[workspaceDir].issueUrls).toEqual(['https://github.com/example/repo/issues/789']);
  });

  test('clears issue and plan metadata when plan omits them', async () => {
    const workspaceDir = path.join(tempDir, 'workspace-clear-metadata');
    await fs.mkdir(workspaceDir, { recursive: true });

    const workspaceEntry: WorkspaceInfo = {
      taskId: 'task-clear-meta',
      workspacePath: workspaceDir,
      createdAt: new Date().toISOString(),
      planId: '999',
      planTitle: 'Old Title',
      issueUrls: ['https://github.com/example/repo/issues/999'],
    };

    await writeTrackingData({ [workspaceDir]: workspaceEntry });

    const planFile = path.join(tasksDir, 'no-id.plan.md');
    await fs.writeFile(planFile, '---\ntitle: Maintenance\n---\n');

    await moduleMocker.mock('../plans.js', () => ({
      resolvePlanFile: async () => planFile,
      readPlanFile: async () => ({
        title: 'Maintenance',
        issue: [],
      }),
    }));

    const { handleWorkspaceUpdateCommand } = await import('./workspace.js');

    await handleWorkspaceUpdateCommand(workspaceDir, { fromPlan: 'no-id' }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    const data = await readTrackingData();
    expect(data[workspaceDir].description).toBe('Maintenance');
    expect(data[workspaceDir].planId).toBeUndefined();
    expect(data[workspaceDir].issueUrls).toBeUndefined();
  });
});

describe('extractIssueNumber helper', () => {
  async function runExtractCase(plan: Record<string, unknown>) {
    const localModuleMocker = new ModuleMocker(import.meta);
    const localTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-issue-test-'));
    const workspaceDir = path.join(localTempDir, 'workspace');
    await fs.mkdir(workspaceDir, { recursive: true });

    const originalEnv = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      APPDATA: process.env.APPDATA,
    };
    process.env.XDG_CONFIG_HOME = path.join(localTempDir, 'config');
    delete process.env.APPDATA;
    closeDatabaseForTesting();

    await writeTrackingData({
      [workspaceDir]: {
        taskId: 'task-extract',
        workspacePath: workspaceDir,
        repositoryId: 'example-repo',
      },
    });

    await localModuleMocker.mock('../../logging.js', () => ({
      log: mock(() => {}),
      warn: mock(() => {}),
    }));

    await localModuleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: {},
      }),
    }));

    await localModuleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => localTempDir,
    }));

    await localModuleMocker.mock('../assignments/workspace_identifier.js', () => ({
      getRepositoryIdentity: async () => ({
        repositoryId: 'example-repo',
        remoteUrl: 'https://example.com/repo.git',
        gitRoot: localTempDir,
      }),
      getUserIdentity: () => 'tester',
    }));

    await localModuleMocker.mock('../plans.js', () => ({
      resolvePlanFile: async () => '/fake/plan.md',
      readPlanFile: async () => plan,
    }));

    const { handleWorkspaceUpdateCommand } = await import('./workspace.js');
    await handleWorkspaceUpdateCommand(workspaceDir, { fromPlan: 'id' }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    const data = await readTrackingData();
    const updated = data[workspaceDir];

    localModuleMocker.clear();
    closeDatabaseForTesting();

    if (originalEnv.XDG_CONFIG_HOME === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalEnv.XDG_CONFIG_HOME;
    }
    if (originalEnv.APPDATA === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalEnv.APPDATA;
    }

    await fs.rm(localTempDir, { recursive: true, force: true });
    return updated;
  }

  test('extracts GitHub issue numbers correctly', async () => {
    const updated = await runExtractCase({
      id: 123,
      title: 'Fix Bug',
      issue: ['https://github.com/owner/repo/issues/123'],
    });
    expect(updated.description).toBe('123 - #123 Fix Bug');
  });

  test('extracts GitLab issue numbers correctly', async () => {
    const updated = await runExtractCase({
      id: 456,
      title: 'Add Feature',
      issue: ['https://gitlab.com/group/project/-/issues/456'],
    });
    expect(updated.description).toBe('456 - #456 Add Feature');
  });

  test('extracts Linear issue IDs correctly', async () => {
    const updated = await runExtractCase({
      id: 789,
      title: 'Implement Feature',
      issue: ['https://linear.app/team/issue/PROJ-123/implement-feature'],
    });
    expect(updated.description).toBe('789 - PROJ-123 Implement Feature');
  });

  test('extracts Jira issue IDs correctly', async () => {
    const updated = await runExtractCase({
      id: 101,
      title: 'Bug Fix',
      issue: ['https://company.atlassian.net/browse/PROJ-456'],
    });
    expect(updated.description).toBe('101 - PROJ-456 Bug Fix');
  });

  test('falls back to title only when no issue URL', async () => {
    const updated = await runExtractCase({
      id: 999,
      title: 'Standalone Task',
      goal: 'Some goal',
    });
    expect(updated.description).toBe('999 - Standalone Task');
  });

  test('handles unrecognized issue URL format gracefully', async () => {
    const updated = await runExtractCase({
      id: 888,
      title: 'Custom Tracker Task',
      issue: ['https://custom-tracker.com/task/abc-xyz'],
    });
    expect(updated.description).toBe('888 - Custom Tracker Task');
    expect(updated.issueUrls).toEqual(['https://custom-tracker.com/task/abc-xyz']);
  });
});
