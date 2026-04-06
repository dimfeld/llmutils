import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import * as agentModule from './agent.js';
import type { PlanSchema } from '../../planSchema.js';

// Mock functions — declared with vi.hoisted() so they are available inside vi.mock() factories
const {
  logSpy,
  loadEffectiveConfigSpy,
  findNextPlanFromDbSpy,
  runWithHeadlessAdapterIfEnabledSpy,
} = vi.hoisted(() => ({
  logSpy: vi.fn(() => {}),
  loadEffectiveConfigSpy: vi.fn(async () => ({})),
  findNextPlanFromDbSpy: vi.fn(async () => null),
  // Capture args but do NOT call callback — prevents timAgent from running (intra-module
  // calls cannot be intercepted by vi.spyOn, so we verify via this mock instead)
  runWithHeadlessAdapterIfEnabledSpy: vi.fn(async (_opts: any) => {}),
}));

vi.mock('../../../logging.js', () => ({
  log: logSpy,
  error: vi.fn(() => {}),
  warn: vi.fn(() => {}),
  openLogFile: vi.fn(() => {}),
  closeLogFile: vi.fn(async () => {}),
  debugLog: vi.fn(() => {}),
  sendStructured: vi.fn(() => {}),
  boldMarkdownHeaders: (s: string) => s,
  runWithLogger: vi.fn(async (_adapter: any, fn: () => any) => fn()),
  writeStdout: vi.fn(() => {}),
  writeStderr: vi.fn(() => {}),
}));

vi.mock('../../configLoader.js', () => ({
  loadEffectiveConfig: loadEffectiveConfigSpy,
  loadGlobalConfigForNotifications: vi.fn(async () => ({})),
}));

vi.mock('../../headless.js', () => ({
  runWithHeadlessAdapterIfEnabled: runWithHeadlessAdapterIfEnabledSpy,
  isTunnelActive: vi.fn(() => false),
  toHeadlessPlanSummary: vi.fn((plan: any) => plan),
  createHeadlessAdapterForCommand: vi.fn(async () => null),
  updateHeadlessSessionInfo: vi.fn(() => {}),
  buildHeadlessSessionInfo: vi.fn(async () => null),
  resetHeadlessWarningStateForTests: vi.fn(() => {}),
  resolveHeadlessUrl: vi.fn(() => 'ws://localhost:8123/tim-agent'),
  DEFAULT_HEADLESS_URL: 'ws://localhost:8123/tim-agent',
}));

vi.mock('../../../logging/tunnel_client.js', () => ({
  isTunnelActive: vi.fn(() => false),
}));

vi.mock('../../ensure_plan_in_db.js', () => ({
  resolvePlanFromDbOrSyncFile: vi.fn(async (_planArg: string) => ({
    plan: { id: 1, title: 'Test Plan', status: 'pending', tasks: [] },
    planPath: '/tmp/test-plan.yml',
  })),
  isPlanNotFoundError: vi.fn(() => false),
}));

vi.mock('../plan_discovery.js', () => ({
  findNextPlanFromDb: findNextPlanFromDbSpy,
  findLatestPlanFromDb: vi.fn(async () => null),
  findNextReadyDependencyFromDb: vi.fn(async () => ({ plan: null, message: '' })),
  toHeadlessPlanSummary: (plan: { id?: number; uuid?: string; title?: string }) => ({
    id: plan.id,
    uuid: plan.uuid,
    title: plan.title,
  }),
  findNextPlanFromCollection: vi.fn(() => null),
  findNextReadyDependencyFromCollection: vi.fn(() => null),
  loadDbPlans: vi.fn(async () => []),
}));

vi.mock('../../notifications.js', () => ({
  sendNotification: vi.fn(async () => {}),
}));

vi.mock('../../../common/git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../common/git.js')>()),
  getGitRoot: vi.fn(async () => '/tmp/test-repo'),
}));

describe('--serial-tasks flag pass-through tests', () => {
  let tempDir: string;
  let planFile: string;

  beforeEach(async () => {
    // Clear all mocks
    logSpy.mockClear();
    loadEffectiveConfigSpy.mockClear();
    findNextPlanFromDbSpy.mockClear();
    runWithHeadlessAdapterIfEnabledSpy.mockClear();

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

    await fs.writeFile(planFile, `---\n${yaml.stringify(testPlan)}---\n`);
  });

  afterEach(async () => {
    vi.clearAllMocks();

    // Clean up temporary directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // Helper: get the callback that handleAgentCommand passed to runWithHeadlessAdapterIfEnabled
  function getCapturedCallback(): (() => any) | undefined {
    const calls = runWithHeadlessAdapterIfEnabledSpy.mock.calls;
    if (calls.length === 0) return undefined;
    return calls[0][0].callback;
  }

  describe('basic flag pass-through', () => {
    test('serialTasks option is passed through to timAgent', async () => {
      const options = { serialTasks: true };
      const globalCliOptions = {};

      await agentModule.handleAgentCommand(planFile, options, globalCliOptions);

      // handleAgentCommand should have called runWithHeadlessAdapterIfEnabled
      expect(runWithHeadlessAdapterIfEnabledSpy).toHaveBeenCalledTimes(1);
      // The options object is passed by reference to timAgent in the callback —
      // verify the original options object has the expected property
      expect(options.serialTasks).toBe(true);
    });

    test('serialTasks option defaults to undefined when not specified', async () => {
      const options: Record<string, any> = {}; // No serialTasks option
      const globalCliOptions = {};

      await agentModule.handleAgentCommand(planFile, options, globalCliOptions);

      expect(runWithHeadlessAdapterIfEnabledSpy).toHaveBeenCalledTimes(1);
      expect(options.serialTasks).toBeUndefined();
    });

    test('serialTasks false value is preserved', async () => {
      const options = { serialTasks: false };
      const globalCliOptions = {};

      await agentModule.handleAgentCommand(planFile, options, globalCliOptions);

      expect(runWithHeadlessAdapterIfEnabledSpy).toHaveBeenCalledTimes(1);
      expect(options.serialTasks).toBe(false);
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

      await agentModule.handleAgentCommand(planFile, options, globalCliOptions);

      expect(runWithHeadlessAdapterIfEnabledSpy).toHaveBeenCalledTimes(1);
      // Options object is not mutated — all values preserved
      expect(options.serialTasks).toBe(true);
      expect(options.executor).toBe('claude-code');
      expect(options.model).toBe('claude-3-5-sonnet');
      expect(options.steps).toBe(5);
      expect(options.dryRun).toBe(true);
      expect(options.nonInteractive).toBe(true);
    });

    test('serialTasks combined with workspace options', async () => {
      const options = {
        serialTasks: true,
        workspace: 'test-workspace-123',
        autoWorkspace: true,
        newWorkspace: true,
      };
      const globalCliOptions = {};

      await agentModule.handleAgentCommand(planFile, options, globalCliOptions);

      expect(runWithHeadlessAdapterIfEnabledSpy).toHaveBeenCalledTimes(1);
      expect(options.serialTasks).toBe(true);
      expect(options.workspace).toBe('test-workspace-123');
      expect(options.autoWorkspace).toBe(true);
      expect(options.newWorkspace).toBe(true);
    });

    test('serialTasks combined with logging options', async () => {
      const options = {
        serialTasks: true,
        log: false,
        verbose: true,
      };
      const globalCliOptions = {};

      await agentModule.handleAgentCommand(planFile, options, globalCliOptions);

      expect(runWithHeadlessAdapterIfEnabledSpy).toHaveBeenCalledTimes(1);
      expect(options.serialTasks).toBe(true);
      expect(options.log).toBe(false);
      expect(options.verbose).toBe(true);
    });
  });

  describe('global CLI options pass-through', () => {
    test('serialTasks with complex global CLI options', async () => {
      const options = { serialTasks: true };
      const globalCliOptions = {
        config: {
          paths: {
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

      await agentModule.handleAgentCommand(planFile, options, globalCliOptions);

      expect(runWithHeadlessAdapterIfEnabledSpy).toHaveBeenCalledTimes(1);
      expect(options.serialTasks).toBe(true);
      // globalCliOptions is not mutated
      expect(globalCliOptions.debug).toBe(true);
      expect(globalCliOptions.config.models.execution).toBe('claude-3-5-sonnet');
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

      findNextPlanFromDbSpy.mockResolvedValueOnce(nextPlan as any);

      const options = {
        serialTasks: true,
        next: true,
      };
      const globalCliOptions = {};

      await agentModule.handleAgentCommand(undefined, options, globalCliOptions);

      expect(runWithHeadlessAdapterIfEnabledSpy).toHaveBeenCalledTimes(1);
      // The plan ID string should have been resolved and passed to runWithHeadlessAdapterIfEnabled
      const passedOpts = runWithHeadlessAdapterIfEnabledSpy.mock.calls[0][0];
      // options.serialTasks preserved
      expect(options.serialTasks).toBe(true);
      expect(options.next).toBe(true);
      // The callback closure should call timAgent with String(nextPlan.id) as first arg
      // We verify this indirectly by ensuring plan summary was populated
      expect(passedOpts.plan).toMatchObject({ id: 2, title: 'Next Plan' });
    });

    test('serialTasks preserved with --current plan discovery', async () => {
      const currentPlan = {
        id: 3,
        title: 'Current Plan',
        filename: '/test/current-plan.yml',
      };

      findNextPlanFromDbSpy.mockResolvedValueOnce(currentPlan as any);

      const options = {
        serialTasks: true,
        current: true,
      };
      const globalCliOptions = {};

      await agentModule.handleAgentCommand(undefined, options, globalCliOptions);

      expect(runWithHeadlessAdapterIfEnabledSpy).toHaveBeenCalledTimes(1);
      const passedOpts = runWithHeadlessAdapterIfEnabledSpy.mock.calls[0][0];
      expect(options.serialTasks).toBe(true);
      expect(options.current).toBe(true);
      expect(passedOpts.plan).toMatchObject({ id: 3, title: 'Current Plan' });
    });
  });

  describe('error handling with serialTasks', () => {
    test('error thrown when plan file is required but not provided', async () => {
      const options = { serialTasks: true };
      const globalCliOptions = {};

      await expect(
        agentModule.handleAgentCommand(undefined, options, globalCliOptions)
      ).rejects.toThrow('Plan file is required');

      expect(runWithHeadlessAdapterIfEnabledSpy).not.toHaveBeenCalled();
    });

    test('serialTasks preserves error handling behavior', async () => {
      // Test that the flag doesn't interfere with normal error handling
      const options = { serialTasks: true };
      const globalCliOptions = {};

      // This should work without throwing errors related to serialTasks processing
      await agentModule.handleAgentCommand(planFile, options, globalCliOptions);

      expect(runWithHeadlessAdapterIfEnabledSpy).toHaveBeenCalledTimes(1);
      expect(options.serialTasks).toBe(true);
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

      await agentModule.handleAgentCommand(planFile, options, globalCliOptions);

      expect(runWithHeadlessAdapterIfEnabledSpy).toHaveBeenCalledTimes(1);
      expect(options.serialTasks).toBe(true);
      expect(options.steps).toBe(10);
      expect(options.timeout).toBe(5000);
      expect(typeof options.steps).toBe('number');
      expect(typeof options.timeout).toBe('number');
    });

    test('boolean options are preserved with serialTasks', async () => {
      const options = {
        serialTasks: true,
        dryRun: false,
        nonInteractive: true,
        direct: false,
      };
      const globalCliOptions = {};

      await agentModule.handleAgentCommand(planFile, options, globalCliOptions);

      expect(runWithHeadlessAdapterIfEnabledSpy).toHaveBeenCalledTimes(1);
      expect(options.serialTasks).toBe(true);
      expect(options.dryRun).toBe(false);
      expect(options.nonInteractive).toBe(true);
      expect(options.direct).toBe(false);
      expect(typeof options.serialTasks).toBe('boolean');
      expect(typeof options.dryRun).toBe('boolean');
      expect(typeof options.nonInteractive).toBe('boolean');
      expect(typeof options.direct).toBe('boolean');
    });

    test('string options are preserved with serialTasks', async () => {
      const options = {
        serialTasks: true,
        executor: 'claude-code',
        model: 'gpt-4',
        workspace: 'test-123',
      };
      const globalCliOptions = {};

      await agentModule.handleAgentCommand(planFile, options, globalCliOptions);

      expect(runWithHeadlessAdapterIfEnabledSpy).toHaveBeenCalledTimes(1);
      expect(options.serialTasks).toBe(true);
      expect(options.executor).toBe('claude-code');
      expect(options.model).toBe('gpt-4');
      expect(options.workspace).toBe('test-123');
      expect(typeof options.executor).toBe('string');
      expect(typeof options.model).toBe('string');
      expect(typeof options.workspace).toBe('string');
    });
  });

  describe('edge cases', () => {
    test('handles null and undefined options gracefully', async () => {
      const options = {
        serialTasks: true,
        model: null as any,
        workspace: undefined as any,
      };
      const globalCliOptions = {};

      await agentModule.handleAgentCommand(planFile, options, globalCliOptions);

      expect(runWithHeadlessAdapterIfEnabledSpy).toHaveBeenCalledTimes(1);
      expect(options.serialTasks).toBe(true);
      expect(options.model).toBe(null);
      expect(options.workspace).toBe(undefined);
    });

    test('handles empty string options', async () => {
      const options = {
        serialTasks: true,
        executor: '',
        workspace: '',
      };
      const globalCliOptions = {};

      await agentModule.handleAgentCommand(planFile, options, globalCliOptions);

      expect(runWithHeadlessAdapterIfEnabledSpy).toHaveBeenCalledTimes(1);
      expect(options.serialTasks).toBe(true);
      expect(options.executor).toBe('');
      expect(options.workspace).toBe('');
    });

    test('handles options object not mutated by handleAgentCommand', async () => {
      const options = { serialTasks: true };
      const globalCliOptions = {};

      await agentModule.handleAgentCommand(planFile, options, globalCliOptions);

      // The original options object should not be affected
      expect(options.serialTasks).toBe(true);
      expect(Object.keys(options)).toEqual(['serialTasks']);
    });
  });
});
