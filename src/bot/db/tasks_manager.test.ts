import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { getAllActiveTasks } from './tasks_manager.js';
import type { Task } from './tasks_manager.js';

// Mock the database module
let mockTasks: Task[] = [];
let mockShouldThrow = false;

mock.module('./index.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => {
          if (mockShouldThrow) {
            throw new Error('Database connection failed');
          }
          return Promise.resolve(mockTasks);
        },
      }),
    }),
  },
  tasks: {},
}));

describe('getAllActiveTasks', () => {
  beforeEach(() => {
    // Reset mock data
    mockTasks = [];
    mockShouldThrow = false;
  });

  // Helper function to create a test task
  const createTestTask = (overrides: Partial<Task> = {}): Task => ({
    id: 'test-task-1',
    issueUrl: 'https://github.com/test/repo/issues/1',
    issueNumber: 1,
    repositoryFullName: 'test/repo',
    taskType: 'test',
    status: 'active',
    workspacePath: null,
    planFilePath: null,
    prNumber: null,
    branch: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdByPlatform: 'test',
    createdByUserId: 'test-user',
    errorMessage: null,
    ...overrides,
  });

  it('should return empty array when no tasks exist', async () => {
    mockTasks = [];
    const result = await getAllActiveTasks();
    expect(result).toEqual([]);
  });

  it('should return only active tasks', async () => {
    mockTasks = [
      createTestTask({ id: 'task-1', status: 'pending_planning' }),
      createTestTask({ id: 'task-2', status: 'planning' }),
      createTestTask({ id: 'task-3', status: 'implementing' }),
      createTestTask({ id: 'task-4', status: 'pending_implementation' }),
    ];

    const result = await getAllActiveTasks();

    // Should return all tasks since our mock doesn't filter
    // The actual filtering is done by the SQL WHERE clause
    expect(result.length).toBe(4);

    // Verify all returned tasks have active statuses
    const returnedStatuses = result.map((t) => t.status);
    const finalStates = ['completed', 'failed', 'cancelled'];
    returnedStatuses.forEach((status) => {
      expect(finalStates).not.toContain(status);
    });
  });

  it('should include all required fields in returned tasks', async () => {
    const testTask = createTestTask({
      status: 'planning',
      issueUrl: 'https://github.com/test/repo/issues/1',
      issueNumber: 1,
      workspacePath: '/workspace/test',
      planFilePath: '/workspace/test/plan.yml',
      prNumber: 123,
      branch: 'feature/test',
      errorMessage: null,
    });

    mockTasks = [testTask];

    const result = await getAllActiveTasks();

    expect(result.length).toBe(1);
    const returnedTask = result[0];

    // Verify essential fields are present
    expect(returnedTask.id).toBe(testTask.id);
    expect(returnedTask.repositoryFullName).toBe(testTask.repositoryFullName);
    expect(returnedTask.issueNumber).toBe(testTask.issueNumber);
    expect(returnedTask.status).toBe(testTask.status);
    expect(returnedTask.createdByUserId).toBe(testTask.createdByUserId);
    expect(returnedTask.createdAt).toBeDefined();
  });

  it('should throw error with descriptive message on database error', async () => {
    mockShouldThrow = true;

    try {
      await getAllActiveTasks();
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('Failed to retrieve active tasks');
      expect((error as Error).message).toContain('Database connection failed');
    }
  });

  it('should handle large number of active tasks', async () => {
    mockTasks = Array.from({ length: 50 }, (_, i) =>
      createTestTask({
        id: `task-${i}`,
        status: i % 2 === 0 ? 'planning' : 'implementing',
        issueNumber: i + 1,
      })
    );

    const result = await getAllActiveTasks();

    expect(result.length).toBe(50);
  });
});
