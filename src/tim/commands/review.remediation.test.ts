/**
 * Covers the `tim review` side of advisor remediation planning: which reviews trigger a
 * consultation, where the plan lands in the review result, and what a failed consultation
 * does to a review that already succeeded.
 *
 * The provider call is the only part of the advisor run that is faked. The gate, the advisor
 * prompt, and the plumbing back into the review result all run for real.
 */
import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { clearConfigCache } from '../configLoader.js';
import { closeDatabaseForTesting } from '../db/database.js';
import { writePlanFile } from '../plans.js';
import type { PlanSchema } from '../planSchema.js';
import type { ReviewResult } from '../formatters/review_formatter.js';
import * as notificationsModule from '../notifications.js';
import * as configLoaderModule from '../configLoader.js';
import * as gitModule from '../../common/git.js';
import * as tunnelClientModule from '../../logging/tunnel_client.js';
import * as contextGatheringModule from '../utils/context_gathering.js';
import * as reviewRunnerModule from '../review_runner.js';
import * as reviewFormatterModule from '../formatters/review_formatter.js';
import * as reviewDiffModule from '../review_diff.js';
import * as reviewPersistenceModule from '../review_persistence.js';
import * as codexRunnerModule from '../executors/codex_cli/codex_runner.js';

vi.mock('../notifications.js', () => ({
  sendNotification: vi.fn(),
}));

vi.mock('../configLoader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof configLoaderModule>()),
  loadEffectiveConfig: vi.fn(),
  loadGlobalConfigForNotifications: vi.fn(),
}));

vi.mock('../../common/git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof gitModule>()),
  getGitRoot: vi.fn(),
  getCurrentCommitHash: vi.fn(),
  getTrunkBranch: vi.fn(),
  getUsingJj: vi.fn(),
  getCurrentBranchName: vi.fn(),
}));

vi.mock('../../logging/tunnel_client.js', () => ({
  isTunnelActive: vi.fn(),
}));

vi.mock('../utils/context_gathering.js', () => ({
  gatherPlanContext: vi.fn(),
}));

vi.mock('../review_runner.js', () => ({
  runReview: vi.fn(),
  prepareReviewExecutors: vi.fn(),
}));

vi.mock('../formatters/review_formatter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof reviewFormatterModule>()),
  createFormatter: vi.fn(),
}));

vi.mock('../review_diff.js', async (importOriginal) => ({
  ...(await importOriginal<typeof reviewDiffModule>()),
  generateDiffForReview: vi.fn(),
}));

vi.mock('../review_persistence.js', () => ({
  saveReviewResult: vi.fn(),
  createReviewsDirectory: vi.fn(),
  createGitNote: vi.fn(),
}));

vi.mock('../executors/codex_cli/codex_runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof codexRunnerModule>()),
  executeCodexStep: vi.fn(),
}));

const basePlan: PlanSchema = {
  id: 123,
  title: 'Remediation Plan Test',
  goal: 'Goal',
  details: 'Details',
  status: 'pending',
  uuid: '12312312-1231-1231-8231-123123123123',
  tasks: [{ title: 'Build the queue', description: 'Write the queue', done: false }],
};

const baseDiff = {
  hasChanges: true,
  changedFiles: ['src/queue.ts'],
  baseBranch: 'main',
  diffContent: 'diff',
};

const mockCommand = { parent: { opts: () => ({}) } };

let tempDir: string;
let tasksDir: string;
let planFile: string;
let advisorConfig: Record<string, unknown>;
let formattedResults: ReviewResult[];
let originalXdgConfigHome: string | undefined;

function reviewOutput(severity: 'major' | 'minor') {
  return {
    reviewResult: {
      planId: '123',
      planTitle: basePlan.title,
      reviewTimestamp: '2024-01-01T00:00:00.000Z',
      baseBranch: 'main',
      changedFiles: baseDiff.changedFiles,
      summary: {
        totalIssues: 1,
        criticalCount: 0,
        majorCount: severity === 'major' ? 1 : 0,
        minorCount: severity === 'minor' ? 1 : 0,
        infoCount: 0,
        categoryCounts: {},
        filesReviewed: 1,
      },
      issues: [
        {
          id: '1',
          severity,
          category: 'bug',
          content: 'The queue drops a message when the worker restarts.',
          file: 'src/queue.ts',
          line: 42,
        },
      ],
      rawOutput: 'raw',
      recommendations: [],
      actionItems: [],
    },
    rawOutput: 'raw',
    usedExecutors: ['claude-code'],
    warnings: [],
  };
}

beforeEach(async () => {
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  tempDir = await mkdtemp(join(tmpdir(), 'tim-review-remediation-'));
  tasksDir = join(tempDir, 'tasks');
  planFile = join(tasksDir, '123-plan.plan.md');
  process.env.XDG_CONFIG_HOME = join(tempDir, 'config-home');
  await mkdir(tasksDir, { recursive: true });
  formattedResults = [];

  await Bun.$`git init`.cwd(tempDir).quiet();
  await Bun.$`git config user.email test@example.com`.cwd(tempDir).quiet();
  await Bun.$`git config user.name "Test User"`.cwd(tempDir).quiet();

  vi.mocked(gitModule.getGitRoot).mockResolvedValue(tempDir);
  vi.mocked(gitModule.getCurrentCommitHash).mockResolvedValue(undefined as any);
  vi.mocked(gitModule.getTrunkBranch).mockResolvedValue('main');
  vi.mocked(gitModule.getUsingJj).mockResolvedValue(false);
  vi.mocked(gitModule.getCurrentBranchName).mockResolvedValue('main');

  // The advisor run resolves the plan for real, so it has to exist on disk and in the database.
  await writePlanFile(planFile, basePlan, {
    cwdForIdentity: tempDir,
    config: { paths: { tasks: tasksDir } },
  });
  advisorConfig = {
    paths: { tasks: tasksDir },
    subagents: { advisor: { executor: 'codex-cli', model: { codex: 'gpt-5.6:high' } } },
  };
  // `tim subagent advisor` reads its own config from disk rather than from the review command.
  await writeFile(
    join(tempDir, '.tim.yml'),
    ['paths:', `  tasks: ${JSON.stringify(tasksDir)}`, ''].join('\n'),
    'utf8'
  );
  clearConfigCache();

  vi.mocked(notificationsModule.sendNotification).mockResolvedValue(true);
  vi.mocked(reviewRunnerModule.runReview).mockResolvedValue(reviewOutput('major') as any);
  vi.mocked(reviewRunnerModule.prepareReviewExecutors).mockResolvedValue([] as any);
  vi.mocked(contextGatheringModule.gatherPlanContext).mockResolvedValue({
    resolvedPlanFile: planFile,
    planData: { ...basePlan },
    repoRoot: tempDir,
    gitRoot: tempDir,
    parentChain: [],
    completedChildren: [],
    diffResult: { ...baseDiff },
    noChangesDetected: false,
  } as any);
  vi.mocked(configLoaderModule.loadEffectiveConfig).mockImplementation(
    async () => advisorConfig as any
  );
  vi.mocked(configLoaderModule.loadGlobalConfigForNotifications).mockResolvedValue({} as any);
  vi.mocked(tunnelClientModule.isTunnelActive).mockReturnValue(false);
  vi.mocked(reviewFormatterModule.createFormatter).mockReturnValue({
    format: (result: ReviewResult) => {
      formattedResults.push(result);
      return 'formatted';
    },
    getFileExtension: () => '.md',
  } as any);
  vi.mocked(reviewDiffModule.generateDiffForReview).mockResolvedValue({ ...baseDiff } as any);
  vi.mocked(reviewPersistenceModule.saveReviewResult).mockResolvedValue('' as any);
  vi.mocked(reviewPersistenceModule.createReviewsDirectory).mockResolvedValue('' as any);
  vi.mocked(reviewPersistenceModule.createGitNote).mockResolvedValue(false);
  vi.mocked(codexRunnerModule.executeCodexStep).mockResolvedValue(
    '## Root causes\nThe restart path never re-enqueues.'
  );
});

afterEach(async () => {
  vi.clearAllMocks();
  closeDatabaseForTesting();
  clearConfigCache();
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
  await rm(tempDir, { recursive: true, force: true });
});

async function runReviewCommand(options: Record<string, unknown> = {}): Promise<void> {
  const { handleReviewCommand } = await import('./review.js');
  await handleReviewCommand(
    123,
    { noSave: true, noAutofix: true, print: true, ...options },
    mockCommand
  );
}

describe('tim review advisor remediation planning', () => {
  test('attaches an advisor remediation plan to a full-plan review with blocking findings', async () => {
    await runReviewCommand();

    expect(vi.mocked(codexRunnerModule.executeCodexStep)).toHaveBeenCalledTimes(1);
    const advisorPrompt = vi.mocked(codexRunnerModule.executeCodexStep).mock.calls[0][0];
    expect(advisorPrompt).toContain('You are a tim advisor agent');
    expect(advisorPrompt).toContain('# Remediation Planning Request');
    expect(advisorPrompt).toContain('The queue drops a message when the worker restarts.');
    expect(advisorPrompt).toContain('Review scope: the full plan');

    expect(formattedResults).toHaveLength(1);
    expect(formattedResults[0].remediationPlan).toBe(
      '## Root causes\nThe restart path never re-enqueues.'
    );
  });

  test('skips the consultation for a task-scoped review', async () => {
    await runReviewCommand({ taskIndex: '1' });

    expect(vi.mocked(codexRunnerModule.executeCodexStep)).not.toHaveBeenCalled();
    expect(formattedResults[0].remediationPlan).toBeUndefined();
  });

  test('skips the consultation when no advisor is configured', async () => {
    advisorConfig = { paths: { tasks: tasksDir } };

    await runReviewCommand();

    expect(vi.mocked(codexRunnerModule.executeCodexStep)).not.toHaveBeenCalled();
    expect(formattedResults[0].remediationPlan).toBeUndefined();
  });

  test('skips the consultation when --no-remediation-plan is passed', async () => {
    await runReviewCommand({ remediationPlan: false });

    expect(vi.mocked(codexRunnerModule.executeCodexStep)).not.toHaveBeenCalled();
    expect(formattedResults[0].remediationPlan).toBeUndefined();
  });

  test('skips the consultation when the review found nothing blocking', async () => {
    vi.mocked(reviewRunnerModule.runReview).mockResolvedValue(reviewOutput('minor') as any);

    await runReviewCommand();

    expect(vi.mocked(codexRunnerModule.executeCodexStep)).not.toHaveBeenCalled();
    expect(formattedResults[0].remediationPlan).toBeUndefined();
  });

  test('keeps the review result when the advisor consultation fails', async () => {
    vi.mocked(codexRunnerModule.executeCodexStep).mockRejectedValue(new Error('advisor exploded'));

    await runReviewCommand();

    expect(formattedResults).toHaveLength(1);
    expect(formattedResults[0].remediationPlan).toBeUndefined();
    expect(formattedResults[0].issues).toHaveLength(1);
  });
});
