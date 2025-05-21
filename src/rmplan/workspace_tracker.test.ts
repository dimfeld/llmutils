import { describe, expect, test, mock, beforeEach } from 'bun:test';
import * as path from 'node:path';

// Create a mock for the tracking file path
const TEST_TRACKING_PATH = '/mock/home/.llmutils/workspaces.json';

// Mock the fs module
const mockReadFile = mock(async () => '{}');
const mockWriteFile = mock(async () => {});
const mockMkdir = mock(async () => {});

// Mock the getTrackingFilePath function
const mockGetTrackingFilePath = mock(() => TEST_TRACKING_PATH);

// Mock logging
const mockLog = mock((...args: any[]) => {});

// Mock modules
mock.module('node:fs/promises', () => ({
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
}));

mock.module('../logging.js', () => ({
  log: mockLog,
}));

// Mock workspace_tracker module
await mock.module('./workspace_tracker.js', () => {
  // Import the actual module
  const originalModule = require('./workspace_tracker.js');

  // Replace getTrackingFilePath with our mock
  return {
    ...originalModule,
    getTrackingFilePath: mockGetTrackingFilePath,
  };
});

// Import the module functions after mocking
import {
  readTrackingData,
  writeTrackingData,
  recordWorkspace,
  getWorkspaceMetadata,
  findWorkspacesByTaskId,
} from './workspace_tracker.js';
import type { WorkspaceInfo } from './workspace_tracker.js';

describe('workspace_tracker', () => {
  // Sample workspace data
  const testWorkspace: WorkspaceInfo = {
    taskId: 'task-123',
    originalPlanFilePath: '/repo/tasks/task-123.yml',
    repositoryUrl: 'https://github.com/example/repo.git',
    workspacePath: '/path/to/workspaces/repo-task-123',
    branch: 'llmutils-task/task-123',
    createdAt: new Date().toISOString(),
  };

  beforeEach(() => {
    // Reset all mocks
    mockReadFile.mockReset();
    mockWriteFile.mockReset();
    mockMkdir.mockReset();
    mockLog.mockReset();
  });

  test('readTrackingData returns empty object when file does not exist', async () => {
    // Mock readFile to throw ENOENT error
    const error = new Error('File not found') as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    mockReadFile.mockRejectedValue(error);

    const result = await readTrackingData();

    expect(result).toEqual({});
    expect(mockReadFile).toHaveBeenCalledWith(TEST_TRACKING_PATH, 'utf-8');
  });

  test('readTrackingData returns empty object when file exists but parsing fails', async () => {
    // Mock readFile to return invalid JSON
    mockReadFile.mockResolvedValue('invalid json');

    const result = await readTrackingData();

    expect(result).toEqual({});
    expect(mockReadFile).toHaveBeenCalledWith(TEST_TRACKING_PATH, 'utf-8');
    expect(mockLog).toHaveBeenCalledWith(
      expect.stringContaining('Error reading workspace tracking data')
    );
  });

  test('readTrackingData returns parsed data when file exists and is valid', async () => {
    const mockData = {
      '/path/to/workspace1': { taskId: 'task-1', workspacePath: '/path/to/workspace1' },
      '/path/to/workspace2': { taskId: 'task-2', workspacePath: '/path/to/workspace2' },
    };

    mockReadFile.mockResolvedValue(JSON.stringify(mockData));

    const result = await readTrackingData();

    expect(result).toEqual(mockData);
    expect(mockReadFile).toHaveBeenCalledWith(TEST_TRACKING_PATH, 'utf-8');
  });

  test('writeTrackingData creates directory and writes data', async () => {
    const mockData = {
      '/path/to/workspace1': { taskId: 'task-1', workspacePath: '/path/to/workspace1' },
    };

    await writeTrackingData(mockData);

    expect(mockMkdir).toHaveBeenCalledWith(path.dirname(TEST_TRACKING_PATH), { recursive: true });
    expect(mockWriteFile).toHaveBeenCalledWith(
      TEST_TRACKING_PATH,
      JSON.stringify(mockData, null, 2),
      'utf-8'
    );
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

    mockReadFile.mockResolvedValue(JSON.stringify(existingData));

    await recordWorkspace(testWorkspace);

    // Verify we read the existing data
    expect(mockReadFile).toHaveBeenCalledWith(TEST_TRACKING_PATH, 'utf-8');

    // Verify we wrote the updated data
    const expectedData = {
      ...existingData,
      [testWorkspace.workspacePath]: testWorkspace,
    };

    expect(mockWriteFile).toHaveBeenCalledWith(
      TEST_TRACKING_PATH,
      JSON.stringify(expectedData, null, 2),
      'utf-8'
    );

    // Verify we logged the action
    expect(mockLog).toHaveBeenCalledWith(
      `Recorded workspace for task ${testWorkspace.taskId} at ${testWorkspace.workspacePath}`
    );
  });

  test('getWorkspaceMetadata returns null for non-existent workspace', async () => {
    mockReadFile.mockResolvedValue('{}');

    const result = await getWorkspaceMetadata('/path/to/nonexistent');

    expect(result).toBeNull();
    expect(mockReadFile).toHaveBeenCalledWith(TEST_TRACKING_PATH, 'utf-8');
  });

  test('getWorkspaceMetadata returns workspace info for existing workspace', async () => {
    const mockData = {
      [testWorkspace.workspacePath]: testWorkspace,
      '/path/to/other': { taskId: 'other', workspacePath: '/path/to/other' },
    };

    mockReadFile.mockResolvedValue(JSON.stringify(mockData));

    const result = await getWorkspaceMetadata(testWorkspace.workspacePath);

    expect(result).toEqual(testWorkspace);
    expect(mockReadFile).toHaveBeenCalledWith(TEST_TRACKING_PATH, 'utf-8');
  });

  test('findWorkspacesByTaskId returns empty array for non-existent task', async () => {
    mockReadFile.mockResolvedValue('{}');

    const result = await findWorkspacesByTaskId('nonexistent');

    expect(result).toEqual([]);
    expect(mockReadFile).toHaveBeenCalledWith(TEST_TRACKING_PATH, 'utf-8');
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

    mockReadFile.mockResolvedValue(JSON.stringify(mockData));

    const result = await findWorkspacesByTaskId(testWorkspace.taskId);

    expect(result).toHaveLength(2);
    expect(result).toContainEqual(workspace1);
    expect(result).toContainEqual(workspace2);
    expect(result).not.toContainEqual(otherWorkspace);
    expect(mockReadFile).toHaveBeenCalledWith(TEST_TRACKING_PATH, 'utf-8');
  });
});
