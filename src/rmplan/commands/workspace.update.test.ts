import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ModuleMocker } from '../../testing.js';
import type { WorkspaceInfo } from '../workspace/workspace_tracker.js';

let moduleMocker: ModuleMocker;
let tempDir: string;
let trackingFile: string;
let tasksDir: string;
let originalCwd: string;

const logSpy = mock(() => {});
const warnSpy = mock(() => {});

async function writeTrackingData(data: Record<string, WorkspaceInfo>) {
  await fs.writeFile(trackingFile, JSON.stringify(data, null, 2));
}

async function readTrackingData(): Promise<Record<string, WorkspaceInfo>> {
  const content = await fs.readFile(trackingFile, 'utf-8');
  return JSON.parse(content);
}

describe('workspace update command', () => {
  beforeEach(async () => {
    moduleMocker = new ModuleMocker(import.meta);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-update-test-'));
    trackingFile = path.join(tempDir, 'workspaces.json');
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    originalCwd = process.cwd();

    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
      warn: warnSpy,
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: {
          trackingFile,
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
    const workspaceDir = path.join(tempDir, 'current-workspace');
    await fs.mkdir(workspaceDir, { recursive: true });

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

  test('creates new entry for untracked workspace directory', async () => {
    const workspaceDir = path.join(tempDir, 'untracked-workspace');
    await fs.mkdir(workspaceDir, { recursive: true });

    // Start with empty tracking data
    await writeTrackingData({});

    const { handleWorkspaceUpdateCommand } = await import('./workspace.js');

    await handleWorkspaceUpdateCommand(
      workspaceDir,
      { name: 'New Workspace', description: 'Newly tracked workspace' },
      {
        parent: {
          parent: {
            opts: () => ({ config: undefined }),
          },
        },
      } as any
    );

    const data = await readTrackingData();
    expect(data[workspaceDir]).toBeDefined();
    expect(data[workspaceDir].name).toBe('New Workspace');
    expect(data[workspaceDir].description).toBe('Newly tracked workspace');
    expect(data[workspaceDir].workspacePath).toBe(workspaceDir);
    expect(data[workspaceDir].repositoryId).toBe('example-repo');
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
    ).rejects.toThrow('At least one of --name, --description, or --from-plan must be provided');
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
    expect(data[workspaceDir].description).toBe('#789 Implement Authentication');
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
  // We need to test the extractIssueNumber function directly
  // Since it's not exported, we test it indirectly through buildDescriptionFromPlan

  test('extracts GitHub issue numbers correctly', async () => {
    const moduleMocker = new ModuleMocker(import.meta);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-issue-test-'));
    const trackingFile = path.join(tempDir, 'workspaces.json');
    const workspaceDir = path.join(tempDir, 'workspace');
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(trackingFile, '{}');

    await moduleMocker.mock('../../logging.js', () => ({
      log: mock(() => {}),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: { trackingFile },
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

    await moduleMocker.mock('../plans.js', () => ({
      resolvePlanFile: async () => '/fake/plan.md',
      readPlanFile: async () => ({
        id: 123,
        title: 'Fix Bug',
        issue: ['https://github.com/owner/repo/issues/123'],
      }),
    }));

    const { handleWorkspaceUpdateCommand } = await import('./workspace.js');

    await handleWorkspaceUpdateCommand(workspaceDir, { fromPlan: '123' }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    const data = JSON.parse(await fs.readFile(trackingFile, 'utf-8'));
    expect(data[workspaceDir].description).toBe('#123 Fix Bug');

    moduleMocker.clear();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('extracts GitLab issue numbers correctly', async () => {
    const moduleMocker = new ModuleMocker(import.meta);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-gitlab-test-'));
    const trackingFile = path.join(tempDir, 'workspaces.json');
    const workspaceDir = path.join(tempDir, 'workspace');
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(trackingFile, '{}');

    await moduleMocker.mock('../../logging.js', () => ({
      log: mock(() => {}),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: { trackingFile },
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

    await moduleMocker.mock('../plans.js', () => ({
      resolvePlanFile: async () => '/fake/plan.md',
      readPlanFile: async () => ({
        id: 456,
        title: 'Add Feature',
        issue: ['https://gitlab.com/group/project/-/issues/456'],
      }),
    }));

    const { handleWorkspaceUpdateCommand } = await import('./workspace.js');

    await handleWorkspaceUpdateCommand(workspaceDir, { fromPlan: '456' }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    const data = JSON.parse(await fs.readFile(trackingFile, 'utf-8'));
    expect(data[workspaceDir].description).toBe('#456 Add Feature');

    moduleMocker.clear();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('extracts Linear issue IDs correctly', async () => {
    const moduleMocker = new ModuleMocker(import.meta);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-linear-test-'));
    const trackingFile = path.join(tempDir, 'workspaces.json');
    const workspaceDir = path.join(tempDir, 'workspace');
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(trackingFile, '{}');

    await moduleMocker.mock('../../logging.js', () => ({
      log: mock(() => {}),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: { trackingFile },
      }),
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => tempDir,
    }));

    await moduleMocker.mock('../plans.js', () => ({
      resolvePlanFile: async () => '/fake/plan.md',
      readPlanFile: async () => ({
        id: 789,
        title: 'Implement Feature',
        issue: ['https://linear.app/team/issue/PROJ-123/implement-feature'],
      }),
    }));

    const { handleWorkspaceUpdateCommand } = await import('./workspace.js');

    await handleWorkspaceUpdateCommand(workspaceDir, { fromPlan: '789' }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    const data = JSON.parse(await fs.readFile(trackingFile, 'utf-8'));
    expect(data[workspaceDir].description).toBe('PROJ-123 Implement Feature');

    moduleMocker.clear();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('extracts Jira issue IDs correctly', async () => {
    const moduleMocker = new ModuleMocker(import.meta);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-jira-test-'));
    const trackingFile = path.join(tempDir, 'workspaces.json');
    const workspaceDir = path.join(tempDir, 'workspace');
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(trackingFile, '{}');

    await moduleMocker.mock('../../logging.js', () => ({
      log: mock(() => {}),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: { trackingFile },
      }),
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => tempDir,
    }));

    await moduleMocker.mock('../plans.js', () => ({
      resolvePlanFile: async () => '/fake/plan.md',
      readPlanFile: async () => ({
        id: 101,
        title: 'Bug Fix',
        issue: ['https://company.atlassian.net/browse/PROJ-456'],
      }),
    }));

    const { handleWorkspaceUpdateCommand } = await import('./workspace.js');

    await handleWorkspaceUpdateCommand(workspaceDir, { fromPlan: '101' }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    const data = JSON.parse(await fs.readFile(trackingFile, 'utf-8'));
    expect(data[workspaceDir].description).toBe('PROJ-456 Bug Fix');

    moduleMocker.clear();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('falls back to title only when no issue URL', async () => {
    const moduleMocker = new ModuleMocker(import.meta);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-no-issue-test-'));
    const trackingFile = path.join(tempDir, 'workspaces.json');
    const workspaceDir = path.join(tempDir, 'workspace');
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(trackingFile, '{}');

    await moduleMocker.mock('../../logging.js', () => ({
      log: mock(() => {}),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: { trackingFile },
      }),
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => tempDir,
    }));

    await moduleMocker.mock('../plans.js', () => ({
      resolvePlanFile: async () => '/fake/plan.md',
      readPlanFile: async () => ({
        id: 999,
        title: 'Standalone Task',
        goal: 'Some goal',
        // No issue field
      }),
    }));

    const { handleWorkspaceUpdateCommand } = await import('./workspace.js');

    await handleWorkspaceUpdateCommand(workspaceDir, { fromPlan: '999' }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    const data = JSON.parse(await fs.readFile(trackingFile, 'utf-8'));
    expect(data[workspaceDir].description).toBe('Standalone Task');

    moduleMocker.clear();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('handles unrecognized issue URL format gracefully', async () => {
    const moduleMocker = new ModuleMocker(import.meta);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'extract-unknown-test-'));
    const trackingFile = path.join(tempDir, 'workspaces.json');
    const workspaceDir = path.join(tempDir, 'workspace');
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(trackingFile, '{}');

    await moduleMocker.mock('../../logging.js', () => ({
      log: mock(() => {}),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: { trackingFile },
      }),
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => tempDir,
    }));

    await moduleMocker.mock('../plans.js', () => ({
      resolvePlanFile: async () => '/fake/plan.md',
      readPlanFile: async () => ({
        id: 888,
        title: 'Custom Tracker Task',
        issue: ['https://custom-tracker.com/task/abc-xyz'],
      }),
    }));

    const { handleWorkspaceUpdateCommand } = await import('./workspace.js');

    await handleWorkspaceUpdateCommand(workspaceDir, { fromPlan: '888' }, {
      parent: {
        parent: {
          opts: () => ({ config: undefined }),
        },
      },
    } as any);

    const data = JSON.parse(await fs.readFile(trackingFile, 'utf-8'));
    // Should fall back to just title since issue URL format not recognized
    expect(data[workspaceDir].description).toBe('Custom Tracker Task');
    // But issue URL should still be stored
    expect(data[workspaceDir].issueUrls).toEqual(['https://custom-tracker.com/task/abc-xyz']);

    moduleMocker.clear();
    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
