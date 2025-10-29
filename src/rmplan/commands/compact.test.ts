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

const executorExecute = mock(async () => ({
  content: `details_markdown: |
  ## Summary
  - Compact result placeholder
research_markdown: |
  - Condensed research insight
progress_notes_summary: |
  Plan completed successfully.
`,
}));

const mockBuildExecutorAndLog = mock(() => ({
  execute: executorExecute,
}));

await moduleMocker.mock('../executors/index.js', () => ({
  buildExecutorAndLog: mockBuildExecutorAndLog,
  ClaudeCodeExecutorName: 'claude-code',
  DEFAULT_EXECUTOR: 'claude-code',
}));

const mockConfirm = mock(async () => true);
await moduleMocker.mock('@inquirer/prompts', () => ({
  confirm: mockConfirm,
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

const { handleCompactCommand, compactPlan } = await import('./compact.js');

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

    executorExecute.mockReset().mockResolvedValue({
      content: `details_markdown: |
  ## Summary
  - Final outcome achieved
  ## Decisions
  - Key architectural decision documented
research_markdown: |
  - Framework A chosen over B due to performance
progress_notes_summary: |
  Implementation completed and verified with automated tests.
`,
    });
    mockBuildExecutorAndLog.mockClear();
    mockConfirm.mockReset().mockResolvedValue(true);
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

  test('compactPlan returns compacted plan with preserved structure', async () => {
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
      execute: async () => ({
        content: `details_markdown: |
  ## Summary
  - Outcome preserved
research_markdown: |
  - Research distilled
progress_notes_summary: |
  Work completed successfully.
`,
      }),
    };

    const result = await compactPlan({
      plan,
      planFilePath: planPath,
      executor: stubExecutor,
      executorName: 'claude-code',
      config,
      minimumAgeDays: 30,
    });

    expect(result.plan.tasks).toEqual(plan.tasks);
    expect(result.plan.details).toContain('## Summary');
    expect(result.plan.details).toContain('<!-- rmplan-generated-start -->');
    expect(result.plan.details).toContain('## Research');
    expect(result.plan.progressNotes?.length).toBe(1);
    expect(result.plan.progressNotes?.[0].text).toContain('Compaction summary');

    const metadata = result.plan as PlanSchema & Record<string, unknown>;
    expect(metadata.compactedAt).toBeDefined();
    expect(metadata.compactedOriginalBytes).toBeGreaterThan(0);
    expect(metadata.compactedBytes).toBeGreaterThan(0);
    expect(typeof metadata.compactedReductionBytes).toBe('number');
  });

  test('handleCompactCommand in dry-run mode does not write changes', async () => {
    const before = await fs.readFile(planPath, 'utf-8');

    await handleCompactCommand(planPath, { dryRun: true }, { parent: { opts: () => ({}) } } as any);

    const after = await fs.readFile(planPath, 'utf-8');
    expect(after).toBe(before);
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(executorExecute).toHaveBeenCalledTimes(1);
  });

  test('handleCompactCommand writes compacted plan when confirmed', async () => {
    await handleCompactCommand(planPath, { yes: true }, { parent: { opts: () => ({}) } } as any);

    const updated = await readPlanFile(planPath);
    expect(updated.details).toContain('## Decisions');
    expect(updated.progressNotes?.length).toBe(1);
    expect(updated.progressNotes?.[0].text).toContain('Compaction summary');
    const metadata = updated as PlanSchema & Record<string, unknown>;
    expect(metadata.compactedAt).toBeDefined();
    expect(metadata.compactedOriginalBytes).toBeGreaterThan(0);
    expect(metadata.compactedReductionBytes).toBeDefined();
  });

  test('handleCompactCommand rejects non-completed plans', async () => {
    const plan: PlanSchema = {
      id: 202,
      title: 'Draft Plan',
      goal: 'Do not compact',
      status: 'pending',
      details: 'Content',
      tasks: [],
    };

    const pendingPath = path.join(tempDir, '202.plan.md');
    await writePlanFile(pendingPath, plan);

    await expect(
      handleCompactCommand(pendingPath, {}, { parent: { opts: () => ({}) } } as any)
    ).rejects.toThrow('Only done, cancelled, or deferred plans can be compacted');
  });
});
