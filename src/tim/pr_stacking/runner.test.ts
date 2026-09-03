import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { TimConfig } from '../configSchema.js';
import type { PlanSchema } from '../planSchema.js';
import { buildPrStackingPrompt, runPrStacking } from './runner.js';

const {
  countChangedLinesSpy,
  executeSpy,
  fetchOpenPullRequestsSpy,
  generateDiffForReviewSpy,
  getDatabaseSpy,
  getGitRepositorySpy,
  getUsingJjSpy,
  getPrStatusByUrlSpy,
  linkPlanToPrsSpy,
  refreshPrStatusSpy,
  resolveEffectivePrBaseSpy,
} = vi.hoisted(() => ({
  countChangedLinesSpy: vi.fn(async () => 500),
  executeSpy: vi.fn(async () => {}),
  fetchOpenPullRequestsSpy: vi.fn(async () => []),
  generateDiffForReviewSpy: vi.fn(async () => ({
    hasChanges: true,
    changedFiles: ['src/a.ts'],
    baseBranch: 'main',
    mergeBaseCommit: 'abc1234',
    diffContent: 'diff',
  })),
  getDatabaseSpy: vi.fn(() => ({})),
  getGitRepositorySpy: vi.fn(async () => 'acme/repo'),
  getUsingJjSpy: vi.fn(async () => false),
  getPrStatusByUrlSpy: vi.fn(() => null),
  linkPlanToPrsSpy: vi.fn(),
  refreshPrStatusSpy: vi.fn(async (db: unknown, prUrl: string) => ({
    status: { id: Number(prUrl.split('/').at(-1)) },
    checks: [],
    reviews: [],
    reviewRequests: [],
    labels: [],
  })),
  resolveEffectivePrBaseSpy: vi.fn(async () => 'main'),
}));

vi.mock('../../common/git.js', () => ({
  getGitRepository: getGitRepositorySpy,
  getUsingJj: getUsingJjSpy,
}));

vi.mock('../../common/github/pull_requests.js', () => ({
  fetchOpenPullRequests: fetchOpenPullRequestsSpy,
}));

vi.mock('../../common/github/pr_status_service.js', () => ({
  refreshPrStatus: refreshPrStatusSpy,
}));

vi.mock('../commands/create_pr.js', () => ({
  resolveEffectivePrBase: resolveEffectivePrBaseSpy,
}));

vi.mock('../db/database.js', () => ({
  getDatabase: getDatabaseSpy,
}));

vi.mock('../db/pr_status.js', () => ({
  getPrStatusByUrl: getPrStatusByUrlSpy,
  linkPlanToPrs: linkPlanToPrsSpy,
}));

vi.mock('../review_diff.js', () => ({
  generateDiffForReview: generateDiffForReviewSpy,
}));

vi.mock('./changed_lines.js', () => ({
  countChangedLines: countChangedLinesSpy,
}));

vi.mock('../executors/index.js', () => ({
  buildExecutorAndLog: vi.fn(() => ({ execute: executeSpy })),
  DEFAULT_EXECUTOR: 'claude-code',
  defaultModelForExecutor: vi.fn(() => 'default-model'),
}));

vi.mock('../environment_options.js', () => ({
  buildTimWorkspaceCommandEnvironmentOptionsForPath: vi.fn(() => ({})),
}));

vi.mock('../../logging.js', () => ({
  boldMarkdownHeaders: vi.fn((value: string) => value),
  log: vi.fn(),
}));

const plan: PlanSchema = {
  id: 12,
  uuid: 'plan-uuid',
  title: 'Add stacked review flow',
  goal: 'Make a large change easier to review.',
  branch: 'feature/stack-review',
  tasks: [],
};

function config(minChangedLines = 400): TimConfig {
  return {
    defaultExecutor: 'claude-code',
    postApplyCommands: [],
    prCreation: { draft: true },
    assignments: { staleTimeout: 7 },
    prStacking: { minChangedLines, model: 'stack-model' },
  };
}

describe('runPrStacking', () => {
  beforeEach(() => {
    countChangedLinesSpy.mockClear();
    countChangedLinesSpy.mockResolvedValue(500);
    executeSpy.mockClear();
    fetchOpenPullRequestsSpy.mockClear();
    fetchOpenPullRequestsSpy.mockResolvedValue([]);
    generateDiffForReviewSpy.mockClear();
    generateDiffForReviewSpy.mockResolvedValue({
      hasChanges: true,
      changedFiles: ['src/a.ts'],
      baseBranch: 'main',
      mergeBaseCommit: 'abc1234',
      diffContent: 'diff',
    });
    getUsingJjSpy.mockClear();
    getUsingJjSpy.mockResolvedValue(false);
    getDatabaseSpy.mockClear();
    getGitRepositorySpy.mockClear();
    getGitRepositorySpy.mockResolvedValue('acme/repo');
    getPrStatusByUrlSpy.mockClear();
    getPrStatusByUrlSpy.mockReturnValue(null);
    linkPlanToPrsSpy.mockClear();
    refreshPrStatusSpy.mockClear();
    resolveEffectivePrBaseSpy.mockClear();
    resolveEffectivePrBaseSpy.mockResolvedValue('main');
  });

  test('skips without inspecting the repository when minChangedLines is not configured', async () => {
    const result = await runPrStacking({
      plan,
      planFilePath: '/repo/.tim/plans/12.yml',
      mainPrUrl: 'https://github.com/acme/repo/pull/20',
      baseDir: '/repo',
      config: { ...config(), prStacking: { executor: 'codex-cli' } },
    });

    expect(result).toEqual({ ran: false, changedLines: 0, reason: 'not-configured' });
    expect(resolveEffectivePrBaseSpy).not.toHaveBeenCalled();
    expect(executeSpy).not.toHaveBeenCalled();
  });

  test('skips when the measured diff is below the configured threshold', async () => {
    countChangedLinesSpy.mockResolvedValue(399);

    const result = await runPrStacking({
      plan,
      planFilePath: '/repo/.tim/plans/12.yml',
      mainPrUrl: 'https://github.com/acme/repo/pull/20',
      baseDir: '/repo',
      config: config(),
    });

    expect(result).toEqual({ ran: false, changedLines: 399, reason: 'below-threshold' });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  test('runs manually without the automatic threshold configuration', async () => {
    countChangedLinesSpy.mockResolvedValue(20);

    const result = await runPrStacking({
      plan,
      planFilePath: '/repo/.tim/plans/12.yml',
      mainPrUrl: 'https://github.com/acme/repo/pull/20',
      baseDir: '/repo',
      config: { ...config(), prStacking: undefined },
      manual: true,
    });

    expect(result).toEqual({ ran: true, changedLines: 20 });
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  test('runs at the configured threshold and supplies the resolved stack context', async () => {
    countChangedLinesSpy.mockResolvedValue(400);

    const result = await runPrStacking({
      plan,
      planFilePath: '/repo/.tim/plans/12.yml',
      mainPrUrl: 'https://github.com/acme/repo/pull/20',
      baseDir: '/repo',
      config: config(),
    });

    expect(result).toEqual({ ran: true, changedLines: 400 });
    expect(countChangedLinesSpy).toHaveBeenCalledWith('/repo', 'abc1234', 'git');
    expect(executeSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'Keep feature/stack-review and https://github.com/acme/repo/pull/20 as the top'
      ),
      expect.objectContaining({ executionMode: 'bare', captureOutput: 'none' })
    );
  });

  test('uses the changed-line count when the review file list omits deletion-only changes', async () => {
    generateDiffForReviewSpy.mockResolvedValue({
      hasChanges: false,
      changedFiles: [],
      baseBranch: 'main',
      mergeBaseCommit: 'abc1234',
      diffContent: 'diff',
    });
    countChangedLinesSpy.mockResolvedValue(400);

    const result = await runPrStacking({
      plan,
      planFilePath: '/repo/.tim/plans/12.yml',
      mainPrUrl: 'https://github.com/acme/repo/pull/20',
      baseDir: '/repo',
      config: config(),
    });

    expect(result).toEqual({ ran: true, changedLines: 400 });
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  test('associates every pull request in the discovered stack with the plan', async () => {
    fetchOpenPullRequestsSpy.mockResolvedValue([
      {
        number: 20,
        title: 'Top PR',
        headRefName: 'feature/stack-review',
        baseRefName: 'feature/slice-two',
        html_url: 'https://github.com/acme/repo/pull/20',
        user: { login: 'dimfeld' },
      },
      {
        number: 19,
        title: 'Slice two',
        headRefName: 'feature/slice-two',
        baseRefName: 'feature/slice-one',
        html_url: 'https://github.com/acme/repo/pull/19',
        user: { login: 'dimfeld' },
      },
      {
        number: 18,
        title: 'Slice one',
        headRefName: 'feature/slice-one',
        baseRefName: 'main',
        html_url: 'https://github.com/acme/repo/pull/18',
        user: { login: 'dimfeld' },
      },
      {
        number: 17,
        title: 'Unrelated PR',
        headRefName: 'feature/unrelated',
        baseRefName: 'main',
        html_url: 'https://github.com/acme/repo/pull/17',
        user: { login: 'dimfeld' },
      },
    ]);

    const result = await runPrStacking({
      plan,
      planFilePath: '/repo/.tim/plans/12.yml',
      mainPrUrl: 'https://github.com/acme/repo/pull/20',
      baseDir: '/repo',
      config: config(),
    });

    expect(result).toEqual({ ran: true, changedLines: 500 });
    expect(refreshPrStatusSpy).toHaveBeenCalledTimes(3);
    expect(linkPlanToPrsSpy).toHaveBeenCalledWith({}, 'plan-uuid', [20, 19, 18], 'auto');
  });

  test('prompt requires vertical slices, draft lower PRs, stack metadata, and tree preservation', () => {
    const prompt = buildPrStackingPrompt({
      plan,
      vcsType: 'jj',
      mainBranch: 'feature/stack-review',
      mainPrUrl: 'https://github.com/acme/repo/pull/20',
      baseBranch: 'main',
      comparisonRef: 'abc1234',
      changedLines: 500,
      targetMaxChangedLines: 400,
    });

    expect(prompt).toContain('vertical slices');
    expect(prompt).toContain('one commit per vertical slice');
    expect(prompt).toContain('keep each slice below 400 changed lines');
    expect(prompt).toContain('inspect every large candidate slice for further coherent splits');
    expect(prompt).toContain('does not need to contain the full end-to-end functionality');
    expect(prompt).toContain('Every PR must still pass CI');
    expect(prompt).toContain('Create every new lower-slice pull request as a draft');
    expect(prompt).toContain('clearly marked "Stack" section');
    expect(prompt).toContain('same final tree');
    expect(prompt).toContain(
      'A single changed file may have its hunks distributed across several slices and branches'
    );
    expect(prompt).toContain(
      'Intermediate branches may contain new changes or a temporary version of a file'
    );
    expect(prompt).toContain(
      'do not include that issue tag at the end of any new lower-slice branch name'
    );
    expect(prompt).toContain('refer to related issues with language such as "Related to ISSUE"');
    expect(prompt).toContain('Do not use "Closes", "Fixes", or other issue-closing keywords');
    expect(prompt).toContain('leave all commits, branches, and pull requests unchanged');
  });
});
