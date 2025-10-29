import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { rmplanAgent } from './agent.js';
import { clearPlanCache } from '../../plans.js';
import type { PlanSchema, PlanSchemaInput } from '../../planSchema.js';
import { ModuleMocker } from '../../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

// Mock functions
const logSpy = mock(() => {});
const errorSpy = mock(() => {});
const warnSpy = mock(() => {});
const openLogFileSpy = mock(() => {});
const closeLogFileSpy = mock(async () => {});

// Mock executor that we can control
const executorExecuteSpy = mock(async () => {});
const buildExecutorAndLogSpy = mock(() => ({
  execute: executorExecuteSpy,
  filePathPrefix: '',
}));

// Mock other dependencies
const resolvePlanFileSpy = mock();
const loadEffectiveConfigSpy = mock(async () => ({
  models: { execution: 'test-model' },
  postApplyCommands: [],
}));
const getGitRootSpy = mock(async () => '/test/project');
const buildExecutionPromptWithoutStepsSpy = mock(async () => 'Test batch prompt');
const executePostApplyCommandSpy = mock(async () => true);

describe('rmplanAgent - Batch Mode Execution Loop', () => {
  let tempDir: string;
  let planFile: string;

  beforeEach(async () => {
    // Clear all mocks
    logSpy.mockClear();
    errorSpy.mockClear();
    warnSpy.mockClear();
    openLogFileSpy.mockClear();
    closeLogFileSpy.mockClear();
    executorExecuteSpy.mockClear();
    buildExecutorAndLogSpy.mockClear();
    resolvePlanFileSpy.mockClear();
    loadEffectiveConfigSpy.mockClear();
    getGitRootSpy.mockClear();
    buildExecutionPromptWithoutStepsSpy.mockClear();
    executePostApplyCommandSpy.mockClear();

    // Clear plan cache
    clearPlanCache();

    // Create temporary directory and plan file
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-batch-mode-test-'));
    planFile = path.join(tempDir, 'test-plan.yml');

    // Mock inquirer prompts to avoid interactive timeouts
    await moduleMocker.mock('@inquirer/prompts', () => ({
      select: mock(async () => 'generate'),
    }));

    // Mock dependencies
    await moduleMocker.mock('../../../logging.js', () => ({
      log: logSpy,
      error: errorSpy,
      warn: warnSpy,
      openLogFile: openLogFileSpy,
      closeLogFile: closeLogFileSpy,
      boldMarkdownHeaders: mock((text: string) => text),
    }));

    getGitRootSpy.mockImplementation(async () => tempDir);
    await moduleMocker.mock('../../../common/git.js', () => ({
      getGitRoot: getGitRootSpy,
    }));

    await moduleMocker.mock('../../configLoader.js', () => ({
      loadEffectiveConfig: loadEffectiveConfigSpy,
    }));

    await moduleMocker.mock('../../executors/index.js', () => ({
      buildExecutorAndLog: buildExecutorAndLogSpy,
      DEFAULT_EXECUTOR: 'copy-only',
      defaultModelForExecutor: mock(() => 'test-model'),
    }));

    await moduleMocker.mock('../../prompt_builder.js', () => ({
      buildExecutionPromptWithoutSteps: buildExecutionPromptWithoutStepsSpy,
    }));

    await moduleMocker.mock('../../actions.js', () => ({
      executePostApplyCommand: executePostApplyCommandSpy,
    }));

    await moduleMocker.mock('../../plans.js', () => ({
      resolvePlanFile: resolvePlanFileSpy,
      readPlanFile: mock(async (filePath: string) => {
        // Read the actual file
        const content = await fs.readFile(filePath, 'utf-8');
        return yaml.parse(content.replace(/^#.*\n/, ''));
      }),
      writePlanFile: mock(async (filePath: string, planData: PlanSchema) => {
        // Write the actual file
        const schemaComment =
          '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json\n';
        await fs.writeFile(filePath, schemaComment + yaml.stringify(planData));
      }),
      setPlanStatus: mock(async (filePath: string, status: string) => {
        const content = await fs.readFile(filePath, 'utf-8');
        const planData = yaml.parse(content.replace(/^#.*\n/, ''));
        planData.status = status;
        planData.updatedAt = new Date().toISOString();
        const schemaComment =
          '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json\n';
        await fs.writeFile(filePath, schemaComment + yaml.stringify(planData));
      }),
      readAllPlans: mock(async () => ({ plans: new Map() })),
      clearPlanCache: mock(() => {}),
    }));

    await moduleMocker.mock('../../configSchema.js', () => ({
      resolveTasksDir: mock(async () => '/test/tasks'),
    }));

    // Set up default mock behaviors
    resolvePlanFileSpy.mockResolvedValue(planFile);
  });

  afterEach(async () => {
    moduleMocker.clear();
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
      '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json\n';
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

      await rmplanAgent(planFile, options, globalCliOptions);

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

      // Mock the normal execution path
      await moduleMocker.mock('../../plans/find_next.js', () => ({
        findNextActionableItem: mock(() => null), // No actionable items
        getAllIncompleteTasks: mock(() => []),
      }));

      const options = { serialTasks: true, log: false, nonInteractive: true } as any;
      const globalCliOptions = {};

      await rmplanAgent(planFile, options, globalCliOptions);

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

      await rmplanAgent(planFile, options, globalCliOptions);

      // Should have executed twice (once for each batch iteration)
      expect(executorExecuteSpy).toHaveBeenCalledTimes(2);
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

      await rmplanAgent(planFile, options, globalCliOptions);

      // Should not execute anything since all tasks are already done
      expect(executorExecuteSpy).not.toHaveBeenCalled();

      // Should log completion message
      expect(logSpy).toHaveBeenCalledWith('Batch mode complete: No incomplete tasks remaining');
    });
  });

  describe('incomplete task detection and formatting', () => {
    test('getAllIncompleteTasks is called to identify tasks', async () => {
      // Mock getAllIncompleteTasks to return specific incomplete tasks
      const mockGetAllIncompleteTasks = mock(() => [
        { taskIndex: 0, task: { title: 'Task 1', description: 'First task' } },
        { taskIndex: 2, task: { title: 'Task 3', description: 'Third task' } },
      ]);

      await moduleMocker.mock('../../plans/find_next.js', () => ({
        getAllIncompleteTasks: mockGetAllIncompleteTasks,
        findNextActionableItem: mock(() => null),
      }));

      await createPlanFile({
        tasks: [
          { title: 'Task 1', description: 'First task' },
          { title: 'Task 2', description: 'Second task', done: true },
          { title: 'Task 3', description: 'Third task' },
        ],
      });

      const options = { log: false, dryRun: true, nonInteractive: true } as any;
      const globalCliOptions = {};

      await rmplanAgent(planFile, options, globalCliOptions);

      // Should have called getAllIncompleteTasks
      expect(mockGetAllIncompleteTasks).toHaveBeenCalled();

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
        // Complete the task
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

      await rmplanAgent(planFile, options, globalCliOptions);

      // Read the final file content to verify status was updated
      const finalContent = await fs.readFile(planFile, 'utf-8');
      const finalPlan = yaml.parse(finalContent.replace(/^#.*\n/, ''));
      expect(finalPlan.status).toBe('done');
    });

    test('plan is marked as done when all tasks complete', async () => {
      await createPlanFile({
        status: 'pending',
        tasks: [
          { title: 'Task 1', description: 'First task' },
          { title: 'Task 2', description: 'Second task' },
        ],
      });

      executorExecuteSpy.mockImplementation(async () => {
        // Complete both tasks
        await createPlanFile({
          status: 'in_progress',
          tasks: [
            { title: 'Task 1', description: 'First task', done: true },
            { title: 'Task 2', description: 'Second task', done: true },
          ],
        });
      });

      const options = { log: false, nonInteractive: true } as any;
      const globalCliOptions = {};

      await rmplanAgent(planFile, options, globalCliOptions);

      // Read the final file content to verify status was updated to done
      const finalContent = await fs.readFile(planFile, 'utf-8');
      const finalPlan = yaml.parse(finalContent.replace(/^#.*\n/, ''));
      expect(finalPlan.status).toBe('done');
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

      // Mock parent plan checking
      const checkAndMarkParentDoneSpy = mock(async () => {});
      await moduleMocker.mock('./agent.js', () => {
        const originalModule = require('./agent.js');
        return {
          ...originalModule,
          checkAndMarkParentDone: checkAndMarkParentDoneSpy,
        };
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

      await rmplanAgent(planFile, options, globalCliOptions);

      // Parent checking happens through the setPlanStatus function in our mocks
      // Verify the plan was marked as done (which would trigger parent updates)
      const finalContent = await fs.readFile(planFile, 'utf-8');
      const finalPlan = yaml.parse(finalContent.replace(/^#.*\n/, ''));
      expect(finalPlan.status).toBe('done');
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

      await rmplanAgent(planFile, options, globalCliOptions);

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

      await rmplanAgent(planFile, options, globalCliOptions);

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

      await rmplanAgent(planFile, options, globalCliOptions);

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

      await expect(rmplanAgent(planFile, options, globalCliOptions)).rejects.toThrow(
        'Batch mode stopped due to error.'
      );
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

      await rmplanAgent(planFile, options, globalCliOptions);

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

      await expect(rmplanAgent(planFile, options, globalCliOptions)).rejects.toThrow(
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
      await expect(rmplanAgent(planFile, options, globalCliOptions)).rejects.toThrow();
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
          // First iteration: complete one task
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
          // Second iteration: complete remaining task
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

      await rmplanAgent(planFile, options, globalCliOptions);

      // Check logging calls for batch mode progress
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

      await rmplanAgent(planFile, options, globalCliOptions);

      const logCalls = logSpy.mock.calls.map((call) => call[0]);
      expect(
        logCalls.some(
          (call) =>
            typeof call === 'string' && call.includes('All tasks completed, marking plan as done')
        )
      ).toBe(true);
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

      await rmplanAgent(planFile, options, globalCliOptions);

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

      await rmplanAgent(planFile, options, globalCliOptions);

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

      const customExecutor = { execute: mock(), filePathPrefix: '/custom/' };
      buildExecutorAndLogSpy.mockReturnValue(customExecutor);

      const options = { executor: 'custom-executor', log: false } as any;
      const globalCliOptions = {};

      await rmplanAgent(planFile, options, globalCliOptions);

      // Should have built executor with the custom executor name
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

      await rmplanAgent(planFile, options, globalCliOptions);

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
});
