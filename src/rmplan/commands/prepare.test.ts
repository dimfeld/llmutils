import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { handlePrepareCommand } from './prepare.js';
import { clearPlanCache } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { ModuleMocker } from '../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

// Mock console functions
const logSpy = mock(() => {});
const errorSpy = mock(() => {});

// Mock preparePhase function
const preparePhaseSpy = mock(async () => {});

describe('handlePrepareCommand', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    // Clear mocks
    logSpy.mockClear();
    errorSpy.mockClear();
    preparePhaseSpy.mockClear();

    // Clear plan cache
    clearPlanCache();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-prepare-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Mock modules
    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
      error: errorSpy,
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../plans/prepare_phase.js', () => ({
      preparePhase: preparePhaseSpy,
    }));

    // Mock git root
    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => tempDir,
    }));
  });

  afterEach(async () => {
    // Clean up mocks
    moduleMocker.clear();

    // Clean up
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('direct_mode configuration logic', () => {
    test('no flag, no config - direct should be false', async () => {
      // Mock config loader with no direct_mode setting
      await moduleMocker.mock('../configLoader.js', () => ({
        loadEffectiveConfig: async () => ({
          paths: {
            tasks: tasksDir,
          },
        }),
      }));

      const planPath = path.join(tasksDir, 'test-plan.yml');
      await fs.writeFile(
        planPath,
        yaml.stringify({
          id: 'test-001',
          title: 'Test Plan',
          goal: 'Test goal',
          status: 'pending',
        })
      );

      const options = {
        // No direct flag specified
        parent: {
          opts: () => ({}),
        },
      };

      const command = {
        parent: {
          opts: () => ({}),
        },
      };

      await handlePrepareCommand(planPath, options, command);

      expect(preparePhaseSpy).toHaveBeenCalledWith(
        planPath,
        expect.any(Object),
        expect.objectContaining({
          direct: false, // Should default to false
        })
      );
    });

    test('no flag, config direct_mode: true - direct should be true', async () => {
      // Mock config loader with direct_mode: true
      await moduleMocker.mock('../configLoader.js', () => ({
        loadEffectiveConfig: async () => ({
          paths: {
            tasks: tasksDir,
          },
          planning: {
            direct_mode: true,
          },
        }),
      }));

      const planPath = path.join(tasksDir, 'test-plan.yml');
      await fs.writeFile(
        planPath,
        yaml.stringify({
          id: 'test-001',
          title: 'Test Plan',
          goal: 'Test goal',
          status: 'pending',
        })
      );

      const options = {
        // No direct flag specified
        parent: {
          opts: () => ({}),
        },
      };

      const command = {
        parent: {
          opts: () => ({}),
        },
      };

      await handlePrepareCommand(planPath, options, command);

      expect(preparePhaseSpy).toHaveBeenCalledWith(
        planPath,
        expect.any(Object),
        expect.objectContaining({
          direct: true, // Should use config value
        })
      );
    });

    test('no flag, config direct_mode: false - direct should be false', async () => {
      // Mock config loader with direct_mode: false
      await moduleMocker.mock('../configLoader.js', () => ({
        loadEffectiveConfig: async () => ({
          paths: {
            tasks: tasksDir,
          },
          planning: {
            direct_mode: false,
          },
        }),
      }));

      const planPath = path.join(tasksDir, 'test-plan.yml');
      await fs.writeFile(
        planPath,
        yaml.stringify({
          id: 'test-001',
          title: 'Test Plan',
          goal: 'Test goal',
          status: 'pending',
        })
      );

      const options = {
        // No direct flag specified
        parent: {
          opts: () => ({}),
        },
      };

      const command = {
        parent: {
          opts: () => ({}),
        },
      };

      await handlePrepareCommand(planPath, options, command);

      expect(preparePhaseSpy).toHaveBeenCalledWith(
        planPath,
        expect.any(Object),
        expect.objectContaining({
          direct: false, // Should use config value
        })
      );
    });

    test('--direct flag overrides config direct_mode: false', async () => {
      // Mock config loader with direct_mode: false
      await moduleMocker.mock('../configLoader.js', () => ({
        loadEffectiveConfig: async () => ({
          paths: {
            tasks: tasksDir,
          },
          planning: {
            direct_mode: false,
          },
        }),
      }));

      const planPath = path.join(tasksDir, 'test-plan.yml');
      await fs.writeFile(
        planPath,
        yaml.stringify({
          id: 'test-001',
          title: 'Test Plan',
          goal: 'Test goal',
          status: 'pending',
        })
      );

      const options = {
        direct: true, // CLI flag set to true
        parent: {
          opts: () => ({}),
        },
      };

      const command = {
        parent: {
          opts: () => ({}),
        },
      };

      await handlePrepareCommand(planPath, options, command);

      expect(preparePhaseSpy).toHaveBeenCalledWith(
        planPath,
        expect.any(Object),
        expect.objectContaining({
          direct: true, // CLI flag should override config
        })
      );
    });

    test('--no-direct flag overrides config direct_mode: true', async () => {
      // Mock config loader with direct_mode: true
      await moduleMocker.mock('../configLoader.js', () => ({
        loadEffectiveConfig: async () => ({
          paths: {
            tasks: tasksDir,
          },
          planning: {
            direct_mode: true,
          },
        }),
      }));

      const planPath = path.join(tasksDir, 'test-plan.yml');
      await fs.writeFile(
        planPath,
        yaml.stringify({
          id: 'test-001',
          title: 'Test Plan',
          goal: 'Test goal',
          status: 'pending',
        })
      );

      const options = {
        direct: false, // CLI flag set to false (--no-direct)
        parent: {
          opts: () => ({}),
        },
      };

      const command = {
        parent: {
          opts: () => ({}),
        },
      };

      await handlePrepareCommand(planPath, options, command);

      expect(preparePhaseSpy).toHaveBeenCalledWith(
        planPath,
        expect.any(Object),
        expect.objectContaining({
          direct: false, // CLI flag should override config
        })
      );
    });
  });
});

describe('handlePrepareCommand with --next-ready flag', () => {
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
  const preparePhaseSpy = mock(async () => {});

  beforeEach(async () => {
    // Clear mocks
    logSpy.mockClear();
    errorSpy.mockClear();
    warnSpy.mockClear();
    findNextReadyDependencySpy.mockClear();
    resolvePlanFileSpy.mockClear();
    readPlanFileSpy.mockClear();
    preparePhaseSpy.mockClear();

    // Clear plan cache
    clearPlanCache();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-prepare-nextready-test-'));
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

    await moduleMocker.mock('../plans/prepare_phase.js', () => ({
      preparePhase: preparePhaseSpy,
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
      force: false,
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handlePrepareCommand(undefined, options, command);

    // Should call findNextReadyDependency with the parent plan ID
    expect(findNextReadyDependencySpy).toHaveBeenCalledWith(123, tasksDir);

    // Should log the success message
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Found ready plan: 456 - Ready Dependency Plan')
    );

    // Should call preparePhase with the found plan's filename
    expect(preparePhaseSpy).toHaveBeenCalledWith(
      '456-ready-dependency-plan.plan.md',
      expect.any(Object),
      expect.any(Object)
    );
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
      force: false,
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handlePrepareCommand(undefined, options, command);

    // Should resolve the plan file
    expect(resolvePlanFileSpy).toHaveBeenCalledWith(parentPlanPath, undefined);

    // Should read the plan to get its ID
    expect(readPlanFileSpy).toHaveBeenCalledWith(parentPlanPath);

    // Should call findNextReadyDependency with the parent plan ID (extracted from file)
    expect(findNextReadyDependencySpy).toHaveBeenCalledWith(123, tasksDir);

    // Should log the success message
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Found ready plan: 456 - Ready Dependency Plan')
    );

    // Should call preparePhase with the found plan's filename
    expect(preparePhaseSpy).toHaveBeenCalledWith(
      '456-ready-dependency-plan.plan.md',
      expect.any(Object),
      expect.any(Object)
    );
  });

  test('handles case when no ready dependencies exist', async () => {
    // Mock findNextReadyDependency to return no plan
    findNextReadyDependencySpy.mockResolvedValueOnce({
      plan: null,
      message: 'No ready or pending dependencies found',
    });

    const options = {
      nextReady: '123', // Parent plan ID
      force: false,
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handlePrepareCommand(undefined, options, command);

    // Should call findNextReadyDependency
    expect(findNextReadyDependencySpy).toHaveBeenCalledWith(123, tasksDir);

    // Should log the no dependencies message
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('No ready or pending dependencies found')
    );

    // Should NOT call preparePhase
    expect(preparePhaseSpy).not.toHaveBeenCalled();
  });

  test('handles invalid parent plan ID', async () => {
    // Mock findNextReadyDependency to return plan not found
    findNextReadyDependencySpy.mockResolvedValueOnce({
      plan: null,
      message: 'Plan not found: 999',
    });

    const options = {
      nextReady: '999', // Invalid parent plan ID
      force: false,
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handlePrepareCommand(undefined, options, command);

    // Should call findNextReadyDependency
    expect(findNextReadyDependencySpy).toHaveBeenCalledWith(999, tasksDir);

    // Should log the plan not found message
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Plan not found: 999'));

    // Should NOT call preparePhase
    expect(preparePhaseSpy).not.toHaveBeenCalled();
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
      force: false,
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    // Should throw an error about missing plan ID
    await expect(handlePrepareCommand(undefined, options, command)).rejects.toThrow(
      'does not have a valid ID'
    );
  });

  test('integrates with --use-yaml option', async () => {
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
      useYaml: true,
      force: false,
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handlePrepareCommand(undefined, options, command);

    // Should call findNextReadyDependency with the parent plan ID
    expect(findNextReadyDependencySpy).toHaveBeenCalledWith(123, tasksDir);

    // Should call preparePhase with useYaml: true
    expect(preparePhaseSpy).toHaveBeenCalledWith(
      '456-ready-dependency-plan.plan.md',
      expect.any(Object),
      expect.objectContaining({
        useYaml: true,
      })
    );
  });

  test('passes rmfilter arguments correctly', async () => {
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
      force: false,
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    // Mock process.argv to include rmfilter args
    const originalArgv = process.argv;
    process.argv = [...process.argv, '--', 'src/**/*.ts', '--with-imports'];

    await handlePrepareCommand(undefined, options, command);

    // Restore process.argv
    process.argv = originalArgv;

    // Should call preparePhase with rmfilter args
    expect(preparePhaseSpy).toHaveBeenCalledWith(
      '456-ready-dependency-plan.plan.md',
      expect.any(Object),
      expect.objectContaining({
        rmfilterArgs: ['src/**/*.ts', '--with-imports'],
      })
    );
  });

  test('respects direct mode configuration', async () => {
    // Mock config with direct_mode: true
    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: {
          tasks: tasksDir,
        },
        models: {
          planning: 'test-model',
        },
        planning: {
          direct_mode: true,
        },
      }),
    }));

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
      force: false,
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handlePrepareCommand(undefined, options, command);

    // Should call preparePhase with direct: true from config
    expect(preparePhaseSpy).toHaveBeenCalledWith(
      '456-ready-dependency-plan.plan.md',
      expect.any(Object),
      expect.objectContaining({
        direct: true,
      })
    );
  });
});
