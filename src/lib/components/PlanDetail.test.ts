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
    hasPlanPrLinks: false,
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
    expect(body).not.toContain('View PR #42');
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
          needsFinishExecutor: true,
        }),
        projectId: '123',
      },
    });

    expect(body).toContain('Update Docs');
    expect(body).not.toContain('Generate');
  });

  test('does not show Update Docs when needs_review but finish work already done', () => {
    const { body } = render(PlanDetailComponent, {
      props: {
        plan: makePlanDetail({
          status: 'needs_review',
          displayStatus: 'needs_review',
          needsFinishExecutor: false,
          docsUpdatedAt: '2026-03-18T10:00:00.000Z',
          lessonsAppliedAt: '2026-03-18T10:00:00.000Z',
        }),
        projectId: '123',
      },
    });

    // Should show "Finish" button (not "Update Docs") since finish work is done
    expect(body).toContain('Finish');
    expect(body).not.toContain('Update Docs');
  });

  test('shows note content when plan has a note', () => {
    const { body } = render(PlanDetailComponent, {
      props: {
        plan: makePlanDetail({
          note: 'Internal note for this plan',
        }),
        projectId: '123',
      },
    });

    expect(body).toContain('Note');
    expect(body).toContain('Internal note for this plan');
  });

  test('shows PR section when plan has explicit PR URLs', () => {
    const { body } = render(PlanDetailComponent, {
      props: {
        plan: makePlanDetail({
          pullRequests: ['https://github.com/example/repo/pull/42'],
          invalidPrUrls: [],
        }),
        projectId: '123',
      },
    });

    expect(body).toContain('Linked PR plan');
  });

  test('shows PR section when plan has invalid PR URLs', () => {
    const { body } = render(PlanDetailComponent, {
      props: {
        plan: makePlanDetail({
          pullRequests: [],
          invalidPrUrls: ['not-a-url', 'owner/repo#123'],
        }),
        projectId: '123',
      },
    });

    expect(body).toContain('Linked PR plan');
  });

  test('shows PR section when plan has auto-linked PRs (via prStatuses)', () => {
    const { body } = render(PlanDetailComponent, {
      props: {
        plan: makePlanDetail({
          pullRequests: [],
          invalidPrUrls: [],
          prStatuses: [makePrStatusDetail()],
        }),
        projectId: '123',
      },
    });

    expect(body).toContain('Linked PR plan');
  });

  test('does not show PR section when plan has no PR data', () => {
    const { body } = render(PlanDetailComponent, {
      props: {
        plan: makePlanDetail({
          pullRequests: [],
          invalidPrUrls: [],
          prStatuses: [],
        }),
        projectId: '123',
      },
    });

    expect(body).not.toContain('PrStatusSection');
  });
});
