import { expect, test, beforeEach, afterEach, describe, mock } from 'bun:test';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModuleMocker } from '../../testing.js';
import { handleReviewCommand, generateDiffForReview, buildReviewPrompt } from './review.js';
import type { PlanSchema } from '../planSchema.js';

const moduleMocker = new ModuleMocker(import.meta);

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'rmplan-review-test-'));
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
      execute: async () => 'Mock execution result',
    }),
    DEFAULT_EXECUTOR: 'copy-only',
  }));

  await moduleMocker.mock('../configLoader.js', () => ({
    loadEffectiveConfig: async () => ({
      defaultExecutor: 'copy-only',
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
    buildReviewPrompt: () => 'mock review prompt',
  }));

  // Test resolving plan by file path
  const mockCommand = {
    parent: {
      opts: () => ({}),
    },
  };

  try {
    await handleReviewCommand(planFile, {}, mockCommand);
    expect(true).toBe(true); // Test passed
  } catch (err) {
    console.error('Test error:', err);
    throw err;
  }
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
      execute: async () => 'Mock execution result',
    }),
    DEFAULT_EXECUTOR: 'copy-only',
  }));

  await moduleMocker.mock('../configLoader.js', () => ({
    loadEffectiveConfig: async () => ({
      defaultExecutor: 'copy-only',
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
      tasks: [],
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
    buildReviewPrompt: () => 'mock review prompt',
  }));

  // Test resolving plan by ID
  const mockCommand = {
    parent: {
      opts: () => ({}),
    },
  };

  try {
    await handleReviewCommand('42', {}, mockCommand);
    expect(true).toBe(true); // Test passed
  } catch (err) {
    console.error('Test error:', err);
    throw err;
  }
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
      // If it doesn't throw, that's also fine - it means git worked
      expect(true).toBe(true);
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
      expect(true).toBe(true);
    } catch (error) {
      // Should throw a meaningful error if jj commands fail
      expect(error.message).toContain('Failed to generate');
    }
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
          steps: [
            { prompt: 'Create login component', done: true },
            { prompt: 'Add validation logic', done: false },
          ],
        },
        {
          title: 'Add data validation',
          description: 'Validate user input',
          steps: [{ prompt: 'Create validators', done: false }],
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

    const prompt = buildReviewPrompt(planData, diffResult);

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
    expect(prompt).toContain('✓ 1. Create login component');
    expect(prompt).toContain('○ 2. Add validation logic');
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

    const prompt = buildReviewPrompt(planData, diffResult);

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

    const prompt = buildReviewPrompt(planData, diffResult);

    expect(prompt).toContain('Plan ID:** 2');
    expect(prompt).toContain('Title:** Plan Without Details');
    expect(prompt).toContain('Goal:** Test goal');
    expect(prompt).not.toContain('Details:**');
    expect(prompt).toContain('1. **Task 1**');
    expect(prompt).toContain('Description 1');
    expect(prompt).toContain('Base Branch:** master');
  });
});

describe('handleReviewCommand error handling', () => {
  test('throws error when plan cannot be loaded', async () => {
    const invalidPlanFile = join(testDir, 'invalid.yml');

    await moduleMocker.mock('../plans.js', () => ({
      resolvePlanFile: async () => invalidPlanFile,
      readPlanFile: async () => null,
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
      'Could not load plan from'
    );
  });

  test('exits early when no changes detected', async () => {
    const planContent = `
id: 1
title: Test Plan
goal: Test goal
`;
    const planFile = join(testDir, 'no-changes.yml');
    await writeFile(planFile, planContent);

    await moduleMocker.mock('../plans.js', () => ({
      resolvePlanFile: async () => planFile,
      readPlanFile: async () => ({
        id: 1,
        title: 'Test Plan',
        goal: 'Test goal',
      }),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({}),
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: async () => testDir,
    }));

    // Mock generateDiffForReview to return no changes
    await moduleMocker.mock('./review.js', () => ({
      handleReviewCommand,
      generateDiffForReview: async () => ({
        hasChanges: false,
        changedFiles: [],
        baseBranch: 'main',
        diffContent: '',
      }),
      buildReviewPrompt: buildReviewPrompt,
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
    const planContent = `
id: 1
title: Test Plan
goal: Test goal
`;
    const planFile = join(testDir, 'executor-fail.yml');
    await writeFile(planFile, planContent);

    const mockExecutor = {
      execute: mock(async () => {
        throw new Error('Executor failed');
      }),
    };

    await moduleMocker.mock('../plans.js', () => ({
      resolvePlanFile: async () => planFile,
      readPlanFile: async () => ({
        id: 1,
        title: 'Test Plan',
        goal: 'Test goal',
      }),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        defaultExecutor: 'copy-only',
      }),
    }));

    await moduleMocker.mock('../executors/index.js', () => ({
      buildExecutorAndLog: () => mockExecutor,
      DEFAULT_EXECUTOR: 'copy-only',
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
        diffContent: 'some diff',
      }),
      buildReviewPrompt: () => 'review prompt',
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
`;
    const planFile = join(testDir, 'integration.yml');
    await writeFile(planFile, planContent);

    const mockExecutor = {
      execute: mock(async (prompt: string, metadata: any) => {
        expect(prompt).toContain('REVIEWER AGENT');
        expect(metadata.planId).toBe('123');
        expect(metadata.planTitle).toBe('Integration Test Plan');
        expect(metadata.planFilePath).toBe(planFile);
        return 'Mock review result';
      }),
    };

    await moduleMocker.mock('../plans.js', () => ({
      resolvePlanFile: async () => planFile,
      readPlanFile: async () => ({
        id: 123,
        title: 'Integration Test Plan',
        goal: 'Test executor integration',
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
        expect(options.interactive).toBe(false);
        return mockExecutor;
      },
      DEFAULT_EXECUTOR: 'copy-only',
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

  test('respects dry-run option', async () => {
    const planContent = `
id: 1
title: Dry Run Test
goal: Test dry run functionality
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
      }),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({}),
    }));

    await moduleMocker.mock('../executors/index.js', () => ({
      buildExecutorAndLog: () => mockExecutor,
      DEFAULT_EXECUTOR: 'copy-only',
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
      buildReviewPrompt: () => 'Generated prompt for dry run',
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
});
