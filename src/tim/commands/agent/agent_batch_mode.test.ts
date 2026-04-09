import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { timAgent } from './agent.js';
import { runWithLogger } from '../../../logging/adapter.js';
import { createRecordingAdapter } from '../../../logging/test_helpers.js';
import type { StructuredMessage } from '../../../logging/structured_messages.js';
import type { PlanSchema, PlanSchemaInput } from '../../planSchema.js';
import { resetShutdownState, setShuttingDown } from '../../shutdown_state.js';
import { removePlanAssignment } from '../../assignments/remove_plan_assignment.js';

// Mock functions — declared with vi.hoisted() so they are available inside vi.mock() factories
const {
  logSpy,
  errorSpy,
  warnSpy,
  sendStructuredSpy,
  openLogFileSpy,
  closeLogFileSpy,
  executorExecuteSpy,
  buildExecutorAndLogSpy,
  resolvePlanFileSpy,
  loadEffectiveConfigSpy,
  getGitRootSpy,
  getWorkingCopyStatusSpy,
  buildExecutionPromptWithoutStepsSpy,
  executePostApplyCommandSpy,
  runUpdateDocsSpy,
  runUpdateLessonsSpy,
  handleReviewCommandSpy,
  promptConfirmSpy,
  autoCreatePrForPlanSpy,
} = vi.hoisted(() => {
  const executorExecuteSpy = vi.fn(async () => {});
  return {
    logSpy: vi.fn(() => {}),
    errorSpy: vi.fn(() => {}),
    warnSpy: vi.fn(() => {}),
    sendStructuredSpy: vi.fn(() => {}),
    openLogFileSpy: vi.fn(() => {}),
    closeLogFileSpy: vi.fn(async () => {}),
    executorExecuteSpy,
    buildExecutorAndLogSpy: vi.fn(() => ({
      execute: executorExecuteSpy,
      filePathPrefix: '',
    })),
    resolvePlanFileSpy: vi.fn(),
    loadEffectiveConfigSpy: vi.fn(async () => ({
      models: { execution: 'test-model' },
      postApplyCommands: [],
    })),
    getGitRootSpy: vi.fn(async () => '/test/project'),
    getWorkingCopyStatusSpy: vi.fn(async () => ({
      hasChanges: false,
      checkFailed: false,
    })),
    buildExecutionPromptWithoutStepsSpy: vi.fn(async () => 'Test batch prompt'),
    executePostApplyCommandSpy: vi.fn(async () => true),
    runUpdateDocsSpy: vi.fn(async () => {}),
    runUpdateLessonsSpy: vi.fn(async () => true),
    handleReviewCommandSpy: vi.fn(async () => ({ tasksAppended: 0 })),
    promptConfirmSpy: vi.fn(async () => false),
    autoCreatePrForPlanSpy: vi.fn(async () => null),
  };
});

// setPlanStatusSpy needs fs and yaml, so it can't be in vi.hoisted() — but it's only used
// inside the plans.js mock factory which can capture it via a non-hoisted reference.
// Since vi.mock() factories are called lazily (when the module is first imported), the
// factory closure over setPlanStatusSpy will capture it after it's assigned.
const setPlanStatusSpy = vi.fn(async (filePath: string, status: string) => {
  const content = await fs.readFile(filePath, 'utf-8');
  const planData = yaml.parse(content.replace(/^#.*\n/, ''));
  planData.status = status;
  planData.updatedAt = new Date().toISOString();
  const schemaComment =
    '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json\n';
  await fs.writeFile(filePath, schemaComment + yaml.stringify(planData));
});

// Per-test find_next control
let getAllIncompleteTasksImpl: ((p: any) => any) | null = null;
let findNextActionableItemImpl: (() => any) | null = null;

let tempDir = '';
let planFile = '';

vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(async () => 'generate'),
}));

vi.mock('../../../common/input.js', () => ({
  promptConfirm: promptConfirmSpy,
}));

vi.mock('../../../logging.js', () => ({
  log: logSpy,
  error: errorSpy,
  warn: warnSpy,
  sendStructured: sendStructuredSpy,
  openLogFile: openLogFileSpy,
  closeLogFile: closeLogFileSpy,
  boldMarkdownHeaders: vi.fn((text: string) => text),
  debugLog: vi.fn(() => {}),
}));

vi.mock('../../../common/git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../common/git.js')>()),
  getGitRoot: getGitRootSpy,
  getWorkingCopyStatus: getWorkingCopyStatusSpy,
}));

vi.mock('../../../common/process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../common/process.js')>()),
  commitAll: vi.fn(async () => 0),
}));

vi.mock('../../configLoader.js', () => ({
  loadEffectiveConfig: loadEffectiveConfigSpy,
  loadGlobalConfigForNotifications: vi.fn(async () => ({})),
}));

vi.mock('../../executors/index.js', () => ({
  buildExecutorAndLog: buildExecutorAndLogSpy,
  DEFAULT_EXECUTOR: 'copy-only',
  defaultModelForExecutor: vi.fn(() => 'test-model'),
}));

vi.mock('../../prompt_builder.js', () => ({
  buildExecutionPromptWithoutSteps: buildExecutionPromptWithoutStepsSpy,
}));

vi.mock('../../actions.js', () => ({
  executePostApplyCommand: executePostApplyCommandSpy,
}));

vi.mock('../../assignments/remove_plan_assignment.js', () => ({
  removePlanAssignment: vi.fn(async () => {}),
}));

vi.mock('../update-docs.js', () => ({
  runUpdateDocs: runUpdateDocsSpy,
}));

vi.mock('../update-lessons.js', () => ({
  runUpdateLessons: runUpdateLessonsSpy,
}));

vi.mock('../review.js', () => ({
  handleReviewCommand: handleReviewCommandSpy,
}));

vi.mock('../create_pr.js', () => ({
  autoCreatePrForPlan: autoCreatePrForPlanSpy,
}));

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
    resolvePlanFile: resolvePlanFileSpy,
    readPlanFile: vi.fn(async (filePath: string) => {
      const { readFile } = await import('node:fs/promises');
      const content = await readFile(filePath, 'utf-8');
      const yaml = await import('yaml');
      return yaml.default.parse(content.replace(/^#.*\n/, ''));
    }),
    writePlanFile: vi.fn(async (filePath: string, planData: any) => {
      const { writeFile } = await import('node:fs/promises');
      const yaml = await import('yaml');
      const schemaComment =
        '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json\n';
      await writeFile(filePath, schemaComment + yaml.default.stringify(planData));
    }),
    setPlanStatus: vi.fn(async (filePath: string, status: string) => {
      await setPlanStatusSpy(filePath, status);
    }),
    setPlanStatusById: vi.fn(
      async (_planId: number, status: string, _repoRoot: string, filePath?: string | null) => {
        if (!filePath) {
          throw new Error('Expected file path for setPlanStatusById test mock');
        }
        await setPlanStatusSpy(filePath, status);
      }
    ),
    generatePlanFileContent: vi.fn(() => ''),
    resolvePlanFromDb: vi.fn(async () => ({
      plan: { id: 1, title: 'P', status: 'pending', tasks: [] },
      planPath: '',
    })),
    writePlanToDb: vi.fn(async () => {}),
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

vi.mock('../../plans/find_next.js', () => ({
  getAllIncompleteTasks: vi.fn((p: any) => {
    if (getAllIncompleteTasksImpl !== null) {
      return getAllIncompleteTasksImpl(p);
    }
    // Default: use real logic based on plan tasks
    if (!p || !p.tasks) return [];
    return p.tasks
      .map((task: any, i: number) => ({ taskIndex: i, task }))
      .filter(({ task }: any) => !task.done);
  }),
  findNextActionableItem: vi.fn(() => {
    if (findNextActionableItemImpl !== null) {
      return findNextActionableItemImpl();
    }
    return null;
  }),
  findPendingTask: vi.fn(() => null),
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

describe('timAgent - Batch Mode Execution Loop', () => {
  beforeEach(async () => {
    // Clear all mocks
    logSpy.mockClear();
    errorSpy.mockClear();
    warnSpy.mockClear();
    sendStructuredSpy.mockClear();
    openLogFileSpy.mockClear();
    closeLogFileSpy.mockClear();
    executorExecuteSpy.mockClear();
    buildExecutorAndLogSpy.mockClear();
    resolvePlanFileSpy.mockClear();
    loadEffectiveConfigSpy.mockClear();
    getGitRootSpy.mockClear();
    getWorkingCopyStatusSpy.mockClear();
    buildExecutionPromptWithoutStepsSpy.mockClear();
    setPlanStatusSpy.mockClear();
    executePostApplyCommandSpy.mockClear();
    executePostApplyCommandSpy.mockResolvedValue(true);
    runUpdateDocsSpy.mockClear();
    runUpdateLessonsSpy.mockClear();
    handleReviewCommandSpy.mockClear();
    promptConfirmSpy.mockClear();
    promptConfirmSpy.mockResolvedValue(false);
    autoCreatePrForPlanSpy.mockClear();
    (removePlanAssignment as ReturnType<typeof vi.fn>).mockClear();
    resetShutdownState();

    // Reset per-test impls
    getAllIncompleteTasksImpl = null;
    findNextActionableItemImpl = null;

    // Create temporary directory and plan file
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-batch-mode-test-'));
    planFile = path.join(tempDir, 'test-plan.yml');

    getGitRootSpy.mockImplementation(async () => tempDir);
    getWorkingCopyStatusSpy.mockImplementation(async () => {
      const content = await fs.readFile(planFile, 'utf-8');
      return {
        hasChanges: true,
        checkFailed: false,
        diffHash: createHash('sha256').update(content).digest('hex'),
      };
    });

    // Set up default mock behaviors
    resolvePlanFileSpy.mockResolvedValue(planFile);

    loadEffectiveConfigSpy.mockResolvedValue({
      models: { execution: 'test-model' },
      postApplyCommands: [],
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    resetShutdownState();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  async function createPlanFile(planData: Partial<PlanSchemaInput>) {
    const defaultPlan: PlanSchemaInput = {
      id: 1,
      title: 'Test Plan',
      goal: 'Test goal',
      details: 'Test details',
      status: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tasks: [],
      ...planData,
    };

    const schemaComment =
      '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json\n';
    await fs.writeFile(planFile, schemaComment + yaml.stringify(defaultPlan));
  }

  describe('batch mode activation and loop behavior', () => {
    test('batch mode executes by default (when options.serialTasks is not true)', async () => {
      await createPlanFile({
        tasks: [
          {
            title: 'Task 1',
            description: 'First task',
            steps: [{ prompt: 'Do task 1', done: false }],
          },
          {
            title: 'Task 2',
            description: 'Second task',
            steps: [{ prompt: 'Do task 2', done: false }],
          },
        ],
      });

      const options = { log: false, dryRun: true, nonInteractive: true } as any;
      const globalCliOptions = {};

      await timAgent(planFile, options, globalCliOptions);

      // Should have been called with batch mode prompt
      expect(buildExecutionPromptWithoutStepsSpy).toHaveBeenCalled();

      // Check the calls to the prompt builder for batch mode characteristics
      const callArgs = buildExecutionPromptWithoutStepsSpy.mock.calls[0][0];
      expect(callArgs.task.title).toContain('2 Tasks');
      expect(callArgs.task.description).toContain('select and complete');
      expect(callArgs.task.description).toContain('Task 1: Task 1');
      expect(callArgs.task.description).toContain('Task 2: Task 2');
    });

    test('batch mode does not execute when options.serialTasks is true', async () => {
      await createPlanFile({
        tasks: [
          {
            title: 'Task 1',
            description: 'First task',
            steps: [{ prompt: 'Do task 1', done: false }],
          },
        ],
      });

      // For serial mode, findNextActionableItem returns null
      findNextActionableItemImpl = () => null;

      const options = { serialTasks: true, log: false, nonInteractive: true } as any;
      const globalCliOptions = {};

      await timAgent(planFile, options, globalCliOptions);

      // Should not have called batch mode prompt building
      const batchCalls = buildExecutionPromptWithoutStepsSpy.mock.calls.filter(
        (call) => call[0].task && call[0].task.title?.includes('Batch Processing')
      );
      expect(batchCalls.length).toBe(0);
    });

    test('batch mode continues until no incomplete tasks remain', async () => {
      await createPlanFile({
        tasks: [
          {
            title: 'Task 1',
            description: 'First task',
            steps: [{ prompt: 'Do task 1', done: false }],
          },
          {
            title: 'Task 2',
            description: 'Second task',
            steps: [{ prompt: 'Do task 2', done: false }],
          },
        ],
      });

      let batchCallCount = 0;
      executorExecuteSpy.mockImplementation(async () => {
        batchCallCount++;
        // Simulate completing tasks by modifying the file
        if (batchCallCount === 1) {
          // First call: complete Task 1
          await createPlanFile({
            tasks: [
              {
                title: 'Task 1',
                description: 'First task',
                steps: [{ prompt: 'Do task 1', done: true }],
                done: true,
              },
              {
                title: 'Task 2',
                description: 'Second task',
                steps: [{ prompt: 'Do task 2', done: false }],
              },
            ],
          });
        } else if (batchCallCount === 2) {
          // Second call: complete Task 2
          await createPlanFile({
            tasks: [
              {
                title: 'Task 1',
                description: 'First task',
                steps: [{ prompt: 'Do task 1', done: true }],
                done: true,
              },
              {
                title: 'Task 2',
                description: 'Second task',
                steps: [{ prompt: 'Do task 2', done: true }],
                done: true,
              },
            ],
          });
        }
      });

      const options = { log: false, nonInteractive: true } as any;
      const globalCliOptions = {};

      await timAgent(planFile, options, globalCliOptions);

      // Should have executed twice (once for each batch iteration)
      expect(executorExecuteSpy).toHaveBeenCalledTimes(2);
    });

    test('batch mode immediately retries when a run makes no changes and finishes quickly', async () => {
      await createPlanFile({
        tasks: [
          {
            title: 'Task 1',
            description: 'First task',
            steps: [{ prompt: 'Do task 1', done: false }],
          },
        ],
      });

      let batchCallCount = 0;
      executorExecuteSpy.mockImplementation(async () => {
        batchCallCount++;
        if (batchCallCount === 2) {
          await createPlanFile({
            tasks: [
              {
                title: 'Task 1',
                description: 'First task',
                steps: [{ prompt: 'Do task 1', done: true }],
                done: true,
              },
            ],
          });
        }
      });

      const options = { log: false, nonInteractive: true, steps: '2' } as any;
      const globalCliOptions = {};

      await timAgent(planFile, options, globalCliOptions);

      expect(executorExecuteSpy).toHaveBeenCalledTimes(2);
      expect(sendStructuredSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'workflow_progress',
          phase: 'batch',
          message: expect.stringContaining('retrying'),
        })
      );
    });

    test('batch mode terminates when all tasks are complete', async () => {
      await createPlanFile({
        tasks: [
          { title: 'Task 1', description: 'First task', done: true },
          { title: 'Task 2', description: 'Second task', done: true },
        ],
      });

      const options = { log: false, nonInteractive: true } as any;
      const globalCliOptions = {};
      const { adapter } = createRecordingAdapter();

      await runWithLogger(adapter, () => timAgent(planFile, options, globalCliOptions));

      // Should not execute anything since all tasks are already done
      expect(executorExecuteSpy).not.toHaveBeenCalled();

      expect(sendStructuredSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'task_completion',
          planComplete: true,
        })
      );
    });
  });

  describe('incomplete task detection and formatting', () => {
    test('getAllIncompleteTasks is called to identify tasks', async () => {
      // Use per-test impl that returns specific incomplete tasks
      getAllIncompleteTasksImpl = () => [
        { taskIndex: 0, task: { title: 'Task 1', description: 'First task' } },
        { taskIndex: 2, task: { title: 'Task 3', description: 'Third task' } },
      ];

      await createPlanFile({
        tasks: [
          { title: 'Task 1', description: 'First task' },
          { title: 'Task 2', description: 'Second task', done: true },
          { title: 'Task 3', description: 'Third task' },
        ],
      });

      const options = { log: false, dryRun: true, nonInteractive: true } as any;
      const globalCliOptions = {};

      await timAgent(planFile, options, globalCliOptions);

      // Check that the batch prompt includes the correct tasks
      const callArgs = buildExecutionPromptWithoutStepsSpy.mock.calls[0][0];
      expect(callArgs.task.description).toContain('Task 1: Task 1');
      expect(callArgs.task.description).toContain('Task 3: Task 3');
      expect(callArgs.task.description).not.toContain('Task 2: Task 2'); // This one is done
    });
  });

  describe('plan status management', () => {
    test('plan status changes from pending to in_progress', async () => {
      await createPlanFile({
        status: 'pending',
        tasks: [
          {
            title: 'Task 1',
            description: 'First task',
            steps: [{ prompt: 'Do task 1', done: false }],
          },
        ],
      });

      executorExecuteSpy.mockImplementation(async () => {
        await createPlanFile({
          status: 'in_progress',
          tasks: [
            {
              title: 'Task 1',
              description: 'First task',
              steps: [{ prompt: 'Do task 1', done: true }],
              done: true,
            },
          ],
        });
      });

      const options = { log: false, nonInteractive: true } as any;
      const globalCliOptions = {};

      await timAgent(planFile, options, globalCliOptions);

      // Read the file to check status was updated
      const content = await fs.readFile(planFile, 'utf-8');
      const planData = yaml.parse(content.replace(/^#.*\n/, ''));
      expect(planData.status).toBe('needs_review');
    });

    test('plan status changes to needs_review when all tasks complete', async () => {
      await createPlanFile({
        status: 'in_progress',
        tasks: [
          {
            title: 'Task 1',
            description: 'First task',
            steps: [{ prompt: 'Do task 1', done: false }],
          },
          { title: 'Task 2', description: 'Second task', done: true },
        ],
      });

      executorExecuteSpy.mockImplementation(async () => {
        await createPlanFile({
          status: 'in_progress',
          tasks: [
            {
              title: 'Task 1',
              description: 'First task',
              steps: [{ prompt: 'Do task 1', done: true }],
              done: true,
            },
            { title: 'Task 2', description: 'Second task', done: true },
          ],
        });
      });

      const options = { log: false, nonInteractive: true } as any;
      const globalCliOptions = {};

      await timAgent(planFile, options, globalCliOptions);

      // Read the final file content to verify status was updated to needs_review
      const finalContent = await fs.readFile(planFile, 'utf-8');
      const finalPlan = yaml.parse(finalContent.replace(/^#.*\n/, ''));
      expect(finalPlan.status).toBe('needs_review');
      expect(removePlanAssignment).not.toHaveBeenCalled();
    });

    test('planAutocompleteStatus=done removes assignment when batch mode completes', async () => {
      await createPlanFile({
        status: 'in_progress',
        uuid: 'plan-uuid-1',
        tasks: [
          {
            title: 'Task 1',
            description: 'First task',
            steps: [{ prompt: 'Do task 1', done: false }],
          },
        ],
      });

      loadEffectiveConfigSpy.mockResolvedValue({
        models: { execution: 'test-model' },
        postApplyCommands: [],
        planAutocompleteStatus: 'done',
      });

      executorExecuteSpy.mockImplementation(async () => {
        await createPlanFile({
          status: 'in_progress',
          uuid: 'plan-uuid-1',
          tasks: [
            {
              title: 'Task 1',
              description: 'First task',
              steps: [{ prompt: 'Do task 1', done: true }],
              done: true,
            },
          ],
        });
      });

      const options = { log: false, nonInteractive: true } as any;
      const globalCliOptions = {};

      await timAgent(planFile, options, globalCliOptions);

      const finalContent = await fs.readFile(planFile, 'utf-8');
      const finalPlan = yaml.parse(finalContent.replace(/^#.*\n/, ''));
      expect(finalPlan.status).toBe('done');
      expect(removePlanAssignment).toHaveBeenCalledTimes(1);
      expect(removePlanAssignment).toHaveBeenCalledWith(
        expect.objectContaining({ id: 1, uuid: 'plan-uuid-1' }),
        tempDir
      );
    });

    test('planAutocompleteStatus=done keeps assignment when final review reopens the plan', async () => {
      await createPlanFile({
        status: 'in_progress',
        uuid: 'plan-uuid-1',
        tasks: [
          {
            title: 'Already Complete',
            description: 'Keeps final review enabled',
            done: true,
            steps: [{ prompt: 'done', done: true }],
          },
          {
            title: 'Task 2',
            description: 'Second task',
            steps: [{ prompt: 'Do task 2', done: false }],
          },
        ],
      });

      loadEffectiveConfigSpy.mockResolvedValue({
        models: { execution: 'test-model' },
        postApplyCommands: [],
        planAutocompleteStatus: 'done',
      });
      handleReviewCommandSpy.mockResolvedValueOnce({ tasksAppended: 2 });
      promptConfirmSpy.mockResolvedValueOnce(false);

      executorExecuteSpy.mockImplementation(async () => {
        await createPlanFile({
          status: 'in_progress',
          uuid: 'plan-uuid-1',
          tasks: [
            {
              title: 'Already Complete',
              description: 'Keeps final review enabled',
              done: true,
              steps: [{ prompt: 'done', done: true }],
            },
            {
              title: 'Task 2',
              description: 'Second task',
              steps: [{ prompt: 'Do task 2', done: true }],
              done: true,
            },
          ],
        });
      });

      const options = { log: false, nonInteractive: true } as any;
      const globalCliOptions = {};

      await timAgent(planFile, options, globalCliOptions);

      const finalContent = await fs.readFile(planFile, 'utf-8');
      const finalPlan = yaml.parse(finalContent.replace(/^#.*\n/, ''));
      expect(finalPlan.status).toBe('in_progress');
      expect(handleReviewCommandSpy).toHaveBeenCalledTimes(1);
      expect(promptConfirmSpy).toHaveBeenCalledTimes(1);
      expect(removePlanAssignment).not.toHaveBeenCalled();
    });

    test('parent plan status is updated when child completes', async () => {
      await createPlanFile({
        status: 'pending',
        parent: 42,
        tasks: [
          {
            title: 'Task 1',
            description: 'Child task',
            steps: [{ prompt: 'Do child task', done: false }],
          },
        ],
      });

      executorExecuteSpy.mockImplementation(async () => {
        await createPlanFile({
          status: 'in_progress',
          parent: 42,
          tasks: [
            {
              title: 'Task 1',
              description: 'Child task',
              steps: [{ prompt: 'Do child task', done: true }],
              done: true,
            },
          ],
        });
      });

      const options = { log: false, nonInteractive: true } as any;
      const globalCliOptions = {};

      await timAgent(planFile, options, globalCliOptions);

      // Parent checking happens through the setPlanStatus function in our mocks
      // Verify the plan was marked as needs_review (which would trigger parent updates)
      const finalContent = await fs.readFile(planFile, 'utf-8');
      const finalPlan = yaml.parse(finalContent.replace(/^#.*\n/, ''));
      expect(finalPlan.status).toBe('needs_review');
    });
  });

  describe('executor integration', () => {
    test('executor receives plan file path for editing', async () => {
      await createPlanFile({
        tasks: [
          {
            title: 'Task 1',
            description: 'First task',
            steps: [{ prompt: 'Do task 1', done: false }],
          },
        ],
      });

      executorExecuteSpy.mockImplementation(async () => {
        await createPlanFile({
          tasks: [
            {
              title: 'Task 1',
              description: 'First task',
              steps: [{ prompt: 'Do task 1', done: true }],
              done: true,
            },
          ],
        });
      });

      const options = { log: false, nonInteractive: true } as any;
      const globalCliOptions = {};

      await timAgent(planFile, options, globalCliOptions);

      // Verify executor was called with correct metadata including plan file path
      expect(executorExecuteSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          planFilePath: planFile,
          planId: '1',
          planTitle: 'Test Plan',
        })
      );
    });

    test('batch prompt is built with correct parameters', async () => {
      await createPlanFile({
        id: 123,
        title: 'Custom Plan Title',
        tasks: [
          {
            title: 'Task 1',
            description: 'First task',
            steps: [{ prompt: 'Do task 1', done: false }],
          },
        ],
      });

      const options = { log: false, dryRun: true, nonInteractive: true } as any;
      const globalCliOptions = {};

      await timAgent(planFile, options, globalCliOptions);

      // Verify buildExecutionPromptWithoutSteps was called with correct params
      expect(buildExecutionPromptWithoutStepsSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          planFilePath: planFile,
          includeCurrentPlanContext: true,
          task: expect.objectContaining({
            description: expect.stringContaining('select and complete'),
          }),
        })
      );
    });
  });

  describe('post-apply commands', () => {
    test('post-apply commands are executed after batch completion', async () => {
      await createPlanFile({
        tasks: [
          {
            title: 'Task 1',
            description: 'First task',
            steps: [{ prompt: 'Do task 1', done: false }],
          },
        ],
      });

      loadEffectiveConfigSpy.mockResolvedValue({
        models: { execution: 'test-model' },
        postApplyCommands: [
          { title: 'Test Command', command: 'echo test' },
          { title: 'Another Command', command: 'echo test2' },
        ],
      });

      executorExecuteSpy.mockImplementation(async () => {
        await createPlanFile({
          tasks: [
            {
              title: 'Task 1',
              description: 'First task',
              steps: [{ prompt: 'Do task 1', done: true }],
              done: true,
            },
          ],
        });
      });

      const options = { log: false, nonInteractive: true } as any;
      const globalCliOptions = {};

      await timAgent(planFile, options, globalCliOptions);

      // Verify post-apply commands were executed
      expect(executePostApplyCommandSpy).toHaveBeenCalledTimes(2);
    });

    test('batch mode stops when required post-apply command fails', async () => {
      await createPlanFile({
        tasks: [
          { title: 'Task 1', description: 'First task' },
          { title: 'Task 2', description: 'Second task' },
        ],
      });

      loadEffectiveConfigSpy.mockResolvedValue({
        models: { execution: 'test-model' },
        postApplyCommands: [{ title: 'Failing Command', command: 'exit 1' }],
      });

      executePostApplyCommandSpy.mockResolvedValue(false); // Command fails

      const options = { log: false, nonInteractive: true } as any;
      const globalCliOptions = {};

      await expect(timAgent(planFile, options, globalCliOptions)).rejects.toThrow(
        'Batch mode stopped due to error.'
      );
    });

    test('post-apply commands run again after after-completion docs update', async () => {
      await createPlanFile({
        tasks: [
          {
            title: 'Task 1',
            description: 'First task',
            steps: [{ prompt: 'Do task 1', done: false }],
          },
        ],
      });

      loadEffectiveConfigSpy.mockResolvedValue({
        models: { execution: 'test-model' },
        postApplyCommands: [{ title: 'Test Command', command: 'echo test' }],
        updateDocs: { mode: 'after-completion' },
      });

      executorExecuteSpy.mockImplementation(async () => {
        await createPlanFile({
          tasks: [
            {
              title: 'Task 1',
              description: 'First task',
              steps: [{ prompt: 'Do task 1', done: true }],
              done: true,
            },
          ],
        });
      });

      const options = { log: false, nonInteractive: true, finalReview: false } as any;
      const globalCliOptions = {};

      await timAgent(planFile, options, globalCliOptions);

      expect(runUpdateDocsSpy).toHaveBeenCalledTimes(1);
      expect(executePostApplyCommandSpy).toHaveBeenCalledTimes(2);
    });

    test('post-apply commands run again after lessons update', async () => {
      await createPlanFile({
        tasks: [
          {
            title: 'Task 1',
            description: 'First task',
            steps: [{ prompt: 'Do task 1', done: false }],
          },
        ],
      });

      loadEffectiveConfigSpy.mockResolvedValue({
        models: { execution: 'test-model' },
        postApplyCommands: [{ title: 'Test Command', command: 'echo test' }],
        updateDocs: { mode: 'never', applyLessons: true },
      });

      executorExecuteSpy.mockImplementation(async () => {
        await createPlanFile({
          tasks: [
            {
              title: 'Task 1',
              description: 'First task',
              steps: [{ prompt: 'Do task 1', done: true }],
              done: true,
            },
          ],
        });
      });

      const options = { log: false, nonInteractive: true, finalReview: false } as any;
      const globalCliOptions = {};

      await timAgent(planFile, options, globalCliOptions);

      expect(runUpdateLessonsSpy).toHaveBeenCalledTimes(1);
      expect(executePostApplyCommandSpy).toHaveBeenCalledTimes(2);
    });

    test('batch mode skips after-iteration docs when shutdown is requested after execution', async () => {
      await createPlanFile({
        tasks: [
          {
            title: 'Task 1',
            description: 'First task',
            steps: [{ prompt: 'Do task 1', done: false }],
          },
        ],
      });

      loadEffectiveConfigSpy.mockResolvedValue({
        models: { execution: 'test-model' },
        postApplyCommands: [],
        updateDocs: { mode: 'after-iteration' },
      });

      executorExecuteSpy.mockImplementationOnce(async () => {
        await createPlanFile({
          tasks: [
            {
              title: 'Task 1',
              description: 'First task',
              steps: [{ prompt: 'Do task 1', done: true }],
              done: true,
            },
          ],
        });
        setShuttingDown(130);
      });

      const originalExit = process.exit;
      process.exit = ((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as typeof process.exit;

      try {
        await expect(timAgent(planFile, { log: false, nonInteractive: true }, {})).rejects.toThrow(
          'process.exit(130)'
        );
      } finally {
        process.exit = originalExit;
      }

      expect(runUpdateDocsSpy).not.toHaveBeenCalled();
      expect(executePostApplyCommandSpy).not.toHaveBeenCalled();
    });

    test('batch mode skips after-completion docs when shutdown is requested after plan status is updated', async () => {
      await createPlanFile({
        tasks: [
          {
            title: 'Task 1',
            description: 'First task',
            steps: [{ prompt: 'Do task 1', done: false }],
          },
        ],
      });

      loadEffectiveConfigSpy.mockResolvedValue({
        models: { execution: 'test-model' },
        postApplyCommands: [],
        updateDocs: { mode: 'after-completion' },
      });

      executorExecuteSpy.mockImplementationOnce(async () => {
        await createPlanFile({
          tasks: [
            {
              title: 'Task 1',
              description: 'First task',
              steps: [{ prompt: 'Do task 1', done: true }],
              done: true,
            },
          ],
        });
      });

      setPlanStatusSpy.mockImplementationOnce(async (filePath: string, status: string) => {
        const content = await fs.readFile(filePath, 'utf-8');
        const planData = yaml.parse(content.replace(/^#.*\n/, ''));
        planData.status = status;
        planData.updatedAt = new Date().toISOString();
        const schemaComment =
          '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json\n';
        await fs.writeFile(filePath, schemaComment + yaml.stringify(planData));
        setShuttingDown(130);
      });

      const originalExit = process.exit;
      process.exit = ((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as typeof process.exit;

      try {
        await expect(
          timAgent(planFile, { log: false, nonInteractive: true, finalReview: false }, {})
        ).rejects.toThrow('process.exit(130)');
      } finally {
        process.exit = originalExit;
      }

      expect(runUpdateDocsSpy).not.toHaveBeenCalled();
    });

    test('batch mode skips lessons update when shutdown is requested after plan status is updated', async () => {
      await createPlanFile({
        tasks: [
          {
            title: 'Task 1',
            description: 'First task',
            steps: [{ prompt: 'Do task 1', done: false }],
          },
        ],
      });

      loadEffectiveConfigSpy.mockResolvedValue({
        models: { execution: 'test-model' },
        postApplyCommands: [],
        updateDocs: { mode: 'never', applyLessons: true },
      });

      executorExecuteSpy.mockImplementationOnce(async () => {
        await createPlanFile({
          tasks: [
            {
              title: 'Task 1',
              description: 'First task',
              steps: [{ prompt: 'Do task 1', done: true }],
              done: true,
            },
          ],
        });
      });

      setPlanStatusSpy.mockImplementationOnce(async (filePath: string, status: string) => {
        const content = await fs.readFile(filePath, 'utf-8');
        const planData = yaml.parse(content.replace(/^#.*\n/, ''));
        planData.status = status;
        planData.updatedAt = new Date().toISOString();
        const schemaComment =
          '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json\n';
        await fs.writeFile(filePath, schemaComment + yaml.stringify(planData));
        setShuttingDown(130);
      });

      const originalExit = process.exit;
      process.exit = ((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as typeof process.exit;

      try {
        await expect(
          timAgent(planFile, { log: false, nonInteractive: true, finalReview: false }, {})
        ).rejects.toThrow('process.exit(130)');
      } finally {
        process.exit = originalExit;
      }

      expect(runUpdateLessonsSpy).not.toHaveBeenCalled();
    });
  });

  describe('dry run mode', () => {
    test('dry run prints batch prompt without executing', async () => {
      await createPlanFile({
        tasks: [
          {
            title: 'Task 1',
            description: 'First task',
            steps: [{ prompt: 'Do task 1', done: false }],
          },
        ],
      });

      const options = { log: false, dryRun: true, nonInteractive: true } as any;
      const globalCliOptions = {};

      await timAgent(planFile, options, globalCliOptions);

      // Should have built the prompt but not executed it
      expect(buildExecutionPromptWithoutStepsSpy).toHaveBeenCalled();
      expect(executorExecuteSpy).not.toHaveBeenCalled();

      // Should have logged dry run information
      const logCalls = logSpy.mock.calls.map((call) => call[0]);
      expect(
        logCalls.some((call) => typeof call === 'string' && call.includes('--dry-run mode'))
      ).toBe(true);
    });
  });

  describe('error handling', () => {
    // TODO: Fix mock interaction issues in this test
    test.skip('batch mode handles executor errors gracefully', async () => {
      await createPlanFile({
        tasks: [
          {
            title: 'Task 1',
            description: 'First task',
            steps: [{ prompt: 'Do task 1', done: false }],
          },
        ],
      });

      // Clear previous mock and set up rejection
      executorExecuteSpy.mockClear();
      executorExecuteSpy.mockRejectedValue(new Error('Executor failed'));

      const options = { log: false, nonInteractive: true } as any;
      const globalCliOptions = {};

      await expect(timAgent(planFile, options, globalCliOptions)).rejects.toThrow(
        'Batch mode stopped due to error.'
      );

      expect(errorSpy).toHaveBeenCalledWith('Batch execution failed:', expect.any(Error));
    });

    test('batch mode handles plan file read errors', async () => {
      // Create invalid plan file
      await fs.writeFile(planFile, 'invalid yaml content [');

      const options = { log: false } as any;
      const globalCliOptions = {};

      // Should throw error when trying to parse invalid YAML
      await expect(timAgent(planFile, options, globalCliOptions)).rejects.toThrow();
    });
  });

  describe('logging and progress tracking', () => {
    // TODO: Fix test interdependency issues
    test.skip('batch mode logs iteration progress', async () => {
      await createPlanFile({
        tasks: [
          { title: 'Task 1', description: 'First task' },
          { title: 'Task 2', description: 'Second task' },
        ],
      });

      let callCount = 0;
      executorExecuteSpy.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          await createPlanFile({
            tasks: [
              {
                title: 'Task 1',
                description: 'First task',
                steps: [{ prompt: 'Do task 1', done: true }],
                done: true,
              },
              {
                title: 'Task 2',
                description: 'Second task',
                steps: [{ prompt: 'Do task 2', done: false }],
              },
            ],
          });
        } else {
          await createPlanFile({
            tasks: [
              {
                title: 'Task 1',
                description: 'First task',
                steps: [{ prompt: 'Do task 1', done: true }],
                done: true,
              },
              {
                title: 'Task 2',
                description: 'Second task',
                steps: [{ prompt: 'Do task 2', done: true }],
                done: true,
              },
            ],
          });
        }
      });

      const options = { log: false, nonInteractive: true } as any;
      const globalCliOptions = {};

      await timAgent(planFile, options, globalCliOptions);

      const logCalls = logSpy.mock.calls.map((call) => call[0]);
      expect(
        logCalls.some(
          (call) => typeof call === 'string' && call.includes('Starting batch mode execution')
        )
      ).toBe(true);
      expect(
        logCalls.some(
          (call) => typeof call === 'string' && call.includes('Processing 2 incomplete task(s)')
        )
      ).toBe(true);
      expect(
        logCalls.some(
          (call) => typeof call === 'string' && call.includes('Processing 1 incomplete task(s)')
        )
      ).toBe(true);
      expect(
        logCalls.some(
          (call) => typeof call === 'string' && call.includes('Batch iteration complete')
        )
      ).toBe(true);
    });

    // TODO: Fix test interdependency issues
    test.skip('batch mode logs plan completion', async () => {
      await createPlanFile({
        tasks: [
          {
            title: 'Task 1',
            description: 'First task',
            steps: [{ prompt: 'Do task 1', done: false }],
          },
        ],
      });

      executorExecuteSpy.mockImplementation(async () => {
        await createPlanFile({
          tasks: [
            {
              title: 'Task 1',
              description: 'First task',
              steps: [{ prompt: 'Do task 1', done: true }],
              done: true,
            },
          ],
        });
      });

      const options = { log: false, nonInteractive: true } as any;
      const globalCliOptions = {};

      await timAgent(planFile, options, globalCliOptions);

      const logCalls = logSpy.mock.calls.map((call) => call[0]);
      expect(
        logCalls.some(
          (call) =>
            typeof call === 'string' && call.includes('All tasks completed, marking plan as done')
        )
      ).toBe(true);
    });
  });

  describe('finalization timestamps and manual mode', () => {
    test('docsUpdatedAt is set after successful runUpdateDocs in after-completion mode', async () => {
      await createPlanFile({
        tasks: [
          {
            title: 'Task 1',
            description: 'First task',
            steps: [{ prompt: 'Do task 1', done: false }],
          },
        ],
      });

      loadEffectiveConfigSpy.mockResolvedValue({
        models: { execution: 'test-model' },
        postApplyCommands: [],
        updateDocs: { mode: 'after-completion' },
      });

      executorExecuteSpy.mockImplementation(async () => {
        await createPlanFile({
          tasks: [
            {
              title: 'Task 1',
              description: 'First task',
              steps: [{ prompt: 'Do task 1', done: true }],
              done: true,
            },
          ],
        });
      });

      const options = { log: false, nonInteractive: true, finalReview: false } as any;
      const globalCliOptions = {};

      await timAgent(planFile, options, globalCliOptions);

      expect(runUpdateDocsSpy).toHaveBeenCalledTimes(1);

      const finalContent = await fs.readFile(planFile, 'utf-8');
      const finalPlan = yaml.parse(finalContent.replace(/^#.*\n/, ''));
      expect(finalPlan.docsUpdatedAt).toBeDefined();
      expect(new Date(finalPlan.docsUpdatedAt).toISOString()).toBe(finalPlan.docsUpdatedAt);
    });

    test('docsUpdatedAt is set after successful runUpdateDocs in after-iteration mode', async () => {
      await createPlanFile({
        tasks: [
          {
            title: 'Task 1',
            description: 'First task',
            steps: [{ prompt: 'Do task 1', done: false }],
          },
          {
            title: 'Task 2',
            description: 'Second task',
            steps: [{ prompt: 'Do task 2', done: false }],
          },
        ],
      });

      loadEffectiveConfigSpy.mockResolvedValue({
        models: { execution: 'test-model' },
        postApplyCommands: [],
        updateDocs: { mode: 'after-iteration' },
      });

      let callCount = 0;
      executorExecuteSpy.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          await createPlanFile({
            tasks: [
              {
                title: 'Task 1',
                description: 'First task',
                steps: [{ prompt: 'Do task 1', done: true }],
                done: true,
              },
              {
                title: 'Task 2',
                description: 'Second task',
                steps: [{ prompt: 'Do task 2', done: false }],
              },
            ],
          });
        } else {
          await createPlanFile({
            tasks: [
              {
                title: 'Task 1',
                description: 'First task',
                steps: [{ prompt: 'Do task 1', done: true }],
                done: true,
              },
              {
                title: 'Task 2',
                description: 'Second task',
                steps: [{ prompt: 'Do task 2', done: true }],
                done: true,
              },
            ],
          });
        }
      });

      const options = { log: false, nonInteractive: true, finalReview: false } as any;
      const globalCliOptions = {};

      await timAgent(planFile, options, globalCliOptions);

      expect(runUpdateDocsSpy).toHaveBeenCalled();

      const finalContent = await fs.readFile(planFile, 'utf-8');
      const finalPlan = yaml.parse(finalContent.replace(/^#.*\n/, ''));
      expect(finalPlan.docsUpdatedAt).toBeDefined();
      expect(new Date(finalPlan.docsUpdatedAt).toISOString()).toBe(finalPlan.docsUpdatedAt);
    });

    test('lessonsAppliedAt is set when runUpdateLessons returns true', async () => {
      await createPlanFile({
        tasks: [
          {
            title: 'Task 1',
            description: 'First task',
            steps: [{ prompt: 'Do task 1', done: false }],
          },
        ],
      });

      loadEffectiveConfigSpy.mockResolvedValue({
        models: { execution: 'test-model' },
        postApplyCommands: [],
        updateDocs: { mode: 'never', applyLessons: true },
      });

      runUpdateLessonsSpy.mockResolvedValue(true);

      executorExecuteSpy.mockImplementation(async () => {
        await createPlanFile({
          tasks: [
            {
              title: 'Task 1',
              description: 'First task',
              steps: [{ prompt: 'Do task 1', done: true }],
              done: true,
            },
          ],
        });
      });

      const options = { log: false, nonInteractive: true, finalReview: false } as any;
      const globalCliOptions = {};

      await timAgent(planFile, options, globalCliOptions);

      expect(runUpdateLessonsSpy).toHaveBeenCalledTimes(1);

      const finalContent = await fs.readFile(planFile, 'utf-8');
      const finalPlan = yaml.parse(finalContent.replace(/^#.*\n/, ''));
      expect(finalPlan.lessonsAppliedAt).toBeDefined();
      expect(new Date(finalPlan.lessonsAppliedAt).toISOString()).toBe(finalPlan.lessonsAppliedAt);
    });

    test('lessonsAppliedAt is set when runUpdateLessons returns skipped-no-lessons', async () => {
      await createPlanFile({
        tasks: [
          {
            title: 'Task 1',
            description: 'First task',
            steps: [{ prompt: 'Do task 1', done: false }],
          },
        ],
      });

      loadEffectiveConfigSpy.mockResolvedValue({
        models: { execution: 'test-model' },
        postApplyCommands: [],
        updateDocs: { mode: 'never', applyLessons: true },
      });

      runUpdateLessonsSpy.mockResolvedValue('skipped-no-lessons' as const);

      executorExecuteSpy.mockImplementation(async () => {
        await createPlanFile({
          tasks: [
            {
              title: 'Task 1',
              description: 'First task',
              steps: [{ prompt: 'Do task 1', done: true }],
              done: true,
            },
          ],
        });
      });

      const options = { log: false, nonInteractive: true, finalReview: false } as any;
      const globalCliOptions = {};

      await timAgent(planFile, options, globalCliOptions);

      expect(runUpdateLessonsSpy).toHaveBeenCalledTimes(1);

      const finalContent = await fs.readFile(planFile, 'utf-8');
      const finalPlan = yaml.parse(finalContent.replace(/^#.*\n/, ''));
      expect(finalPlan.lessonsAppliedAt).toBeDefined();
      expect(new Date(finalPlan.lessonsAppliedAt).toISOString()).toBe(finalPlan.lessonsAppliedAt);
    });

    test('lessonsAppliedAt is NOT set when runUpdateLessons returns false', async () => {
      await createPlanFile({
        tasks: [
          {
            title: 'Task 1',
            description: 'First task',
            steps: [{ prompt: 'Do task 1', done: false }],
          },
        ],
      });

      loadEffectiveConfigSpy.mockResolvedValue({
        models: { execution: 'test-model' },
        postApplyCommands: [],
        updateDocs: { mode: 'never', applyLessons: true },
      });

      runUpdateLessonsSpy.mockResolvedValue(false);

      executorExecuteSpy.mockImplementation(async () => {
        await createPlanFile({
          tasks: [
            {
              title: 'Task 1',
              description: 'First task',
              steps: [{ prompt: 'Do task 1', done: true }],
              done: true,
            },
          ],
        });
      });

      const options = { log: false, nonInteractive: true, finalReview: false } as any;
      const globalCliOptions = {};

      await timAgent(planFile, options, globalCliOptions);

      expect(runUpdateLessonsSpy).toHaveBeenCalledTimes(1);

      const finalContent = await fs.readFile(planFile, 'utf-8');
      const finalPlan = yaml.parse(finalContent.replace(/^#.*\n/, ''));
      expect(finalPlan.lessonsAppliedAt).toBeUndefined();
    });

    test('manual mode skips both docs and lessons', async () => {
      await createPlanFile({
        tasks: [
          {
            title: 'Task 1',
            description: 'First task',
            steps: [{ prompt: 'Do task 1', done: false }],
          },
        ],
      });

      loadEffectiveConfigSpy.mockResolvedValue({
        models: { execution: 'test-model' },
        postApplyCommands: [],
        updateDocs: { mode: 'manual', applyLessons: true },
      });

      executorExecuteSpy.mockImplementation(async () => {
        await createPlanFile({
          tasks: [
            {
              title: 'Task 1',
              description: 'First task',
              steps: [{ prompt: 'Do task 1', done: true }],
              done: true,
            },
          ],
        });
      });

      const options = { log: false, nonInteractive: true, finalReview: false } as any;
      const globalCliOptions = {};

      await timAgent(planFile, options, globalCliOptions);

      expect(runUpdateDocsSpy).not.toHaveBeenCalled();
      expect(runUpdateLessonsSpy).not.toHaveBeenCalled();

      const finalContent = await fs.readFile(planFile, 'utf-8');
      const finalPlan = yaml.parse(finalContent.replace(/^#.*\n/, ''));
      expect(finalPlan.docsUpdatedAt).toBeUndefined();
      expect(finalPlan.lessonsAppliedAt).toBeUndefined();
    });
  });

  describe('integration with existing agent functionality', () => {
    test('batch mode respects no-log option', async () => {
      await createPlanFile({
        tasks: [
          {
            title: 'Task 1',
            description: 'First task',
            steps: [{ prompt: 'Do task 1', done: true }],
            done: true,
          },
        ],
      });

      const options = { log: false, nonInteractive: true } as any;
      const globalCliOptions = {};

      await timAgent(planFile, options, globalCliOptions);

      // Should not have opened log file
      expect(openLogFileSpy).not.toHaveBeenCalled();
    });

    test('batch mode opens and closes log file when logging enabled', async () => {
      await createPlanFile({
        tasks: [
          {
            title: 'Task 1',
            description: 'First task',
            steps: [{ prompt: 'Do task 1', done: true }],
            done: true,
          },
        ],
      });

      const options = {};
      const globalCliOptions = {};

      await timAgent(planFile, options, globalCliOptions);

      // Should have opened and closed log file
      expect(openLogFileSpy).toHaveBeenCalled();
      expect(closeLogFileSpy).toHaveBeenCalled();
    });

    test('batch mode uses correct executor from options', async () => {
      await createPlanFile({
        tasks: [
          {
            title: 'Task 1',
            description: 'First task',
            steps: [{ prompt: 'Do task 1', done: true }],
            done: true,
          },
        ],
      });

      const customExecutor = { execute: vi.fn(), filePathPrefix: '/custom/' };
      buildExecutorAndLogSpy.mockReturnValueOnce(customExecutor);

      const options = { orchestrator: 'custom-executor', log: false } as any;
      const globalCliOptions = {};

      await timAgent(planFile, options, globalCliOptions);

      // Should have built executor with the custom orchestrator name
      expect(buildExecutorAndLogSpy).toHaveBeenCalledWith(
        'custom-executor',
        expect.any(Object),
        expect.any(Object)
      );
    });

    test('batch mode uses correct model from options', async () => {
      await createPlanFile({
        tasks: [
          {
            title: 'Task 1',
            description: 'First task',
            steps: [{ prompt: 'Do task 1', done: true }],
            done: true,
          },
        ],
      });

      const options = { model: 'custom-model', log: false } as any;
      const globalCliOptions = {};

      await timAgent(planFile, options, globalCliOptions);

      // Should have passed custom model to executor options
      expect(buildExecutorAndLogSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          model: 'custom-model',
        }),
        expect.any(Object)
      );
    });
  });

  describe('auto-create PR hook in agent completion', () => {
    // Helper to create a plan that starts in_progress with a pending task. The executor mock
    // completes the task, which triggers batch mode to transition the plan to the completion status.
    // This mirrors a real agent run where the plan starts in_progress and transitions to done/needs_review.
    const pendingTask = {
      title: 'Task 1',
      description: 'A pending task',
      steps: [{ prompt: 'Do the task', done: false }],
    };

    const completedTask = {
      title: 'Task 1',
      description: 'A pending task',
      steps: [{ prompt: 'Do the task', done: true }],
      done: true,
    };

    // Executor mock that marks all tasks done so batch mode transitions the plan to completion status
    function mockExecutorCompletingTasks(branch: string) {
      executorExecuteSpy.mockImplementationOnce(async () => {
        await createPlanFile({
          status: 'in_progress',
          branch,
          tasks: [completedTask],
        });
      });
    }

    // Keep a pre-done task for negative/skip tests that just verify the hook is NOT called.
    // These tests don't need realistic transitions since they only verify skipping behavior.
    const donePlanTask = {
      title: 'Task 1',
      description: 'Already done task',
      done: true,
    };

    test('calls autoCreatePrForPlan after plan transitions from in_progress to done via executor', async () => {
      await createPlanFile({
        status: 'in_progress',
        branch: 'feature/my-branch',
        tasks: [pendingTask],
      });

      loadEffectiveConfigSpy.mockResolvedValue({
        models: { execution: 'test-model' },
        postApplyCommands: [],
        planAutocompleteStatus: 'done',
        prCreation: { autoCreatePr: 'done' },
      });

      mockExecutorCompletingTasks('feature/my-branch');

      const options = { log: false, nonInteractive: true, finalReview: false } as any;
      await timAgent(planFile, options, {});

      expect(autoCreatePrForPlanSpy).toHaveBeenCalledTimes(1);
      expect(autoCreatePrForPlanSpy).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'done', branch: 'feature/my-branch' }),
        planFile,
        expect.objectContaining({ terminalInput: false })
      );
    });

    test('calls autoCreatePrForPlan when config is always and plan transitions to needs_review', async () => {
      await createPlanFile({
        status: 'in_progress',
        branch: 'feature/my-branch',
        tasks: [pendingTask],
      });

      loadEffectiveConfigSpy.mockResolvedValue({
        models: { execution: 'test-model' },
        postApplyCommands: [],
        // planAutocompleteStatus defaults to 'needs_review'
        prCreation: { autoCreatePr: 'always' },
      });

      mockExecutorCompletingTasks('feature/my-branch');

      const options = { log: false, nonInteractive: true, finalReview: false } as any;
      await timAgent(planFile, options, {});

      expect(autoCreatePrForPlanSpy).toHaveBeenCalledTimes(1);
      expect(autoCreatePrForPlanSpy).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'needs_review', branch: 'feature/my-branch' }),
        planFile,
        expect.objectContaining({ terminalInput: false })
      );
    });

    test('calls autoCreatePrForPlan when config is needs_review and plan transitions to needs_review', async () => {
      await createPlanFile({
        status: 'in_progress',
        branch: 'feature/my-branch',
        tasks: [pendingTask],
      });

      loadEffectiveConfigSpy.mockResolvedValue({
        models: { execution: 'test-model' },
        postApplyCommands: [],
        // planAutocompleteStatus defaults to 'needs_review'
        prCreation: { autoCreatePr: 'needs_review' },
      });

      mockExecutorCompletingTasks('feature/my-branch');

      const options = { log: false, nonInteractive: true, finalReview: false } as any;
      await timAgent(planFile, options, {});

      expect(autoCreatePrForPlanSpy).toHaveBeenCalledTimes(1);
    });

    test('does NOT call autoCreatePrForPlan when config is never (default)', async () => {
      await createPlanFile({
        status: 'needs_review',
        branch: 'feature/my-branch',
        tasks: [donePlanTask],
      });

      // Default config — no prCreation.autoCreatePr
      loadEffectiveConfigSpy.mockResolvedValue({
        models: { execution: 'test-model' },
        postApplyCommands: [],
      });

      const options = { log: false, nonInteractive: true, finalReview: false } as any;
      await timAgent(planFile, options, {});

      expect(autoCreatePrForPlanSpy).not.toHaveBeenCalled();
    });

    test('does NOT call autoCreatePrForPlan when config is done but plan status is needs_review', async () => {
      await createPlanFile({
        status: 'needs_review',
        branch: 'feature/my-branch',
        tasks: [donePlanTask],
      });

      loadEffectiveConfigSpy.mockResolvedValue({
        models: { execution: 'test-model' },
        postApplyCommands: [],
        prCreation: { autoCreatePr: 'done' },
      });

      const options = { log: false, nonInteractive: true, finalReview: false } as any;
      await timAgent(planFile, options, {});

      expect(autoCreatePrForPlanSpy).not.toHaveBeenCalled();
    });

    test('does NOT call autoCreatePrForPlan when config is needs_review but plan status is done', async () => {
      await createPlanFile({
        status: 'done',
        branch: 'feature/my-branch',
        tasks: [donePlanTask],
      });

      loadEffectiveConfigSpy.mockResolvedValue({
        models: { execution: 'test-model' },
        postApplyCommands: [],
        prCreation: { autoCreatePr: 'needs_review' },
      });

      const options = { log: false, nonInteractive: true, finalReview: false } as any;
      await timAgent(planFile, options, {});

      expect(autoCreatePrForPlanSpy).not.toHaveBeenCalled();
    });

    test('auto-create failure is non-fatal — agent completes and warn is called', async () => {
      await createPlanFile({
        status: 'in_progress',
        branch: 'feature/my-branch',
        tasks: [pendingTask],
      });

      loadEffectiveConfigSpy.mockResolvedValue({
        models: { execution: 'test-model' },
        postApplyCommands: [],
        // planAutocompleteStatus defaults to 'needs_review', always matches it
        prCreation: { autoCreatePr: 'always' },
      });

      mockExecutorCompletingTasks('feature/my-branch');
      autoCreatePrForPlanSpy.mockRejectedValueOnce(new Error('gh: command not found'));

      const options = { log: false, nonInteractive: true, finalReview: false } as any;

      // Should not throw — failure is non-fatal
      await timAgent(planFile, options, {});

      expect(autoCreatePrForPlanSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to auto-create PR'));
    });

    test('does NOT call autoCreatePrForPlan when isShuttingDown is true during execution', async () => {
      await createPlanFile({
        status: 'in_progress',
        branch: 'feature/my-branch',
        tasks: [pendingTask],
      });

      loadEffectiveConfigSpy.mockResolvedValue({
        models: { execution: 'test-model' },
        postApplyCommands: [],
        prCreation: { autoCreatePr: 'always' },
      });

      // Executor triggers shutdown instead of completing tasks
      executorExecuteSpy.mockImplementationOnce(async () => {
        setShuttingDown(130);
      });

      const originalExit = process.exit;
      process.exit = ((code?: number) => {
        throw new Error(`process.exit(${code})`);
      }) as typeof process.exit;

      try {
        await expect(
          timAgent(planFile, { log: false, nonInteractive: true, finalReview: false } as any, {})
        ).rejects.toThrow('process.exit(130)');
      } finally {
        process.exit = originalExit;
      }

      expect(autoCreatePrForPlanSpy).not.toHaveBeenCalled();
    });

    test('does NOT call autoCreatePrForPlan when executor threw an error', async () => {
      await createPlanFile({
        status: 'in_progress',
        branch: 'feature/my-branch',
        tasks: [pendingTask],
      });

      loadEffectiveConfigSpy.mockResolvedValue({
        models: { execution: 'test-model' },
        postApplyCommands: [],
        prCreation: { autoCreatePr: 'always' },
      });

      // Executor throws an error — executionError is set, auto-create is skipped
      executorExecuteSpy.mockRejectedValueOnce(new Error('Executor crashed'));

      const options = { log: false, nonInteractive: true, finalReview: false } as any;
      await expect(timAgent(planFile, options, {})).rejects.toThrow();

      expect(autoCreatePrForPlanSpy).not.toHaveBeenCalled();
    });
  });
});
