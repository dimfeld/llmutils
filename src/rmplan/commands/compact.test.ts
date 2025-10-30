import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ModuleMocker } from '../../testing.js';
import type { PlanSchema } from '../planSchema.js';
import { getDefaultConfig, type RmplanConfig } from '../configSchema.js';
import { writePlanFile, readPlanFile, clearPlanCache } from '../plans.js';
import type { Executor } from '../executors/types.js';

const moduleMocker = new ModuleMocker(import.meta);

const mockLog = mock(() => {});
const mockWarn = mock(() => {});
await moduleMocker.mock('../../logging.js', () => ({
  log: mockLog,
  warn: mockWarn,
}));

const executorExecute = mock(async () => undefined);

const mockBuildExecutorAndLog = mock(() => ({
  execute: executorExecute,
}));

await moduleMocker.mock('../executors/index.js', () => ({
  buildExecutorAndLog: mockBuildExecutorAndLog,
  ClaudeCodeExecutorName: 'claude-code',
  DEFAULT_EXECUTOR: 'claude-code',
}));

const mockGetGitRoot = mock(async () => process.cwd());
await moduleMocker.mock('../../common/git.js', () => ({
  getGitRoot: mockGetGitRoot,
}));

const mockLoadEffectiveConfig = mock(
  async () =>
    ({
      ...getDefaultConfig(),
      compaction: {
        minimumAgeDays: 30,
        defaultExecutor: 'claude-code',
      },
      executors: {},
    }) as RmplanConfig
);

await moduleMocker.mock('../configLoader.js', () => ({
  loadEffectiveConfig: mockLoadEffectiveConfig,
}));

const { handleCompactCommand, compactPlan, generateCompactionPrompt } = await import(
  './compact.js'
);

describe('compact command', () => {
  let tempDir: string;
  let planPath: string;

  beforeEach(async () => {
    clearPlanCache();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-compact-test-'));
    planPath = path.join(tempDir, '101-compact.plan.md');

    const plan: PlanSchema = {
      id: 101,
      title: 'Test Plan',
      goal: 'Ship the feature',
      status: 'done',
      uuid: '11111111-1111-1111-1111-111111111111',
      details: `<!-- rmplan-generated-start -->
## Expected Behavior
- This is a verbose description that should be compacted.
<!-- rmplan-generated-end -->

## Research

- Extensive research notes that will be summarized.
`,
      tasks: [
        { title: 'Task A', description: 'Initial implementation', done: true },
        { title: 'Task B', description: 'Write tests', done: true },
      ],
      progressNotes: [
        {
          timestamp: new Date('2024-01-01T00:00:00.000Z').toISOString(),
          text: 'Initial work logged.',
        },
        {
          timestamp: new Date('2024-01-02T00:00:00.000Z').toISOString(),
          text: 'Follow-up exploration.',
        },
      ],
    };

    await writePlanFile(planPath, plan);

    executorExecute.mockReset().mockResolvedValue(undefined);
    mockBuildExecutorAndLog.mockClear();
    mockLog.mockReset();
    mockWarn.mockReset();
    mockGetGitRoot.mockReset().mockResolvedValue(process.cwd());
    mockLoadEffectiveConfig.mockReset().mockResolvedValue({
      ...getDefaultConfig(),
      compaction: {
        minimumAgeDays: 30,
        defaultExecutor: 'claude-code',
      },
      executors: {},
    });
  });

  afterEach(async () => {
    clearPlanCache();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    moduleMocker.clear();
  });

  test('compactPlan executes agent with correct prompt', async () => {
    const plan = await readPlanFile(planPath);
    const config: RmplanConfig = {
      ...getDefaultConfig(),
      compaction: {
        minimumAgeDays: 30,
        defaultExecutor: 'claude-code',
      },
      executors: {},
    };

    const stubExecutor: Executor = {
      execute: mock(async () => undefined),
    };

    await compactPlan({
      plan,
      planFilePath: planPath,
      executor: stubExecutor,
      executorName: 'claude-code',
      config,
      minimumAgeDays: 30,
    });

    expect(stubExecutor.execute).toHaveBeenCalledTimes(1);
    const callArgs = (stubExecutor.execute as any).mock.calls[0];
    const prompt = callArgs[0];
    const options = callArgs[1];

    // Verify prompt contains key instructions
    expect(prompt).toContain('Read the plan file at:');
    expect(prompt).toContain(planPath);
    expect(prompt).toContain('Compact the plan by editing the file directly');
    expect(prompt).toContain('Read and Edit tools');
    expect(prompt).toContain('generated details (content between delimiters)');
    expect(prompt).toContain('research section');
    expect(prompt).toContain('progress notes');

    // Verify options
    expect(options.planId).toBe('101');
    expect(options.planTitle).toBe('Test Plan');
    expect(options.planFilePath).toBe(planPath);
    expect(options.captureOutput).toBe('none');
    expect(options.executionMode).toBe('planning');
  });

  test('compactPlan respects section toggles in config', async () => {
    const plan = await readPlanFile(planPath);
    const config: RmplanConfig = {
      ...getDefaultConfig(),
      compaction: {
        minimumAgeDays: 30,
        defaultExecutor: 'claude-code',
        sections: {
          details: true,
          research: false,
          progressNotes: true,
        },
      },
      executors: {},
    };

    const stubExecutor: Executor = {
      execute: mock(async () => undefined),
    };

    await compactPlan({
      plan,
      planFilePath: planPath,
      executor: stubExecutor,
      executorName: 'claude-code',
      config,
      minimumAgeDays: 30,
    });

    const callArgs = (stubExecutor.execute as any).mock.calls[0];
    const prompt = callArgs[0];

    expect(prompt).toContain('generated details (content between delimiters)');
    expect(prompt).toContain('progress notes');
    expect(prompt).toContain('Research section: Do NOT modify (disabled by configuration)');
  });

  test('generateCompactionPrompt includes plan information', () => {
    const plan: PlanSchema = {
      id: 42,
      title: 'Test Compaction',
      goal: 'Archive old plan',
      status: 'done',
      uuid: '22222222-2222-2222-2222-222222222222',
      tasks: [
        { title: 'Step 1', description: 'Do the work', done: true },
        { title: 'Step 2', description: 'Write docs', done: false },
      ],
    };

    const planContent = '---\nid: 42\ntitle: Test Compaction\n---\n';
    const prompt = generateCompactionPrompt(
      plan,
      '/path/to/plan.md',
      planContent,
      30,
      undefined
    );

    expect(prompt).toContain('Plan ID: 42');
    expect(prompt).toContain('Plan Title: Test Compaction');
    expect(prompt).toContain('Current Status: done');
    expect(prompt).toContain('Minimum age threshold: 30 days');
    expect(prompt).toContain('1. Step 1 (done)');
    expect(prompt).toContain('   Do the work');
    expect(prompt).toContain('2. Step 2');
    expect(prompt).toContain('   Write docs');
    expect(prompt).toContain(planContent);
  });

  test('generateCompactionPrompt includes preservation instructions', () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Test',
      goal: 'Test goal',
      status: 'done',
      uuid: '33333333-3333-3333-3333-333333333333',
      tasks: [],
    };

    const prompt = generateCompactionPrompt(plan, '/path/to/plan.md', 'content', 30, undefined);

    expect(prompt).toContain('Preserve (must remain explicit and factual)');
    expect(prompt).toContain('Original goal and final outcome');
    expect(prompt).toContain('Key technical decisions');
    expect(prompt).toContain('Acceptance criteria results');
    expect(prompt).toContain('Compress or omit when redundant');
    expect(prompt).toContain('Exploratory research steps');
    expect(prompt).toContain('dead-ends');
    expect(prompt).toContain('verbose progress logs');
  });

  test('generateCompactionPrompt warns about delimiter preservation', () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Test',
      goal: 'Test goal',
      status: 'done',
      uuid: '44444444-4444-4444-4444-444444444444',
      tasks: [],
    };

    const prompt = generateCompactionPrompt(plan, '/path/to/plan.md', 'content', 30, undefined);

    expect(prompt).toContain('<!-- rmplan-generated-start -->');
    expect(prompt).toContain('<!-- rmplan-generated-end -->');
    expect(prompt).toContain('Do NOT remove the delimiters themselves');
    expect(prompt).toContain('Content outside these delimiters should be preserved unchanged');
  });

  test('generateCompactionPrompt includes metadata update instructions', () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Test',
      goal: 'Test goal',
      status: 'done',
      uuid: '55555555-5555-5555-5555-555555555555',
      tasks: [],
    };

    const prompt = generateCompactionPrompt(plan, '/path/to/plan.md', 'content', 30, undefined);

    expect(prompt).toContain('compactedAt');
    expect(prompt).toContain('compactedBy');
    expect(prompt).toContain('current ISO timestamp');
  });

  test('generateCompactionPrompt warns about invariant fields', () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Test',
      goal: 'Test goal',
      status: 'done',
      uuid: '66666666-6666-6666-6666-666666666666',
      tasks: [],
    };

    const prompt = generateCompactionPrompt(plan, '/path/to/plan.md', 'content', 30, undefined);

    expect(prompt).toContain('You MUST NOT modify any of the following fields');
    expect(prompt).toContain('id, uuid, title, goal, status');
    expect(prompt).toContain('tasks array');
    expect(prompt).toContain('dependencies, parent, references');
  });

  test('handleCompactCommand rejects non-completed plans', async () => {
    const plan = await readPlanFile(planPath);
    plan.status = 'in_progress';
    await writePlanFile(planPath, plan);

    const mockCommand = {
      parent: () => ({ opts: () => ({}) }),
    } as any;

    await expect(
      handleCompactCommand(planPath, { executor: 'claude-code' }, mockCommand)
    ).rejects.toThrow('Only done, cancelled, or deferred plans can be compacted');
  });

  test('handleCompactCommand warns about plan age', async () => {
    const plan = await readPlanFile(planPath);
    plan.updatedAt = new Date().toISOString(); // Very recent
    await writePlanFile(planPath, plan);

    const mockCommand = {
      parent: () => ({ opts: () => ({}) }),
    } as any;

    await handleCompactCommand(planPath, { executor: 'claude-code' }, mockCommand);

    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('was updated'));
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('threshold'));
  });

  test('compactPlan throws on executor failure', async () => {
    const plan = await readPlanFile(planPath);
    const config: RmplanConfig = {
      ...getDefaultConfig(),
      executors: {},
    };

    const stubExecutor: Executor = {
      execute: async () => ({
        success: false,
        failureDetails: {
          problems: 'Something went wrong',
        },
      }),
    };

    await expect(
      compactPlan({
        plan,
        planFilePath: planPath,
        executor: stubExecutor,
        executorName: 'claude-code',
        config,
        minimumAgeDays: 30,
      })
    ).rejects.toThrow('Something went wrong');
  });
});
