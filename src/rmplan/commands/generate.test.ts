import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { handleGenerateCommand } from './generate.js';
import { clearPlanCache } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import { ModuleMocker } from '../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

// Mock console functions
const logSpy = mock(() => {});
const errorSpy = mock(() => {});

// Mock logSpawn for rmfilter and other commands
const logSpawnSpy = mock(() => ({ exited: Promise.resolve(0) }));

// Mock clipboard
const clipboardWriteSpy = mock(async () => {});
const clipboardReadSpy = mock(async () => 'clipboard content');

// Mock LLM prompt
const runStreamingPromptSpy = mock(async () => ({ text: 'Generated plan content' }));

// Mock terminal functions
const waitForEnterSpy = mock(
  async () => `
id: test-plan-001
title: Test Plan
goal: Test goal
details: Test details
status: pending
createdAt: 2024-01-01T00:00:00Z
updatedAt: 2024-01-01T00:00:00Z
tasks:
  - id: task-1
    title: Test Task
    description: Task description
    status: pending
`
);

describe('handleGenerateCommand', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    // Clear mocks
    logSpy.mockClear();
    errorSpy.mockClear();
    logSpawnSpy.mockClear();
    clipboardWriteSpy.mockClear();
    clipboardReadSpy.mockClear();
    runStreamingPromptSpy.mockClear();
    waitForEnterSpy.mockClear();

    // Clear plan cache
    clearPlanCache();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-generate-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Mock modules
    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
      error: errorSpy,
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/clipboard.js', () => ({
      write: clipboardWriteSpy,
      read: clipboardReadSpy,
    }));

    await moduleMocker.mock('../../common/run_and_apply.js', () => ({
      runStreamingPrompt: runStreamingPromptSpy,
    }));

    await moduleMocker.mock('ai', () => ({
      generateText: async () => ({ text: 'editor-test-plan' }),
    }));

    await moduleMocker.mock('@inquirer/prompts', () => ({
      input: async (config: any) => {
        // Return the default value provided
        return config.default || '';
      },
    }));

    await moduleMocker.mock('../../common/terminal.js', () => ({
      waitForEnter: waitForEnterSpy,
    }));

    await moduleMocker.mock('../process_markdown.ts', () => ({
      extractMarkdownToYaml: mock(async () => {}),
    }));

    // Mock config loader
    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: {
          tasks: tasksDir,
        },
        models: {
          planning: 'test-model',
        },
      }),
    }));

    // Mock utils
    await moduleMocker.mock('../../rmfilter/utils.js', () => ({
      getGitRoot: async () => tempDir,
      setDebug: () => {},
      logSpawn: logSpawnSpy,
    }));

    // Mock model factory
    await moduleMocker.mock('../../common/model_factory.js', () => ({
      getModel: () => 'test-model',
      createModel: () => ({
        // Mock model for generateText
      }),
    }));
  });

  afterEach(async () => {
    // Clean up mocks
    moduleMocker.clear();

    // Clean up
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('generates planning prompt with plan file', async () => {
    // Create a test plan file
    const planPath = path.join(tempDir, 'test-plan.md');
    await fs.writeFile(planPath, '# Test Plan\n\nThis is a test plan.');

    const options = {
      plan: planPath,
      extract: false, // Disable extract to avoid YAML parsing
      parent: {
        opts: () => ({}),
      },
    };

    const command = {
      args: ['src/**/*.ts'],
      parent: {
        opts: () => ({}),
      },
    };

    // Update process.argv to include the files
    const originalArgv = process.argv;
    process.argv = [...process.argv, '--', 'src/**/*.ts'];

    await handleGenerateCommand(undefined, options, command);

    // Restore process.argv
    process.argv = originalArgv;

    // rmfilter handles clipboard internally with --copy flag

    // Should run rmfilter through logSpawn
    expect(logSpawnSpy).toHaveBeenCalled();
    expect(logSpawnSpy).toHaveBeenCalledWith(
      expect.arrayContaining(['rmfilter']),
      expect.any(Object)
    );

    // Should NOT wait for enter since extract is false
    expect(waitForEnterSpy).not.toHaveBeenCalled();
  });

  test('generates simple plan when --simple flag is used', async () => {
    const planPath = path.join(tempDir, 'simple-plan.md');
    await fs.writeFile(planPath, '# Simple Plan\n\nA simple task.');

    const options = {
      plan: planPath,
      simple: true,
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

    await handleGenerateCommand(undefined, options, command);

    // Should write simple planning prompt to clipboard
    expect(clipboardWriteSpy).toHaveBeenCalled();
    const clipboardContent = clipboardWriteSpy.mock.calls[0][0];
    expect(clipboardContent).toContain('series of prompts');
  });

  test('uses autofind when --autofind flag is used', async () => {
    const planPath = path.join(tempDir, 'autofind-plan.md');
    await fs.writeFile(planPath, '# Autofind Plan\n\nFind relevant files.');

    // Mock findFilesCore
    const findFilesCoreSpyLocal = mock(async () => ({
      files: [path.join(tempDir, 'src/file1.ts'), path.join(tempDir, 'src/file2.ts')],
    }));
    await moduleMocker.mock('../../rmfind/core.js', () => ({
      findFilesCore: findFilesCoreSpyLocal,
    }));

    const options = {
      plan: planPath,
      autofind: true,
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

    await handleGenerateCommand(undefined, options, command);

    // Should have called findFilesCore
    expect(findFilesCoreSpyLocal).toHaveBeenCalled();

    // Should use the found files in rmfilter command
    expect(logSpawnSpy).toHaveBeenCalledWith(
      expect.arrayContaining(['src/file1.ts', 'src/file2.ts']),
      expect.any(Object)
    );
  });

  test('opens plan in editor when --plan-editor flag is used', async () => {
    // Mock Bun.file to return plan content when reading from temp file
    const originalBunFile = Bun.file;
    const mockText = mock(async () => '# Test Plan\n\nThis is a test plan from editor.');
    const mockUnlink = mock(async () => {});

    // @ts-ignore
    Bun.file = mock((path: string) => {
      if (path.includes('rmplan-editor-')) {
        return {
          text: mockText,
          unlink: mockUnlink,
        };
      }
      // Fall back to original for other files
      return originalBunFile(path);
    });

    // Mock editor spawn
    const editorProcess = {
      exited: Promise.resolve(0),
    };

    // Update logSpawnSpy to return our editor process
    logSpawnSpy.mockImplementation(() => editorProcess);

    const options = {
      planEditor: true,
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

    // Set EDITOR environment variable
    process.env.EDITOR = 'test-editor';

    await handleGenerateCommand(undefined, options, command);

    // Should have written plan to clipboard
    expect(clipboardWriteSpy).toHaveBeenCalledWith(expect.stringContaining('Test Plan'));

    // Restore Bun.file
    // @ts-ignore
    Bun.file = originalBunFile;
  });

  test('runs extract command after generation by default', async () => {
    const planPath = path.join(tempDir, 'extract-plan.md');
    await fs.writeFile(planPath, '# Extract Plan\n\nPlan content.');

    // Mock the clipboard to return valid YAML for extract
    clipboardReadSpy.mockResolvedValue(`# Title
Test Plan

## Goal
Test goal

## Priority
medium

## Details
Test details

## Phase 1: Test Phase

### Goal
Phase goal

### Priority
medium

### Dependencies
None

### Details
Phase details

### Tasks

#### Task 1: Test Task

Task description`);

    const options = {
      plan: planPath,
      extract: true, // Default is true
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

    await handleGenerateCommand(undefined, options, command);

    // Should wait for enter for extract
    expect(waitForEnterSpy).toHaveBeenCalled();
  });

  test('commits changes when --commit flag is used', async () => {
    const planPath = path.join(tempDir, 'commit-plan.md');
    await fs.writeFile(planPath, '# Commit Plan\n\nPlan content.');

    const options = {
      plan: planPath,
      commit: true,
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

    await handleGenerateCommand(undefined, options, command);

    // Should NOT have called commit since extract is false
    expect(logSpawnSpy).not.toHaveBeenCalledWith(
      expect.arrayContaining(['jj', 'commit']),
      expect.any(Object)
    );
  });

  test('handles missing plan gracefully', async () => {
    const options = {
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

    await expect(handleGenerateCommand(undefined, options, command)).rejects.toThrow(
      'You must provide one and only one of [plan], --plan <plan>, --plan-editor, --issue <url|number>, or --next-ready <planIdOrPath>'
    );
  });

  test('uses quiet mode when --quiet flag is set', async () => {
    const planPath = path.join(tempDir, 'quiet-plan.md');
    await fs.writeFile(planPath, '# Quiet Plan\n\nPlan content.');

    const options = {
      plan: planPath,
      quiet: true,
      extract: false,
      parent: {
        opts: () => ({}),
      },
    };

    const command = {
      args: ['--', 'src/**/*.ts'], // Add files so rmfilter runs
      parent: {
        opts: () => ({}),
      },
    };

    // Update process.argv to include the files
    const originalArgv = process.argv;
    process.argv = [...process.argv, '--', 'src/**/*.ts'];

    await handleGenerateCommand(undefined, options, command);

    // Restore process.argv
    process.argv = originalArgv;

    // Should run rmfilter command
    expect(logSpawnSpy).toHaveBeenCalledWith(
      expect.arrayContaining(['rmfilter']),
      expect.any(Object)
    );
  });
});

describe('handleGenerateCommand with --next-ready flag', () => {
  let tempDir: string;
  let tasksDir: string;

  // Mock functions
  const logSpy = mock(() => {});
  const errorSpy = mock(() => {});
  const warnSpy = mock(() => {});
  const findNextReadyDependencySpy = mock(async () => ({
    plan: null,
    message: 'No ready dependencies found',
  }));
  const resolvePlanFileSpy = mock(async () => '/mock/plan/path.plan.md');
  const readPlanFileSpy = mock(async () => ({ id: 123, title: 'Mock Plan' }));

  beforeEach(async () => {
    // Clear mocks
    logSpy.mockClear();
    errorSpy.mockClear();
    warnSpy.mockClear();
    findNextReadyDependencySpy.mockClear();
    resolvePlanFileSpy.mockClear();
    readPlanFileSpy.mockClear();

    // Clear plan cache
    clearPlanCache();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-generate-nextready-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Mock modules
    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
      error: errorSpy,
      warn: warnSpy,
    }));

    await moduleMocker.mock('./find_next_dependency.js', () => ({
      findNextReadyDependency: findNextReadyDependencySpy,
    }));

    await moduleMocker.mock('../plans.js', () => ({
      ...require('../plans.js'),
      resolvePlanFile: resolvePlanFileSpy,
      readPlanFile: readPlanFileSpy,
      clearPlanCache: mock(() => {}),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: {
          tasks: tasksDir,
        },
        models: {
          planning: 'test-model',
        },
      }),
    }));

    await moduleMocker.mock('../configSchema.ts', () => ({
      resolveTasksDir: async () => tasksDir,
    }));

    // Mock git
    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => tempDir,
    }));
  });

  afterEach(async () => {
    // Clean up mocks
    moduleMocker.clear();

    // Clean up temp directory if it exists
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  test('successfully finds and operates on a ready dependency with numeric ID', async () => {
    // Mock findNextReadyDependency to return a ready plan
    const readyPlan: PlanSchema & { filename: string } = {
      id: 456,
      title: 'Ready Dependency Plan',
      goal: 'Test dependency goal',
      details: 'Test dependency details',
      status: 'pending',
      priority: 'medium',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      tasks: [],
      filename: '456-ready-dependency-plan.plan.md',
    };

    findNextReadyDependencySpy.mockResolvedValueOnce({
      plan: readyPlan,
      message: 'Found ready plan: Ready Dependency Plan (ID: 456)',
    });

    const options = {
      nextReady: '123', // Parent plan ID
      extract: false,
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleGenerateCommand(undefined, options, command);

    // Should call findNextReadyDependency with the parent plan ID and includeEmptyPlans=true
    expect(findNextReadyDependencySpy).toHaveBeenCalledWith(123, tasksDir, true);

    // Should log the success message
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Found ready dependency: 456 - Ready Dependency Plan')
    );

    // Should have set options.plan to the found plan's filename
    expect(options.plan).toBe('456-ready-dependency-plan.plan.md');
  });

  test('successfully finds and operates on a ready dependency with file path', async () => {
    const parentPlanPath = '/mock/parent/plan.plan.md';

    // Mock the plan file resolution and reading
    resolvePlanFileSpy.mockResolvedValueOnce(parentPlanPath);
    readPlanFileSpy.mockResolvedValueOnce({
      id: 123,
      title: 'Parent Plan',
      goal: 'Parent goal',
      details: 'Parent details',
      status: 'in_progress',
      priority: 'high',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      tasks: [],
    });

    // Mock findNextReadyDependency to return a ready plan
    const readyPlan: PlanSchema & { filename: string } = {
      id: 456,
      title: 'Ready Dependency Plan',
      goal: 'Test dependency goal',
      details: 'Test dependency details',
      status: 'pending',
      priority: 'medium',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      tasks: [],
      filename: '456-ready-dependency-plan.plan.md',
    };

    findNextReadyDependencySpy.mockResolvedValueOnce({
      plan: readyPlan,
      message: 'Found ready plan: Ready Dependency Plan (ID: 456)',
    });

    const options = {
      nextReady: parentPlanPath, // Parent plan file path
      extract: false,
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleGenerateCommand(undefined, options, command);

    // Should resolve the plan file
    expect(resolvePlanFileSpy).toHaveBeenCalledWith(parentPlanPath, undefined);

    // Should read the plan to get its ID
    expect(readPlanFileSpy).toHaveBeenCalledWith(parentPlanPath);

    // Should call findNextReadyDependency with the parent plan ID (extracted from file)
    expect(findNextReadyDependencySpy).toHaveBeenCalledWith(123, tasksDir, true);

    // Should log the success message
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('Found ready dependency: 456 - Ready Dependency Plan')
    );

    // Should have set options.plan to the found plan's filename
    expect(options.plan).toBe('456-ready-dependency-plan.plan.md');
  });

  test('handles case when no ready dependencies exist', async () => {
    // Mock findNextReadyDependency to return no plan
    findNextReadyDependencySpy.mockResolvedValueOnce({
      plan: null,
      message: 'No ready or pending dependencies found',
    });

    const options = {
      nextReady: '123', // Parent plan ID
      extract: false,
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleGenerateCommand(undefined, options, command);

    // Should call findNextReadyDependency
    expect(findNextReadyDependencySpy).toHaveBeenCalledWith(123, tasksDir, true);

    // Should log the no dependencies message
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('No ready or pending dependencies found')
    );
  });

  test('handles invalid parent plan ID', async () => {
    // Mock findNextReadyDependency to return plan not found
    findNextReadyDependencySpy.mockResolvedValueOnce({
      plan: null,
      message: 'Plan not found: 999',
    });

    const options = {
      nextReady: '999', // Invalid parent plan ID
      extract: false,
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleGenerateCommand(undefined, options, command);

    // Should call findNextReadyDependency
    expect(findNextReadyDependencySpy).toHaveBeenCalledWith(999, tasksDir, true);

    // Should log the plan not found message
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Plan not found: 999'));
  });

  test('handles parent plan file without valid ID', async () => {
    const invalidPlanPath = '/mock/invalid/plan.plan.md';

    // Mock the plan file resolution and reading to return a plan without ID
    resolvePlanFileSpy.mockResolvedValueOnce(invalidPlanPath);
    readPlanFileSpy.mockResolvedValueOnce({
      title: 'Parent Plan Without ID',
      goal: 'Parent goal',
      details: 'Parent details',
      status: 'in_progress',
      priority: 'high',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      tasks: [],
      // No id field
    });

    const options = {
      nextReady: invalidPlanPath,
      extract: false,
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    // Should throw an error about missing plan ID
    await expect(handleGenerateCommand(undefined, options, command)).rejects.toThrow(
      'does not have a valid ID'
    );
  });
});

describe('handleGenerateCommand with --claude flag', () => {
  let tempDir: string;
  let tasksDir: string;

  // Mock functions
  const logSpy = mock(() => {});
  const errorSpy = mock(() => {});
  const logSpawnSpy = mock(() => ({ exited: Promise.resolve(0) }));
  const clipboardWriteSpy = mock(async () => {});
  const clipboardReadSpy = mock(async () => 'clipboard content');
  const waitForEnterSpy = mock(async () => 'enter pressed');
  const invokeClaudeCodeForGenerationSpy = mock(async () => 'Generated YAML content');
  const extractMarkdownToYamlSpy = mock(async () => {});

  beforeEach(async () => {
    // Clear mocks
    logSpy.mockClear();
    errorSpy.mockClear();
    logSpawnSpy.mockClear();
    clipboardWriteSpy.mockClear();
    clipboardReadSpy.mockClear();
    waitForEnterSpy.mockClear();
    invokeClaudeCodeForGenerationSpy.mockClear();
    extractMarkdownToYamlSpy.mockClear();

    // Clear plan cache
    clearPlanCache();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-generate-claude-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Mock modules
    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
      error: errorSpy,
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/clipboard.js', () => ({
      write: clipboardWriteSpy,
      read: clipboardReadSpy,
    }));

    await moduleMocker.mock('../../common/terminal.js', () => ({
      waitForEnter: waitForEnterSpy,
    }));

    await moduleMocker.mock('../claude_utils.js', () => ({
      invokeClaudeCodeForGeneration: invokeClaudeCodeForGenerationSpy,
    }));

    await moduleMocker.mock('../process_markdown.ts', () => ({
      extractMarkdownToYaml: extractMarkdownToYamlSpy,
    }));

    // Mock config loader
    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: {
          tasks: tasksDir,
        },
        models: {
          planning: 'test-model',
        },
      }),
    }));

    // Mock utils
    await moduleMocker.mock('../../rmfilter/utils.js', () => ({
      getGitRoot: async () => tempDir,
      setDebug: () => {},
      logSpawn: logSpawnSpy,
    }));

    // Mock process for logSpawn
    await moduleMocker.mock('../../common/process.js', () => ({
      logSpawn: logSpawnSpy,
    }));

    // Mock git
    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => tempDir,
    }));

    // Mock model factory
    await moduleMocker.mock('../../common/model_factory.js', () => ({
      getModel: () => 'test-model',
      createModel: () => ({}),
    }));
  });

  afterEach(async () => {
    // Clean up mocks
    moduleMocker.clear();

    // Clean up
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('calls invokeClaudeCodeForGeneration with planning and generation prompts', async () => {
    const planPath = path.join(tempDir, 'test-plan.md');
    await fs.writeFile(planPath, '# Test Plan\n\nThis is a test plan for Claude.');

    const options = {
      plan: planPath,
      claude: true,
      extract: false,
      parent: {
        opts: () => ({}),
      },
    };

    const command = {
      args: ['src/**/*.ts'],
      parent: {
        opts: () => ({}),
      },
    };

    // Update process.argv to include the files
    const originalArgv = process.argv;
    process.argv = [...process.argv, '--', 'src/**/*.ts'];

    await handleGenerateCommand(undefined, options, command);

    // Restore process.argv
    process.argv = originalArgv;

    // Verify invokeClaudeCodeForGeneration was called
    expect(invokeClaudeCodeForGenerationSpy).toHaveBeenCalledTimes(1);

    // Verify the arguments include two distinct prompts and options
    const callArgs = invokeClaudeCodeForGenerationSpy.mock.calls[0];
    expect(callArgs).toHaveLength(3);

    // Check for key phrases in planning prompt
    expect(callArgs[0]).toEqual(expect.stringContaining('planning'));
    expect(callArgs[0]).toEqual(expect.stringContaining('Test Plan'));

    // Check for key phrases in generation prompt
    expect(callArgs[1]).toEqual(expect.stringContaining('YAML'));
    expect(callArgs[1]).toEqual(expect.stringContaining('generate'));

    // Check options
    expect(callArgs[2]).toEqual({
      model: 'test-model',
      includeDefaultTools: true,
    });
  });

  test('pipes Claude output to extractMarkdownToYaml when extract is true', async () => {
    const planPath = path.join(tempDir, 'test-plan.md');
    await fs.writeFile(planPath, '# Test Plan\n\nThis is a test plan for extraction.');

    // Mock invokeClaudeCodeForGeneration to return valid YAML
    const yamlContent = `# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
id: test-plan-001
title: Test Plan from Claude
goal: Test goal from Claude
details: Test details from Claude
status: pending
createdAt: 2024-01-01T00:00:00Z
updatedAt: 2024-01-01T00:00:00Z
phases:
  - id: phase-1
    title: Test Phase
    goal: Phase goal
    status: pending
    tasks:
      - id: task-1
        title: Test Task
        description: Task description
        status: pending`;

    invokeClaudeCodeForGenerationSpy.mockResolvedValueOnce(yamlContent);

    const options = {
      plan: planPath,
      claude: true,
      extract: true,
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

    await handleGenerateCommand(undefined, options, command);

    // Verify invokeClaudeCodeForGeneration was called
    expect(invokeClaudeCodeForGenerationSpy).toHaveBeenCalledTimes(1);

    // Verify extractMarkdownToYaml was called with the YAML string
    expect(extractMarkdownToYamlSpy).toHaveBeenCalledTimes(1);
    expect(extractMarkdownToYamlSpy).toHaveBeenCalledWith(
      yamlContent,
      expect.any(Object),
      expect.any(Object)
    );
  });
});

describe('handleGenerateCommand direct_mode configuration logic', () => {
  let tempDir: string;
  let tasksDir: string;

  // Mock functions
  const logSpy = mock(() => {});
  const errorSpy = mock(() => {});
  const logSpawnSpy = mock(() => ({ exited: Promise.resolve(0) }));
  const clipboardWriteSpy = mock(async () => {});
  const clipboardReadSpy = mock(async () => 'clipboard content');
  const runStreamingPromptSpy = mock(async () => {
    // Just return the YAML directly since we're testing the direct mode logic
    const yamlContent = `# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
id: test-plan-001
title: Test Plan
goal: Test goal
details: Test details
status: pending
createdAt: 2024-01-01T00:00:00Z
updatedAt: 2024-01-01T00:00:00Z
phases:
  - id: phase-1
    title: Test Phase
    goal: Phase goal
    status: pending
    tasks:
      - id: task-1
        title: Test Task
        description: Task description
        status: pending`;

    // Write to clipboard to simulate what runStreamingPrompt would do
    await clipboardWriteSpy(yamlContent);

    return { text: yamlContent };
  });
  const waitForEnterSpy = mock(
    async () => `# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json
id: test-plan-001
title: Test Plan
goal: Test goal
details: Test details
status: pending
createdAt: 2024-01-01T00:00:00Z
updatedAt: 2024-01-01T00:00:00Z
phases:
  - id: phase-1
    title: Test Phase
    goal: Phase goal
    status: pending
    tasks:
      - id: task-1
        title: Test Task
        description: Task description
        status: pending
`
  );

  beforeEach(async () => {
    // Clear mocks
    logSpy.mockClear();
    errorSpy.mockClear();
    logSpawnSpy.mockClear();
    clipboardWriteSpy.mockClear();
    clipboardReadSpy.mockClear();
    runStreamingPromptSpy.mockClear();
    waitForEnterSpy.mockClear();

    // Clear plan cache
    clearPlanCache();

    // Create temporary directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-generate-directmode-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Mock modules
    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
      error: errorSpy,
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../../common/clipboard.js', () => ({
      write: clipboardWriteSpy,
      read: clipboardReadSpy,
    }));

    await moduleMocker.mock('../../common/run_and_apply.js', () => ({
      runStreamingPrompt: runStreamingPromptSpy,
    }));

    await moduleMocker.mock('../../rmplan/llm_utils/run_and_apply.js', () => ({
      runStreamingPrompt: runStreamingPromptSpy,
      DEFAULT_RUN_MODEL: 'test-model',
    }));

    await moduleMocker.mock('ai', () => ({
      generateText: async () => ({ text: 'editor-test-plan' }),
    }));

    await moduleMocker.mock('@inquirer/prompts', () => ({
      input: async (config: any) => {
        // Return the default value provided
        return config.default || '';
      },
    }));

    await moduleMocker.mock('../../common/terminal.js', () => ({
      waitForEnter: waitForEnterSpy,
    }));

    await moduleMocker.mock('../process_markdown.ts', () => ({
      extractMarkdownToYaml: mock(async () => {}),
    }));

    // Mock utils
    await moduleMocker.mock('../../rmfilter/utils.js', () => ({
      getGitRoot: async () => tempDir,
      setDebug: () => {},
      logSpawn: logSpawnSpy,
    }));

    // Mock process for logSpawn
    await moduleMocker.mock('../../common/process.js', () => ({
      logSpawn: logSpawnSpy,
    }));

    // Mock git
    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => tempDir,
    }));

    // Mock model factory
    await moduleMocker.mock('../../common/model_factory.js', () => ({
      getModel: () => 'test-model',
      createModel: () => ({
        doStream: mock(async () => ({
          fullStream: (async function* () {
            yield { type: 'text-delta', textDelta: 'Generated YAML content' };
          })(),
          text: Promise.resolve(
            '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json\nid: test-plan-001\ntitle: Test Plan\ngoal: Test goal\ndetails: Test details\nstatus: pending\ncreatedAt: 2024-01-01T00:00:00Z\nupdatedAt: 2024-01-01T00:00:00Z\nphases:\n  - id: phase-1\n    title: Test Phase\n    goal: Phase goal\n    status: pending\n    tasks:\n      - id: task-1\n        title: Test Task\n        description: Task description\n        status: pending'
          ),
        })),
      }),
    }));
  });

  afterEach(async () => {
    // Clean up mocks
    moduleMocker.clear();

    // Clean up
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('no flag, no config - direct should be false', async () => {
    // Mock config loader with no direct_mode setting
    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: {
          tasks: tasksDir,
        },
        models: {
          planning: 'test-model',
        },
      }),
    }));

    const planPath = path.join(tempDir, 'test-plan.md');
    await fs.writeFile(planPath, '# Test Plan\n\nThis is a test plan.');

    const options = {
      plan: planPath, // Add required plan option
      extract: false,
      // No direct flag specified
      parent: {
        opts: () => ({}),
      },
    };

    const command = {
      args: ['src/**/*.ts'],
      parent: {
        opts: () => ({}),
      },
    };

    // Update process.argv to include the files
    const originalArgv = process.argv;
    process.argv = [...process.argv, '--', 'src/**/*.ts'];

    await handleGenerateCommand(undefined, options, command);

    // Restore process.argv
    process.argv = originalArgv;

    // Should run rmfilter with --copy flag
    expect(logSpawnSpy).toHaveBeenCalled();
    const callArgs = logSpawnSpy.mock.calls[0];
    expect(callArgs[0]).toContain('rmfilter');
    expect(callArgs[0]).toContain('--copy');
  });

  test('no flag, config direct_mode: true - direct should be true', async () => {
    // Mock config loader with direct_mode: true
    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: {
          tasks: tasksDir,
        },
        models: {
          planning: 'test-model',
          stepGeneration: 'test-model',
        },
        planning: {
          direct_mode: true,
        },
      }),
    }));

    const planPath = path.join(tempDir, 'test-plan.md');
    await fs.writeFile(planPath, '# Test Plan\n\nThis is a test plan.');

    const options = {
      extract: true, // Enable extract to test direct mode
      // No direct flag specified
      parent: {
        opts: () => ({}),
      },
    };

    const command = {
      args: ['src/**/*.ts'],
      parent: {
        opts: () => ({}),
      },
    };

    // Update process.argv to include the files
    const originalArgv = process.argv;
    process.argv = [...process.argv, '--', 'src/**/*.ts'];

    await handleGenerateCommand(undefined, options, command);

    // Restore process.argv
    process.argv = originalArgv;

    // Should run rmfilter
    expect(logSpawnSpy).toHaveBeenCalled();
    // Should run LLM directly (not wait for enter)
    expect(runStreamingPromptSpy).toHaveBeenCalled();
    expect(waitForEnterSpy).not.toHaveBeenCalled();
  });

  test('no flag, config direct_mode: false - direct should be false', async () => {
    // Mock config loader with direct_mode: false
    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: {
          tasks: tasksDir,
        },
        models: {
          planning: 'test-model',
        },
        planning: {
          direct_mode: false,
        },
      }),
    }));

    const planPath = path.join(tempDir, 'test-plan.md');
    await fs.writeFile(planPath, '# Test Plan\n\nThis is a test plan.');

    const options = {
      plan: planPath, // Add required plan option
      extract: false,
      // No direct flag specified
      parent: {
        opts: () => ({}),
      },
    };

    const command = {
      args: ['src/**/*.ts'],
      parent: {
        opts: () => ({}),
      },
    };

    // Update process.argv to include the files
    const originalArgv = process.argv;
    process.argv = [...process.argv, '--', 'src/**/*.ts'];

    await handleGenerateCommand(undefined, options, command);

    // Restore process.argv
    process.argv = originalArgv;

    // Should run rmfilter with --copy flag
    expect(logSpawnSpy).toHaveBeenCalled();
    const callArgs = logSpawnSpy.mock.calls[0];
    expect(callArgs[0]).toContain('rmfilter');
    expect(callArgs[0]).toContain('--copy');
  });

  test('--direct flag overrides config direct_mode: false', async () => {
    // Mock config loader with direct_mode: false
    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: {
          tasks: tasksDir,
        },
        models: {
          planning: 'test-model',
          stepGeneration: 'test-model',
        },
        planning: {
          direct_mode: false,
        },
      }),
    }));

    const planPath = path.join(tempDir, 'test-plan.md');
    await fs.writeFile(planPath, '# Test Plan\n\nThis is a test plan.');

    const options = {
      extract: true, // Enable extract to test direct mode
      direct: true, // CLI flag set to true
      parent: {
        opts: () => ({}),
      },
    };

    const command = {
      args: ['src/**/*.ts'],
      parent: {
        opts: () => ({}),
      },
    };

    // Update process.argv to include the files
    const originalArgv = process.argv;
    process.argv = [...process.argv, '--', 'src/**/*.ts'];

    await handleGenerateCommand(undefined, options, command);

    // Restore process.argv
    process.argv = originalArgv;

    // Should run rmfilter
    expect(logSpawnSpy).toHaveBeenCalled();
    // Should run LLM directly (not wait for enter)
    expect(runStreamingPromptSpy).toHaveBeenCalled();
    expect(waitForEnterSpy).not.toHaveBeenCalled();
  });

  test('--no-direct flag overrides config direct_mode: true', async () => {
    // Mock config loader with direct_mode: true
    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: {
          tasks: tasksDir,
        },
        models: {
          planning: 'test-model',
        },
        planning: {
          direct_mode: true,
        },
      }),
    }));

    const planPath = path.join(tempDir, 'test-plan.md');
    await fs.writeFile(planPath, '# Test Plan\n\nThis is a test plan.');

    const options = {
      extract: true, // Enable extract to test direct mode
      direct: false, // CLI flag set to false (--no-direct)
      parent: {
        opts: () => ({}),
      },
    };

    const command = {
      args: ['src/**/*.ts'],
      parent: {
        opts: () => ({}),
      },
    };

    // Update process.argv to include the files
    const originalArgv = process.argv;
    process.argv = [...process.argv, '--', 'src/**/*.ts'];

    await handleGenerateCommand(undefined, options, command);

    // Restore process.argv
    process.argv = originalArgv;

    // Should run rmfilter
    expect(logSpawnSpy).toHaveBeenCalled();
    // Should wait for enter (not direct mode)
    expect(waitForEnterSpy).toHaveBeenCalled();
    expect(runStreamingPromptSpy).not.toHaveBeenCalled();
  });
});
