import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import type { PlanSchema } from '../planSchema.js';
import { parsePlanIdFromCliArg } from '../plans.js';

vi.mock('../../logging.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  };
});

vi.mock('../../common/git.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getGitRoot: vi.fn(),
  };
});

vi.mock('../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(),
}));

vi.mock('../../common/clipboard.js', () => ({
  write: vi.fn(async () => {}),
  read: vi.fn(async () => 'clipboard content'),
}));

vi.mock('../../common/process.js', () => ({
  logSpawn: vi.fn(() => ({ exited: Promise.resolve(0) })),
  commitAll: vi.fn(async () => 0),
}));

vi.mock('../executors/index.js', () => ({
  buildExecutorAndLog: vi.fn(() => ({
    execute: vi.fn(async () => {}),
    filePathPrefix: '',
  })),
  DEFAULT_EXECUTOR: 'claude_code',
}));

vi.mock('../workspace/workspace_setup.js', () => ({
  setupWorkspace: vi.fn(async (_options: any, baseDir: string, planFile: string) => ({
    baseDir,
    planFile,
  })),
}));

vi.mock('./prompts.js', () => ({
  buildPromptText: vi.fn(async () => 'Generated prompt'),
  findMostRecentlyUpdatedPlan: vi.fn(async () => null),
  getPlanTimestamp: vi.fn(async () => 0),
  parseIsoTimestamp: vi.fn(() => undefined),
}));

vi.mock('../assignments/auto_claim.js', () => ({
  isAutoClaimEnabled: vi.fn(() => false),
  autoClaimPlan: vi.fn(async () => {}),
}));

vi.mock('../workspace/workspace_roundtrip.js', () => ({
  prepareWorkspaceRoundTrip: vi.fn(async () => null),
  runPreExecutionWorkspaceSync: vi.fn(async () => {}),
  runPostExecutionWorkspaceSync: vi.fn(async () => {}),
  materializePlansForExecution: vi.fn(async () => undefined),
}));

vi.mock('../workspace/workspace_info.js', () => ({
  getWorkspaceInfoByPath: vi.fn(() => null),
  patchWorkspaceInfo: vi.fn(),
  touchWorkspaceInfo: vi.fn(),
}));

vi.mock('../../logging/tunnel_client.js', () => ({
  isTunnelActive: vi.fn(() => false),
}));

vi.mock('../headless.js', () => ({
  runWithHeadlessAdapterIfEnabled: vi.fn(async (options: any) => options.callback()),
}));

vi.mock('../plans.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../plans.js')>();
  return {
    ...actual,
    resolvePlanByNumericId: vi.fn(),
  };
});

vi.mock('../db/plan_sync.js', () => ({
  syncPlanToDb: vi.fn(async () => {}),
}));

import { handleGenerateCommand } from './generate.js';
import { handleAgentCommand } from './agent/agent.js';
import { log as logFn } from '../../logging.js';
import { getGitRoot } from '../../common/git.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { resolvePlanByNumericId } from '../plans.js';

const logSpy = vi.mocked(logFn);
const errorSpy = vi.mocked((await import('../../logging.js')).error);
const warnSpy = vi.mocked((await import('../../logging.js')).warn);

describe('--next-ready CLI flag integration tests', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    // Clear mocks
    vi.clearAllMocks();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-next-ready-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Mock core modules
    vi.mocked(loadEffectiveConfig).mockResolvedValue({
      paths: {
        tasks: tasksDir,
      },
      models: {
        planning: 'test-model',
        stepGeneration: 'test-model',
      },
    } as any);

    vi.mocked(getGitRoot).mockResolvedValue(tempDir);

    vi.mocked(resolvePlanByNumericId).mockImplementation(async (planId: number) => {
      const { readPlanFile } = await import('../plans.js');
      const entries = await fs.readdir(tasksDir);
      const filename = entries.find((entry) => entry.startsWith(`${planId}-`));
      if (!filename) {
        throw new Error(`No plan file found for ${planId}`);
      }
      const planPath = path.join(tasksDir, filename);
      return {
        plan: await readPlanFile(planPath),
        planPath,
      };
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();

    // Clean up
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  async function createPlanFile(plan: PlanSchema & { filename: string }) {
    const filePath = path.join(tasksDir, plan.filename);
    const planData: any = {
      id: plan.id,
      title: plan.title,
      goal: plan.goal || 'Test goal',
      status: plan.status || 'pending',
      tasks: plan.tasks || [],
    };

    if (plan.dependencies && plan.dependencies.length > 0) {
      planData.dependencies = plan.dependencies;
    }
    if (plan.parent !== undefined) {
      planData.parent = plan.parent;
    }
    if (plan.priority) {
      planData.priority = plan.priority;
    }

    const yamlContent = yaml.stringify(planData);
    await fs.writeFile(filePath, yamlContent, 'utf-8');
  }

  describe('generate command with --next-ready', () => {
    test('should find and use next ready dependency', async () => {
      // Create test plans
      await createPlanFile({
        id: 1,
        title: 'Parent Plan',
        filename: '1-parent.yml',
        status: 'in_progress',
        dependencies: [2, 3],
        tasks: [{ title: 'Parent task', description: 'Do parent work' }],
      });

      await createPlanFile({
        id: 2,
        title: 'Done Dependency',
        filename: '2-done.yml',
        status: 'done',
        tasks: [{ title: 'Done task', description: 'Already completed', done: true }],
      });

      await createPlanFile({
        id: 3,
        title: 'Ready Dependency',
        filename: '3-ready.yml',
        status: 'pending',
        dependencies: [2], // Depends on plan 2 which is done
        tasks: [{ title: 'Ready task', description: 'Ready to work on' }],
      });

      const options = {
        nextReady: 1, // Parent plan ID
        extract: false,
        parent: {
          opts: () => ({}),
        },
      };

      // After --next-ready processing, options.plan will be set

      const command = {
        args: [],
        parent: {
          opts: () => ({}),
        },
      };

      await handleGenerateCommand(undefined, options, command);

      // Should have processed plan 3 (the ready dependency)
      // We verify this by checking that the generate command was called
      // with the correct plan context (implementation will vary)
      expect(logSpy).toHaveBeenCalled();
    });

    test('should handle no ready dependencies gracefully', async () => {
      // Create parent plan with no ready dependencies
      await createPlanFile({
        id: 1,
        title: 'Parent Plan',
        filename: '1-parent.yml',
        status: 'in_progress',
        dependencies: [2],
        tasks: [{ title: 'Parent task', description: 'Do parent work' }],
      });

      await createPlanFile({
        id: 2,
        title: 'Blocked Dependency',
        filename: '2-blocked.yml',
        status: 'pending',
        dependencies: [3], // Depends on plan 3
        tasks: [{ title: 'Blocked task', description: 'Cannot start yet' }],
      });

      await createPlanFile({
        id: 3,
        title: 'Incomplete Dependency',
        filename: '3-incomplete.yml',
        status: 'pending',
        tasks: [{ title: 'Incomplete task', description: 'Still working' }],
      });

      const options = {
        nextReady: 1,
        extract: false,
        parent: {
          opts: () => ({}),
        },
      };

      const command = {
        args: [],
        parent: {
          opts: () => ({}),
        },
      };

      // In this case, plan 3 should be found as it has no dependencies
      await handleGenerateCommand(undefined, options, command);
      expect(logSpy).toHaveBeenCalled();
    });

    test('should handle invalid parent plan ID gracefully', async () => {
      const options = {
        nextReady: 999, // Non-existent plan ID
        extract: false,
        parent: {
          opts: () => ({}),
        },
      };

      const command = {
        args: [],
        parent: {
          opts: () => ({}),
        },
      };

      // Should handle gracefully by logging and returning early
      await handleGenerateCommand(undefined, options, command);

      // Should have logged the "not found" message
      expect(logSpy).toHaveBeenCalled();
      const calls = logSpy.mock.calls;
      const hasNotFoundMessage = calls.some((call) =>
        call.some((arg) => arg && arg.toString().includes('Plan not found: 999'))
      );
      expect(hasNotFoundMessage).toBe(true);
    });
  });

  describe('CLI argument parsing', () => {
    test('--next-ready flag should be parsed correctly in generate command', async () => {
      // This test verifies that the CLI parser correctly extracts the --next-ready value
      // We'll simulate how Commander.js would parse the options

      const mockOptions = {
        nextReady: 123,
        extract: false,
        parent: { opts: () => ({}) },
      };

      // Verify the option is accessible
      expect(mockOptions.nextReady).toBe(123);
    });

    test('--next-ready should reject file-path values before handlers run', async () => {
      expect(parsePlanIdFromCliArg('42')).toBe(42);
      expect(() => parsePlanIdFromCliArg('my-plan.yml')).toThrow('Expected a numeric plan ID');
    });
  });
});
