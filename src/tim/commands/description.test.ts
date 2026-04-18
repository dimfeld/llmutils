import { expect, test, beforeEach, afterEach, vi, describe } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleDescriptionCommand } from './description.js';
import type { PlanSchema } from '../planSchema.js';
import type { PlanContext } from '../utils/context_gathering.js';

// Module-level state variables for controlling mock behavior per-test
let mockGatherPlanContextImpl: (() => Promise<PlanContext>) | undefined;
let mockLoadEffectiveConfigImpl: (() => Promise<any>) | undefined;
let mockBuildExecutorAndLogImpl: (() => any) | undefined;
let mockGetPrDescriptionPromptImpl: (() => any) | undefined;
let mockLogImpl: ((...args: any[]) => void) | undefined;
let mockSelectImpl: (() => Promise<string>) | undefined;
let mockInputImpl: (() => Promise<string>) | undefined;
let mockWriteFileImpl: ((path: string, data: any, encoding?: string) => Promise<void>) | undefined;
let mockMkdirImpl: ((path: string, options?: any) => Promise<void>) | undefined;
let mockClipboardWriteImpl: ((text: string) => Promise<void>) | undefined;
let mockSpawnAndLogOutputImpl: ((cmd: string[], options?: any) => Promise<any>) | undefined;
let mockGetGitRootImpl: (() => Promise<string>) | undefined;

vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(async () => {
    if (mockSelectImpl) return mockSelectImpl();
    return 'none';
  }),
  input: vi.fn(async () => {
    if (mockInputImpl) return mockInputImpl();
    return 'test.md';
  }),
}));

vi.mock('../utils/context_gathering.js', () => ({
  gatherPlanContext: vi.fn(async () => {
    if (mockGatherPlanContextImpl) return mockGatherPlanContextImpl();
    throw new Error('mockGatherPlanContextImpl not set');
  }),
}));

vi.mock('../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(async () => {
    if (mockLoadEffectiveConfigImpl) return mockLoadEffectiveConfigImpl();
    return { defaultExecutor: 'copy-only' };
  }),
}));

vi.mock('../executors/index.js', () => ({
  buildExecutorAndLog: vi.fn((...args: any[]) => {
    if (mockBuildExecutorAndLogImpl) return (mockBuildExecutorAndLogImpl as any)(...args);
    return {
      execute: vi.fn(async () => 'Generated PR description content'),
      prepareStepOptions: () => ({ rmfilter: true }),
    };
  }),
  DEFAULT_EXECUTOR: 'copy-only',
}));

vi.mock('../executors/claude_code/agent_prompts.js', () => ({
  getPrDescriptionPrompt: vi.fn((...args: any[]) => {
    if (mockGetPrDescriptionPromptImpl) return (mockGetPrDescriptionPromptImpl as any)(...args);
    return {
      name: 'pr-description',
      description: 'Test prompt',
      prompt: 'Test prompt content',
    };
  }),
}));

vi.mock('../../logging.js', () => ({
  log: vi.fn((...args: any[]) => {
    if (mockLogImpl) mockLogImpl(...args);
  }),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: vi.fn(async (path: string, data: any, encoding?: string) => {
      if (mockWriteFileImpl) return mockWriteFileImpl(path, data, encoding);
      return actual.writeFile(path, data, encoding as any);
    }),
    mkdir: vi.fn(async (path: string, options?: any) => {
      if (mockMkdirImpl) return mockMkdirImpl(path, options);
      return actual.mkdir(path as any, options);
    }),
    mkdtemp: vi.fn(actual.mkdtemp),
  };
});

vi.mock('../../common/git.js', () => ({
  getGitRoot: vi.fn(async () => {
    if (mockGetGitRootImpl) return mockGetGitRootImpl();
    return '/mock-git-root';
  }),
}));

vi.mock('../../common/clipboard.js', () => ({
  write: vi.fn(async (text: string) => {
    if (mockClipboardWriteImpl) return mockClipboardWriteImpl(text);
  }),
}));

vi.mock('../../common/process.js', () => ({
  spawnAndLogOutput: vi.fn(async (cmd: string[], options?: any) => {
    if (mockSpawnAndLogOutputImpl) return mockSpawnAndLogOutputImpl(cmd, options);
    return { exitCode: 0, stdout: '', stderr: '' };
  }),
}));

import { log as logFn } from '../../logging.js';
import { gatherPlanContext } from '../utils/context_gathering.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { buildExecutorAndLog } from '../executors/index.js';
import { getPrDescriptionPrompt } from '../executors/claude_code/agent_prompts.js';
import { select as selectFn, input as inputFn } from '@inquirer/prompts';
import { writeFile as writeFileFn, mkdir as mkdirFn } from 'node:fs/promises';
import { getGitRoot } from '../../common/git.js';
import { write as clipboardWrite } from '../../common/clipboard.js';
import { spawnAndLogOutput } from '../../common/process.js';

let testDir: string;

beforeEach(async () => {
  // Reset all module-level state
  mockGatherPlanContextImpl = undefined;
  mockLoadEffectiveConfigImpl = undefined;
  mockBuildExecutorAndLogImpl = undefined;
  mockGetPrDescriptionPromptImpl = undefined;
  mockLogImpl = undefined;
  mockSelectImpl = undefined;
  mockInputImpl = undefined;
  mockWriteFileImpl = undefined;
  mockMkdirImpl = undefined;
  mockClipboardWriteImpl = undefined;
  mockSpawnAndLogOutputImpl = undefined;
  mockGetGitRootImpl = undefined;

  vi.clearAllMocks();

  testDir = await mkdtemp(join(tmpdir(), 'tim-description-test-'));
});

afterEach(() => {
  vi.clearAllMocks();
});

// Mock dependencies for description command tests
const createMockContext = (overrides: Partial<PlanContext> = {}): PlanContext => ({
  resolvedPlanFile: join(testDir, 'test-plan.yml'),
  planData: {
    id: 1,
    title: 'Test Plan',
    goal: 'Test the description functionality',
    details: 'This is a test plan for the description command',
    tasks: [
      {
        title: 'Test task',
        description: 'A test task',
        steps: [{ prompt: 'Do something', done: false }],
      },
    ],
  } as PlanSchema,
  repoRoot: testDir,
  gitRoot: testDir,
  parentChain: [],
  completedChildren: [],
  diffResult: {
    hasChanges: true,
    changedFiles: ['test.ts', 'another.ts'],
    baseBranch: 'main',
    diffContent: 'mock diff content',
  },
  noChangesDetected: false,
  ...overrides,
});

describe('handleDescriptionCommand', () => {
  test('successfully generates a PR description', async () => {
    mockSelectImpl = async () => 'none';
    mockInputImpl = async () => 'test.md';

    const mockContext = createMockContext();
    mockGatherPlanContextImpl = async () => mockContext;
    mockLoadEffectiveConfigImpl = async () => ({ defaultExecutor: 'copy-only' });

    const mockExecuteInner = vi.fn(async () => 'Generated PR description content');
    mockBuildExecutorAndLogImpl = () => ({
      execute: mockExecuteInner,
      prepareStepOptions: () => ({ rmfilter: true }),
    });

    const logCalls: any[][] = [];
    mockLogImpl = (...args: any[]) => {
      logCalls.push(args);
    };

    const options = {};
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleDescriptionCommand(123, options, command);

    expect(mockExecuteInner).toHaveBeenCalledTimes(1);
    expect(logCalls.length).toBeGreaterThan(0);

    // Check that success message was logged
    const allOutput = logCalls.map((call) => call[0]).join('\n');
    expect(allOutput).toContain('Generated PR description content');
  });

  test('handles dry-run mode by printing prompt without execution', async () => {
    const mockContext = createMockContext();
    mockGatherPlanContextImpl = async () => mockContext;
    mockLoadEffectiveConfigImpl = async () => ({ defaultExecutor: 'copy-only' });

    const mockExecuteInner = vi.fn(async () => 'Should not be called');
    mockBuildExecutorAndLogImpl = () => ({
      execute: mockExecuteInner,
      prepareStepOptions: () => ({ rmfilter: true }),
    });

    mockGetPrDescriptionPromptImpl = () => ({
      name: 'pr-description',
      description: 'Test prompt',
      prompt: 'Test prompt content for dry run',
    });

    const logCalls: any[][] = [];
    mockLogImpl = (...args: any[]) => {
      logCalls.push(args);
    };

    const options = { dryRun: true };
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleDescriptionCommand(123, options, command);

    // Executor should not be called in dry-run mode
    expect(mockExecuteInner).not.toHaveBeenCalled();

    // Should log the prompt content
    const allOutput = logCalls.map((call) => call[0]).join('\n');
    expect(allOutput).toContain('Test prompt content for dry run');
    expect(allOutput).toContain('--dry-run mode');
  });

  test('handles case when no changes are detected', async () => {
    const mockContext = createMockContext({
      noChangesDetected: true,
      diffResult: {
        hasChanges: false,
        changedFiles: [],
        baseBranch: 'main',
        diffContent: '',
      },
    });

    mockGatherPlanContextImpl = async () => mockContext;
    mockLoadEffectiveConfigImpl = async () => ({ defaultExecutor: 'copy-only' });

    const logCalls: any[][] = [];
    mockLogImpl = (...args: any[]) => {
      logCalls.push(args);
    };

    const options = {};
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleDescriptionCommand(123, options, command);

    const allOutput = logCalls.map((call) => call[0]).join('\n');
    expect(allOutput).toContain('No changes detected');
    expect(allOutput).toContain('Nothing to describe');
  });

  test('handles custom instructions from CLI options', async () => {
    mockSelectImpl = async () => 'none';
    mockInputImpl = async () => 'test.md';

    const mockContext = createMockContext();
    mockGatherPlanContextImpl = async () => mockContext;
    mockLoadEffectiveConfigImpl = async () => ({ defaultExecutor: 'copy-only' });

    const mockExecuteInner = vi.fn(async () => 'Generated PR description with custom instructions');
    mockBuildExecutorAndLogImpl = () => ({
      execute: mockExecuteInner,
      prepareStepOptions: () => ({ rmfilter: true }),
    });

    const promptSpy = vi.fn(() => ({
      name: 'pr-description',
      description: 'Test prompt',
      prompt: 'Test prompt content',
    }));
    mockGetPrDescriptionPromptImpl = promptSpy;

    const options = {
      instructions: 'Focus on performance improvements',
    };
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleDescriptionCommand(123, options, command);

    // Verify prompt was called with custom instructions
    expect(promptSpy).toHaveBeenCalledWith(expect.any(String), 'Focus on performance improvements');
  });

  test('handles different executor configurations', async () => {
    mockSelectImpl = async () => 'none';
    mockInputImpl = async () => 'test.md';

    const mockContext = createMockContext();
    mockGatherPlanContextImpl = async () => mockContext;
    mockLoadEffectiveConfigImpl = async () => ({ defaultExecutor: 'custom-executor' });

    const mockExecuteInner = vi.fn(async () => 'Generated description with custom executor');
    const buildExecutorSpy = vi.fn(() => ({
      execute: mockExecuteInner,
      prepareStepOptions: () => ({ rmfilter: false }),
    }));
    mockBuildExecutorAndLogImpl = buildExecutorSpy;

    const options = {
      executor: 'claude-code',
      model: 'gpt-4',
    };
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleDescriptionCommand(123, options, command);

    // Verify executor was built with correct options
    expect(buildExecutorSpy).toHaveBeenCalledWith(
      'claude-code', // executor name from options
      expect.objectContaining({
        model: 'gpt-4',
      }),
      expect.any(Object) // config
    );
  });

  test('handles execution errors gracefully', async () => {
    const mockContext = createMockContext();
    mockGatherPlanContextImpl = async () => mockContext;
    mockLoadEffectiveConfigImpl = async () => ({ defaultExecutor: 'copy-only' });

    mockBuildExecutorAndLogImpl = () => ({
      execute: vi.fn(async () => {
        throw new Error('Execution failed');
      }),
      prepareStepOptions: () => ({ rmfilter: true }),
    });

    const options = {};
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await expect(handleDescriptionCommand(123, options, command)).rejects.toThrow(
      'Description generation failed: Execution failed'
    );
  });

  test('validates plan has required fields', async () => {
    mockGatherPlanContextImpl = async () => {
      throw new Error('Invalid plan file invalid-plan.yml:\n  - goal: Required');
    };
    mockLoadEffectiveConfigImpl = async () => ({ defaultExecutor: 'copy-only' });

    const options = {};
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    // This should be caught by gatherPlanContext's validation
    await expect(handleDescriptionCommand(999, options, command)).rejects.toThrow(
      'Invalid plan file invalid-plan.yml:\n  - goal: Required'
    );
  });

  describe('output handling', () => {
    test('handles --output-file flag', async () => {
      const mockContext = createMockContext();
      mockGetGitRootImpl = async () => testDir;
      mockGatherPlanContextImpl = async () => mockContext;
      mockLoadEffectiveConfigImpl = async () => ({ defaultExecutor: 'copy-only' });

      mockBuildExecutorAndLogImpl = () => ({
        execute: vi.fn(async () => 'Generated PR description content'),
        prepareStepOptions: () => ({ rmfilter: true }),
      });

      const mkdirCalls: any[][] = [];
      const writeFileCalls: any[][] = [];
      mockMkdirImpl = async (p: string, opts?: any) => {
        mkdirCalls.push([p, opts]);
      };
      mockWriteFileImpl = async (p: string, data: any, encoding?: string) => {
        writeFileCalls.push([p, data, encoding]);
      };

      const logCalls: any[][] = [];
      mockLogImpl = (...args: any[]) => {
        logCalls.push(args);
      };

      const options = {
        outputFile: 'description.md', // Use relative path
      };
      const command = {
        parent: {
          opts: () => ({}),
        },
      };

      await handleDescriptionCommand(123, options, command);

      expect(mkdirCalls.some(([p, opts]) => p === testDir && opts?.recursive === true)).toBe(true);
      expect(
        writeFileCalls.some(
          ([p, data, enc]) =>
            p === join(testDir, 'description.md') &&
            data === 'Generated PR description content' &&
            enc === 'utf-8'
        )
      ).toBe(true);

      const allOutput = logCalls.map((call) => call[0]).join('\n');
      expect(allOutput).toContain('Description saved to: description.md');
    });

    test('handles --copy flag', async () => {
      const mockContext = createMockContext();
      mockGatherPlanContextImpl = async () => mockContext;
      mockLoadEffectiveConfigImpl = async () => ({ defaultExecutor: 'copy-only' });

      mockBuildExecutorAndLogImpl = () => ({
        execute: vi.fn(async () => 'Generated PR description content'),
        prepareStepOptions: () => ({ rmfilter: true }),
      });

      const clipboardCalls: string[] = [];
      mockClipboardWriteImpl = async (text: string) => {
        clipboardCalls.push(text);
      };

      const logCalls: any[][] = [];
      mockLogImpl = (...args: any[]) => {
        logCalls.push(args);
      };

      const options = {
        copy: true,
      };
      const command = {
        parent: {
          opts: () => ({}),
        },
      };

      await handleDescriptionCommand(123, options, command);

      expect(clipboardCalls).toContain('Generated PR description content');

      const allOutput = logCalls.map((call) => call[0]).join('\n');
      expect(allOutput).toContain('Description copied to clipboard');
    });

    test('handles --create-pr flag with default draft config', async () => {
      const mockContext = createMockContext();
      mockGatherPlanContextImpl = async () => mockContext;
      // No prCreation config, should default to draft: true
      mockLoadEffectiveConfigImpl = async () => ({ defaultExecutor: 'copy-only' });

      mockBuildExecutorAndLogImpl = () => ({
        execute: vi.fn(async () => 'Generated PR description content'),
        prepareStepOptions: () => ({ rmfilter: true }),
      });

      const spawnCalls: any[][] = [];
      mockSpawnAndLogOutputImpl = async (cmd: string[], opts?: any) => {
        spawnCalls.push([cmd, opts]);
        return { exitCode: 0, stdout: 'PR created successfully', stderr: '' };
      };

      const logCalls: any[][] = [];
      mockLogImpl = (...args: any[]) => {
        logCalls.push(args);
      };

      const options = {
        createPr: true,
      };
      const command = {
        parent: {
          opts: () => ({}),
        },
      };

      await handleDescriptionCommand(123, options, command);

      expect(spawnCalls.length).toBe(1);
      expect(spawnCalls[0][0]).toEqual([
        'gh',
        'pr',
        'create',
        '--draft',
        '--title',
        'Test Plan',
        '--body-file',
        '-',
      ]);
      expect(spawnCalls[0][1]).toEqual({ stdin: 'Generated PR description content' });

      const allOutput = logCalls.map((call) => call[0]).join('\n');
      expect(allOutput).toContain('GitHub PR created successfully');
    });

    test('creates PR without --draft flag when draft is false in config', async () => {
      const mockContext = createMockContext();
      mockGatherPlanContextImpl = async () => mockContext;
      mockLoadEffectiveConfigImpl = async () => ({
        defaultExecutor: 'copy-only',
        prCreation: { draft: false },
      });

      mockBuildExecutorAndLogImpl = () => ({
        execute: vi.fn(async () => 'Generated PR description content'),
        prepareStepOptions: () => ({ rmfilter: true }),
      });

      const spawnCalls: any[][] = [];
      mockSpawnAndLogOutputImpl = async (cmd: string[], opts?: any) => {
        spawnCalls.push([cmd, opts]);
        return { exitCode: 0, stdout: 'PR created successfully', stderr: '' };
      };

      const logCalls: any[][] = [];
      mockLogImpl = (...args: any[]) => {
        logCalls.push(args);
      };

      const options = { createPr: true };
      const command = { parent: { opts: () => ({}) } };

      await handleDescriptionCommand(123, options, command);

      // Should NOT include --draft flag when draft is false
      expect(spawnCalls[0][0]).toEqual([
        'gh',
        'pr',
        'create',
        '--title',
        'Test Plan',
        '--body-file',
        '-',
      ]);

      const allOutput = logCalls.map((call) => call[0]).join('\n');
      expect(allOutput).toContain('GitHub PR created successfully');
    });

    test('prepends title prefix when configured', async () => {
      const mockContext = createMockContext();
      mockGatherPlanContextImpl = async () => mockContext;
      mockLoadEffectiveConfigImpl = async () => ({
        defaultExecutor: 'copy-only',
        prCreation: { draft: true, titlePrefix: '[FEATURE] ' },
      });

      mockBuildExecutorAndLogImpl = () => ({
        execute: vi.fn(async () => 'Generated PR description content'),
        prepareStepOptions: () => ({ rmfilter: true }),
      });

      const spawnCalls: any[][] = [];
      mockSpawnAndLogOutputImpl = async (cmd: string[], opts?: any) => {
        spawnCalls.push([cmd, opts]);
        return { exitCode: 0, stdout: 'PR created successfully', stderr: '' };
      };

      const logCalls: any[][] = [];
      mockLogImpl = (...args: any[]) => {
        logCalls.push(args);
      };

      const options = { createPr: true };
      const command = { parent: { opts: () => ({}) } };

      await handleDescriptionCommand(123, options, command);

      // Should include the prefix in the title
      expect(spawnCalls[0][0]).toEqual([
        'gh',
        'pr',
        'create',
        '--draft',
        '--title',
        '[FEATURE] Test Plan',
        '--body-file',
        '-',
      ]);

      const allOutput = logCalls.map((call) => call[0]).join('\n');
      expect(allOutput).toContain('GitHub PR created successfully');
    });

    test('backward compatibility - defaults to draft true when prCreation not configured', async () => {
      const mockContext = createMockContext();
      mockGatherPlanContextImpl = async () => mockContext;
      mockLoadEffectiveConfigImpl = async () => ({
        defaultExecutor: 'copy-only',
        // No prCreation field
      });

      mockBuildExecutorAndLogImpl = () => ({
        execute: vi.fn(async () => 'Generated PR description content'),
        prepareStepOptions: () => ({ rmfilter: true }),
      });

      const spawnCalls: any[][] = [];
      mockSpawnAndLogOutputImpl = async (cmd: string[], opts?: any) => {
        spawnCalls.push([cmd, opts]);
        return { exitCode: 0, stdout: 'PR created successfully', stderr: '' };
      };

      const logCalls: any[][] = [];
      mockLogImpl = (...args: any[]) => {
        logCalls.push(args);
      };

      const options = { createPr: true };
      const command = { parent: { opts: () => ({}) } };

      await handleDescriptionCommand(123, options, command);

      // Should default to draft mode (includes --draft flag)
      expect(spawnCalls[0][0]).toEqual([
        'gh',
        'pr',
        'create',
        '--draft',
        '--title',
        'Test Plan',
        '--body-file',
        '-',
      ]);

      const allOutput = logCalls.map((call) => call[0]).join('\n');
      expect(allOutput).toContain('GitHub PR created successfully');
    });

    test('handles multiple flags together', async () => {
      const mockContext = createMockContext();
      mockGetGitRootImpl = async () => testDir;
      mockGatherPlanContextImpl = async () => mockContext;
      mockLoadEffectiveConfigImpl = async () => ({ defaultExecutor: 'copy-only' });

      mockBuildExecutorAndLogImpl = () => ({
        execute: vi.fn(async () => 'Generated PR description content'),
        prepareStepOptions: () => ({ rmfilter: true }),
      });

      const mkdirCalls: any[][] = [];
      const writeFileCalls: any[][] = [];
      mockMkdirImpl = async (p: string, opts?: any) => {
        mkdirCalls.push([p, opts]);
      };
      mockWriteFileImpl = async (p: string, data: any, encoding?: string) => {
        writeFileCalls.push([p, data, encoding]);
      };

      const clipboardCalls: string[] = [];
      mockClipboardWriteImpl = async (text: string) => {
        clipboardCalls.push(text);
      };

      const spawnCalls: any[][] = [];
      mockSpawnAndLogOutputImpl = async (cmd: string[], opts?: any) => {
        spawnCalls.push([cmd, opts]);
        return { exitCode: 0, stdout: 'PR created successfully', stderr: '' };
      };

      const options = {
        outputFile: 'description.md',
        copy: true,
        createPr: true,
      };
      const command = { parent: { opts: () => ({}) } };

      await handleDescriptionCommand(123, options, command);

      // All actions should be performed
      expect(
        writeFileCalls.some(
          ([p, data, enc]) =>
            p === join(testDir, 'description.md') &&
            data === 'Generated PR description content' &&
            enc === 'utf-8'
        )
      ).toBe(true);
      expect(clipboardCalls).toContain('Generated PR description content');
      expect(spawnCalls[0][0]).toEqual([
        'gh',
        'pr',
        'create',
        '--draft',
        '--title',
        'Test Plan',
        '--body-file',
        '-',
      ]);
    });

    test('handles interactive mode when no flags provided', async () => {
      const mockContext = createMockContext();
      mockSelectImpl = async () => 'copy';
      mockInputImpl = async () => 'interactive-description.md';

      const clipboardCalls: string[] = [];
      mockClipboardWriteImpl = async (text: string) => {
        clipboardCalls.push(text);
      };
      mockMkdirImpl = async () => {};
      mockWriteFileImpl = async () => {};

      mockGatherPlanContextImpl = async () => mockContext;
      mockLoadEffectiveConfigImpl = async () => ({ defaultExecutor: 'copy-only' });

      mockBuildExecutorAndLogImpl = () => ({
        execute: vi.fn(async () => 'Generated PR description content'),
        prepareStepOptions: () => ({ rmfilter: true }),
      });

      const options = {}; // No output flags provided
      const command = { parent: { opts: () => ({}) } };

      await handleDescriptionCommand(123, options, command);

      expect(clipboardCalls).toContain('Generated PR description content');
    });

    test('handles error cases', async () => {
      const mockContext = createMockContext();
      mockGetGitRootImpl = async () => testDir;
      mockGatherPlanContextImpl = async () => mockContext;
      mockLoadEffectiveConfigImpl = async () => ({ defaultExecutor: 'copy-only' });

      mockBuildExecutorAndLogImpl = () => ({
        execute: vi.fn(async () => 'Generated PR description content'),
        prepareStepOptions: () => ({ rmfilter: true }),
      });

      mockWriteFileImpl = async () => {
        throw new Error('EACCES: Permission denied');
      };
      mockMkdirImpl = async () => {};

      const options = {
        outputFile: 'description.md',
      };
      const command = { parent: { opts: () => ({}) } };

      await expect(handleDescriptionCommand(123, options, command)).rejects.toThrow(
        'Output operations failed'
      );
    });

    test('handles gh command failures', async () => {
      const mockContext = createMockContext();
      mockGatherPlanContextImpl = async () => mockContext;
      mockLoadEffectiveConfigImpl = async () => ({ defaultExecutor: 'copy-only' });

      mockBuildExecutorAndLogImpl = () => ({
        execute: vi.fn(async () => 'Generated PR description content'),
        prepareStepOptions: () => ({ rmfilter: true }),
      });

      mockSpawnAndLogOutputImpl = async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'fatal: not a git repository',
      });

      const options = { createPr: true };
      const command = { parent: { opts: () => ({}) } };

      await expect(handleDescriptionCommand(123, options, command)).rejects.toThrow(
        'Failed to create GitHub PR: gh command failed with exit code 1: fatal: not a git repository'
      );
    });

    test('handles interactive prompt cancellation gracefully', async () => {
      const mockContext = createMockContext();

      const ExitPromptError = class extends Error {
        constructor() {
          super('User cancelled prompt');
          this.name = 'ExitPromptError';
        }
      };

      mockSelectImpl = async () => {
        throw new ExitPromptError();
      };
      mockInputImpl = async () => 'test.md';

      mockGatherPlanContextImpl = async () => mockContext;
      mockLoadEffectiveConfigImpl = async () => ({ defaultExecutor: 'copy-only' });

      mockBuildExecutorAndLogImpl = () => ({
        execute: vi.fn(async () => 'Generated PR description content'),
        prepareStepOptions: () => ({ rmfilter: true }),
      });

      const logCalls: any[][] = [];
      mockLogImpl = (...args: any[]) => {
        logCalls.push(args);
      };

      const options = {}; // No output flags provided - should trigger interactive mode
      const command = { parent: { opts: () => ({}) } };

      // Should not throw, should handle cancellation gracefully
      await handleDescriptionCommand(123, options, command);

      // Should log cancellation message
      const allOutput = logCalls.map((call) => call[0]).join('\n');
      expect(allOutput).toContain('Action cancelled by user.');
    });

    test('handles interactive mode errors within actions', async () => {
      const mockContext = createMockContext();
      mockSelectImpl = async () => 'copy';
      mockInputImpl = async () => 'test.md';

      // Mock clipboard to fail
      mockClipboardWriteImpl = async () => {
        throw new Error('Clipboard access denied');
      };

      mockGatherPlanContextImpl = async () => mockContext;
      mockLoadEffectiveConfigImpl = async () => ({ defaultExecutor: 'copy-only' });

      mockBuildExecutorAndLogImpl = () => ({
        execute: vi.fn(async () => 'Generated PR description content'),
        prepareStepOptions: () => ({ rmfilter: true }),
      });

      const logCalls: any[][] = [];
      mockLogImpl = (...args: any[]) => {
        logCalls.push(args);
      };

      const options = {}; // No output flags provided - should trigger interactive mode
      const command = { parent: { opts: () => ({}) } };

      // Should not throw, should handle the error gracefully
      await handleDescriptionCommand(123, options, command);

      // Should log error message
      const allOutput = logCalls.map((call) => call[0]).join('\n');
      expect(allOutput).toContain('Failed to copy to clipboard: Clipboard access denied');
    });

    test('handles interactive mode file save errors', async () => {
      const mockContext = createMockContext();
      mockSelectImpl = async () => 'save';
      mockInputImpl = async () => 'test-file.md';

      // Mock filesystem operations to fail
      mockWriteFileImpl = async () => {
        throw new Error('EACCES: Permission denied');
      };
      mockMkdirImpl = async () => {};

      mockGatherPlanContextImpl = async () => mockContext;
      mockLoadEffectiveConfigImpl = async () => ({ defaultExecutor: 'copy-only' });

      mockBuildExecutorAndLogImpl = () => ({
        execute: vi.fn(async () => 'Generated PR description content'),
        prepareStepOptions: () => ({ rmfilter: true }),
      });

      const logCalls: any[][] = [];
      mockLogImpl = (...args: any[]) => {
        logCalls.push(args);
      };

      const options = {}; // No output flags provided - should trigger interactive mode
      const command = { parent: { opts: () => ({}) } };

      // Should not throw, should handle the error gracefully
      await handleDescriptionCommand(123, options, command);

      // Should log error message
      const allOutput = logCalls.map((call) => call[0]).join('\n');
      expect(allOutput).toContain('Failed to save file: EACCES: Permission denied');
    });

    test('handles interactive mode PR creation errors', async () => {
      const mockContext = createMockContext();
      mockSelectImpl = async () => 'pr';
      mockInputImpl = async () => 'test.md';

      mockSpawnAndLogOutputImpl = async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'fatal: not a git repository',
      });

      mockGatherPlanContextImpl = async () => mockContext;
      mockLoadEffectiveConfigImpl = async () => ({ defaultExecutor: 'copy-only' });

      mockBuildExecutorAndLogImpl = () => ({
        execute: vi.fn(async () => 'Generated PR description content'),
        prepareStepOptions: () => ({ rmfilter: true }),
      });

      const logCalls: any[][] = [];
      mockLogImpl = (...args: any[]) => {
        logCalls.push(args);
      };

      const options = {}; // No output flags provided - should trigger interactive mode
      const command = { parent: { opts: () => ({}) } };

      // Should not throw, should handle the error gracefully
      await handleDescriptionCommand(123, options, command);

      // Should log error message
      const allOutput = logCalls.map((call) => call[0]).join('\n');
      expect(allOutput).toContain(
        'Failed to create GitHub PR: gh command failed with exit code 1: fatal: not a git repository'
      );
    });

    test('handles interactive mode when user selects no actions', async () => {
      const mockContext = createMockContext();
      mockSelectImpl = async () => 'none';
      mockInputImpl = async () => 'test.md';

      mockGatherPlanContextImpl = async () => mockContext;
      mockLoadEffectiveConfigImpl = async () => ({ defaultExecutor: 'copy-only' });

      mockBuildExecutorAndLogImpl = () => ({
        execute: vi.fn(async () => 'Generated PR description content'),
        prepareStepOptions: () => ({ rmfilter: true }),
      });

      const logCalls: any[][] = [];
      mockLogImpl = (...args: any[]) => {
        logCalls.push(args);
      };

      const options = {}; // No output flags provided - should trigger interactive mode
      const command = { parent: { opts: () => ({}) } };

      await handleDescriptionCommand(123, options, command);

      // Should log "no actions selected" message
      const allOutput = logCalls.map((call) => call[0]).join('\n');
      expect(allOutput).toContain('No additional actions selected.');
    });

    test('handles interactive mode when user selects empty array', async () => {
      const mockContext = createMockContext();
      mockSelectImpl = async () => 'none';
      mockInputImpl = async () => 'test.md';

      mockGatherPlanContextImpl = async () => mockContext;
      mockLoadEffectiveConfigImpl = async () => ({ defaultExecutor: 'copy-only' });

      mockBuildExecutorAndLogImpl = () => ({
        execute: vi.fn(async () => 'Generated PR description content'),
        prepareStepOptions: () => ({ rmfilter: true }),
      });

      const logCalls: any[][] = [];
      mockLogImpl = (...args: any[]) => {
        logCalls.push(args);
      };

      const options = {}; // No output flags provided - should trigger interactive mode
      const command = { parent: { opts: () => ({}) } };

      await handleDescriptionCommand(123, options, command);

      // Should log "no actions selected" message
      const allOutput = logCalls.map((call) => call[0]).join('\n');
      expect(allOutput).toContain('No additional actions selected.');
    });
  });

  describe('security and validation', () => {
    test('validates CLI options early and rejects invalid types', async () => {
      const options = {
        outputFile: 123, // Invalid type
        copy: 'invalid',
        createPr: null,
      };
      const command = {
        parent: {
          opts: () => ({}),
        },
      };

      await expect(handleDescriptionCommand(123, options as any, command)).rejects.toThrow(
        '--output-file must be a string path'
      );
    });

    test('validates output file paths for security', async () => {
      const mockContext = createMockContext();
      mockGetGitRootImpl = async () => testDir;
      mockGatherPlanContextImpl = async () => mockContext;
      mockLoadEffectiveConfigImpl = async () => ({ defaultExecutor: 'copy-only' });

      mockBuildExecutorAndLogImpl = () => ({
        execute: vi.fn(async () => 'Generated PR description content'),
        prepareStepOptions: () => ({ rmfilter: true }),
      });

      mockWriteFileImpl = async () => {};
      mockMkdirImpl = async () => {};

      const options = {
        outputFile: '../../../etc/passwd', // Path traversal attempt
      };
      const command = { parent: { opts: () => ({}) } };

      await expect(handleDescriptionCommand(123, options, command)).rejects.toThrow(
        'Output operations failed'
      );
    });

    test('sanitizes process input for PR creation', async () => {
      const mockContext = createMockContext();
      mockGatherPlanContextImpl = async () => mockContext;
      mockLoadEffectiveConfigImpl = async () => ({ defaultExecutor: 'copy-only' });

      // Mock executor that returns content with control characters
      mockBuildExecutorAndLogImpl = () => ({
        execute: vi.fn(async () => 'Description with control chars\x01\x02\x1F'),
        prepareStepOptions: () => ({ rmfilter: true }),
      });

      const spawnCalls: any[][] = [];
      mockSpawnAndLogOutputImpl = async (cmd: string[], opts?: any) => {
        spawnCalls.push([cmd, opts]);
        return { exitCode: 0, stdout: 'PR created successfully', stderr: '' };
      };

      const options = { createPr: true };
      const command = { parent: { opts: () => ({}) } };

      await handleDescriptionCommand(123, options, command);

      // Verify that the input was sanitized (control characters removed)
      expect(spawnCalls[0][0]).toEqual([
        'gh',
        'pr',
        'create',
        '--draft',
        '--title',
        'Test Plan',
        '--body-file',
        '-',
      ]);
      expect(spawnCalls[0][1]).toEqual({ stdin: 'Description with control chars' });
    });

    test('handles process input with null bytes safely', async () => {
      const mockContext = createMockContext();
      mockGatherPlanContextImpl = async () => mockContext;
      mockLoadEffectiveConfigImpl = async () => ({ defaultExecutor: 'copy-only' });

      // Mock executor that returns content with null bytes
      mockBuildExecutorAndLogImpl = () => ({
        execute: vi.fn(async () => 'Description with null\x00byte'),
        prepareStepOptions: () => ({ rmfilter: true }),
      });

      const options = { createPr: true };
      const command = { parent: { opts: () => ({}) } };

      await expect(handleDescriptionCommand(123, options, command)).rejects.toThrow(
        'Process input contains null byte character'
      );
    });

    test('handles partial failures in multiple output actions gracefully', async () => {
      const mockContext = createMockContext();
      mockGetGitRootImpl = async () => testDir;
      mockGatherPlanContextImpl = async () => mockContext;
      mockLoadEffectiveConfigImpl = async () => ({ defaultExecutor: 'copy-only' });

      mockBuildExecutorAndLogImpl = () => ({
        execute: vi.fn(async () => 'Generated PR description content'),
        prepareStepOptions: () => ({ rmfilter: true }),
      });

      // File write fails
      mockWriteFileImpl = async () => {
        throw new Error('File write failed');
      };
      mockMkdirImpl = async () => {};

      // Clipboard succeeds
      const clipboardCalls: string[] = [];
      mockClipboardWriteImpl = async (text: string) => {
        clipboardCalls.push(text);
      };

      // Spawn fails
      mockSpawnAndLogOutputImpl = async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'Git error',
      });

      const options = {
        outputFile: 'description.md',
        copy: true,
        createPr: true,
      };
      const command = { parent: { opts: () => ({}) } };

      // Should fail with comprehensive error message
      await expect(handleDescriptionCommand(123, options, command)).rejects.toThrow(
        'Output operations failed'
      );

      // Should still have attempted clipboard operation (which succeeded)
      expect(clipboardCalls).toContain('Generated PR description content');
    });

    test('handles interactive mode with path validation errors', async () => {
      const mockContext = createMockContext();
      mockSelectImpl = async () => 'save';
      mockInputImpl = async () => '../../../etc/passwd'; // Dangerous path
      mockGetGitRootImpl = async () => testDir;

      mockGatherPlanContextImpl = async () => mockContext;
      mockLoadEffectiveConfigImpl = async () => ({ defaultExecutor: 'copy-only' });

      mockBuildExecutorAndLogImpl = () => ({
        execute: vi.fn(async () => 'Generated PR description content'),
        prepareStepOptions: () => ({ rmfilter: true }),
      });

      const logCalls: any[][] = [];
      mockLogImpl = (...args: any[]) => {
        logCalls.push(args);
      };

      const options = {}; // No output flags provided - should trigger interactive mode
      const command = { parent: { opts: () => ({}) } };

      // Should not throw, should handle the error gracefully
      await handleDescriptionCommand(123, options, command);

      // Should log error message about path traversal
      const allOutput = logCalls.map((call) => call[0]).join('\n');
      expect(allOutput).toContain('Failed to save file');
      expect(allOutput).toContain('path traversal');
    });
  });

  describe('PR creation with configuration', () => {
    test('sanitizes dangerous characters in title prefix', async () => {
      const mockContext = createMockContext();
      mockGatherPlanContextImpl = async () => mockContext;
      mockLoadEffectiveConfigImpl = async () => ({
        defaultExecutor: 'copy-only',
        prCreation: {
          draft: true,
          titlePrefix: '[TEST`$;|&<>\\] ', // Contains shell metacharacters
        },
      });

      mockBuildExecutorAndLogImpl = () => ({
        execute: vi.fn(async () => 'Generated PR description content'),
        prepareStepOptions: () => ({ rmfilter: true }),
      });

      const spawnCalls: any[][] = [];
      mockSpawnAndLogOutputImpl = async (cmd: string[], opts?: any) => {
        spawnCalls.push([cmd, opts]);
        return { exitCode: 0, stdout: 'PR created successfully', stderr: '' };
      };

      const options = { createPr: true };
      const command = { parent: { opts: () => ({}) } };

      await handleDescriptionCommand(123, options, command);

      // Should sanitize the dangerous characters from the prefix
      expect(spawnCalls[0][0]).toEqual([
        'gh',
        'pr',
        'create',
        '--draft',
        '--title',
        '[TEST] Test Plan',
        '--body-file',
        '-',
      ]);
    });

    test('handles very long title prefix by truncating to GitHub limits', async () => {
      const mockContext = createMockContext();
      mockGatherPlanContextImpl = async () => mockContext;

      // Create a very long prefix that would exceed GitHub's 256 character title limit
      const longPrefix = '[' + 'A'.repeat(200) + '] ';
      mockLoadEffectiveConfigImpl = async () => ({
        defaultExecutor: 'copy-only',
        prCreation: {
          draft: true,
          titlePrefix: longPrefix,
        },
      });

      mockBuildExecutorAndLogImpl = () => ({
        execute: vi.fn(async () => 'Generated PR description content'),
        prepareStepOptions: () => ({ rmfilter: true }),
      });

      const spawnCalls: any[][] = [];
      mockSpawnAndLogOutputImpl = async (cmd: string[], opts?: any) => {
        spawnCalls.push([cmd, opts]);
        return { exitCode: 0, stdout: 'PR created successfully', stderr: '' };
      };

      const options = { createPr: true };
      const command = { parent: { opts: () => ({}) } };

      await handleDescriptionCommand(123, options, command);

      // Get the actual call to verify title was truncated
      expect(spawnCalls).toHaveLength(1);
      const actualCall = spawnCalls[0];
      const titleIndex = actualCall[0].indexOf('--title') + 1;
      const actualTitle = actualCall[0][titleIndex];

      // Verify title was truncated to 256 characters or less
      expect(actualTitle.length).toBeLessThanOrEqual(256);
      expect(actualTitle).toContain('Test Plan'); // Should still contain the original title
    });

    test('works with both draft and non-draft settings via CLI flag', async () => {
      const mockContext = createMockContext();
      mockGatherPlanContextImpl = async () => mockContext;
      mockLoadEffectiveConfigImpl = async () => ({
        defaultExecutor: 'copy-only',
        prCreation: {
          draft: false,
          titlePrefix: '[NON-DRAFT] ',
        },
      });

      mockBuildExecutorAndLogImpl = () => ({
        execute: vi.fn(async () => 'Generated PR description content'),
        prepareStepOptions: () => ({ rmfilter: true }),
      });

      const spawnCalls: any[][] = [];
      mockSpawnAndLogOutputImpl = async (cmd: string[], opts?: any) => {
        spawnCalls.push([cmd, opts]);
        return { exitCode: 0, stdout: 'PR created successfully', stderr: '' };
      };

      const options = { createPr: true };
      const command = { parent: { opts: () => ({}) } };

      await handleDescriptionCommand(123, options, command);

      // Should create non-draft PR with prefix
      expect(spawnCalls[0][0]).toEqual([
        'gh',
        'pr',
        'create',
        '--title',
        '[NON-DRAFT] Test Plan',
        '--body-file',
        '-',
      ]);
    });

    test('simulates real config file with comprehensive error handling', async () => {
      const mockContext = createMockContext();
      mockGatherPlanContextImpl = async () => mockContext;
      mockLoadEffectiveConfigImpl = async () => ({
        defaultExecutor: 'copy-only',
        prCreation: {
          draft: false,
          titlePrefix: '[FEATURE] ',
        },
        issueTracker: 'github',
        postApplyCommands: [],
        paths: {
          tasks: './tasks',
        },
      });

      mockBuildExecutorAndLogImpl = () => ({
        execute: vi.fn(async () => 'Generated PR description content'),
        prepareStepOptions: () => ({ rmfilter: true }),
      });

      const spawnCalls: any[][] = [];
      mockSpawnAndLogOutputImpl = async (cmd: string[], opts?: any) => {
        spawnCalls.push([cmd, opts]);
        return { exitCode: 128, stdout: '', stderr: 'fatal: not in a git repository' };
      };

      const options = { createPr: true };
      const command = { parent: { opts: () => ({}) } };

      // Should throw error due to gh command failure
      await expect(handleDescriptionCommand(123, options, command)).rejects.toThrow(
        'Failed to create GitHub PR: gh command failed with exit code 128: fatal: not in a git repository'
      );

      // Verify the command was called with correct configuration
      expect(spawnCalls[0][0]).toEqual([
        'gh',
        'pr',
        'create',
        '--title',
        '[FEATURE] Test Plan',
        '--body-file',
        '-',
      ]);
    });

    test('integration test with interactive mode and config-driven PR creation', async () => {
      const mockContext = createMockContext();
      mockSelectImpl = async () => 'pr';
      mockInputImpl = async () => 'test.md';

      mockGatherPlanContextImpl = async () => mockContext;
      mockLoadEffectiveConfigImpl = async () => ({
        defaultExecutor: 'copy-only',
        prCreation: {
          draft: true,
          titlePrefix: '[AUTO] ',
        },
      });

      mockBuildExecutorAndLogImpl = () => ({
        execute: vi.fn(async () => 'Generated PR description content from interactive mode'),
        prepareStepOptions: () => ({ rmfilter: true }),
      });

      const spawnCalls: any[][] = [];
      mockSpawnAndLogOutputImpl = async (cmd: string[], opts?: any) => {
        spawnCalls.push([cmd, opts]);
        return { exitCode: 0, stdout: 'PR created successfully', stderr: '' };
      };

      const logCalls: any[][] = [];
      mockLogImpl = (...args: any[]) => {
        logCalls.push(args);
      };

      const options = {}; // No flags - should trigger interactive mode
      const command = { parent: { opts: () => ({}) } };

      await handleDescriptionCommand(123, options, command);

      // Should use config for PR creation in interactive mode
      expect(spawnCalls[0][0]).toEqual([
        'gh',
        'pr',
        'create',
        '--draft',
        '--title',
        '[AUTO] Test Plan',
        '--body-file',
        '-',
      ]);
      expect(spawnCalls[0][1]).toEqual({
        stdin: 'Generated PR description content from interactive mode',
      });

      const allOutput = logCalls.map((call) => call[0]).join('\n');
      expect(allOutput).toContain('GitHub PR created successfully');
    });

    test('validates config values and applies defaults correctly', async () => {
      const mockContext = createMockContext();
      mockGatherPlanContextImpl = async () => mockContext;
      mockLoadEffectiveConfigImpl = async () => ({
        defaultExecutor: 'copy-only',
        prCreation: {
          titlePrefix: '[PARTIAL] ',
          // No draft field - should use default behavior
        },
      });

      mockBuildExecutorAndLogImpl = () => ({
        execute: vi.fn(async () => 'Generated PR description content'),
        prepareStepOptions: () => ({ rmfilter: true }),
      });

      const spawnCalls: any[][] = [];
      mockSpawnAndLogOutputImpl = async (cmd: string[], opts?: any) => {
        spawnCalls.push([cmd, opts]);
        return { exitCode: 0, stdout: 'PR created successfully', stderr: '' };
      };

      const options = { createPr: true };
      const command = { parent: { opts: () => ({}) } };

      await handleDescriptionCommand(123, options, command);

      // Should use titlePrefix from config and default to draft mode
      expect(spawnCalls[0][0]).toEqual([
        'gh',
        'pr',
        'create',
        '--draft',
        '--title',
        '[PARTIAL] Test Plan',
        '--body-file',
        '-',
      ]);
    });

    test('handles empty prCreation object correctly', async () => {
      const mockContext = createMockContext();
      mockGatherPlanContextImpl = async () => mockContext;
      mockLoadEffectiveConfigImpl = async () => ({
        defaultExecutor: 'copy-only',
        prCreation: {}, // Empty object - should use all defaults
      });

      mockBuildExecutorAndLogImpl = () => ({
        execute: vi.fn(async () => 'Generated PR description content'),
        prepareStepOptions: () => ({ rmfilter: true }),
      });

      const spawnCalls: any[][] = [];
      mockSpawnAndLogOutputImpl = async (cmd: string[], opts?: any) => {
        spawnCalls.push([cmd, opts]);
        return { exitCode: 0, stdout: 'PR created successfully', stderr: '' };
      };

      const options = { createPr: true };
      const command = { parent: { opts: () => ({}) } };

      await handleDescriptionCommand(123, options, command);

      // Should default to draft mode with no prefix when prCreation is empty object
      expect(spawnCalls[0][0]).toEqual([
        'gh',
        'pr',
        'create',
        '--draft',
        '--title',
        'Test Plan',
        '--body-file',
        '-',
      ]);
    });
  });
});
