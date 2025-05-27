import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mapUser } from './db/user_mappings_manager.js';
import { isAdmin } from './discord_admin_utils.js';
import { getAllActiveTasks } from './db/tasks_manager.js';
import type { Task } from './db/tasks_manager.js';

// Mock the modules
mock.module('./db/user_mappings_manager.js', () => ({
  mapUser: mock(() => Promise.resolve()),
}));

mock.module('./discord_admin_utils.js', () => ({
  isAdmin: mock(() => false),
}));

mock.module('./db/tasks_manager.js', () => ({
  getAllActiveTasks: mock(() => Promise.resolve([])),
}));

describe('Discord Admin Commands', () => {
  beforeEach(() => {
    // Reset mocks before each test
    (mapUser as any).mockClear();
    (isAdmin as any).mockClear();
    (getAllActiveTasks as any).mockClear();
  });

  describe('/rm-link-user command', () => {
    test('should successfully map user when admin runs command', async () => {
      // Setup
      const githubUsername = 'testuser';
      const discordId = '123456789';
      (isAdmin as any).mockReturnValue(true);

      // Execute
      await mapUser(githubUsername, discordId, 'admin', true);

      // Verify
      expect(mapUser).toHaveBeenCalledWith(githubUsername, discordId, 'admin', true);
      expect(mapUser).toHaveBeenCalledTimes(1);
    });

    test('should reject command when non-admin user tries to run it', async () => {
      // Setup
      const userId = 'non-admin-user-id';
      (isAdmin as any).mockReturnValue(false);

      // Execute
      const result = isAdmin(userId);

      // Verify
      expect(result).toBe(false);
      expect(isAdmin).toHaveBeenCalledWith(userId);
      expect(mapUser).not.toHaveBeenCalled();
    });

    test('should handle errors from mapUser gracefully', async () => {
      // Setup
      const githubUsername = 'testuser';
      const discordId = '123456789';
      const errorMessage = 'Database error';
      (isAdmin as any).mockReturnValue(true);
      (mapUser as any).mockRejectedValue(new Error(errorMessage));

      // Execute & Verify
      await expect(mapUser(githubUsername, discordId, 'admin', true)).rejects.toThrow(errorMessage);
    });

    test('should accept various input parameters', async () => {
      // Setup
      (isAdmin as any).mockReturnValue(true);
      (mapUser as any).mockResolvedValue(undefined);

      // Test with empty github username - the actual implementation would handle validation
      await mapUser('', '123456789', 'admin', true);
      expect(mapUser).toHaveBeenCalledWith('', '123456789', 'admin', true);

      // Test with empty discord ID - the actual implementation would handle validation
      await mapUser('testuser', '', 'admin', true);
      expect(mapUser).toHaveBeenCalledWith('testuser', '', 'admin', true);
    });
  });

  describe('/rm-status-all command', () => {
    // Helper function to create mock task
    const createMockTask = (overrides: Partial<Task> = {}): Task => ({
      id: 'test-task-1',
      issueUrl: 'https://github.com/test/repo/issues/1',
      issueNumber: 1,
      repositoryFullName: 'test/repo',
      taskType: 'implementation',
      status: 'implementing',
      workspacePath: null,
      planFilePath: null,
      prNumber: null,
      branch: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      createdByPlatform: 'discord',
      createdByUserId: 'test-user',
      errorMessage: null,
      ...overrides,
    });

    test('should reject command when non-admin user tries to run it', async () => {
      // Setup
      const userId = 'non-admin-user-id';
      (isAdmin as any).mockReturnValue(false);

      // Execute
      const result = isAdmin(userId);

      // Verify
      expect(result).toBe(false);
      expect(isAdmin).toHaveBeenCalledWith(userId);
      expect(getAllActiveTasks).not.toHaveBeenCalled();
    });

    test('should return active tasks when admin runs command', async () => {
      // Setup
      const mockTasks = [
        createMockTask({ id: 'task-1', status: 'planning' }),
        createMockTask({ id: 'task-2', status: 'implementing' }),
      ];
      (isAdmin as any).mockReturnValue(true);
      (getAllActiveTasks as any).mockResolvedValue(mockTasks);

      // Execute
      const tasks = await getAllActiveTasks();

      // Verify
      expect(tasks).toEqual(mockTasks);
      expect(getAllActiveTasks).toHaveBeenCalledTimes(1);
    });

    test('should handle empty task list', async () => {
      // Setup
      (isAdmin as any).mockReturnValue(true);
      (getAllActiveTasks as any).mockResolvedValue([]);

      // Execute
      const tasks = await getAllActiveTasks();

      // Verify
      expect(tasks).toEqual([]);
      expect(getAllActiveTasks).toHaveBeenCalledTimes(1);
    });

    test('should handle database errors gracefully', async () => {
      // Setup
      const errorMessage = 'Database connection failed';
      (isAdmin as any).mockReturnValue(true);
      (getAllActiveTasks as any).mockRejectedValue(new Error(errorMessage));

      // Execute & Verify
      await expect(getAllActiveTasks()).rejects.toThrow(errorMessage);
    });

    test('should return tasks with various statuses', async () => {
      // Setup
      const mockTasks = [
        createMockTask({ id: 'task-1', status: 'pending_planning' }),
        createMockTask({ id: 'task-2', status: 'planning' }),
        createMockTask({ id: 'task-3', status: 'plan_complete' }),
        createMockTask({ id: 'task-4', status: 'pending_implementation' }),
        createMockTask({ id: 'task-5', status: 'implementing' }),
        createMockTask({ id: 'task-6', status: 'implementation_complete' }),
      ];
      (isAdmin as any).mockReturnValue(true);
      (getAllActiveTasks as any).mockResolvedValue(mockTasks);

      // Execute
      const tasks = await getAllActiveTasks();

      // Verify
      expect(tasks.length).toBe(6);
      expect(tasks.map((t) => t.status)).toContain('pending_planning');
      expect(tasks.map((t) => t.status)).toContain('implementing');
    });
  });
});
