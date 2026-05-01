import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import type { PlanDetail } from '$lib/server/db_queries.js';
import type { PrStatusRow } from '$tim/db/pr_status.js';
import type { PrStatusDetailWithRequiredChecks } from '$lib/server/required_check_rollup.js';
import PlanDetailComponent from './PlanDetail.svelte';

vi.mock('$app/navigation', () => ({
  afterNavigate: vi.fn(),
  invalidateAll: vi.fn(),
}));

vi.mock('$lib/remote/plan_actions.remote.js', () => ({
  startGenerate: vi.fn(),
  startAgent: vi.fn(),
  startChat: vi.fn(),
  startRebase: vi.fn(),
  startUpdateDocs: vi.fn(),
  startCreatePr: vi.fn(),
  finishPlanQuick: vi.fn(),
  openInEditor: vi.fn(),
}));

vi.mock('$lib/remote/review_issue_actions.remote.js', () => ({
  removeReviewIssue: vi.fn(),
  convertReviewIssueToTask: vi.fn(),
  clearReviewIssues: vi.fn(),
}));

vi.mock('./PrStatusSection.svelte', () => ({
  default: () => '',
}));

vi.mock('./CopyButton.svelte', () => ({
  default: () => '',
}));

vi.mock('$lib/stores/session_state.svelte.js', () => ({
  useSessionManager: () => ({
    sessions: new Map(),
    openTerminalInDirectory: vi.fn(),
    onEvent: vi.fn(() => () => {}),
  }),
}));

vi.mock('svelte-sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function makePrStatus(overrides: Partial<PrStatusRow> = {}): PrStatusRow {
  return {
    id: 1,
    pr_url: 'https://github.com/example/repo/pull/42',
    owner: 'example',
    repo: 'repo',
    pr_number: 42,
    author: 'alice',
    title: 'Add feature',
    state: 'open',
    draft: 0,
    mergeable: 'MERGEABLE',
    head_sha: 'abc123',
    base_branch: 'main',
    head_branch: 'feature/link-pr',
    requested_reviewers: null,
    review_decision: null,
    check_rollup_state: 'success',
    merged_at: null,
    additions: null,
    deletions: null,
    changed_files: null,
    pr_updated_at: null,
    latest_commit_pushed_at: null,
    last_fetched_at: '2026-03-18T10:00:00.000Z',
    created_at: '2026-03-18T10:00:00.000Z',
    updated_at: '2026-03-18T10:00:00.000Z',
    ...overrides,
  };
}

function makePrStatusDetail(
  overrides: Partial<PrStatusRow> = {}
): PrStatusDetailWithRequiredChecks {
  return {
    status: makePrStatus(overrides),
    requiredCheckNames: [],
    checks: [],
    reviews: [],
    reviewRequests: [],
    labels: [],
    reviewThreads: [],
  };
}

function makePlanDetail(overrides: Partial<PlanDetail> = {}): PlanDetail {
  return {
    uuid: 'plan-1',
    projectId: 123,
    planId: 1,
    title: 'Action selection plan',
    goal: 'Verify plan action selection',
    details: null,
    status: 'pending',
    displayStatus: 'pending',
    priority: 'medium',
    branch: 'feature/simple-plan',
    parentUuid: null,
    epic: false,
    simple: false,
    createdAt: '2026-03-18T10:00:00.000Z',
    updatedAt: '2026-03-18T10:00:00.000Z',
    pullRequests: [],
    invalidPrUrls: [],
    issues: [],
    prSummaryStatus: 'none',
    hasPlanPrLinks: false,
    docsUpdatedAt: null,
    lessonsAppliedAt: null,
    canUpdateDocs: false,
    tags: [],
    dependencyUuids: [],
    tasks: [],
    taskCounts: { done: 0, total: 0 },
    reviewIssueCount: 0,
    dependencies: [],
    assignment: null,
    parent: null,
    prStatuses: [makePrStatusDetail()],
    reviewIssues: undefined,
    ...overrides,
  };
}

function renderPlan(plan: PlanDetail) {
  return render(PlanDetailComponent, {
    props: {
      plan,
      projectId: '123',
    },
  });
}

describe('PlanDetail action selection', () => {
  test('shows Run Agent without Generate for a taskless simple plan', async () => {
    renderPlan(
      makePlanDetail({
        simple: true,
        tasks: [],
        taskCounts: { done: 0, total: 0 },
        prStatuses: [],
      })
    );

    await expect.element(page.getByRole('button', { name: 'Run Agent' })).toBeInTheDocument();
    await expect.element(page.getByText('Generate')).not.toBeInTheDocument();
  });

  test('keeps Run Agent as primary for a simple plan with incomplete tasks', async () => {
    renderPlan(
      makePlanDetail({
        status: 'in_progress',
        displayStatus: 'in_progress',
        simple: true,
        tasks: [
          {
            id: 1,
            taskIndex: 0,
            title: 'Implement the change',
            description: '',
            done: false,
          },
        ],
        taskCounts: { done: 0, total: 1 },
        prStatuses: [],
      })
    );

    await expect.element(page.getByRole('button', { name: 'Run Agent' })).toBeInTheDocument();
    await expect.element(page.getByText('Generate')).not.toBeInTheDocument();
  });

  test('keeps Generate primary and Run Agent in the dropdown for a taskless non-simple plan', async () => {
    const screen = renderPlan(
      makePlanDetail({
        simple: false,
        tasks: [],
        taskCounts: { done: 0, total: 0 },
        prStatuses: [],
      })
    );

    await expect.element(page.getByRole('button', { name: 'Generate' })).toBeInTheDocument();
    await screen.getByRole('button', { name: 'More actions' }).click();
    await expect.element(page.getByRole('menuitem', { name: 'Run Agent' })).toBeInTheDocument();
  });
});
