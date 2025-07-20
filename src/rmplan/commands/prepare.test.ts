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
