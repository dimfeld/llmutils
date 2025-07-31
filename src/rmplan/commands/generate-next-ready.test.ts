import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { handleGenerateCommand } from './generate.js';
import { clearPlanCache } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { ModuleMocker } from '../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('handleGenerateCommand with --next-ready flag', () => {
  let tempDir: string;
  let tasksDir: string;

  // Mock functions
  const logSpy = mock(() => {});
  const errorSpy = mock(() => {});
  const warnSpy = mock(() => {});
  const findNextReadyDependencySpy = mock(async () => ({
    plan: null,
    message: 'No ready dependencies found',
  }));
  const resolvePlanFileSpy = mock(async () => '/mock/plan/path.plan.md');
  const readPlanFileSpy = mock(async () => ({ id: 123, title: 'Mock Plan' }));

  beforeEach(async () => {
    // Clear mocks
    logSpy.mockClear();
    errorSpy.mockClear();
    warnSpy.mockClear();
    findNextReadyDependencySpy.mockClear();
    resolvePlanFileSpy.mockClear();
    readPlanFileSpy.mockClear();

    // Clear plan cache
    clearPlanCache();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-generate-nextready-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Mock modules
    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
      error: errorSpy,
      warn: warnSpy,
    }));

    await moduleMocker.mock('./find_next_dependency.js', () => ({
      findNextReadyDependency: findNextReadyDependencySpy,
    }));

    await moduleMocker.mock('../plans.js', () => ({
      ...require('../plans.js'),
      resolvePlanFile: resolvePlanFileSpy,
      readPlanFile: readPlanFileSpy,
      clearPlanCache: mock(() => {}),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: {
          tasks: tasksDir,
        },
        models: {
          planning: 'test-model',
        },
      }),
    }));

    await moduleMocker.mock('../configSchema.ts', () => ({
      resolveTasksDir: async () => tasksDir,
    }));

    // Mock git
    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => tempDir,
    }));
  });

  afterEach(async () => {
    // Clean up mocks
    moduleMocker.clear();

    // Clean up temp directory if it exists
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test('successfully finds and operates on a ready dependency with numeric ID', async () => {
    // Mock findNextReadyDependency to return a ready plan
    const readyPlan: PlanSchema & { filename: string } = {
      id: 456,
      title: 'Ready Dependency Plan',
      goal: 'Test dependency goal',
      details: 'Test dependency details',
      status: 'pending',
      priority: 'medium',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      tasks: [],
      filename: '456-ready-dependency-plan.plan.md',
    };

    findNextReadyDependencySpy.mockResolvedValueOnce({
      plan: readyPlan,
      message: 'Found ready plan: Ready Dependency Plan (ID: 456)',
    });

    const options = {
      nextReady: '123', // Parent plan ID
      extract: false,
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleGenerateCommand(undefined, options, command);

    // Should call findNextReadyDependency with the parent plan ID
    expect(findNextReadyDependencySpy).toHaveBeenCalledWith(123, tasksDir);

    // Should log the success message
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Found ready dependency: 456 - Ready Dependency Plan')
    );

    // Should have set options.plan to the found plan's filename
    expect(options.plan).toBe('456-ready-dependency-plan.plan.md');
  });

  test('successfully finds and operates on a ready dependency with file path', async () => {
    const parentPlanPath = '/mock/parent/plan.plan.md';
    
    // Mock the plan file resolution and reading
    resolvePlanFileSpy.mockResolvedValueOnce(parentPlanPath);
    readPlanFileSpy.mockResolvedValueOnce({
      id: 123,
      title: 'Parent Plan',
      goal: 'Parent goal',
      details: 'Parent details', 
      status: 'in_progress',
      priority: 'high',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      tasks: [],
    });

    // Mock findNextReadyDependency to return a ready plan
    const readyPlan: PlanSchema & { filename: string } = {
      id: 456,
      title: 'Ready Dependency Plan',
      goal: 'Test dependency goal',
      details: 'Test dependency details',
      status: 'pending',
      priority: 'medium',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      tasks: [],
      filename: '456-ready-dependency-plan.plan.md',
    };

    findNextReadyDependencySpy.mockResolvedValueOnce({
      plan: readyPlan,
      message: 'Found ready plan: Ready Dependency Plan (ID: 456)',
    });

    const options = {
      nextReady: parentPlanPath, // Parent plan file path
      extract: false,
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleGenerateCommand(undefined, options, command);

    // Should resolve the plan file
    expect(resolvePlanFileSpy).toHaveBeenCalledWith(parentPlanPath, undefined);
    
    // Should read the plan to get its ID
    expect(readPlanFileSpy).toHaveBeenCalledWith(parentPlanPath);

    // Should call findNextReadyDependency with the parent plan ID (extracted from file)
    expect(findNextReadyDependencySpy).toHaveBeenCalledWith(123, tasksDir);

    // Should log the success message
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Found ready dependency: 456 - Ready Dependency Plan')
    );

    // Should have set options.plan to the found plan's filename
    expect(options.plan).toBe('456-ready-dependency-plan.plan.md');
  });

  test('handles case when no ready dependencies exist', async () => {
    // Mock findNextReadyDependency to return no plan
    findNextReadyDependencySpy.mockResolvedValueOnce({
      plan: null,
      message: 'No ready or pending dependencies found',
    });

    const options = {
      nextReady: '123', // Parent plan ID
      extract: false,
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleGenerateCommand(undefined, options, command);

    // Should call findNextReadyDependency
    expect(findNextReadyDependencySpy).toHaveBeenCalledWith(123, tasksDir);

    // Should log the no dependencies message
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('No ready or pending dependencies found')
    );
  });

  test('handles invalid parent plan ID', async () => {
    // Mock findNextReadyDependency to return plan not found
    findNextReadyDependencySpy.mockResolvedValueOnce({
      plan: null,
      message: 'Plan not found: 999',
    });

    const options = {
      nextReady: '999', // Invalid parent plan ID
      extract: false,
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleGenerateCommand(undefined, options, command);

    // Should call findNextReadyDependency
    expect(findNextReadyDependencySpy).toHaveBeenCalledWith(999, tasksDir);

    // Should log the plan not found message
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Plan not found: 999'));
  });

  test('handles parent plan file without valid ID', async () => {
    const invalidPlanPath = '/mock/invalid/plan.plan.md';
    
    // Mock the plan file resolution and reading to return a plan without ID
    resolvePlanFileSpy.mockResolvedValueOnce(invalidPlanPath);
    readPlanFileSpy.mockResolvedValueOnce({
      title: 'Parent Plan Without ID',
      goal: 'Parent goal',
      details: 'Parent details',
      status: 'in_progress',
      priority: 'high',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      tasks: [],
      // No id field
    });

    const options = {
      nextReady: invalidPlanPath,
      extract: false,
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    // Should throw an error about missing plan ID
    await expect(handleGenerateCommand(undefined, options, command)).rejects.toThrow(
      'does not have a valid ID'
    );
  });
});