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

const {
  handleCompactCommand,
  compactPlan,
  validateCompaction,
  generateCompactionPrompt,
  writeCompactedPlanWithBackup,
} = await import('./compact.js');

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
    expect(result.plan.details).not.toContain('Extensive research notes that will be summarized.');
    expect(result.plan.progressNotes?.length).toBe(1);
    expect(result.plan.progressNotes?.[0].text).toContain('Compaction summary');

    const metadata = result.plan as PlanSchema & Record<string, unknown>;
    expect(metadata.compactedAt).toBeDefined();
    expect(metadata.compactedOriginalBytes).toBeGreaterThan(0);
    expect(metadata.compactedBytes).toBeGreaterThan(0);
    expect(typeof metadata.compactedReductionBytes).toBe('number');
  });

  test('compactPlan parses fenced YAML output and preserves manual details', async () => {
    const plan = await readPlanFile(planPath);
    plan.details = `<!-- rmplan-generated-start -->
## Expected Behavior
- Original generated details to replace.
<!-- rmplan-generated-end -->

## Manual Notes
- Retain this manual section.
`;
    await writePlanFile(planPath, plan);

    const config: RmplanConfig = {
      ...getDefaultConfig(),
      compaction: {
        minimumAgeDays: 30,
        defaultExecutor: 'claude-code',
      },
      executors: {},
    };

    const stubExecutor: Executor = {
      execute: async () =>
        [
          '```yaml',
          'details_markdown: |',
          '  ## Summary',
          '  - Fenced YAML parsed successfully',
          'research_markdown: |',
          '  - Research distilled in fenced output',
          'progress_notes_summary: |',
          '  Summaries applied without issues.',
          '```',
        ].join('\n'),
    };

    const result = await compactPlan({
      plan: await readPlanFile(planPath),
      planFilePath: planPath,
      executor: stubExecutor,
      executorName: 'claude-code',
      config,
      minimumAgeDays: 30,
    });

    expect(result.plan.details).toContain('## Summary');
    expect(result.plan.details).toContain('## Manual Notes');
    expect(result.plan.details).toContain('## Research');
    expect(result.plan.details).toContain('Research distilled in fenced output');
    expect(result.plan.details).not.toContain('Original generated details to replace.');
  });

  test('compactPlan preserves generated delimiters when executor includes research heading', async () => {
    const plan = await readPlanFile(planPath);
    plan.details = `<!-- rmplan-generated-start -->
## Summary
- Generated block already contains a Research section.
## Research
- Generated content referencing research.
<!-- rmplan-generated-end -->

## Research

- Manual research that should be replaced.

## Follow-up
- Keep this manual content.
`;
    await writePlanFile(planPath, plan);

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
  - Updated generated details.
  ## Research
  - Research heading included by executor inside generated content.
research_markdown: |
  - Manual research replaced safely.
progress_notes_summary: |
  Compaction completed.
`,
      }),
    };

    const result = await compactPlan({
      plan: await readPlanFile(planPath),
      planFilePath: planPath,
      executor: stubExecutor,
      executorName: 'claude-code',
      config,
      minimumAgeDays: 30,
    });

    expect(result.plan.details).toContain('<!-- rmplan-generated-end -->');
    expect(result.plan.details).toContain(
      'Research heading included by executor inside generated content.'
    );
    expect(result.plan.details).toContain('Manual research replaced safely.');
    expect(result.plan.details).not.toContain('Manual research that should be replaced.');
    expect(result.plan.details).toContain('## Follow-up');
  });

  test('compactPlan honors compaction section toggles from configuration', async () => {
    const plan = await readPlanFile(planPath);
    const originalDetails = plan.details;
    const originalProgressNotes = structuredClone(plan.progressNotes);

    const config: RmplanConfig = {
      ...getDefaultConfig(),
      compaction: {
        minimumAgeDays: 30,
        defaultExecutor: 'claude-code',
        sections: {
          details: false,
          research: false,
          progressNotes: false,
        },
      },
      executors: {},
    };

    const stubExecutor: Executor = {
      execute: async () => ({
        content: `details_markdown: |
  ## Summary
  - This content should not be merged due to config.
research_markdown: |
  - This research should be ignored.
progress_notes_summary: |
  This summary should not replace progress notes.
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

    expect(result.plan.details).toBe(originalDetails);
    expect(result.plan.progressNotes).toEqual(originalProgressNotes);
    expect(result.appliedSections).toEqual({
      details: false,
      research: false,
      progressNotes: false,
    });
  });

  test('handleCompactCommand in dry-run mode does not write changes', async () => {
    const before = await fs.readFile(planPath, 'utf-8');

    await handleCompactCommand(planPath, { dryRun: true }, { parent: { opts: () => ({}) } } as any);

    const after = await fs.readFile(planPath, 'utf-8');
    expect(after).toBe(before);
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(executorExecute).toHaveBeenCalledTimes(1);
    expect(
      mockLog.mock.calls.some(
        ([message]) => typeof message === 'string' && message.includes('Plan compaction preview')
      )
    ).toBe(true);
  });

  test('handleCompactCommand writes compacted plan when confirmed', async () => {
    const beforeContent = await fs.readFile(planPath, 'utf-8');
    await handleCompactCommand(planPath, { yes: true }, { parent: { opts: () => ({}) } } as any);

    const updated = await readPlanFile(planPath);
    expect(updated.details).toContain('## Decisions');
    expect(updated.progressNotes?.length).toBe(1);
    expect(updated.progressNotes?.[0].text).toContain('Compaction summary');
    const metadata = updated as PlanSchema & Record<string, unknown>;
    expect(metadata.compactedAt).toBeDefined();
    expect(metadata.compactedOriginalBytes).toBeGreaterThan(0);
    expect(metadata.compactedReductionBytes).toBeDefined();

    const backupFiles = (await fs.readdir(tempDir)).filter((file) =>
      file.startsWith(path.basename(planPath) + '.backup-')
    );
    expect(backupFiles.length).toBe(1);
    const backupContent = await fs.readFile(path.join(tempDir, backupFiles[0]), 'utf-8');
    expect(backupContent).toBe(beforeContent);
    expect(
      mockLog.mock.calls.some(
        ([message]) => typeof message === 'string' && message.includes('Backup saved to')
      )
    ).toBe(true);
  });

  test('writeCompactedPlanWithBackup restores original content when writer fails', async () => {
    const plan = await readPlanFile(planPath);
    const originalContent = await fs.readFile(planPath, 'utf-8');

    await expect(
      writeCompactedPlanWithBackup({
        planPath,
        plan,
        originalContent,
        writer: async () => {
          throw new Error('simulated failure');
        },
      })
    ).rejects.toThrow('Failed to write compacted plan with backup.');

    const restored = await fs.readFile(planPath, 'utf-8');
    expect(restored).toBe(originalContent);

    const backupFiles = (await fs.readdir(tempDir)).filter((file) =>
      file.startsWith(path.basename(planPath) + '.backup-')
    );
    expect(backupFiles.length).toBe(1);
    const backupContent = await fs.readFile(path.join(tempDir, backupFiles[0]), 'utf-8');
    expect(backupContent).toBe(originalContent);
  });

  test('handleCompactCommand warns when plan was recently updated', async () => {
    const plan: PlanSchema = {
      id: 303,
      title: 'Fresh Plan',
      goal: 'Ensure warning',
      status: 'done',
      uuid: '22222222-2222-2222-2222-222222222222',
      updatedAt: new Date().toISOString(),
      details: `<!-- rmplan-generated-start -->
## Expected Behavior
- Fresh work
<!-- rmplan-generated-end -->
`,
      tasks: [],
    };
    await writePlanFile(planPath, plan);

    await handleCompactCommand(planPath, { dryRun: true }, { parent: { opts: () => ({}) } } as any);

    expect(mockWarn).toHaveBeenCalled();
    const warningMessage = mockWarn.mock.calls[0]?.[0];
    expect(warningMessage).toContain('Consider waiting before compacting.');
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

  test('compactPlan throws when executor omits details_markdown', async () => {
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
        content: `research_markdown: |
  - No generated details returned
progress_notes_summary: |
  Tasks completed.`,
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
    ).rejects.toThrow('Compaction response omitted details_markdown content.');
  });

  test('validateCompaction reports issues when tasks change', async () => {
    const plan = await readPlanFile(planPath);
    const mutated = structuredClone(plan);
    mutated.tasks = [
      ...mutated.tasks,
      { title: 'New task', description: 'Should not exist', done: false },
    ];

    const result = validateCompaction(plan, mutated);
    expect(result.issues).toContain('Field "tasks" was modified during compaction.');
  });

  test('validateCompaction flags non-printable output', async () => {
    const plan = await readPlanFile(planPath);
    const mutated = structuredClone(plan);
    mutated.details = `Problematic${String.fromCharCode(0)}text`;

    const result = validateCompaction(plan, mutated);
    expect(result.issues.some((issue) => issue.includes('non-printable control characters'))).toBe(
      true
    );
  });

  test('validateCompaction returns normalized plan with no issues when untouched', async () => {
    const plan = await readPlanFile(planPath);
    const result = validateCompaction(plan, structuredClone(plan));

    expect(result.issues).toEqual([]);
    expect(result.plan).toEqual(plan);
  });

  test('validateCompaction flags missing required metadata and dependency changes', async () => {
    const plan = await readPlanFile(planPath);
    const mutated = structuredClone(plan);
    // Remove required field
    delete (mutated as Partial<PlanSchema>).goal;
    // Introduce dependency modification
    mutated.dependencies = ['extra-plan'];

    const result = validateCompaction(plan, mutated);
    expect(result.issues).toContain('Required field "goal" is missing after compaction.');
    expect(result.issues).toContain('Field "dependencies" was modified during compaction.');
  });

  test('validateCompaction flags parent removal', async () => {
    const plan = await readPlanFile(planPath);
    const planWithParent: PlanSchema = { ...plan, parent: 'upstream-plan' };
    const mutated = structuredClone(planWithParent);
    delete mutated.parent;

    const result = validateCompaction(planWithParent, mutated);
    expect(result.issues).toContain('Field "parent" changed from "upstream-plan" to "undefined".');
  });

  test('generateCompactionPrompt includes preservation guidance and plan context', async () => {
    const plan = await readPlanFile(planPath);
    const fileContent = await fs.readFile(planPath, 'utf-8');

    const prompt = generateCompactionPrompt(plan, fileContent, 45);

    expect(prompt).toContain('Preserve (must remain explicit and factual):');
    expect(prompt).toContain('Compress or omit when redundant:');
    expect(prompt).toContain('Output format (YAML only, no prose outside this block):');
    expect(prompt).toContain('Example of a well-compacted output');
    expect(prompt).toContain('Plan ID: 101');
    expect(prompt).toContain('Plan tasks for context:');
    expect(prompt).toContain('1. Task A (done)');
    expect(prompt).toContain('Full plan file:');
    expect(prompt).toContain(fileContent.trim());
  });
});
