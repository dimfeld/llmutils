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

describe.skip('handleGenerateCommand', () => {
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

    await handleGenerateCommand(planPath, options, command);

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

    await handleGenerateCommand(planPath, options, command);

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

    await handleGenerateCommand(planPath, options, command);

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

    await handleGenerateCommand(planPath, options, command);

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

    await handleGenerateCommand(planPath, options, command);

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

    await handleGenerateCommand(planPath, options, command);

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

    await handleGenerateCommand(planPath, options, command);

    // Restore process.argv
    process.argv = originalArgv;

    // Should run rmfilter command
    expect(logSpawnSpy).toHaveBeenCalledWith(
      expect.arrayContaining(['rmfilter']),
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

    await handleGenerateCommand(planPath, options, command);

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

    await handleGenerateCommand(planPath, options, command);

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

    await handleGenerateCommand(planPath, options, command);

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

    await handleGenerateCommand(planPath, options, command);

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

    await handleGenerateCommand(planPath, options, command);

    // Restore process.argv
    process.argv = originalArgv;

    // Should run rmfilter
    expect(logSpawnSpy).toHaveBeenCalled();
    // Should wait for enter (not direct mode)
    expect(waitForEnterSpy).toHaveBeenCalled();
    expect(runStreamingPromptSpy).not.toHaveBeenCalled();
  });
});
