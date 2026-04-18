import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';

// This test specifically verifies that timAgent writes a summary file in batch mode
// using the real summary display module (no mock), ensuring on-disk content is formatted.

let tempDir = '';
let planFile = '';
let summaryOut = '';

async function createPlanFile(filePath: string, planData: any) {
  const schemaComment =
    '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json\n';
  await fs.writeFile(filePath, schemaComment + yaml.stringify(planData));
}

const executorExecuteSpy = vi.fn(async () => 'default output');

vi.mock('../../../logging.js', () => ({
  log: vi.fn(() => {}),
  warn: vi.fn(() => {}),
  error: vi.fn(() => {}),
  openLogFile: vi.fn(() => {}),
  closeLogFile: vi.fn(async () => {}),
  boldMarkdownHeaders: (s: string) => s,
  debugLog: vi.fn(() => {}),
  sendStructured: vi.fn(() => {}),
}));

vi.mock('../../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(async () => ({ models: { execution: 'test-model' } })),
  loadGlobalConfigForNotifications: vi.fn(async () => ({})),
}));

let workingCopyCallCount = 0;

vi.mock('../../../common/git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../common/git.js')>()),
  getGitRoot: vi.fn(async () => tempDir),
  getChangedFilesOnBranch: vi.fn(async () => ['src/a.ts']),
  getCurrentCommitHash: vi.fn(async () => 'rev-0'),
  getChangedFilesBetween: vi.fn(async () => ['src/a.ts']),
  getUsingJj: vi.fn(async () => false),
  hasUncommittedChanges: vi.fn(async () => false),
  getWorkingCopyStatus: vi.fn(async () => ({
    hasChanges: true,
    checkFailed: false,
    diffHash: `hash-${workingCopyCallCount++}`,
  })),
}));

// Real summary display is used: DO NOT mock '../../summary/display.js'

vi.mock('../../plans.js', () => {
  class PlanNotFoundError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'PlanNotFoundError';
    }
  }
  class NoFrontmatterError extends Error {
    constructor(filePath: string) {
      super(`File lacks frontmatter: ${filePath}`);
      this.name = 'NoFrontmatterError';
    }
  }
  return {
    PlanNotFoundError,
    NoFrontmatterError,
    resolvePlanFile: vi.fn(async (p: string) => p),
    readPlanFile: vi.fn(async (filePath: string) => {
      const { readFile } = await import('node:fs/promises');
      const content = await readFile(filePath, 'utf8');
      const yaml = await import('yaml');
      return yaml.default.parse(content.replace(/^#.*\n/, ''));
    }),
    setPlanStatusById: vi.fn(
      async (_planId: number, status: string, _repoRoot: string, filePath?: string | null) => {
        if (!filePath) {
          throw new Error('Expected file path');
        }
        const { readFile } = await import('node:fs/promises');
        const content = await readFile(filePath, 'utf8');
        const yaml = await import('yaml');
        const data = yaml.default.parse(content.replace(/^#.*\n/, ''));
        data.status = status;
        data.updatedAt = new Date().toISOString();
        const schemaComment =
          '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json\n';
        const { writeFile } = await import('node:fs/promises');
        await writeFile(filePath, schemaComment + yaml.default.stringify(data));
      }
    ),
    writePlanFile: vi.fn(async (filePath: string, data: any) => {
      const schemaComment =
        '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json\n';
      const { writeFile } = await import('node:fs/promises');
      const yaml = await import('yaml');
      await writeFile(filePath, schemaComment + yaml.default.stringify(data));
    }),
    generatePlanFileContent: vi.fn(() => ''),
    resolvePlanByNumericId: vi.fn(async (planId: number) => ({
      plan: { id: planId, title: 'Batch Plan', status: 'pending', tasks: [] },
      planPath: planFile,
    })),
    writePlanToDb: vi.fn(async () => {}),
    setPlanStatus: vi.fn(async () => {}),
    isTaskDone: vi.fn((task: any) => !!task.done),
    getBlockedPlans: vi.fn(() => []),
    getChildPlans: vi.fn(() => []),
    getDiscoveredPlans: vi.fn(() => []),
    getMaxNumericPlanId: vi.fn(async () => 0),
    parsePlanIdentifier: vi.fn(() => ({})),
    isPlanReady: vi.fn(() => true),
    collectDependenciesInOrder: vi.fn(async () => []),
    generateSuggestedFilename: vi.fn(async () => 'plan.yml'),
  };
});

vi.mock('../../prompt_builder.js', () => ({
  buildExecutionPromptWithoutSteps: vi.fn(async () => 'BATCH PROMPT'),
}));

vi.mock('../../plan_materialize.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../plan_materialize.js')>()),
  materializePlan: vi.fn(async () => {}),
  syncMaterializedPlan: vi.fn(async () => {}),
  getMaterializedPlanPath: vi.fn(() => '/tmp/plan.md'),
  getShadowPlanPath: vi.fn(() => '/tmp/.plan.md.shadow'),
  materializeRelatedPlans: vi.fn(async () => {}),
  materializeAndPruneRelatedPlans: vi.fn(async () => {}),
  withPlanAutoSync: vi.fn(async (_id: any, _root: any, fn: () => any) => fn()),
  resolveProjectContext: vi.fn(async () => ({
    projectId: 1,
    planRowsByPlanId: new Map(),
    planRowsByUuid: new Map(),
    maxNumericId: 0,
  })),
  readMaterializedPlanRole: vi.fn(async () => null),
  ensureMaterializeDir: vi.fn(async () => '/tmp'),
  parsePlanId: vi.fn((id: string) => parseInt(id)),
  diffPlanFields: vi.fn(() => ({})),
  mergePlanWithShadow: vi.fn((base: any) => base),
  cleanupMaterializedPlans: vi.fn(async () => {}),
  MATERIALIZED_DIR: '.tim/plans',
}));

vi.mock('../../executors/index.js', () => ({
  buildExecutorAndLog: vi.fn(() => ({ execute: executorExecuteSpy, filePathPrefix: '' })),
  DEFAULT_EXECUTOR: 'codex-cli',
  defaultModelForExecutor: vi.fn(() => 'test-model'),
}));

vi.mock('../../workspace/workspace_roundtrip.js', () => ({
  prepareWorkspaceRoundTrip: vi.fn(async () => null),
  runPostExecutionWorkspaceSync: vi.fn(async () => {}),
  runPreExecutionWorkspaceSync: vi.fn(async () => {}),
  materializePlansForExecution: vi.fn(async () => undefined),
}));

describe('timAgent - summary file write (batch mode)', () => {
  beforeEach(async () => {
    // Temp dir + plan
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-summary-file-int-'));
    planFile = path.join(tempDir, 'plan.yml');
    summaryOut = path.join(tempDir, 'out', 'summary.txt');

    executorExecuteSpy.mockClear();
    workingCopyCallCount = 0;

    // Prepare initial plan with two incomplete tasks to force batch iterations
    await createPlanFile(planFile, {
      id: 551,
      title: 'Batch Plan',
      goal: 'Run multiple tasks',
      details: 'Batch summary file test',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [
        { title: 'Task A', description: 'A', steps: [{ prompt: 'Do A', done: false }] },
        { title: 'Task B', description: 'B', steps: [{ prompt: 'Do B', done: false }] },
      ],
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('writes a formatted summary file including mode and step counts', async () => {
    // Executor that marks tasks done across two iterations
    let call = 0;
    executorExecuteSpy.mockImplementation(async () => {
      call++;
      if (call === 1) {
        // After first batch run, mark Task A done
        await createPlanFile(planFile, {
          id: 551,
          title: 'Batch Plan',
          goal: 'Run multiple tasks',
          details: 'Batch summary file test',
          status: 'in_progress',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tasks: [
            {
              title: 'Task A',
              description: 'A',
              steps: [{ prompt: 'Do A', done: true }],
              done: true,
            },
            { title: 'Task B', description: 'B', steps: [{ prompt: 'Do B', done: false }] },
          ],
        });
        return 'Batch iteration 1 complete';
      } else {
        // After second run, all tasks done
        await createPlanFile(planFile, {
          id: 551,
          title: 'Batch Plan',
          goal: 'Run multiple tasks',
          details: 'Batch summary file test',
          status: 'in_progress',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tasks: [
            {
              title: 'Task A',
              description: 'A',
              steps: [{ prompt: 'Do A', done: true }],
              done: true,
            },
            {
              title: 'Task B',
              description: 'B',
              steps: [{ prompt: 'Do B', done: true }],
              done: true,
            },
          ],
        });
        return 'Batch iteration 2 complete';
      }
    });

    const { timAgent } = await import('./agent.js');
    const options: any = { log: false, orchestrator: 'codex-cli', summaryFile: summaryOut };
    await timAgent(551, options, {});

    // Verify file written and contains key elements
    const content = await fs.readFile(summaryOut, 'utf8');
    expect(content).toContain('Execution Summary: Batch Plan');
    // Table section should include Mode and batch
    expect(content).toContain('Mode');
    expect(content).toContain('batch');
    // Should reflect two steps executed (two iterations)
    expect(content).toMatch(/Steps Executed[\s\S]*2/);
    // Batch iteration titles appear in Step Results
    expect(content).toContain('Batch Iteration 1');
    expect(content).toContain('Batch Iteration 2');
  });

  test('creates parent directories for --summary-file when missing', async () => {
    // Executor that progresses the plan to completion across two iterations
    let call = 0;
    executorExecuteSpy.mockImplementation(async () => {
      call++;
      if (call === 1) {
        // Mark first task done
        await createPlanFile(planFile, {
          id: 551,
          title: 'Batch Plan',
          goal: 'Run multiple tasks',
          details: 'Batch summary file test',
          status: 'in_progress',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tasks: [
            {
              title: 'Task A',
              description: 'A',
              steps: [{ prompt: 'Do A', done: true }],
              done: true,
            },
            { title: 'Task B', description: 'B', steps: [{ prompt: 'Do B', done: false }] },
          ],
        });
        return 'iteration 1';
      }
      // Mark all done
      await createPlanFile(planFile, {
        id: 551,
        title: 'Batch Plan',
        goal: 'Run multiple tasks',
        details: 'Batch summary file test',
        status: 'in_progress',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        tasks: [
          {
            title: 'Task A',
            description: 'A',
            steps: [{ prompt: 'Do A', done: true }],
            done: true,
          },
          {
            title: 'Task B',
            description: 'B',
            steps: [{ prompt: 'Do B', done: true }],
            done: true,
          },
        ],
      });
      return 'iteration 2';
    });

    const { timAgent } = await import('./agent.js');

    const nestedOut = path.join(tempDir, 'nested', 'dir', 'another', 'summary.txt');

    // Ensure parent directory does not exist beforehand
    await expect(fs.access(path.dirname(nestedOut))).rejects.toBeTruthy();

    const options: any = { log: false, orchestrator: 'codex-cli', summaryFile: nestedOut };
    await timAgent(551, options, {});

    // File should now exist and contain a header
    const content = await fs.readFile(nestedOut, 'utf8');
    expect(content).toContain('Execution Summary: Batch Plan');
  });
});
