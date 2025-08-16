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
        steps: [{ prompt: 'Do something', done: false }],
      },
    ],
  } as PlanSchema,
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
    // Mock @inquirer/prompts to prevent hanging
    await moduleMocker.mock('@inquirer/prompts', () => ({
      checkbox: mock(async () => ['none']), // Select none to skip interactive actions
      input: mock(async () => 'test.md'),
      select: mock(async () => 'none'),
    }));
    const mockContext = createMockContext();

    // Mock gatherPlanContext
    await moduleMocker.mock('../utils/context_gathering.js', () => ({
      gatherPlanContext: async () => mockContext,
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
        prompt: 'Test prompt content',
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
      gatherPlanContext: async () => mockContext,
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
        prompt: 'Test prompt content for dry run',
      }),
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
        diffContent: '',
      },
    });

    // Mock gatherPlanContext
    await moduleMocker.mock('../utils/context_gathering.js', () => ({
      gatherPlanContext: async () => mockContext,
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
    // Mock @inquirer/prompts to prevent hanging
    await moduleMocker.mock('@inquirer/prompts', () => ({
      checkbox: mock(async () => ['none']), // Select none to skip interactive actions
      input: mock(async () => 'test.md'),
      select: mock(async () => 'none'),
    }));

    const mockContext = createMockContext();

    // Mock gatherPlanContext
    await moduleMocker.mock('../utils/context_gathering.js', () => ({
      gatherPlanContext: async () => mockContext,
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
      prompt: 'Test prompt content',
    }));

    await moduleMocker.mock('../executors/claude_code/agent_prompts.js', () => ({
      getPrDescriptionPrompt: promptSpy,
    }));

    // Mock log function
    const logSpy = mock(() => {});
    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
    }));

    const options = {
      instructions: 'Focus on performance improvements',
    };
    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleDescriptionCommand('test-plan.yml', options, command);

    // Verify prompt was called with custom instructions
    expect(promptSpy).toHaveBeenCalledWith(expect.any(String), 'Focus on performance improvements');
  });

  test('handles different executor configurations', async () => {
    // Mock @inquirer/prompts to prevent hanging
    await moduleMocker.mock('@inquirer/prompts', () => ({
      checkbox: mock(async () => ['none']), // Select none to skip interactive actions
      input: mock(async () => 'test.md'),
      select: mock(async () => 'none'),
    }));

    const mockContext = createMockContext();

    // Mock gatherPlanContext
    await moduleMocker.mock('../utils/context_gathering.js', () => ({
      gatherPlanContext: async () => mockContext,
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
        prompt: 'Test prompt content',
      }),
    }));

    // Mock log function
    const logSpy = mock(() => {});
    await moduleMocker.mock('../../logging.js', () => ({
      log: logSpy,
    }));

    const options = {
      executor: 'claude-code',
      model: 'gpt-4',
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
        interactive: false,
      }),
      expect.any(Object) // config
    );
  });

  test('handles execution errors gracefully', async () => {
    const mockContext = createMockContext();

    // Mock gatherPlanContext
    await moduleMocker.mock('../utils/context_gathering.js', () => ({
      gatherPlanContext: async () => mockContext,
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
        prompt: 'Test prompt content',
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

    await expect(handleDescriptionCommand('test-plan.yml', options, command)).rejects.toThrow(
      'Description generation failed: Execution failed'
    );
  });

  test('validates plan has required fields', async () => {
    // Mock gatherPlanContext to throw an error for invalid plan
    await moduleMocker.mock('../utils/context_gathering.js', () => ({
      gatherPlanContext: async () => {
        throw new Error('Invalid plan file invalid-plan.yml:\n  - goal: Required');
      },
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
    await expect(handleDescriptionCommand('invalid-plan.yml', options, command)).rejects.toThrow(
      'Invalid plan file invalid-plan.yml:\n  - goal: Required'
    );
  });

  describe('output handling', () => {
    test('handles --output-file flag', async () => {
      const mockContext = createMockContext();

      // Mock filesystem operations
      const mkdirSpy = mock(() => Promise.resolve());
      const writeFileSpy = mock(() => Promise.resolve());

      await moduleMocker.mock('node:fs/promises', () => ({
        readFile: mock(async () => 'mock file content'),
        writeFile: writeFileSpy,
        mkdir: mkdirSpy,
      }));

      // Mock getGitRoot to return test directory
      await moduleMocker.mock('../../common/git.js', () => ({
        getGitRoot: mock(async () => testDir),
      }));

      // Mock gatherPlanContext
      await moduleMocker.mock('../utils/context_gathering.js', () => ({
        gatherPlanContext: async () => mockContext,
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
          prompt: 'Test prompt content',
        }),
      }));

      // Mock log function
      const logSpy = mock(() => {});
      await moduleMocker.mock('../../logging.js', () => ({
        log: logSpy,
      }));

      const options = {
        outputFile: 'description.md', // Use relative path
      };
      const command = {
        parent: {
          opts: () => ({}),
        },
      };

      await handleDescriptionCommand('test-plan.yml', options, command);

      expect(mkdirSpy).toHaveBeenCalledWith(testDir, { recursive: true });
      expect(writeFileSpy).toHaveBeenCalledWith(
        join(testDir, 'description.md'),
        'Generated PR description content',
        'utf-8'
      );

      const logCalls = logSpy.mock.calls.map((call) => call[0]);
      const allOutput = logCalls.join('\n');
      expect(allOutput).toContain('Description saved to: description.md');
    });

    test('handles --copy flag', async () => {
      const mockContext = createMockContext();

      // Mock clipboard
      const clipboardWriteSpy = mock(() => Promise.resolve());
      await moduleMocker.mock('../../common/clipboard.js', () => ({
        write: clipboardWriteSpy,
      }));

      // Mock gatherPlanContext
      await moduleMocker.mock('../utils/context_gathering.js', () => ({
        gatherPlanContext: async () => mockContext,
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
          prompt: 'Test prompt content',
        }),
      }));

      // Mock log function
      const logSpy = mock(() => {});
      await moduleMocker.mock('../../logging.js', () => ({
        log: logSpy,
      }));

      const options = {
        copy: true,
      };
      const command = {
        parent: {
          opts: () => ({}),
        },
      };

      await handleDescriptionCommand('test-plan.yml', options, command);

      expect(clipboardWriteSpy).toHaveBeenCalledWith('Generated PR description content');

      const logCalls = logSpy.mock.calls.map((call) => call[0]);
      const allOutput = logCalls.join('\n');
      expect(allOutput).toContain('Description copied to clipboard');
    });

    test('handles --create-pr flag', async () => {
      const mockContext = createMockContext();

      // Mock spawnAndLogOutput
      const spawnSpy = mock(async () => ({
        exitCode: 0,
        stdout: 'PR created successfully',
        stderr: '',
      }));
      await moduleMocker.mock('../../common/process.js', () => ({
        spawnAndLogOutput: spawnSpy,
      }));

      // Mock gatherPlanContext
      await moduleMocker.mock('../utils/context_gathering.js', () => ({
        gatherPlanContext: async () => mockContext,
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
          prompt: 'Test prompt content',
        }),
      }));

      // Mock log function
      const logSpy = mock(() => {});
      await moduleMocker.mock('../../logging.js', () => ({
        log: logSpy,
      }));

      const options = {
        createPr: true,
      };
      const command = {
        parent: {
          opts: () => ({}),
        },
      };

      await handleDescriptionCommand('test-plan.yml', options, command);

      expect(spawnSpy).toHaveBeenCalledWith(['gh', 'pr', 'create', '--draft', '--title', 'Test Plan', '--body-file', '-'], {
        stdin: 'Generated PR description content',
      });

      const logCalls = logSpy.mock.calls.map((call) => call[0]);
      const allOutput = logCalls.join('\n');
      expect(allOutput).toContain('GitHub PR created successfully');
    });

    test('handles multiple flags together', async () => {
      const mockContext = createMockContext();

      // Mock all dependencies
      const mkdirSpy = mock(() => Promise.resolve());
      const writeFileSpy = mock(() => Promise.resolve());
      const clipboardWriteSpy = mock(() => Promise.resolve());
      const spawnSpy = mock(async () => ({
        exitCode: 0,
        stdout: 'PR created successfully',
        stderr: '',
      }));

      await moduleMocker.mock('node:fs/promises', () => ({
        readFile: mock(async () => 'mock file content'),
        writeFile: writeFileSpy,
        mkdir: mkdirSpy,
      }));

      await moduleMocker.mock('../../common/clipboard.js', () => ({
        write: clipboardWriteSpy,
      }));

      await moduleMocker.mock('../../common/process.js', () => ({
        spawnAndLogOutput: spawnSpy,
      }));

      // Mock getGitRoot to return test directory
      await moduleMocker.mock('../../common/git.js', () => ({
        getGitRoot: mock(async () => testDir),
      }));

      // Mock gatherPlanContext
      await moduleMocker.mock('../utils/context_gathering.js', () => ({
        gatherPlanContext: async () => mockContext,
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
          prompt: 'Test prompt content',
        }),
      }));

      // Mock log function
      const logSpy = mock(() => {});
      await moduleMocker.mock('../../logging.js', () => ({
        log: logSpy,
      }));

      const options = {
        outputFile: 'description.md', // Use relative path
        copy: true,
        createPr: true,
      };
      const command = {
        parent: {
          opts: () => ({}),
        },
      };

      await handleDescriptionCommand('test-plan.yml', options, command);

      // All actions should be performed
      expect(writeFileSpy).toHaveBeenCalledWith(
        join(testDir, 'description.md'),
        'Generated PR description content',
        'utf-8'
      );
      expect(clipboardWriteSpy).toHaveBeenCalledWith('Generated PR description content');
      expect(spawnSpy).toHaveBeenCalledWith(['gh', 'pr', 'create', '--draft', '--title', 'Test Plan', '--body-file', '-'], {
        stdin: 'Generated PR description content',
      });
    });

    test('handles interactive mode when no flags provided', async () => {
      const mockContext = createMockContext();

      // Mock interactive prompt to simulate user selections
      const clipboardWriteSpy = mock(() => Promise.resolve());

      await moduleMocker.mock('@inquirer/prompts', () => ({
        checkbox: mock(async () => ['copy', 'save']),
        input: mock(async () => 'interactive-description.md'),
        select: mock(async () => 'none'),
      }));

      await moduleMocker.mock('node:fs/promises', () => ({
        readFile: mock(async () => 'mock file content'),
        writeFile: mock(() => Promise.resolve()),
        mkdir: mock(() => Promise.resolve()),
      }));

      await moduleMocker.mock('../../common/clipboard.js', () => ({
        write: clipboardWriteSpy,
      }));

      // Mock gatherPlanContext
      await moduleMocker.mock('../utils/context_gathering.js', () => ({
        gatherPlanContext: async () => mockContext,
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
          prompt: 'Test prompt content',
        }),
      }));

      // Mock log function
      const logSpy = mock(() => {});
      await moduleMocker.mock('../../logging.js', () => ({
        log: logSpy,
      }));

      const options = {}; // No output flags provided
      const command = {
        parent: {
          opts: () => ({}),
        },
      };

      await handleDescriptionCommand('test-plan.yml', options, command);

      expect(clipboardWriteSpy).toHaveBeenCalledWith('Generated PR description content');
    });

    test('handles error cases', async () => {
      const mockContext = createMockContext();

      // Mock filesystem operations that fail
      await moduleMocker.mock('node:fs/promises', () => ({
        readFile: mock(async () => 'mock file content'),
        writeFile: mock(() => Promise.reject(new Error('EACCES: Permission denied'))),
        mkdir: mock(() => Promise.resolve()),
      }));

      // Mock getGitRoot to return test directory
      await moduleMocker.mock('../../common/git.js', () => ({
        getGitRoot: mock(async () => testDir),
      }));

      // Mock gatherPlanContext
      await moduleMocker.mock('../utils/context_gathering.js', () => ({
        gatherPlanContext: async () => mockContext,
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
          prompt: 'Test prompt content',
        }),
      }));

      // Mock log function
      const logSpy = mock(() => {});
      await moduleMocker.mock('../../logging.js', () => ({
        log: logSpy,
      }));

      const options = {
        outputFile: 'description.md', // Use relative path
      };
      const command = {
        parent: {
          opts: () => ({}),
        },
      };

      await expect(handleDescriptionCommand('test-plan.yml', options, command)).rejects.toThrow(
        'Output operations failed'
      );
    });

    test('handles gh command failures', async () => {
      const mockContext = createMockContext();

      // Mock spawnAndLogOutput to simulate gh command failure
      const spawnSpy = mock(async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'fatal: not a git repository',
      }));
      await moduleMocker.mock('../../common/process.js', () => ({
        spawnAndLogOutput: spawnSpy,
      }));

      // Mock gatherPlanContext
      await moduleMocker.mock('../utils/context_gathering.js', () => ({
        gatherPlanContext: async () => mockContext,
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
          prompt: 'Test prompt content',
        }),
      }));

      // Mock log function
      const logSpy = mock(() => {});
      await moduleMocker.mock('../../logging.js', () => ({
        log: logSpy,
      }));

      const options = {
        createPr: true,
      };
      const command = {
        parent: {
          opts: () => ({}),
        },
      };

      await expect(handleDescriptionCommand('test-plan.yml', options, command)).rejects.toThrow(
        'Failed to create GitHub PR: gh command failed with exit code 1: fatal: not a git repository'
      );
    });

    test('handles interactive prompt cancellation gracefully', async () => {
      const mockContext = createMockContext();

      // Mock interactive prompt to simulate user cancellation
      const ExitPromptError = class extends Error {
        constructor() {
          super('User cancelled prompt');
          this.name = 'ExitPromptError';
        }
      };

      await moduleMocker.mock('@inquirer/prompts', () => ({
        checkbox: mock(async () => {
          throw new ExitPromptError();
        }),
        input: mock(async () => 'test.md'),
        select: mock(async () => 'none'),
      }));

      // Mock gatherPlanContext
      await moduleMocker.mock('../utils/context_gathering.js', () => ({
        gatherPlanContext: async () => mockContext,
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
          prompt: 'Test prompt content',
        }),
      }));

      // Mock log function
      const logSpy = mock(() => {});
      await moduleMocker.mock('../../logging.js', () => ({
        log: logSpy,
      }));

      const options = {}; // No output flags provided - should trigger interactive mode
      const command = {
        parent: {
          opts: () => ({}),
        },
      };

      // Should not throw, should handle cancellation gracefully
      await handleDescriptionCommand('test-plan.yml', options, command);

      // Should log cancellation message
      const logCalls = logSpy.mock.calls.map((call) => call[0]);
      const allOutput = logCalls.join('\n');
      expect(allOutput).toContain('Action cancelled by user.');
    });

    test('handles interactive mode errors within actions', async () => {
      const mockContext = createMockContext();

      // Mock interactive prompt to select copy action
      await moduleMocker.mock('@inquirer/prompts', () => ({
        checkbox: mock(async () => ['copy']),
        input: mock(async () => 'test.md'),
        select: mock(async () => 'none'),
      }));

      // Mock clipboard to fail
      await moduleMocker.mock('../../common/clipboard.js', () => ({
        write: mock(() => Promise.reject(new Error('Clipboard access denied'))),
      }));

      // Mock gatherPlanContext
      await moduleMocker.mock('../utils/context_gathering.js', () => ({
        gatherPlanContext: async () => mockContext,
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
          prompt: 'Test prompt content',
        }),
      }));

      // Mock log function
      const logSpy = mock(() => {});
      await moduleMocker.mock('../../logging.js', () => ({
        log: logSpy,
      }));

      const options = {}; // No output flags provided - should trigger interactive mode
      const command = {
        parent: {
          opts: () => ({}),
        },
      };

      // Should not throw, should handle the error gracefully
      await handleDescriptionCommand('test-plan.yml', options, command);

      // Should log error message
      const logCalls = logSpy.mock.calls.map((call) => call[0]);
      const allOutput = logCalls.join('\n');
      expect(allOutput).toContain('Failed to copy to clipboard: Clipboard access denied');
    });

    test('handles interactive mode file save errors', async () => {
      const mockContext = createMockContext();

      // Mock interactive prompt to select save action
      await moduleMocker.mock('@inquirer/prompts', () => ({
        checkbox: mock(async () => ['save']),
        input: mock(async () => 'test-file.md'),
        select: mock(async () => 'none'),
      }));

      // Mock filesystem operations to fail
      await moduleMocker.mock('node:fs/promises', () => ({
        readFile: mock(async () => 'mock file content'),
        writeFile: mock(() => Promise.reject(new Error('EACCES: Permission denied'))),
        mkdir: mock(() => Promise.resolve()),
      }));

      // Mock gatherPlanContext
      await moduleMocker.mock('../utils/context_gathering.js', () => ({
        gatherPlanContext: async () => mockContext,
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
          prompt: 'Test prompt content',
        }),
      }));

      // Mock log function
      const logSpy = mock(() => {});
      await moduleMocker.mock('../../logging.js', () => ({
        log: logSpy,
      }));

      const options = {}; // No output flags provided - should trigger interactive mode
      const command = {
        parent: {
          opts: () => ({}),
        },
      };

      // Should not throw, should handle the error gracefully
      await handleDescriptionCommand('test-plan.yml', options, command);

      // Should log error message
      const logCalls = logSpy.mock.calls.map((call) => call[0]);
      const allOutput = logCalls.join('\n');
      expect(allOutput).toContain('Failed to save file: EACCES: Permission denied');
    });

    test('handles interactive mode PR creation errors', async () => {
      const mockContext = createMockContext();

      // Mock interactive prompt to select PR creation
      await moduleMocker.mock('@inquirer/prompts', () => ({
        checkbox: mock(async () => ['pr']),
        input: mock(async () => 'test.md'),
        select: mock(async () => 'none'),
      }));

      // Mock spawnAndLogOutput to simulate gh command failure
      const spawnSpy = mock(async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'fatal: not a git repository',
      }));
      await moduleMocker.mock('../../common/process.js', () => ({
        spawnAndLogOutput: spawnSpy,
      }));

      // Mock gatherPlanContext
      await moduleMocker.mock('../utils/context_gathering.js', () => ({
        gatherPlanContext: async () => mockContext,
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
          prompt: 'Test prompt content',
        }),
      }));

      // Mock log function
      const logSpy = mock(() => {});
      await moduleMocker.mock('../../logging.js', () => ({
        log: logSpy,
      }));

      const options = {}; // No output flags provided - should trigger interactive mode
      const command = {
        parent: {
          opts: () => ({}),
        },
      };

      // Should not throw, should handle the error gracefully
      await handleDescriptionCommand('test-plan.yml', options, command);

      // Should log error message
      const logCalls = logSpy.mock.calls.map((call) => call[0]);
      const allOutput = logCalls.join('\n');
      expect(allOutput).toContain(
        'Failed to create GitHub PR: gh command failed with exit code 1: fatal: not a git repository'
      );
    });

    test('handles interactive mode when user selects no actions', async () => {
      const mockContext = createMockContext();

      // Mock interactive prompt to select none/empty selection
      await moduleMocker.mock('@inquirer/prompts', () => ({
        checkbox: mock(async () => ['none']), // User explicitly selects "none"
        input: mock(async () => 'test.md'),
        select: mock(async () => 'none'),
      }));

      // Mock gatherPlanContext
      await moduleMocker.mock('../utils/context_gathering.js', () => ({
        gatherPlanContext: async () => mockContext,
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
          prompt: 'Test prompt content',
        }),
      }));

      // Mock log function
      const logSpy = mock(() => {});
      await moduleMocker.mock('../../logging.js', () => ({
        log: logSpy,
      }));

      const options = {}; // No output flags provided - should trigger interactive mode
      const command = {
        parent: {
          opts: () => ({}),
        },
      };

      await handleDescriptionCommand('test-plan.yml', options, command);

      // Should log "no actions selected" message
      const logCalls = logSpy.mock.calls.map((call) => call[0]);
      const allOutput = logCalls.join('\n');
      expect(allOutput).toContain('No additional actions selected.');
    });

    test('handles interactive mode when user selects empty array', async () => {
      const mockContext = createMockContext();

      // Mock interactive prompt to return empty array
      await moduleMocker.mock('@inquirer/prompts', () => ({
        checkbox: mock(async () => []), // User selects nothing
        input: mock(async () => 'test.md'),
        select: mock(async () => 'none'),
      }));

      // Mock gatherPlanContext
      await moduleMocker.mock('../utils/context_gathering.js', () => ({
        gatherPlanContext: async () => mockContext,
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
          prompt: 'Test prompt content',
        }),
      }));

      // Mock log function
      const logSpy = mock(() => {});
      await moduleMocker.mock('../../logging.js', () => ({
        log: logSpy,
      }));

      const options = {}; // No output flags provided - should trigger interactive mode
      const command = {
        parent: {
          opts: () => ({}),
        },
      };

      await handleDescriptionCommand('test-plan.yml', options, command);

      // Should log "no actions selected" message
      const logCalls = logSpy.mock.calls.map((call) => call[0]);
      const allOutput = logCalls.join('\n');
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

      await expect(
        handleDescriptionCommand('test-plan.yml', options as any, command)
      ).rejects.toThrow('--output-file must be a string path');
    });

    test('validates output file paths for security', async () => {
      const mockContext = createMockContext();

      // Mock filesystem operations
      await moduleMocker.mock('node:fs/promises', () => ({
        readFile: mock(async () => 'mock file content'),
        writeFile: mock(() => Promise.resolve()),
        mkdir: mock(() => Promise.resolve()),
      }));

      // Mock getGitRoot to return test directory
      await moduleMocker.mock('../../common/git.js', () => ({
        getGitRoot: mock(async () => testDir),
      }));

      // Mock gatherPlanContext
      await moduleMocker.mock('../utils/context_gathering.js', () => ({
        gatherPlanContext: async () => mockContext,
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
          prompt: 'Test prompt content',
        }),
      }));

      // Mock log function
      const logSpy = mock(() => {});
      await moduleMocker.mock('../../logging.js', () => ({
        log: logSpy,
      }));

      const options = {
        outputFile: '../../../etc/passwd', // Path traversal attempt
      };
      const command = {
        parent: {
          opts: () => ({}),
        },
      };

      await expect(handleDescriptionCommand('test-plan.yml', options, command)).rejects.toThrow(
        'Output operations failed'
      );
    });

    test('sanitizes process input for PR creation', async () => {
      const mockContext = createMockContext();

      // Mock spawnAndLogOutput to capture the sanitized input
      const spawnSpy = mock(async () => ({
        exitCode: 0,
        stdout: 'PR created successfully',
        stderr: '',
      }));
      await moduleMocker.mock('../../common/process.js', () => ({
        spawnAndLogOutput: spawnSpy,
      }));

      // Mock gatherPlanContext
      await moduleMocker.mock('../utils/context_gathering.js', () => ({
        gatherPlanContext: async () => mockContext,
      }));

      // Mock config loader
      await moduleMocker.mock('../configLoader.js', () => ({
        loadEffectiveConfig: async () => ({
          defaultExecutor: 'copy-only',
        }),
      }));

      // Mock executor that returns content with control characters
      const mockExecutor = {
        execute: mock(async () => 'Description with control chars\x01\x02\x1F'),
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
          prompt: 'Test prompt content',
        }),
      }));

      // Mock log function
      const logSpy = mock(() => {});
      await moduleMocker.mock('../../logging.js', () => ({
        log: logSpy,
      }));

      const options = {
        createPr: true,
      };
      const command = {
        parent: {
          opts: () => ({}),
        },
      };

      await handleDescriptionCommand('test-plan.yml', options, command);

      // Verify that the input was sanitized (control characters removed)
      expect(spawnSpy).toHaveBeenCalledWith(['gh', 'pr', 'create', '--draft', '--title', 'Test Plan', '--body-file', '-'], {
        stdin: 'Description with control chars',
      });
    });

    test('handles process input with null bytes safely', async () => {
      const mockContext = createMockContext();

      // Mock gatherPlanContext
      await moduleMocker.mock('../utils/context_gathering.js', () => ({
        gatherPlanContext: async () => mockContext,
      }));

      // Mock config loader
      await moduleMocker.mock('../configLoader.js', () => ({
        loadEffectiveConfig: async () => ({
          defaultExecutor: 'copy-only',
        }),
      }));

      // Mock executor that returns content with null bytes
      const mockExecutor = {
        execute: mock(async () => 'Description with null\x00byte'),
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
          prompt: 'Test prompt content',
        }),
      }));

      // Mock log function
      const logSpy = mock(() => {});
      await moduleMocker.mock('../../logging.js', () => ({
        log: logSpy,
      }));

      const options = {
        createPr: true,
      };
      const command = {
        parent: {
          opts: () => ({}),
        },
      };

      await expect(handleDescriptionCommand('test-plan.yml', options, command)).rejects.toThrow(
        'Process input contains null byte character'
      );
    });

    test('handles partial failures in multiple output actions gracefully', async () => {
      const mockContext = createMockContext();

      // Mock filesystem operations that fail
      await moduleMocker.mock('node:fs/promises', () => ({
        readFile: mock(async () => 'mock file content'),
        writeFile: mock(() => Promise.reject(new Error('File write failed'))),
        mkdir: mock(() => Promise.resolve()),
      }));

      // Mock clipboard that succeeds
      const clipboardWriteSpy = mock(() => Promise.resolve());
      await moduleMocker.mock('../../common/clipboard.js', () => ({
        write: clipboardWriteSpy,
      }));

      // Mock spawnAndLogOutput that fails
      const spawnSpy = mock(async () => ({
        exitCode: 1,
        stdout: '',
        stderr: 'Git error',
      }));
      await moduleMocker.mock('../../common/process.js', () => ({
        spawnAndLogOutput: spawnSpy,
      }));

      // Mock getGitRoot to return test directory
      await moduleMocker.mock('../../common/git.js', () => ({
        getGitRoot: mock(async () => testDir),
      }));

      // Mock gatherPlanContext
      await moduleMocker.mock('../utils/context_gathering.js', () => ({
        gatherPlanContext: async () => mockContext,
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
          prompt: 'Test prompt content',
        }),
      }));

      // Mock log function
      const logSpy = mock(() => {});
      await moduleMocker.mock('../../logging.js', () => ({
        log: logSpy,
      }));

      const options = {
        outputFile: 'description.md', // Use relative path
        copy: true,
        createPr: true,
      };
      const command = {
        parent: {
          opts: () => ({}),
        },
      };

      // Should fail with comprehensive error message
      await expect(handleDescriptionCommand('test-plan.yml', options, command)).rejects.toThrow(
        'Output operations failed'
      );

      // Should still have attempted clipboard operation (which succeeded)
      expect(clipboardWriteSpy).toHaveBeenCalledWith('Generated PR description content');
    });

    test('handles interactive mode with path validation errors', async () => {
      const mockContext = createMockContext();

      // Mock interactive prompt to select save action
      await moduleMocker.mock('@inquirer/prompts', () => ({
        checkbox: mock(async () => ['save']),
        input: mock(async () => '../../../etc/passwd'), // Dangerous path
        select: mock(async () => 'none'),
      }));

      // Mock getGitRoot to return test directory
      await moduleMocker.mock('../../common/git.js', () => ({
        getGitRoot: mock(async () => testDir),
      }));

      // Mock gatherPlanContext
      await moduleMocker.mock('../utils/context_gathering.js', () => ({
        gatherPlanContext: async () => mockContext,
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
          prompt: 'Test prompt content',
        }),
      }));

      // Mock log function
      const logSpy = mock(() => {});
      await moduleMocker.mock('../../logging.js', () => ({
        log: logSpy,
      }));

      const options = {}; // No output flags provided - should trigger interactive mode
      const command = {
        parent: {
          opts: () => ({}),
        },
      };

      // Should not throw, should handle the error gracefully
      await handleDescriptionCommand('test-plan.yml', options, command);

      // Should log error message about path traversal
      const logCalls = logSpy.mock.calls.map((call) => call[0]);
      const allOutput = logCalls.join('\n');
      expect(allOutput).toContain('Failed to save file');
      expect(allOutput).toContain('path traversal');
    });
  });
});
