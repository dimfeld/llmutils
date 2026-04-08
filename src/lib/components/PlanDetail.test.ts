import { render } from 'svelte/server';
import { describe, expect, test, vi } from 'vitest';

import type { PlanDetail } from '$lib/server/db_queries.js';
import type { PrStatusDetail, PrStatusRow } from '$tim/db/pr_status.js';
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
  startFinish: vi.fn(),
  finishPlanQuick: vi.fn(),
  openInEditor: vi.fn(),
}));

vi.mock('$lib/remote/review_issue_actions.remote.js', () => ({
  removeReviewIssue: vi.fn(),
  convertReviewIssueToTask: vi.fn(),
  clearReviewIssues: vi.fn(),
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
    pr_updated_at: null,
    last_fetched_at: '2026-03-18T10:00:00.000Z',
    created_at: '2026-03-18T10:00:00.000Z',
    updated_at: '2026-03-18T10:00:00.000Z',
    ...overrides,
  };
}

function makePrStatusDetail(overrides: Partial<PrStatusRow> = {}): PrStatusDetail {
  return {
    status: makePrStatus(overrides),
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
    title: 'Linked PR plan',
    goal: 'Show the PR route link',
    details: null,
    status: 'in_progress',
    displayStatus: 'in_progress',
    priority: 'medium',
    branch: 'feature/link-pr',
    parentUuid: null,
    epic: false,
    simple: false,
    createdAt: '2026-03-18T10:00:00.000Z',
    updatedAt: '2026-03-18T10:00:00.000Z',
    pullRequests: [],
    invalidPrUrls: [],
    issues: [],
    prSummaryStatus: 'none',
    docsUpdatedAt: null,
    lessonsAppliedAt: null,
    needsFinishExecutor: false,
    tags: [],
    dependencyUuids: [],
    tasks: [],
    taskCounts: { done: 0, total: 0 },
    dependencies: [],
    assignment: null,
    parent: null,
    prStatuses: [makePrStatusDetail()],
    reviewIssues: undefined,
    ...overrides,
  };
}

describe('PlanDetail', () => {
  test('shows a route link when the branch is linked to a known PR', () => {
    const { body } = render(PlanDetailComponent, {
      props: {
        plan: makePlanDetail(),
        projectId: '123',
      },
    });

    expect(body).toContain('href="/projects/123/prs/42"');
    expect(body).toContain('View PR #42');
  });

  test('shows Update Docs for a taskless epic outside needs_review', () => {
    const { body } = render(PlanDetailComponent, {
      props: {
        plan: makePlanDetail({
          status: 'pending',
          displayStatus: 'pending',
          epic: true,
          tasks: [],
          taskCounts: { done: 0, total: 0 },
        }),
        projectId: '123',
      },
    });

    expect(body).toContain('Update Docs');
    expect(body).not.toContain('Generate');
  });
});
