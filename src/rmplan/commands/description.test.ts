import { expect, test, beforeEach, afterEach, mock, describe } from 'bun:test';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModuleMocker } from '../../testing.js';
import { handleDescriptionCommand } from './description.js';
import type { PlanSchema } from '../planSchema.js';
import type { PlanContext } from '../utils/context_gathering.js';

const moduleMocker = new ModuleMocker(import.meta);

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'rmplan-description-test-'));
});

afterEach(() => {
  moduleMocker.clear();
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
        steps: [
          { prompt: 'Do something', done: false }
        ]
      }
    ]
  } as PlanSchema,
  parentChain: [],
  completedChildren: [],
  diffResult: {
    hasChanges: true,
    changedFiles: ['test.ts', 'another.ts'],
    baseBranch: 'main',
    diffContent: 'mock diff content'
  },
  noChangesDetected: false,
  ...overrides
});

describe('handleDescriptionCommand', () => {
  test('successfully generates a PR description', async () => {
    const mockContext = createMockContext();
    
    // Mock gatherPlanContext
    await moduleMocker.mock('../utils/context_gathering.js', () => ({
      gatherPlanContext: async () => mockContext
    }));

    // Mock config loader
    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        defaultExecutor: 'copy-only',
      }),
    }));

    // Mock executor
    const mockExecutor = {
      execute: mock(async () => 'Generated PR description content'),
      prepareStepOptions: () => ({ rmfilter: true }),
    };

    await moduleMocker.mock('../executors/index.js', () => ({
      buildExecutorAndLog: () => mockExecutor,
      DEFAULT_EXECUTOR: 'copy-only',
    }));

    // Mock the prompt function
    await moduleMocker.mock('../executors/claude_code/agent_prompts.js', () => ({
      getPrDescriptionPrompt: () => ({
        name: 'pr-description',
        description: 'Test prompt',
        prompt: 'Test prompt content'
      })
    }));

    // Mock log function
    const logSpy = mock(() => {});
    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
    }));

    const options = {};
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleDescriptionCommand('test-plan.yml', options, command);

    expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalled();

    // Check that success message was logged
    const logCalls = logSpy.mock.calls.map((call) => call[0]);
    const allOutput = logCalls.join('\n');
    expect(allOutput).toContain('Generated PR description content');
  });

  test('handles dry-run mode by printing prompt without execution', async () => {
    const mockContext = createMockContext();
    
    // Mock gatherPlanContext
    await moduleMocker.mock('../utils/context_gathering.js', () => ({
      gatherPlanContext: async () => mockContext
    }));

    // Mock config loader
    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        defaultExecutor: 'copy-only',
      }),
    }));

    // Mock executor (should not be called in dry-run)
    const mockExecutor = {
      execute: mock(async () => 'Should not be called'),
      prepareStepOptions: () => ({ rmfilter: true }),
    };

    await moduleMocker.mock('../executors/index.js', () => ({
      buildExecutorAndLog: () => mockExecutor,
      DEFAULT_EXECUTOR: 'copy-only',
    }));

    // Mock the prompt function
    await moduleMocker.mock('../executors/claude_code/agent_prompts.js', () => ({
      getPrDescriptionPrompt: () => ({
        name: 'pr-description',
        description: 'Test prompt',
        prompt: 'Test prompt content for dry run'
      })
    }));

    // Mock log function
    const logSpy = mock(() => {});
    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
    }));

    const options = { dryRun: true };
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleDescriptionCommand('test-plan.yml', options, command);

    // Executor should not be called in dry-run mode
    expect(mockExecutor.execute).not.toHaveBeenCalled();
    
    // Should log the prompt content
    const logCalls = logSpy.mock.calls.map((call) => call[0]);
    const allOutput = logCalls.join('\n');
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
        diffContent: ''
      }
    });
    
    // Mock gatherPlanContext
    await moduleMocker.mock('../utils/context_gathering.js', () => ({
      gatherPlanContext: async () => mockContext
    }));

    // Mock config loader
    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        defaultExecutor: 'copy-only',
      }),
    }));

    // Mock log function
    const logSpy = mock(() => {});
    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
    }));

    const options = {};
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleDescriptionCommand('test-plan.yml', options, command);

    const logCalls = logSpy.mock.calls.map((call) => call[0]);
    const allOutput = logCalls.join('\n');
    expect(allOutput).toContain('No changes detected');
    expect(allOutput).toContain('Nothing to describe');
  });

  test('handles custom instructions from CLI options', async () => {
    const mockContext = createMockContext();
    
    // Mock gatherPlanContext
    await moduleMocker.mock('../utils/context_gathering.js', () => ({
      gatherPlanContext: async () => mockContext
    }));

    // Mock config loader
    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        defaultExecutor: 'copy-only',
      }),
    }));

    // Mock executor
    const mockExecutor = {
      execute: mock(async () => 'Generated PR description with custom instructions'),
      prepareStepOptions: () => ({ rmfilter: true }),
    };

    await moduleMocker.mock('../executors/index.js', () => ({
      buildExecutorAndLog: () => mockExecutor,
      DEFAULT_EXECUTOR: 'copy-only',
    }));

    // Mock the prompt function to verify custom instructions are passed
    const promptSpy = mock(() => ({
      name: 'pr-description',
      description: 'Test prompt',
      prompt: 'Test prompt content'
    }));

    await moduleMocker.mock('../executors/claude_code/agent_prompts.js', () => ({
      getPrDescriptionPrompt: promptSpy
    }));

    // Mock log function
    const logSpy = mock(() => {});
    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
    }));

    const options = {
      instructions: 'Focus on performance improvements'
    };
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleDescriptionCommand('test-plan.yml', options, command);

    // Verify prompt was called with custom instructions
    expect(promptSpy).toHaveBeenCalledWith(
      expect.any(String),
      'Focus on performance improvements'
    );
  });

  test('handles different executor configurations', async () => {
    const mockContext = createMockContext();
    
    // Mock gatherPlanContext
    await moduleMocker.mock('../utils/context_gathering.js', () => ({
      gatherPlanContext: async () => mockContext
    }));

    // Mock config loader
    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        defaultExecutor: 'custom-executor',
      }),
    }));

    // Mock executor
    const mockExecutor = {
      execute: mock(async () => 'Generated description with custom executor'),
      prepareStepOptions: () => ({ rmfilter: false }),
    };

    const buildExecutorSpy = mock(() => mockExecutor);

    await moduleMocker.mock('../executors/index.js', () => ({
      buildExecutorAndLog: buildExecutorSpy,
      DEFAULT_EXECUTOR: 'copy-only',
    }));

    // Mock the prompt function
    await moduleMocker.mock('../executors/claude_code/agent_prompts.js', () => ({
      getPrDescriptionPrompt: () => ({
        name: 'pr-description',
        description: 'Test prompt',
        prompt: 'Test prompt content'
      })
    }));

    // Mock log function
    const logSpy = mock(() => {});
    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
    }));

    const options = {
      executor: 'claude-code',
      model: 'gpt-4'
    };
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleDescriptionCommand('test-plan.yml', options, command);

    // Verify executor was built with correct options
    expect(buildExecutorSpy).toHaveBeenCalledWith(
      'claude-code', // executor name from options
      expect.objectContaining({
        model: 'gpt-4',
        interactive: false
      }),
      expect.any(Object) // config
    );
  });

  test('handles execution errors gracefully', async () => {
    const mockContext = createMockContext();
    
    // Mock gatherPlanContext
    await moduleMocker.mock('../utils/context_gathering.js', () => ({
      gatherPlanContext: async () => mockContext
    }));

    // Mock config loader
    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        defaultExecutor: 'copy-only',
      }),
    }));

    // Mock executor that throws an error
    const mockExecutor = {
      execute: mock(async () => {
        throw new Error('Execution failed');
      }),
      prepareStepOptions: () => ({ rmfilter: true }),
    };

    await moduleMocker.mock('../executors/index.js', () => ({
      buildExecutorAndLog: () => mockExecutor,
      DEFAULT_EXECUTOR: 'copy-only',
    }));

    // Mock the prompt function
    await moduleMocker.mock('../executors/claude_code/agent_prompts.js', () => ({
      getPrDescriptionPrompt: () => ({
        name: 'pr-description',
        description: 'Test prompt',
        prompt: 'Test prompt content'
      })
    }));

    // Mock log function
    const logSpy = mock(() => {});
    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
    }));

    const options = {};
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await expect(handleDescriptionCommand('test-plan.yml', options, command))
      .rejects.toThrow('Description generation failed: Execution failed');
  });

  test('validates plan has required fields', async () => {
    // Mock gatherPlanContext to throw an error for invalid plan
    await moduleMocker.mock('../utils/context_gathering.js', () => ({
      gatherPlanContext: async () => {
        throw new Error("Plan file is missing required 'goal' field");
      }
    }));

    // Mock config loader
    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        defaultExecutor: 'copy-only',
      }),
    }));

    const options = {};
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    // This should be caught by gatherPlanContext's validation
    await expect(handleDescriptionCommand('invalid-plan.yml', options, command))
      .rejects.toThrow("Plan file is missing required 'goal' field");
  });
});