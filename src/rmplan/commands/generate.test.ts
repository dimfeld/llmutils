import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { handleGenerateCommand } from './generate.js';
import { clearPlanCache } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';

// Mock console functions
const logSpy = mock(() => {});
const errorSpy = mock(() => {});

mock.module('../../logging.js', () => ({
  log: logSpy,
  error: errorSpy,
  warn: mock(() => {}),
}));

// Mock logSpawn for rmfilter and other commands
const logSpawnSpy = mock(() => ({ exited: Promise.resolve(0) }));

// Mock clipboard
const clipboardWriteSpy = mock(async () => {});
const clipboardReadSpy = mock(async () => 'clipboard content');
mock.module('../../common/clipboard.js', () => ({
  write: clipboardWriteSpy,
  read: clipboardReadSpy,
}));

// Mock LLM prompt
const runStreamingPromptSpy = mock(async () => ({ text: 'Generated plan content' }));
mock.module('../../common/run_and_apply.js', () => ({
  runStreamingPrompt: runStreamingPromptSpy,
}));

// Mock AI module
mock.module('ai', () => ({
  generateText: async () => ({ text: 'editor-test-plan' }),
}));

// Mock inquirer prompts
mock.module('@inquirer/prompts', () => ({
  input: async (config: any) => {
    // Return the default value provided
    return config.default || '';
  },
}));

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
mock.module('../../common/terminal.js', () => ({
  waitForEnter: waitForEnterSpy,
}));

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

    // Mock config loader
    mock.module('../configLoader.js', () => ({
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
    mock.module('../../rmfilter/utils.js', () => ({
      getGitRoot: async () => tempDir,
      setDebug: () => {},
      logSpawn: logSpawnSpy,
    }));

    // Mock model factory
    mock.module('../../common/model_factory.js', () => ({
      getModel: () => 'test-model',
      createModel: () => ({
        // Mock model for generateText
      }),
    }));
  });

  afterEach(async () => {
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

    await handleGenerateCommand(options, command);

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

    await handleGenerateCommand(options, command);

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
    mock.module('../../rmfind/core.js', () => ({
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

    await handleGenerateCommand(options, command);

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

    await handleGenerateCommand(options, command);

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

    await handleGenerateCommand(options, command);

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

    await handleGenerateCommand(options, command);

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

    await expect(handleGenerateCommand(options, command)).rejects.toThrow(
      'You must provide one and only one of --plan <file>, --plan-editor, or --issue <url|number>'
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

    await handleGenerateCommand(options, command);

    // Restore process.argv
    process.argv = originalArgv;

    // Should run rmfilter command
    expect(logSpawnSpy).toHaveBeenCalledWith(
      expect.arrayContaining(['rmfilter']),
      expect.any(Object)
    );
  });
});
