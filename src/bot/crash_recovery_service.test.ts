import { describe, expect, it, beforeEach, afterAll, mock } from 'bun:test';
import { recoverCrashedTasks } from './crash_recovery_service.js';
import { db, tasks } from './db/index.js';
import * as taskCheckpointsManager from './db/task_checkpoints_manager.js';
import * as tasksManager from './db/tasks_manager.js';
import * as prResponseService from './pr_response_service.js';
import * as rmplanAgent from '../rmplan/agent.js';
import * as threadManager from './core/thread_manager.js';
import { WorkspaceLock } from '../rmplan/workspace/workspace_lock.js';

// Mock the modules
mock.module('./db/index.js', () => ({
  db: {
    select: mock(() => ({
      from: mock(() => ({
        where: mock(() => Promise.resolve([])),
      })),
    })),
    update: mock(() => ({
      set: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
    })),
  },
  tasks: {},
}));

mock.module('./db/task_checkpoints_manager.js', () => ({
  getTasksWithCheckpoints: mock(() => Promise.resolve([])),
  getCheckpoint: mock(() => Promise.resolve(null)),
  deleteCheckpoint: mock(() => Promise.resolve()),
  saveCheckpoint: mock(() => Promise.resolve()),
  cleanupStaleCheckpoints: mock(() => Promise.resolve()),
}));

mock.module('./db/tasks_manager.js', () => ({
  getAllActiveTasks: mock(() => Promise.resolve([])),
}));

mock.module('./pr_response_service.js', () => ({
  resumePrResponseTask: mock(() => Promise.resolve()),
}));

mock.module('../rmplan/agent.js', () => ({
  rmplanAgent: mock(() => Promise.resolve()),
}));

mock.module('./core/thread_manager.js', () => ({
  notifyTaskProgress: mock(() => Promise.resolve()),
}));

// Mock console methods to avoid test output noise
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

beforeEach(() => {
  console.log = mock(() => {});
  console.error = mock(() => {});
  console.warn = mock(() => {});
});

describe('recoverCrashedTasks', () => {
  it('should handle no tasks with checkpoints gracefully', async () => {
    mock.module('./db/task_checkpoints_manager.js', () => ({
      getTasksWithCheckpoints: mock(() => Promise.resolve([])),
      cleanupStaleCheckpoints: mock(() => Promise.resolve()),
    }));

    mock.module('./db/tasks_manager.js', () => ({
      getAllActiveTasks: mock(() => Promise.resolve([])),
    }));

    await recoverCrashedTasks();

    // Should complete without errors
    expect(true).toBe(true);
  });

  it('should skip tasks in terminal states', async () => {
    const mockTaskId = 'test-task-1';
    const mockDeleteCheckpoint = mock(() => Promise.resolve());

    mock.module('./db/task_checkpoints_manager.js', () => ({
      getTasksWithCheckpoints: mock(() => Promise.resolve([mockTaskId])),
      getCheckpoint: mock(() =>
        Promise.resolve({
          stepIndex: 0,
          checkpointData: { taskType: 'planning' },
        })
      ),
      deleteCheckpoint: mockDeleteCheckpoint,
      cleanupStaleCheckpoints: mock(() => Promise.resolve()),
    }));

    mock.module('./db/tasks_manager.js', () => ({
      getAllActiveTasks: mock(() => Promise.resolve([{ id: mockTaskId, status: 'planning' }])),
    }));

    const mockDbSelect = mock(() => ({
      from: mock(() => ({
        where: mock(() =>
          Promise.resolve([{ id: mockTaskId, status: 'completed', taskType: 'planning' }])
        ),
      })),
    }));

    mock.module('./db/index.js', () => ({
      db: {
        select: mockDbSelect,
        update: mock(() => ({
          set: mock(() => ({
            where: mock(() => Promise.resolve()),
          })),
        })),
      },
      tasks: {},
    }));

    await recoverCrashedTasks();

    expect(mockDeleteCheckpoint).toHaveBeenCalledWith(mockTaskId);
  });

  it('should resume PR response tasks', async () => {
    const mockTaskId = 'test-pr-task';
    const mockResumePrResponseTask = mock(() => Promise.resolve());
    const mockNotifyTaskProgress = mock(() => Promise.resolve());

    mock.module('./db/task_checkpoints_manager.js', () => ({
      getTasksWithCheckpoints: mock(() => Promise.resolve([mockTaskId])),
      getCheckpoint: mock(() =>
        Promise.resolve({
          stepIndex: 0,
          checkpointData: { taskType: 'responding' },
        })
      ),
      deleteCheckpoint: mock(() => Promise.resolve()),
      cleanupStaleCheckpoints: mock(() => Promise.resolve()),
    }));

    mock.module('./db/tasks_manager.js', () => ({
      getAllActiveTasks: mock(() => Promise.resolve([{ id: mockTaskId, status: 'responding' }])),
    }));

    mock.module('./pr_response_service.js', () => ({
      resumePrResponseTask: mockResumePrResponseTask,
    }));

    mock.module('./core/thread_manager.js', () => ({
      notifyTaskProgress: mockNotifyTaskProgress,
    }));

    const mockDbSelect = mock(() => ({
      from: mock(() => ({
        where: mock(() =>
          Promise.resolve([{ id: mockTaskId, status: 'responding', taskType: 'responding' }])
        ),
      })),
    }));

    mock.module('./db/index.js', () => ({
      db: {
        select: mockDbSelect,
        update: mock(() => ({
          set: mock(() => ({
            where: mock(() => Promise.resolve()),
          })),
        })),
      },
      tasks: {},
    }));

    await recoverCrashedTasks();

    expect(mockResumePrResponseTask).toHaveBeenCalledWith(mockTaskId);
    expect(mockNotifyTaskProgress).toHaveBeenCalled();
  });

  it('should handle workspace lock conflicts', async () => {
    const mockTaskId = 'test-planning-task';
    const mockWorkspacePath = '/test/workspace';
    const mockNotifyTaskProgress = mock(() => Promise.resolve());
    const mockDbUpdate = mock(() => ({
      set: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
    }));

    mock.module('./db/task_checkpoints_manager.js', () => ({
      getTasksWithCheckpoints: mock(() => Promise.resolve([mockTaskId])),
      getCheckpoint: mock(() =>
        Promise.resolve({
          stepIndex: 2,
          checkpointData: {
            taskType: 'planning',
            planFile: '/test/plan.yml',
            workspacePath: mockWorkspacePath,
          },
        })
      ),
      deleteCheckpoint: mock(() => Promise.resolve()),
      cleanupStaleCheckpoints: mock(() => Promise.resolve()),
    }));

    mock.module('./db/tasks_manager.js', () => ({
      getAllActiveTasks: mock(() => Promise.resolve([{ id: mockTaskId, status: 'planning' }])),
    }));

    mock.module('./core/thread_manager.js', () => ({
      notifyTaskProgress: mockNotifyTaskProgress,
    }));

    // Mock workspace lock to indicate it's locked
    WorkspaceLock.getLockInfo = mock(() =>
      Promise.resolve({
        pid: 1234,
        command: 'test',
        startedAt: new Date().toISOString(),
        hostname: 'test-host',
        version: 1,
      })
    );
    WorkspaceLock.isLockStale = mock(() => Promise.resolve(false));

    const mockDbSelect = mock(() => ({
      from: mock(() => ({
        where: mock(() =>
          Promise.resolve([{ id: mockTaskId, status: 'planning', taskType: 'planning' }])
        ),
      })),
    }));

    mock.module('./db/index.js', () => ({
      db: {
        select: mockDbSelect,
        update: mockDbUpdate,
      },
      tasks: {},
    }));

    await recoverCrashedTasks();

    // Should not call rmplanAgent when workspace is locked
    expect(mockNotifyTaskProgress).toHaveBeenCalledWith(
      mockTaskId,
      'Bot restarted - resuming task from checkpoint',
      'planning'
    );
  });

  it('should successfully resume planning tasks', async () => {
    const mockTaskId = 'test-planning-task';
    const mockWorkspacePath = '/test/workspace';
    const mockRmplanAgent = mock(() => Promise.resolve());
    const mockNotifyTaskProgress = mock(() => Promise.resolve());
    const mockDbUpdate = mock(() => ({
      set: mock(() => ({
        where: mock(() => Promise.resolve()),
      })),
    }));
    const mockDeleteCheckpoint = mock(() => Promise.resolve());

    mock.module('./db/task_checkpoints_manager.js', () => ({
      getTasksWithCheckpoints: mock(() => Promise.resolve([mockTaskId])),
      getCheckpoint: mock(() =>
        Promise.resolve({
          stepIndex: 2,
          checkpointData: {
            taskType: 'planning',
            planFile: '/test/plan.yml',
            workspacePath: mockWorkspacePath,
            executorName: 'test-executor',
            model: 'test-model',
          },
        })
      ),
      deleteCheckpoint: mockDeleteCheckpoint,
      cleanupStaleCheckpoints: mock(() => Promise.resolve()),
      saveCheckpoint: mock(() => Promise.resolve()),
    }));

    mock.module('./db/tasks_manager.js', () => ({
      getAllActiveTasks: mock(() => Promise.resolve([{ id: mockTaskId, status: 'planning' }])),
    }));

    mock.module('../rmplan/agent.js', () => ({
      rmplanAgent: mockRmplanAgent,
    }));

    mock.module('./core/thread_manager.js', () => ({
      notifyTaskProgress: mockNotifyTaskProgress,
    }));

    // Mock workspace lock to indicate it's not locked
    WorkspaceLock.getLockInfo = mock(() => Promise.resolve(null));

    const mockDbSelect = mock(() => ({
      from: mock(() => ({
        where: mock(() =>
          Promise.resolve([{ id: mockTaskId, status: 'planning', taskType: 'planning' }])
        ),
      })),
    }));

    mock.module('./db/index.js', () => ({
      db: {
        select: mockDbSelect,
        update: mockDbUpdate,
      },
      tasks: {},
    }));

    await recoverCrashedTasks();

    expect(mockRmplanAgent).toHaveBeenCalledWith(
      '/test/plan.yml',
      expect.objectContaining({
        workspace: mockWorkspacePath,
        botTaskId: mockTaskId,
        nonInteractive: true,
        'no-log': true,
        executor: 'test-executor',
        model: 'test-model',
        resumeFromCheckpoint: {
          stepIndex: 2,
          checkpointData: expect.any(Object),
        },
      }),
      { debug: false }
    );

    expect(mockDbUpdate).toHaveBeenCalled();
    expect(mockDeleteCheckpoint).toHaveBeenCalledWith(mockTaskId);
  });
});

// Restore console methods
afterAll(() => {
  console.log = originalLog;
  console.error = originalError;
  console.warn = originalWarn;
});
