import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import yaml from 'yaml';
import type { PlanSchema } from './planSchema';

// Helper function for creating temp plan file
async function createTempPlanFile(initialPlan: Partial<PlanSchema>): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-agent-test-'));
  const planFilePath = path.join(tempDir, 'test-plan.yml');
  const fullPlan: PlanSchema = {
    id: 'test-id',
    status: 'pending',
    priority: 'unknown',
    goal: 'Test Goal',
    details: 'Test Details',
    createdAt: new Date(Date.now() - 100000).toISOString(), // Older timestamp
    updatedAt: new Date(Date.now() - 100000).toISOString(),
    planGeneratedAt: new Date(Date.now() - 100000).toISOString(),
    promptsGeneratedAt: new Date(Date.now() - 100000).toISOString(),
    tasks: [
      {
        title: 'Test Task',
        description: 'Test Task Description',
        files: ['file1.ts'],
        steps: [{ prompt: 'Step 1', done: false }],
      },
    ],
    ...initialPlan,
  };
  await fs.writeFile(planFilePath, yaml.stringify(fullPlan));
  return planFilePath;
}

describe('rmplanAgent status updates', () => {
  let tempDirs: string[] = [];
  let mockFindPendingTask: any;
  let mockPrepareNextStep: any;
  let mockExecutor: any;
  let mockMarkStepDone: any;
  let mockLoadEffectiveConfig: any;

  beforeEach(() => {
    // Mock the necessary imports
    mockFindPendingTask = mock.module('./actions.ts', () => ({
      findPendingTask: mock(() => ({
        taskIndex: 0,
        stepIndex: 0,
        task: {
          title: 'Test Task',
          description: 'Test',
          files: ['file1.ts'],
          steps: [{ prompt: 'Step 1', done: false }],
        },
        step: { prompt: 'Step 1', done: false },
      })),
      prepareNextStep: mock(() =>
        Promise.resolve({
          prompt: 'Test prompt',
          promptFilePath: null,
          taskIndex: 0,
          stepIndex: 0,
          numStepsSelected: 1,
          rmfilterArgs: undefined,
        })
      ),
      markStepDone: mock(() =>
        Promise.resolve({ planComplete: false, message: 'Step marked done' })
      ),
      executePostApplyCommand: mock(() => Promise.resolve(true)),
    }));

    mockExecutor = {
      execute: mock(() => Promise.resolve()),
      prepareStepOptions: mock(() => ({})),
    };

    mock.module('./executors/index.ts', () => ({
      buildExecutorAndLog: mock(() => mockExecutor),
      DEFAULT_EXECUTOR: 'CopyOnlyExecutor',
      defaultModelForExecutor: mock(() => 'test-model'),
    }));

    mock.module('./configLoader.ts', () => ({
      loadEffectiveConfig: mock(() =>
        Promise.resolve({
          postApplyCommands: [],
          defaultExecutor: 'CopyOnlyExecutor',
        })
      ),
    }));

    mock.module('../rmfilter/utils.ts', () => ({
      getGitRoot: mock(() => Promise.resolve('/test/git/root')),
      logSpawn: mock(() => ({ exited: Promise.resolve(0), exitCode: 0 })),
      quiet: false,
      setQuiet: mock(),
      setDebug: mock(),
    }));

    mock.module('../logging.ts', () => ({
      log: mock(),
      error: mock(),
      warn: mock(),
      debugLog: mock(),
      boldMarkdownHeaders: mock((text: string) => text),
      openLogFile: mock(),
      closeLogFile: mock(() => Promise.resolve()),
      writeStdout: mock(),
      writeStderr: mock(),
    }));

    // Mock workspace-related modules
    mock.module('./workspace/workspace_manager.ts', () => ({
      createWorkspace: mock(),
    }));

    mock.module('./workspace/workspace_auto_selector.ts', () => ({
      WorkspaceAutoSelector: mock(),
    }));

    mock.module('./workspace/workspace_lock.ts', () => ({
      WorkspaceLock: {
        acquireLock: mock(),
        setupCleanupHandlers: mock(),
        getLockInfo: mock(),
        isLockStale: mock(),
      },
    }));

    mock.module('./workspace/workspace_tracker.ts', () => ({
      findWorkspacesByTaskId: mock(() => Promise.resolve([])),
    }));

    mock.module('../treesitter/extract.ts', () => ({
      Extractor: mock(),
    }));

    // Track temp directories for cleanup
    tempDirs = [];
  });

  afterEach(async () => {
    // Clean up temp directories
    for (const dir of tempDirs) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  test('Status transitions from "pending" to "in progress"', async () => {
    // Create a temp plan file with status: 'pending'
    const planFilePath = await createTempPlanFile({ status: 'pending' });
    tempDirs.push(path.dirname(planFilePath));

    // Import the function dynamically to get mocked dependencies
    const { rmplanAgent } = await import('./agent.ts');

    // Run rmplanAgent for 1 step
    await rmplanAgent(planFilePath, { steps: '1' }, {});

    // Read the plan file to verify status update
    const updatedPlanContent = await fs.readFile(planFilePath, 'utf-8');
    const updatedPlan = yaml.parse(updatedPlanContent) as PlanSchema;

    // Verify status changed to 'in progress'
    expect(updatedPlan.status).toBe('in progress');

    // Verify updatedAt is a recent timestamp (within 5 seconds)
    const updatedAtTime = new Date(updatedPlan.updatedAt).getTime();
    const now = Date.now();
    expect(now - updatedAtTime).toBeLessThan(5000);
    expect(now - updatedAtTime).toBeGreaterThanOrEqual(0);
  });

  test('updatedAt is updated even if status was already "in progress"', async () => {
    // Create a temp plan file with status: 'in progress' and old updatedAt
    const oldTimestamp = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago
    const planFilePath = await createTempPlanFile({
      status: 'in progress',
      updatedAt: oldTimestamp,
    });
    tempDirs.push(path.dirname(planFilePath));

    // Mock markStepDone to update the plan file with new updatedAt
    const mockMarkStepDone = mock(async (filePath: string) => {
      const content = await fs.readFile(filePath, 'utf-8');
      const plan = yaml.parse(content) as PlanSchema;
      plan.updatedAt = new Date().toISOString();
      await fs.writeFile(filePath, yaml.stringify(plan));
      return { planComplete: false, message: 'Step marked done' };
    });

    mock.module('./actions.ts', () => ({
      findPendingTask: mock(() => ({
        taskIndex: 0,
        stepIndex: 0,
        task: {
          title: 'Test Task',
          description: 'Test',
          files: ['file1.ts'],
          steps: [{ prompt: 'Step 1', done: false }],
        },
        step: { prompt: 'Step 1', done: false },
      })),
      prepareNextStep: mock(() =>
        Promise.resolve({
          prompt: 'Test prompt',
          promptFilePath: null,
          taskIndex: 0,
          stepIndex: 0,
          numStepsSelected: 1,
          rmfilterArgs: undefined,
        })
      ),
      markStepDone: mockMarkStepDone,
      executePostApplyCommand: mock(() => Promise.resolve(true)),
    }));

    // Import the function dynamically to get mocked dependencies
    const { rmplanAgent } = await import('./agent.ts');

    // Run rmplanAgent for 1 step
    await rmplanAgent(planFilePath, { steps: '1' }, {});

    // Read the plan file to verify updatedAt update
    const updatedPlanContent = await fs.readFile(planFilePath, 'utf-8');
    const updatedPlan = yaml.parse(updatedPlanContent) as PlanSchema;

    // Verify status remains 'in progress'
    expect(updatedPlan.status).toBe('in progress');

    // Verify updatedAt was updated (should be much more recent than the old timestamp)
    const updatedAtTime = new Date(updatedPlan.updatedAt).getTime();
    const oldTime = new Date(oldTimestamp).getTime();
    const now = Date.now();

    expect(updatedAtTime).toBeGreaterThan(oldTime);
    expect(now - updatedAtTime).toBeLessThan(5000);
    expect(now - updatedAtTime).toBeGreaterThanOrEqual(0);
  });
});
