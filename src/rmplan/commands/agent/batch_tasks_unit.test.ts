import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { handleAgentCommand } from './agent.js';
import { clearPlanCache } from '../../plans.js';
import type { PlanSchema } from '../../planSchema.js';
import { ModuleMocker } from '../../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

// Mock functions
const rmplanAgentSpy = mock();
const logSpy = mock(() => {});
const resolvePlanFileSpy = mock(async (planFile: string) => planFile);
const loadEffectiveConfigSpy = mock(async () => ({}));
const resolveTasksDirSpy = mock(async () => '/test/tasks');

describe('--serial-tasks flag pass-through tests', () => {
  let tempDir: string;
  let planFile: string;

  beforeEach(async () => {
    // Clear all mocks
    rmplanAgentSpy.mockClear();
    logSpy.mockClear();
    resolvePlanFileSpy.mockClear();
    loadEffectiveConfigSpy.mockClear();
    resolveTasksDirSpy.mockClear();

    // Clear plan cache
    clearPlanCache();

    // Create temporary directory and test plan
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'batch-tasks-unit-test-'));
    planFile = path.join(tempDir, 'test-plan.yml');

    const testPlan: PlanSchema = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'pending',
      tasks: [{ title: 'Test task', description: 'Test description' }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await fs.writeFile(planFile, yaml.stringify(testPlan));

    // Mock dependencies
    await moduleMocker.mock('../../../logging.js', () => ({
      log: logSpy,
      error: mock(() => {}),
      warn: mock(() => {}),
      openLogFile: mock(() => {}),
      closeLogFile: mock(async () => {}),
    }));

    await moduleMocker.mock('../../configLoader.js', () => ({
      loadEffectiveConfig: loadEffectiveConfigSpy,
    }));

    await moduleMocker.mock('../../configSchema.js', () => ({
      resolveTasksDir: resolveTasksDirSpy,
    }));

    await moduleMocker.mock('../../plans.js', () => ({
      resolvePlanFile: resolvePlanFileSpy,
      findNextPlan: mock(async () => null), // No next plan available
    }));

    await moduleMocker.mock('./agent.js', () => ({
      rmplanAgent: rmplanAgentSpy,
      handleAgentCommand: handleAgentCommand, // Use the real implementation
    }));

    // Set up default mock behaviors
    resolvePlanFileSpy.mockResolvedValue(planFile);
  });

  afterEach(async () => {
    // Clean up mocks
    moduleMocker.clear();

    // Clean up temporary directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('basic flag pass-through', () => {
    test('serialTasks option is passed through to rmplanAgent', async () => {
      const options = { serialTasks: true };
      const globalCliOptions = {};

      await handleAgentCommand(planFile, options, globalCliOptions);

      // Verify rmplanAgent was called with the options including serialTasks
      expect(rmplanAgentSpy).toHaveBeenCalledWith(planFile, options, globalCliOptions);

      // Get the actual options that were passed
      const passedOptions = rmplanAgentSpy.mock.calls[0][1];
      expect(passedOptions.serialTasks).toBe(true);
    });

    test('serialTasks option defaults to undefined when not specified', async () => {
      const options = {}; // No serialTasks option
      const globalCliOptions = {};

      await handleAgentCommand(planFile, options, globalCliOptions);

      expect(rmplanAgentSpy).toHaveBeenCalledWith(planFile, options, globalCliOptions);

      // serialTasks should not be present in the options
      const passedOptions = rmplanAgentSpy.mock.calls[0][1];
      expect(passedOptions.serialTasks).toBeUndefined();
    });

    test('serialTasks false value is preserved', async () => {
      const options = { serialTasks: false };
      const globalCliOptions = {};

      await handleAgentCommand(planFile, options, globalCliOptions);

      expect(rmplanAgentSpy).toHaveBeenCalledWith(planFile, options, globalCliOptions);

      const passedOptions = rmplanAgentSpy.mock.calls[0][1];
      expect(passedOptions.serialTasks).toBe(false);
    });
  });

  describe('flag combination preservation', () => {
    test('serialTasks combined with other execution options', async () => {
      const options = {
        serialTasks: true,
        executor: 'claude-code',
        model: 'claude-3-5-sonnet',
        steps: 5,
        dryRun: true,
        nonInteractive: true,
      };
      const globalCliOptions = {};

      await handleAgentCommand(planFile, options, globalCliOptions);

      expect(rmplanAgentSpy).toHaveBeenCalledWith(planFile, options, globalCliOptions);

      const passedOptions = rmplanAgentSpy.mock.calls[0][1];
      expect(passedOptions.serialTasks).toBe(true);
      expect(passedOptions.executor).toBe('claude-code');
      expect(passedOptions.model).toBe('claude-3-5-sonnet');
      expect(passedOptions.steps).toBe(5);
      expect(passedOptions.dryRun).toBe(true);
      expect(passedOptions.nonInteractive).toBe(true);
    });

    test('serialTasks combined with workspace options', async () => {
      const options = {
        serialTasks: true,
        workspace: 'test-workspace-123',
        autoWorkspace: true,
        newWorkspace: true,
      };
      const globalCliOptions = {};

      await handleAgentCommand(planFile, options, globalCliOptions);

      expect(rmplanAgentSpy).toHaveBeenCalledWith(planFile, options, globalCliOptions);

      const passedOptions = rmplanAgentSpy.mock.calls[0][1];
      expect(passedOptions.serialTasks).toBe(true);
      expect(passedOptions.workspace).toBe('test-workspace-123');
      expect(passedOptions.autoWorkspace).toBe(true);
      expect(passedOptions.newWorkspace).toBe(true);
    });

    test('serialTasks combined with logging options', async () => {
      const options = {
        serialTasks: true,
        'no-log': true,
        verbose: true,
      };
      const globalCliOptions = {};

      await handleAgentCommand(planFile, options, globalCliOptions);

      expect(rmplanAgentSpy).toHaveBeenCalledWith(planFile, options, globalCliOptions);

      const passedOptions = rmplanAgentSpy.mock.calls[0][1];
      expect(passedOptions.serialTasks).toBe(true);
      expect(passedOptions['no-log']).toBe(true);
      expect(passedOptions.verbose).toBe(true);
    });
  });

  describe('global CLI options pass-through', () => {
    test('serialTasks with complex global CLI options', async () => {
      const options = { serialTasks: true };
      const globalCliOptions = {
        config: {
          paths: {
            tasks: '/custom/tasks',
            workspace: '/custom/workspaces',
          },
          models: {
            execution: 'claude-3-5-sonnet',
            planning: 'claude-3-haiku',
          },
          postApplyCommands: [{ title: 'Test command', command: 'echo test' }],
        },
        debug: true,
      };

      await handleAgentCommand(planFile, options, globalCliOptions);

      expect(rmplanAgentSpy).toHaveBeenCalledWith(planFile, options, globalCliOptions);

      // Verify both options and globalCliOptions are preserved
      const [passedPlanFile, passedOptions, passedGlobalOptions] = rmplanAgentSpy.mock.calls[0];
      expect(passedPlanFile).toBe(planFile);
      expect(passedOptions.serialTasks).toBe(true);
      expect(passedGlobalOptions).toEqual(globalCliOptions);
    });
  });

  describe('plan discovery with serialTasks', () => {
    test('serialTasks preserved with --next plan discovery', async () => {
      // Mock findNextPlan to return a plan
      const nextPlan = {
        id: 2,
        title: 'Next Plan',
        filename: '/test/next-plan.yml',
      };

      await moduleMocker.mock('../../plans.js', () => ({
        resolvePlanFile: resolvePlanFileSpy,
        findNextPlan: mock(async () => nextPlan),
      }));

      const options = {
        serialTasks: true,
        next: true,
      };
      const globalCliOptions = {};

      await handleAgentCommand(undefined, options, globalCliOptions);

      expect(rmplanAgentSpy).toHaveBeenCalledWith(nextPlan.filename, options, globalCliOptions);

      const passedOptions = rmplanAgentSpy.mock.calls[0][1];
      expect(passedOptions.serialTasks).toBe(true);
      expect(passedOptions.next).toBe(true);
    });

    test('serialTasks preserved with --current plan discovery', async () => {
      const currentPlan = {
        id: 3,
        title: 'Current Plan',
        filename: '/test/current-plan.yml',
      };

      await moduleMocker.mock('../../plans.js', () => ({
        resolvePlanFile: resolvePlanFileSpy,
        findNextPlan: mock(async () => currentPlan),
      }));

      const options = {
        serialTasks: true,
        current: true,
      };
      const globalCliOptions = {};

      await handleAgentCommand(undefined, options, globalCliOptions);

      expect(rmplanAgentSpy).toHaveBeenCalledWith(currentPlan.filename, options, globalCliOptions);

      const passedOptions = rmplanAgentSpy.mock.calls[0][1];
      expect(passedOptions.serialTasks).toBe(true);
      expect(passedOptions.current).toBe(true);
    });
  });

  describe('error handling with serialTasks', () => {
    test('error thrown when plan file is required but not provided', async () => {
      const options = { serialTasks: true };
      const globalCliOptions = {};

      await expect(handleAgentCommand(undefined, options, globalCliOptions)).rejects.toThrow(
        'Plan file is required'
      );

      expect(rmplanAgentSpy).not.toHaveBeenCalled();
    });

    test('serialTasks preserves error handling behavior', async () => {
      // Test that the flag doesn't interfere with normal error handling
      const options = { serialTasks: true };
      const globalCliOptions = {};

      // This should work without throwing errors related to serialTasks processing
      await handleAgentCommand(planFile, options, globalCliOptions);

      expect(rmplanAgentSpy).toHaveBeenCalled();
      const passedOptions = rmplanAgentSpy.mock.calls[0][1];
      expect(passedOptions.serialTasks).toBe(true);
    });
  });

  describe('option type preservation', () => {
    test('numeric options are preserved with serialTasks', async () => {
      const options = {
        serialTasks: true,
        steps: 10,
        timeout: 5000,
      };
      const globalCliOptions = {};

      await handleAgentCommand(planFile, options, globalCliOptions);

      const passedOptions = rmplanAgentSpy.mock.calls[0][1];
      expect(passedOptions.serialTasks).toBe(true);
      expect(passedOptions.steps).toBe(10);
      expect(passedOptions.timeout).toBe(5000);
      expect(typeof passedOptions.steps).toBe('number');
      expect(typeof passedOptions.timeout).toBe('number');
    });

    test('boolean options are preserved with serialTasks', async () => {
      const options = {
        serialTasks: true,
        dryRun: false,
        nonInteractive: true,
        direct: false,
      };
      const globalCliOptions = {};

      await handleAgentCommand(planFile, options, globalCliOptions);

      const passedOptions = rmplanAgentSpy.mock.calls[0][1];
      expect(passedOptions.serialTasks).toBe(true);
      expect(passedOptions.dryRun).toBe(false);
      expect(passedOptions.nonInteractive).toBe(true);
      expect(passedOptions.direct).toBe(false);
      expect(typeof passedOptions.serialTasks).toBe('boolean');
      expect(typeof passedOptions.dryRun).toBe('boolean');
      expect(typeof passedOptions.nonInteractive).toBe('boolean');
      expect(typeof passedOptions.direct).toBe('boolean');
    });

    test('string options are preserved with serialTasks', async () => {
      const options = {
        serialTasks: true,
        executor: 'claude-code',
        model: 'gpt-4',
        workspace: 'test-123',
      };
      const globalCliOptions = {};

      await handleAgentCommand(planFile, options, globalCliOptions);

      const passedOptions = rmplanAgentSpy.mock.calls[0][1];
      expect(passedOptions.serialTasks).toBe(true);
      expect(passedOptions.executor).toBe('claude-code');
      expect(passedOptions.model).toBe('gpt-4');
      expect(passedOptions.workspace).toBe('test-123');
      expect(typeof passedOptions.executor).toBe('string');
      expect(typeof passedOptions.model).toBe('string');
      expect(typeof passedOptions.workspace).toBe('string');
    });
  });

  describe('edge cases', () => {
    test('handles null and undefined options gracefully', async () => {
      const options = {
        serialTasks: true,
        model: null,
        workspace: undefined,
      };
      const globalCliOptions = {};

      await handleAgentCommand(planFile, options, globalCliOptions);

      const passedOptions = rmplanAgentSpy.mock.calls[0][1];
      expect(passedOptions.serialTasks).toBe(true);
      expect(passedOptions.model).toBe(null);
      expect(passedOptions.workspace).toBe(undefined);
    });

    test('handles empty string options', async () => {
      const options = {
        serialTasks: true,
        executor: '',
        workspace: '',
      };
      const globalCliOptions = {};

      await handleAgentCommand(planFile, options, globalCliOptions);

      const passedOptions = rmplanAgentSpy.mock.calls[0][1];
      expect(passedOptions.serialTasks).toBe(true);
      expect(passedOptions.executor).toBe('');
      expect(passedOptions.workspace).toBe('');
    });

    test('handles options object mutation', async () => {
      const options = { serialTasks: true };
      const globalCliOptions = {};

      await handleAgentCommand(planFile, options, globalCliOptions);

      // The original options object should not be affected
      expect(options.serialTasks).toBe(true);

      const passedOptions = rmplanAgentSpy.mock.calls[0][1];
      expect(passedOptions.serialTasks).toBe(true);
    });
  });
});
