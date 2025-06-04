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

// Mock spawn for rmfilter and other commands
const spawnSpy = mock(() => ({ exitCode: 0 }));
mock.module('bun', () => ({
  spawn: spawnSpy,
  $: {},
}));

// Mock rmfilter module
const runRmfilterSpy = mock(async () => 'mocked rmfilter output');
mock.module('../../rmfilter/rmfilter.js', () => ({
  runRmfilter: runRmfilterSpy,
}));

// Mock clipboard
const clipboardWriteSpy = mock(async () => {});
const clipboardReadSpy = mock(async () => 'clipboard content');
mock.module('../../common/clipboard.js', () => ({
  clipboardWrite: clipboardWriteSpy,
  clipboardRead: clipboardReadSpy,
}));

// Mock LLM prompt
const runStreamingPromptSpy = mock(async () => ({ text: 'Generated plan content' }));
mock.module('../../common/run_and_apply.js', () => ({
  runStreamingPrompt: runStreamingPromptSpy,
}));

// Mock terminal functions
const waitForEnterSpy = mock(async () => '');
mock.module('../../common/terminal.js', () => ({
  waitForEnter: waitForEnterSpy,
}));

// Mock process.exit
const originalExit = process.exit;
const exitSpy = mock(() => {
  throw new Error('process.exit called');
});

describe('handleGenerateCommand', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    // Clear mocks
    logSpy.mockClear();
    errorSpy.mockClear();
    exitSpy.mockClear();
    spawnSpy.mockClear();
    runRmfilterSpy.mockClear();
    clipboardWriteSpy.mockClear();
    clipboardReadSpy.mockClear();
    runStreamingPromptSpy.mockClear();
    waitForEnterSpy.mockClear();

    // Mock process.exit
    process.exit = exitSpy as any;

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
    }));

    // Mock model factory
    mock.module('../../common/model_factory.js', () => ({
      getModel: () => 'test-model',
    }));
  });

  afterEach(async () => {
    // Restore process.exit
    process.exit = originalExit;

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

    await handleGenerateCommand(options, command);

    // Should read the plan file
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Using plan file'));

    // Should run rmfilter
    expect(runRmfilterSpy).toHaveBeenCalled();
    expect(runRmfilterSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        filePaths: ['src/**/*.ts'],
      })
    );

    // Should write to clipboard
    expect(clipboardWriteSpy).toHaveBeenCalled();
    const clipboardContent = clipboardWriteSpy.mock.calls[0][0];
    expect(clipboardContent).toContain('Test Plan');
    expect(clipboardContent).toContain('This is a test plan');

    // Should wait for enter
    expect(waitForEnterSpy).toHaveBeenCalled();
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

    // Should use simple planning prompt
    expect(runStreamingPromptSpy).toHaveBeenCalled();
    const promptCall = runStreamingPromptSpy.mock.calls[0][0];
    expect(promptCall.messages[0].content).toContain('single phase plan');
  });

  test('uses autofind when --autofind flag is used', async () => {
    const planPath = path.join(tempDir, 'autofind-plan.md');
    await fs.writeFile(planPath, '# Autofind Plan\n\nFind relevant files.');

    // Mock rmfind
    const rmfindSpy = mock(() => ({
      exitCode: 0,
      stdout: {
        toString: () => 'src/file1.ts\nsrc/file2.ts',
      },
    }));
    spawnSpy.mockImplementation((cmd, args) => {
      if (cmd.includes('rmfind')) {
        return rmfindSpy();
      }
      return { exitCode: 0 };
    });

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

    // Should have called rmfind
    expect(spawnSpy).toHaveBeenCalledWith(
      expect.arrayContaining([expect.stringContaining('rmfind')]),
      expect.any(Object)
    );

    // Should use the found files
    expect(runRmfilterSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        filePaths: expect.arrayContaining(['src/file1.ts', 'src/file2.ts']),
      })
    );
  });

  test('opens plan in editor when --plan-editor flag is used', async () => {
    // Mock editor detection
    const editorSpy = mock(() => ({ exitCode: 0 }));
    spawnSpy.mockImplementation((cmd) => {
      if (cmd.includes('editor')) {
        return editorSpy();
      }
      return { exitCode: 0 };
    });

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

    // Should have opened editor
    expect(spawnSpy).toHaveBeenCalledWith(
      expect.arrayContaining(['test-editor']),
      expect.any(Object)
    );
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

    // Should wait for enter then read clipboard
    expect(waitForEnterSpy).toHaveBeenCalled();
    expect(clipboardReadSpy).toHaveBeenCalled();
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

    // Should have called commit
    expect(spawnSpy).toHaveBeenCalledWith(expect.arrayContaining(['commit']), expect.any(Object));
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

    try {
      await handleGenerateCommand(options, command);
    } catch (e) {
      // Expected to throw due to process.exit mock
    }

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('must provide a plan'));
    expect(exitSpy).toHaveBeenCalledWith(1);
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
      args: [],
      parent: {
        opts: () => ({}),
      },
    };

    await handleGenerateCommand(options, command);

    // Should set quiet mode for rmfilter
    expect(runRmfilterSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        quiet: true,
      })
    );
  });
});
