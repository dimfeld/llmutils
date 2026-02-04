import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// Import the module functions
import {
  readTrackingData,
  writeTrackingData,
  recordWorkspace,
  getWorkspaceMetadata,
  findWorkspacesByTaskId,
  patchWorkspaceMetadata,
  buildWorkspaceListEntries,
} from './workspace_tracker.js';
import type { WorkspaceInfo, WorkspaceMetadataPatch } from './workspace_tracker.js';

describe('workspace_tracker', () => {
  let tempDir: string;
  let testTrackingPath: string;

  // Sample workspace data
  const testWorkspace: WorkspaceInfo = {
    taskId: 'task-123',
    originalPlanFilePath: '/repo/tasks/task-123.yml',
    repositoryId: 'github.com/example/repo',
    workspacePath: '/path/to/workspaces/repo-task-123',
    branch: 'llmutils-task/task-123',
    createdAt: new Date().toISOString(),
  };

  beforeEach(async () => {
    // Create a temporary directory for each test
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-tracker-test-'));
    // Use a unique filename to avoid any potential conflicts
    testTrackingPath = path.join(tempDir, `workspaces-${Date.now()}-${Math.random()}.json`);
  });

  afterEach(async () => {
    // Clean up temporary directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  test('readTrackingData returns empty object when file does not exist', async () => {
    const result = await readTrackingData(testTrackingPath);
    expect(result).toEqual({});
  });

  test('readTrackingData returns empty object when file exists but parsing fails', async () => {
    // Write invalid JSON to the tracking file
    await fs.writeFile(testTrackingPath, 'invalid json', 'utf-8');

    const result = await readTrackingData(testTrackingPath);

    expect(result).toEqual({});
    // We're not testing logging anymore to avoid mock issues
  });

  test('readTrackingData returns parsed data when file exists and is valid', async () => {
    const mockData = {
      '/path/to/workspace1': { taskId: 'task-1', workspacePath: '/path/to/workspace1' },
      '/path/to/workspace2': { taskId: 'task-2', workspacePath: '/path/to/workspace2' },
    };

    await fs.writeFile(testTrackingPath, JSON.stringify(mockData), 'utf-8');

    const result = await readTrackingData(testTrackingPath);

    expect(result).toEqual(mockData);
  });

  test('writeTrackingData creates directory and writes data', async () => {
    const mockData = {
      '/path/to/workspace1': { taskId: 'task-1', workspacePath: '/path/to/workspace1' },
    };

    await writeTrackingData(mockData, testTrackingPath);

    // Read the file and verify contents
    const fileContent = await fs.readFile(testTrackingPath, 'utf-8');
    const parsedContent = JSON.parse(fileContent);

    expect(parsedContent).toEqual(mockData);
  });

  test('recordWorkspace adds workspace to tracking data', async () => {
    // Write initial data
    const existingData = {
      '/path/to/existing': {
        taskId: 'task-existing',
        originalPlanFilePath: '/repo/tasks/existing.yml',
        repositoryId: 'github.com/example/repo',
        workspacePath: '/path/to/existing',
        branch: 'existing-branch',
        createdAt: '2023-01-01T00:00:00.000Z',
      },
    };
    await fs.writeFile(testTrackingPath, JSON.stringify(existingData), 'utf-8');

    // Record new workspace
    await recordWorkspace(testWorkspace, testTrackingPath);

    // Verify the workspace was added
    const updatedData = await readTrackingData(testTrackingPath);
    const expectedData = {
      ...existingData,
      [testWorkspace.workspacePath]: testWorkspace,
    };

    expect(updatedData).toEqual(expectedData);
    // We're not testing logging anymore to avoid mock issues
  });

  test('getWorkspaceMetadata returns null for non-existent workspace', async () => {
    await fs.writeFile(testTrackingPath, '{}', 'utf-8');

    const result = await getWorkspaceMetadata('/non/existent/path', testTrackingPath);

    expect(result).toBeNull();
  });

  test('getWorkspaceMetadata returns workspace info for existing workspace', async () => {
    const mockData = {
      [testWorkspace.workspacePath]: testWorkspace,
    };
    await fs.writeFile(testTrackingPath, JSON.stringify(mockData), 'utf-8');

    const result = await getWorkspaceMetadata(testWorkspace.workspacePath, testTrackingPath);

    expect(result).toEqual(testWorkspace);
  });

  test('findWorkspacesByTaskId returns empty array for non-existent task', async () => {
    await fs.writeFile(testTrackingPath, '{}', 'utf-8');

    const result = await findWorkspacesByTaskId('nonexistent', testTrackingPath);

    expect(result).toEqual([]);
  });

  test('findWorkspacesByTaskId returns all workspaces for a task', async () => {
    const workspace1 = { ...testWorkspace, workspacePath: '/path/1' };
    const workspace2 = { ...testWorkspace, workspacePath: '/path/2' };
    const workspace3 = {
      ...testWorkspace,
      taskId: 'different-task',
      workspacePath: '/path/3',
    };

    const mockData = {
      '/path/1': workspace1,
      '/path/2': workspace2,
      '/path/3': workspace3,
    };

    await fs.writeFile(testTrackingPath, JSON.stringify(mockData), 'utf-8');

    const result = await findWorkspacesByTaskId(testWorkspace.taskId, testTrackingPath);

    expect(result).toHaveLength(2);
    expect(result).toContainEqual(workspace1);
    expect(result).toContainEqual(workspace2);
  });

  describe('patchWorkspaceMetadata', () => {
    test('updates existing workspace metadata without clobbering other fields', async () => {
      // Create an existing workspace with some metadata
      const existingWorkspace: WorkspaceInfo = {
        taskId: 'task-123',
        workspacePath: '/path/to/workspace',
        createdAt: '2023-01-01T00:00:00.000Z',
        branch: 'feature-branch',
        repositoryId: 'github.com/example/repo',
      };

      await fs.writeFile(
        testTrackingPath,
        JSON.stringify({ [existingWorkspace.workspacePath]: existingWorkspace }),
        'utf-8'
      );

      const patch: WorkspaceMetadataPatch = {
        name: 'My Workspace',
        description: 'Working on feature X',
      };

      const result = await patchWorkspaceMetadata(
        existingWorkspace.workspacePath,
        patch,
        testTrackingPath
      );

      // Check the returned result
      expect(result.name).toBe('My Workspace');
      expect(result.description).toBe('Working on feature X');
      // Original fields should be preserved
      expect(result.taskId).toBe('task-123');
      expect(result.branch).toBe('feature-branch');
      expect(result.repositoryId).toBe('github.com/example/repo');
      expect(result.createdAt).toBe('2023-01-01T00:00:00.000Z');
      // Should have updatedAt timestamp
      expect(result.updatedAt).toBeDefined();

      // Verify it was persisted
      const data = await readTrackingData(testTrackingPath);
      expect(data[existingWorkspace.workspacePath]).toEqual(result);
    });

    test('creates new workspace entry when not tracked', async () => {
      // Start with an empty tracking file
      await fs.writeFile(testTrackingPath, '{}', 'utf-8');

      const workspacePath = '/path/to/new/workspace';
      const patch: WorkspaceMetadataPatch = {
        name: 'New Workspace',
        description: 'New workspace description',
      };

      const result = await patchWorkspaceMetadata(workspacePath, patch, testTrackingPath);

      // Check the returned result
      expect(result.workspacePath).toBe(workspacePath);
      expect(result.taskId).toBe('workspace'); // Should be the basename
      expect(result.name).toBe('New Workspace');
      expect(result.description).toBe('New workspace description');
      expect(result.createdAt).toBeDefined();
      expect(result.updatedAt).toBeDefined();

      // Verify it was persisted
      const data = await readTrackingData(testTrackingPath);
      expect(data[workspacePath]).toEqual(result);
    });

    test('uses planId to derive taskId when creating new entry', async () => {
      await fs.writeFile(testTrackingPath, '{}', 'utf-8');

      const workspacePath = '/path/to/plan/workspace';
      const patch: WorkspaceMetadataPatch = {
        planId: '789',
        description: 'Plan-linked workspace',
      };

      const result = await patchWorkspaceMetadata(workspacePath, patch, testTrackingPath);

      expect(result.taskId).toBe('task-789');
      expect(result.planId).toBe('789');
    });

    test('clears fields when empty string is provided', async () => {
      // Create an existing workspace with metadata
      const existingWorkspace: WorkspaceInfo = {
        taskId: 'task-123',
        workspacePath: '/path/to/workspace',
        createdAt: '2023-01-01T00:00:00.000Z',
        name: 'Old Name',
        description: 'Old Description',
        planId: '123',
        planTitle: 'Old Plan Title',
      };

      await fs.writeFile(
        testTrackingPath,
        JSON.stringify({ [existingWorkspace.workspacePath]: existingWorkspace }),
        'utf-8'
      );

      // Clear name and description with empty strings
      const patch: WorkspaceMetadataPatch = {
        name: '',
        description: '',
      };

      const result = await patchWorkspaceMetadata(
        existingWorkspace.workspacePath,
        patch,
        testTrackingPath
      );

      // Fields should be cleared (deleted)
      expect(result.name).toBeUndefined();
      expect(result.description).toBeUndefined();
      // Other fields should be preserved
      expect(result.planId).toBe('123');
      expect(result.planTitle).toBe('Old Plan Title');
    });

    test('clears issueUrls when empty array is provided', async () => {
      const existingWorkspace: WorkspaceInfo = {
        taskId: 'task-123',
        workspacePath: '/path/to/workspace',
        createdAt: '2023-01-01T00:00:00.000Z',
        issueUrls: ['https://github.com/example/repo/issues/1'],
      };

      await fs.writeFile(
        testTrackingPath,
        JSON.stringify({ [existingWorkspace.workspacePath]: existingWorkspace }),
        'utf-8'
      );

      const patch: WorkspaceMetadataPatch = {
        issueUrls: [],
      };

      const result = await patchWorkspaceMetadata(
        existingWorkspace.workspacePath,
        patch,
        testTrackingPath
      );

      expect(result.issueUrls).toBeUndefined();
    });

    test('sets updatedAt timestamp on every update', async () => {
      const workspacePath = '/path/to/workspace';
      await fs.writeFile(testTrackingPath, '{}', 'utf-8');

      // First update
      const result1 = await patchWorkspaceMetadata(
        workspacePath,
        { name: 'First' },
        testTrackingPath
      );
      const firstUpdatedAt = result1.updatedAt;
      expect(firstUpdatedAt).toBeDefined();

      // Wait a tiny bit to ensure timestamp changes
      await new Promise((resolve) => setTimeout(resolve, 5));

      // Second update
      const result2 = await patchWorkspaceMetadata(
        workspacePath,
        { name: 'Second' },
        testTrackingPath
      );
      const secondUpdatedAt = result2.updatedAt;
      expect(secondUpdatedAt).toBeDefined();

      // Timestamps should be different
      expect(new Date(secondUpdatedAt!).getTime()).toBeGreaterThan(
        new Date(firstUpdatedAt!).getTime()
      );
    });

    test('updates plan metadata fields correctly', async () => {
      const workspacePath = '/path/to/workspace';
      await fs.writeFile(testTrackingPath, '{}', 'utf-8');

      const patch: WorkspaceMetadataPatch = {
        planId: '456',
        planTitle: 'Implement Feature Y',
        issueUrls: ['https://github.com/example/repo/issues/456'],
      };

      const result = await patchWorkspaceMetadata(workspacePath, patch, testTrackingPath);

      expect(result.planId).toBe('456');
      expect(result.planTitle).toBe('Implement Feature Y');
      expect(result.issueUrls).toEqual(['https://github.com/example/repo/issues/456']);
    });

    test('clears planId with empty string', async () => {
      const existingWorkspace: WorkspaceInfo = {
        taskId: 'task-123',
        workspacePath: '/path/to/workspace',
        createdAt: '2023-01-01T00:00:00.000Z',
        planId: '123',
        planTitle: 'Some Plan',
      };

      await fs.writeFile(
        testTrackingPath,
        JSON.stringify({ [existingWorkspace.workspacePath]: existingWorkspace }),
        'utf-8'
      );

      const result = await patchWorkspaceMetadata(
        existingWorkspace.workspacePath,
        { planId: '' },
        testTrackingPath
      );

      expect(result.planId).toBeUndefined();
      expect(result.planTitle).toBe('Some Plan'); // Should be preserved
    });

    test('clears planTitle with empty string', async () => {
      const existingWorkspace: WorkspaceInfo = {
        taskId: 'task-123',
        workspacePath: '/path/to/workspace',
        createdAt: '2023-01-01T00:00:00.000Z',
        planId: '123',
        planTitle: 'Some Plan Title',
      };

      await fs.writeFile(
        testTrackingPath,
        JSON.stringify({ [existingWorkspace.workspacePath]: existingWorkspace }),
        'utf-8'
      );

      const result = await patchWorkspaceMetadata(
        existingWorkspace.workspacePath,
        { planTitle: '' },
        testTrackingPath
      );

      expect(result.planTitle).toBeUndefined();
      expect(result.planId).toBe('123'); // Should be preserved
    });

    test('updates repositoryId field', async () => {
      const workspacePath = '/path/to/workspace';
      await fs.writeFile(testTrackingPath, '{}', 'utf-8');

      const result = await patchWorkspaceMetadata(
        workspacePath,
        { repositoryId: 'github.com/example/new-repo' },
        testTrackingPath
      );

      expect(result.repositoryId).toBe('github.com/example/new-repo');
    });

    test('clears repositoryId with empty string', async () => {
      const existingWorkspace: WorkspaceInfo = {
        taskId: 'task-123',
        workspacePath: '/path/to/workspace',
        createdAt: '2023-01-01T00:00:00.000Z',
        repositoryId: 'github.com/example/repo',
      };

      await fs.writeFile(
        testTrackingPath,
        JSON.stringify({ [existingWorkspace.workspacePath]: existingWorkspace }),
        'utf-8'
      );

      const result = await patchWorkspaceMetadata(
        existingWorkspace.workspacePath,
        { repositoryId: '' },
        testTrackingPath
      );

      expect(result.repositoryId).toBeUndefined();
    });

    test('does not modify unspecified fields in patch', async () => {
      const existingWorkspace: WorkspaceInfo = {
        taskId: 'task-123',
        workspacePath: '/path/to/workspace',
        createdAt: '2023-01-01T00:00:00.000Z',
        name: 'Original Name',
        description: 'Original Description',
        planId: '123',
        planTitle: 'Original Title',
        issueUrls: ['https://github.com/example/repo/issues/1'],
      };

      await fs.writeFile(
        testTrackingPath,
        JSON.stringify({ [existingWorkspace.workspacePath]: existingWorkspace }),
        'utf-8'
      );

      // Only update description
      const result = await patchWorkspaceMetadata(
        existingWorkspace.workspacePath,
        { description: 'Updated Description' },
        testTrackingPath
      );

      // Only description should change
      expect(result.description).toBe('Updated Description');
      // All other metadata should be preserved
      expect(result.name).toBe('Original Name');
      expect(result.planId).toBe('123');
      expect(result.planTitle).toBe('Original Title');
      expect(result.issueUrls).toEqual(['https://github.com/example/repo/issues/1']);
    });
  });

  describe('buildWorkspaceListEntries', () => {
    let workspaceDir: string;

    beforeEach(async () => {
      // Create an actual directory for workspace existence checks
      workspaceDir = path.join(tempDir, 'workspace-1');
      await fs.mkdir(workspaceDir, { recursive: true });
    });

    test('returns empty array when given empty workspaces array', async () => {
      const result = await buildWorkspaceListEntries([]);
      expect(result).toEqual([]);
    });

    test('filters out workspaces with missing directories', async () => {
      const existingWorkspace: WorkspaceInfo = {
        taskId: 'task-1',
        workspacePath: workspaceDir,
        createdAt: '2023-01-01T00:00:00.000Z',
      };

      const missingWorkspace: WorkspaceInfo = {
        taskId: 'task-2',
        workspacePath: '/non/existent/path/workspace',
        createdAt: '2023-01-02T00:00:00.000Z',
      };

      const result = await buildWorkspaceListEntries([existingWorkspace, missingWorkspace]);

      expect(result).toHaveLength(1);
      expect(result[0].fullPath).toBe(workspaceDir);
    });

    test('returns properly structured list entries', async () => {
      const workspace: WorkspaceInfo = {
        taskId: 'task-123',
        workspacePath: workspaceDir,
        createdAt: '2023-01-01T00:00:00.000Z',
        name: 'My Workspace',
        description: 'Working on feature',
        planId: '456',
        planTitle: 'Feature Implementation',
        issueUrls: ['https://github.com/example/repo/issues/1'],
        repositoryId: 'github.com/example/repo',
        updatedAt: '2023-01-02T00:00:00.000Z',
      };

      const result = await buildWorkspaceListEntries([workspace]);

      expect(result).toHaveLength(1);
      const entry = result[0];

      expect(entry.fullPath).toBe(workspaceDir);
      expect(entry.basename).toBe('workspace-1');
      expect(entry.name).toBe('My Workspace');
      expect(entry.description).toBe('Working on feature');
      expect(entry.taskId).toBe('task-123');
      expect(entry.planId).toBe('456');
      expect(entry.planTitle).toBe('Feature Implementation');
      expect(entry.issueUrls).toEqual(['https://github.com/example/repo/issues/1']);
      expect(entry.repositoryId).toBe('github.com/example/repo');
      expect(entry.createdAt).toBe('2023-01-01T00:00:00.000Z');
      expect(entry.updatedAt).toBe('2023-01-02T00:00:00.000Z');
    });

    test('handles workspaces without optional fields', async () => {
      const workspace: WorkspaceInfo = {
        taskId: 'task-123',
        workspacePath: workspaceDir,
        createdAt: '2023-01-01T00:00:00.000Z',
      };

      const result = await buildWorkspaceListEntries([workspace]);

      expect(result).toHaveLength(1);
      const entry = result[0];

      expect(entry.fullPath).toBe(workspaceDir);
      expect(entry.basename).toBe('workspace-1');
      expect(entry.taskId).toBe('task-123');
      expect(entry.createdAt).toBe('2023-01-01T00:00:00.000Z');
      // Optional fields should be undefined
      expect(entry.name).toBeUndefined();
      expect(entry.description).toBeUndefined();
      expect(entry.planId).toBeUndefined();
      expect(entry.planTitle).toBeUndefined();
      expect(entry.issueUrls).toBeUndefined();
      expect(entry.repositoryId).toBeUndefined();
      expect(entry.updatedAt).toBeUndefined();
    });

    test('preserves lock info from workspace', async () => {
      const workspace: WorkspaceInfo = {
        taskId: 'task-123',
        workspacePath: workspaceDir,
        createdAt: '2023-01-01T00:00:00.000Z',
        lockedBy: {
          type: 'persistent',
          pid: 12345,
          startedAt: '2023-01-01T00:00:00.000Z',
          hostname: 'test-host',
          command: 'tim agent',
        },
      };

      const result = await buildWorkspaceListEntries([workspace]);

      expect(result).toHaveLength(1);
      expect(result[0].lockedBy).toEqual(workspace.lockedBy);
    });

    test('filters out non-directory paths', async () => {
      // Create a file instead of a directory
      const filePath = path.join(tempDir, 'not-a-directory');
      await fs.writeFile(filePath, 'content');

      const workspace: WorkspaceInfo = {
        taskId: 'task-file',
        workspacePath: filePath,
        createdAt: '2023-01-01T00:00:00.000Z',
      };

      const result = await buildWorkspaceListEntries([workspace]);

      expect(result).toHaveLength(0);
    });
  });
});
