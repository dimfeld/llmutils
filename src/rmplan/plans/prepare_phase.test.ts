import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { preparePhase } from './prepare_phase.js';
import { clearPlanCache, readPlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { ModuleMocker } from '../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

// Mock console functions
const logSpy = mock(() => {});
const errorSpy = mock(() => {});
const warnSpy = mock(() => {});

// Mock invokeClaudeCodeForGeneration
const invokeClaudeCodeForGenerationSpy = mock(async () => {
  // Return predefined YAML with tasks containing files and steps
  return `tasks:
  - title: "Task 1"
    description: "Task 1 description"
    files:
      - "src/file1.ts"
      - "src/file2.ts"
    steps:
      - prompt: "Step 1 for Task 1"
        done: false
      - prompt: "Step 2 for Task 1"
        done: false
  - title: "Task 2"
    description: "Task 2 description"
    files:
      - "src/file3.ts"
    steps:
      - prompt: "Step 1 for Task 2"
        done: false`;
});

// Mock runRmfilterProgrammatically
const runRmfilterProgrammaticallySpy = mock(async () => 'rmfilter output');

// Mock getGitRoot
const getGitRootSpy = mock(async () => '/mock/git/root');

// Mock model factory
const createModelSpy = mock(async () => ({ id: 'test-model' }));

describe('preparePhase with Claude option', () => {
  let tempDir: string;
  let tasksDir: string;
  let planFilePath: string;

  beforeEach(async () => {
    // Clear mocks
    logSpy.mockClear();
    errorSpy.mockClear();
    warnSpy.mockClear();
    invokeClaudeCodeForGenerationSpy.mockClear();
    runRmfilterProgrammaticallySpy.mockClear();
    getGitRootSpy.mockClear();
    createModelSpy.mockClear();

    // Clear plan cache
    clearPlanCache();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-prepare-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Mock modules
    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
      error: errorSpy,
      warn: warnSpy,
    }));

    await moduleMocker.mock('../claude_utils.js', () => ({
      invokeClaudeCodeForGeneration: invokeClaudeCodeForGenerationSpy,
    }));

    await moduleMocker.mock('../../rmfilter/rmfilter.js', () => ({
      runRmfilterProgrammatically: runRmfilterProgrammaticallySpy,
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: getGitRootSpy,
    }));

    await moduleMocker.mock('../../common/model_factory.js', () => ({
      createModel: createModelSpy,
    }));
  });

  afterEach(async () => {
    moduleMocker.clear();
    // Clean up temporary directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('preparePhase with claude: true option updates plan with generated files and steps', async () => {
    // Create a temporary plan file with tasks that only have titles and descriptions
    const planData: PlanSchema = {
      id: 1,
      title: 'Test Phase',
      goal: 'Test the prepare phase functionality',
      details: 'This is a test phase',
      status: 'pending',
      tasks: [
        {
          title: 'Task 1',
          description: 'Task 1 description',
          files: [],
          steps: [],
        },
        {
          title: 'Task 2',
          description: 'Task 2 description',
          files: [],
          steps: [],
        },
      ],
    };

    planFilePath = path.join(tasksDir, 'test-phase.yaml');
    await fs.writeFile(planFilePath, yaml.stringify(planData));

    // Create a mock config
    const mockConfig = {
      models: {
        stepGeneration: 'test-model',
      },
    };

    // Call preparePhase with claude: true
    await preparePhase(planFilePath, mockConfig as any, {
      claude: true,
    });

    // Read the updated plan file using readPlanFile which handles front matter format
    const updatedPlan = await readPlanFile(planFilePath);

    // Assert that invokeClaudeCodeForGeneration was called
    expect(invokeClaudeCodeForGenerationSpy).toHaveBeenCalledTimes(1);
    const claudeCall = invokeClaudeCodeForGenerationSpy.mock.calls[0] as any;
    // Now we expect 3 arguments: planningPrompt, generationPrompt, options
    expect(claudeCall).toHaveLength(3);
    expect(claudeCall[0]).toContain('Phase Implementation Analysis'); // Planning prompt
    expect(claudeCall[1]).toContain('YAML'); // Generation prompt
    expect(claudeCall[2]).toEqual({
      model: 'test-model',
      includeDefaultTools: true,
    });

    // Assert that the tasks have been updated with files and steps
    expect(updatedPlan.tasks).toHaveLength(2);

    // Check Task 1
    expect(updatedPlan.tasks[0].title).toBe('Task 1');
    expect(updatedPlan.tasks[0].description).toBe('Task 1 description');
    expect(updatedPlan.tasks[0].files).toEqual(['src/file1.ts', 'src/file2.ts']);
    expect(updatedPlan.tasks[0].steps).toHaveLength(2);
    expect(updatedPlan.tasks[0].steps[0]).toEqual({
      prompt: 'Step 1 for Task 1',
      done: false,
    });
    expect(updatedPlan.tasks[0].steps[1]).toEqual({
      prompt: 'Step 2 for Task 1',
      done: false,
    });

    // Check Task 2
    expect(updatedPlan.tasks[1].title).toBe('Task 2');
    expect(updatedPlan.tasks[1].description).toBe('Task 2 description');
    expect(updatedPlan.tasks[1].files).toEqual(['src/file3.ts']);
    expect(updatedPlan.tasks[1].steps).toHaveLength(1);
    expect(updatedPlan.tasks[1].steps[0]).toEqual({
      prompt: 'Step 1 for Task 2',
      done: false,
    });

    // Check that timestamps were updated
    expect(updatedPlan.promptsGeneratedAt).toBeDefined();
    expect(updatedPlan.updatedAt).toBeDefined();

    // Other plan properties should remain unchanged
    expect(updatedPlan.id).toBe(1);
    expect(updatedPlan.title).toBe('Test Phase');
    expect(updatedPlan.goal).toBe('Test the prepare phase functionality');
    expect(updatedPlan.details).toBe('This is a test phase');
    expect(updatedPlan.status).toBe('pending');
  });

  test('preparePhase with claude: true uses custom model when provided', async () => {
    // Create a temporary plan file
    const planData: PlanSchema = {
      id: 2,
      title: 'Test Phase with Custom Model',
      goal: 'Test custom model option',
      status: 'pending',
      tasks: [
        {
          title: 'Task A',
          description: 'Task A description',
          files: [],
          steps: [],
        },
      ],
    };

    planFilePath = path.join(tasksDir, 'test-phase-custom-model.yaml');
    await fs.writeFile(planFilePath, yaml.stringify(planData));

    // Create a mock config
    const mockConfig = {
      models: {
        stepGeneration: 'default-model',
      },
    };

    // Call preparePhase with claude: true and custom model
    await preparePhase(planFilePath, mockConfig as any, {
      claude: true,
      model: 'custom-model',
    });

    // Assert that invokeClaudeCodeForGeneration was called with custom model
    expect(invokeClaudeCodeForGenerationSpy).toHaveBeenCalledTimes(1);
    const claudeCall = invokeClaudeCodeForGenerationSpy.mock.calls[0] as any;
    expect(claudeCall[2].model).toBe('custom-model');
  });
});
