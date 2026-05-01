import { render } from 'svelte/server';
import { describe, expect, test, vi } from 'vitest';

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

vi.mock('./ActionButtonWithDropdown.svelte', () => ({
  default: (
    payload: { push: (content: string) => void },
    props: {
      primary: { label: string };
      menuItems?: Array<{ label: string }>;
    }
  ) => {
    payload.push(`<div data-testid="action-config"><button>${props.primary.label}</button>`);
    for (const item of props.menuItems ?? []) {
      payload.push(`<button>${item.label}</button>`);
    }
    payload.push('</div>');
  },
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

describe('PlanDetail', () => {
  test('shows branch and PR context when the plan is linked to a known PR', () => {
    const { body } = render(PlanDetailComponent, {
      props: {
        plan: makePlanDetail(),
        projectId: '123',
      },
    });

    expect(body).toContain('feature/link-pr');
    expect(body).toContain('Linked PR plan');
  });

  test('shows Finish for a taskless epic outside needs_review', () => {
    const { body } = render(PlanDetailComponent, {
      props: {
        plan: makePlanDetail({
          status: 'pending',
          displayStatus: 'pending',
          epic: true,
          tasks: [],
          taskCounts: { done: 0, total: 0 },
          canUpdateDocs: true,
        }),
        projectId: '123',
      },
    });

    expect(body).toContain('Finish');
    expect(body).not.toContain('Generate');
  });

  test('does not show Update Docs when needs_review but finish work already done', () => {
    const { body } = render(PlanDetailComponent, {
      props: {
        plan: makePlanDetail({
          status: 'needs_review',
          displayStatus: 'needs_review',
          canUpdateDocs: false,
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

  test('shows Run Agent without Generate for a taskless simple plan', () => {
    const { body } = render(PlanDetailComponent, {
      props: {
        plan: makePlanDetail({
          status: 'pending',
          displayStatus: 'pending',
          simple: true,
          tasks: [],
          taskCounts: { done: 0, total: 0 },
          prStatuses: [],
        }),
        projectId: '123',
      },
    });

    expect(body).toContain('Run Agent');
    expect(body).not.toContain('Generate');
  });

  test('keeps Run Agent as primary for a simple plan with incomplete tasks', () => {
    const { body } = render(PlanDetailComponent, {
      props: {
        plan: makePlanDetail({
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
        }),
        projectId: '123',
      },
    });

    expect(body).toContain('Run Agent');
    expect(body).not.toContain('Generate');
  });

  test('keeps Generate primary and Run Agent in the dropdown for a taskless non-simple plan', () => {
    const { body } = render(PlanDetailComponent, {
      props: {
        plan: makePlanDetail({
          status: 'pending',
          displayStatus: 'pending',
          simple: false,
          tasks: [],
          taskCounts: { done: 0, total: 0 },
          prStatuses: [],
        }),
        projectId: '123',
      },
    });

    expect(body).toContain('<div data-testid="action-config"><button>Generate</button>');
    expect(body).toContain('Run Agent');
    expect(body.indexOf('Generate')).toBeLessThan(body.indexOf('Run Agent'));
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

  test('sorts dependencies by plan number', () => {
    const { body } = render(PlanDetailComponent, {
      props: {
        plan: makePlanDetail({
          dependencies: [
            {
              uuid: 'dep-30',
              projectId: 123,
              planId: 30,
              title: 'Plan thirty',
              status: 'in_progress',
              displayStatus: 'in_progress',
              isResolved: false,
            },
            {
              uuid: 'dep-10',
              projectId: 123,
              planId: 10,
              title: 'Plan ten',
              status: 'pending',
              displayStatus: 'pending',
              isResolved: false,
            },
            {
              uuid: 'dep-20',
              projectId: 123,
              planId: 20,
              title: 'Plan twenty',
              status: 'done',
              displayStatus: 'done',
              isResolved: true,
            },
          ],
        }),
        projectId: '123',
      },
    });

    const dep10 = body.indexOf('href="/projects/123/plans/dep-10"');
    const dep20 = body.indexOf('href="/projects/123/plans/dep-20"');
    const dep30 = body.indexOf('href="/projects/123/plans/dep-30"');

    expect(dep10).toBeGreaterThanOrEqual(0);
    expect(dep20).toBeGreaterThanOrEqual(0);
    expect(dep30).toBeGreaterThanOrEqual(0);
    expect(dep10).toBeLessThan(dep20);
    expect(dep20).toBeLessThan(dep30);
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
