import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// Mock logging
const mockLog = mock((...args: any[]) => {});

mock.module('../logging.js', () => ({
  log: mockLog,
}));

// Import the module functions after mocking logging
import {
  readTrackingData,
  writeTrackingData,
  recordWorkspace,
  getWorkspaceMetadata,
  findWorkspacesByTaskId,
  getTrackingFilePath,
} from './workspace_tracker.js';
import type { WorkspaceInfo } from './workspace_tracker.js';

describe('workspace_tracker', () => {
  let tempDir: string;
  let testTrackingPath: string;

  // Sample workspace data
  const testWorkspace: WorkspaceInfo = {
    taskId: 'task-123',
    originalPlanFilePath: '/repo/tasks/task-123.yml',
    repositoryUrl: 'https://github.com/example/repo.git',
    workspacePath: '/path/to/workspaces/repo-task-123',
    branch: 'llmutils-task/task-123',
    createdAt: new Date().toISOString(),
  };

  beforeEach(async () => {
    // Create a temporary directory for each test
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-tracker-test-'));
    testTrackingPath = path.join(tempDir, 'workspaces.json');
    
    // Mock getTrackingFilePath to use our temp directory
    mock.module('./workspace_tracker.js', () => {
      const originalModule = require('./workspace_tracker.js');
      return {
        ...originalModule,
        getTrackingFilePath: () => testTrackingPath,
      };
    });

    // Reset logging mock
    mockLog.mockReset();
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
    const result = await readTrackingData();
    expect(result).toEqual({});
  });

  test('readTrackingData returns empty object when file exists but parsing fails', async () => {
    // Write invalid JSON to the tracking file
    await fs.writeFile(testTrackingPath, 'invalid json', 'utf-8');

    const result = await readTrackingData();

    expect(result).toEqual({});
    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining('Error reading workspace tracking data')
    );
  });

  test('readTrackingData returns parsed data when file exists and is valid', async () => {
    const mockData = {
      '/path/to/workspace1': { taskId: 'task-1', workspacePath: '/path/to/workspace1' },
      '/path/to/workspace2': { taskId: 'task-2', workspacePath: '/path/to/workspace2' },
    };

    await fs.writeFile(testTrackingPath, JSON.stringify(mockData), 'utf-8');

    const result = await readTrackingData();

    expect(result).toEqual(mockData);
  });

  test('writeTrackingData creates directory and writes data', async () => {
    const mockData = {
      '/path/to/workspace1': { taskId: 'task-1', workspacePath: '/path/to/workspace1' },
    };

    await writeTrackingData(mockData);

    // Verify the file was created and contains the expected data
    const fileExists = await fs.access(testTrackingPath).then(() => true).catch(() => false);
    expect(fileExists).toBe(true);

    const fileContents = await fs.readFile(testTrackingPath, 'utf-8');
    expect(JSON.parse(fileContents)).toEqual(mockData);
  });

  test('recordWorkspace adds workspace to tracking data', async () => {
    // Setup existing data
    const existingData = {
      '/path/to/existing': {
        taskId: 'task-existing',
        workspacePath: '/path/to/existing',
        originalPlanFilePath: '/repo/tasks/existing.yml',
        repositoryUrl: 'https://github.com/example/repo.git',
        branch: 'existing-branch',
        createdAt: '2023-01-01T00:00:00.000Z',
      },
    };

    await fs.writeFile(testTrackingPath, JSON.stringify(existingData), 'utf-8');

    await recordWorkspace(testWorkspace);

    // Verify the updated data was written
    const fileContents = await fs.readFile(testTrackingPath, 'utf-8');
    const updatedData = JSON.parse(fileContents);

    const expectedData = {
      ...existingData,
      [testWorkspace.workspacePath]: testWorkspace,
    };

    expect(updatedData).toEqual(expectedData);

    // Verify we logged the action
    expect(mockLog).toHaveBeenCalledWith(
      `Recorded workspace for task ${testWorkspace.taskId} at ${testWorkspace.workspacePath}`
    );
  });

  test('getWorkspaceMetadata returns null for non-existent workspace', async () => {
    await fs.writeFile(testTrackingPath, '{}', 'utf-8');

    const result = await getWorkspaceMetadata('/path/to/nonexistent');

    expect(result).toBeNull();
  });

  test('getWorkspaceMetadata returns workspace info for existing workspace', async () => {
    const mockData = {
      [testWorkspace.workspacePath]: testWorkspace,
      '/path/to/other': { taskId: 'other', workspacePath: '/path/to/other' },
    };

    await fs.writeFile(testTrackingPath, JSON.stringify(mockData), 'utf-8');

    const result = await getWorkspaceMetadata(testWorkspace.workspacePath);

    expect(result).toEqual(testWorkspace);
  });

  test('findWorkspacesByTaskId returns empty array for non-existent task', async () => {
    await fs.writeFile(testTrackingPath, '{}', 'utf-8');

    const result = await findWorkspacesByTaskId('nonexistent');

    expect(result).toEqual([]);
  });

  test('findWorkspacesByTaskId returns all workspaces for a task', async () => {
    const workspace1 = {
      ...testWorkspace,
      workspacePath: '/path/to/workspace1',
    };

    const workspace2 = {
      ...testWorkspace,
      workspacePath: '/path/to/workspace2',
    };

    const otherWorkspace = {
      ...testWorkspace,
      taskId: 'other-task',
      workspacePath: '/path/to/other',
    };

    const mockData = {
      [workspace1.workspacePath]: workspace1,
      [workspace2.workspacePath]: workspace2,
      [otherWorkspace.workspacePath]: otherWorkspace,
    };

    await fs.writeFile(testTrackingPath, JSON.stringify(mockData), 'utf-8');

    const result = await findWorkspacesByTaskId(testWorkspace.taskId);

    expect(result).toHaveLength(2);
    expect(result).toContainEqual(workspace1);
    expect(result).toContainEqual(workspace2);
    expect(result).not.toContainEqual(otherWorkspace);
  });
});