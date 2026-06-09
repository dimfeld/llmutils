import { render } from 'svelte/server';
import { describe, expect, test, vi } from 'vitest';

import type { PlanDetail } from '$lib/server/db_queries.js';
import type { PrStatusRow } from '$tim/db/pr_status.js';
import type { ReviewWithIssueCounts } from '$tim/db/review.js';
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
  startReview: vi.fn(),
  startAutoreview: vi.fn(),
  startShell: vi.fn(),
  startUpdateDocs: vi.fn(),
  startCreatePr: vi.fn(),
  startAgentMulti: vi.fn(),
  startPlanReviewGuide: vi.fn(),
  startProof: vi.fn(),
  finishPlanQuick: vi.fn(),
  openInEditor: vi.fn(),
}));

vi.mock('$lib/remote/sync_status.remote.js', () => ({
  getPlanSyncStatus: vi.fn(() => ({ current: null })),
}));

vi.mock('$lib/remote/plan_metadata.remote.js', () => ({
  updatePlanMetadata: vi.fn(),
}));

vi.mock('$lib/remote/review_issue_actions.remote.js', () => ({
  removeReviewIssue: vi.fn(),
  convertReviewIssueToTask: vi.fn(),
  clearReviewIssues: vi.fn(),
}));

vi.mock('$lib/remote/sync_status.remote.js', () => ({
  getPlanSyncStatus: vi.fn(() => ({ current: null })),
}));

vi.mock('./PrStatusSection.svelte', () => ({
  default: () => '',
}));

vi.mock('./CopyButton.svelte', () => ({
  default: () => '',
}));

vi.mock('./PlanArtifactsList.svelte', () => ({
  default: () => '',
}));

vi.mock('./PlanArtifactUploader.svelte', () => ({
  default: () => '',
}));

vi.mock('./ActionButtonWithDropdown.svelte', () => ({
  default: (
    payload: { push: (content: string) => void },
    props: {
      primary: { label: string };
      menuItems?: Array<{ label: string }>;
      fixedActions?: Array<{ label: string }>;
    }
  ) => {
    if (props.menuItems?.length) {
      payload.push('<div data-testid="action-config"><button>Actions</button>');
      payload.push(`<button>${props.primary.label}</button>`);
      for (const item of props.menuItems) {
        payload.push(`<button>${item.label}</button>`);
      }
    } else {
      payload.push(`<div data-testid="action-config"><button>${props.primary.label}</button>`);
    }
    for (const item of props.fixedActions ?? []) {
      payload.push(`<button data-fixed-action>${item.label}</button>`);
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
    depsFullyResolved: true,
    tasks: [],
    taskCounts: { done: 0, total: 0 },
    reviewIssueCount: 0,
    note: null,
    dependencies: [],
    dependents: [],
    siblings: [],
    children: [],
    childExternalDependencyStatuses: {},
    assignment: null,
    parent: null,
    basePlan: null,
    effectiveBaseBranch: null,
    effectiveBaseBranchSource: null,
    effectiveBasePlan: null,
    prStatuses: [makePrStatusDetail()],
    reviewIssues: undefined,
    artifacts: [],
    ...overrides,
  };
}

function makeReview(overrides: Partial<ReviewWithIssueCounts> = {}): ReviewWithIssueCounts {
  return {
    id: 101,
    project_id: 123,
    pr_status_id: null,
    pr_url: null,
    branch: null,
    base_branch: 'main',
    reviewed_sha: 'abc123',
    review_guide: '# Review guide',
    status: 'complete',
    error_message: null,
    created_at: '2026-03-18T10:00:00.000Z',
    updated_at: '2026-03-18T10:00:00.000Z',
    plan_uuid: 'plan-1',
    issue_count: 3,
    unresolved_count: 1,
    ...overrides,
  };
}

describe('PlanDetail', () => {
  test('shows branch and PR context when the plan is linked to a known PR', () => {
    const { body } = render(PlanDetailComponent, {
      props: {
        plan: makePlanDetail({ effectiveBaseBranch: 'main', effectiveBaseBranchSource: 'plan' }),
        projectId: '123',
      },
    });

    expect(body).toContain('feature/link-pr');
    expect(body).toContain('main');
    expect(body).toContain('Linked PR plan');
  });

  test('links to the dedicated metadata edit route using the current route project id', () => {
    const { body } = render(PlanDetailComponent, {
      props: {
        plan: makePlanDetail({ uuid: 'plan-edit-uuid' }),
        projectId: 'all',
      },
    });

    expect(body).toContain('href="/projects/all/plans/plan-edit-uuid/edit"');
    expect(body).toContain('aria-label="Edit plan metadata"');
  });

  test('shows artifact archive download button when active artifacts exist', () => {
    const { body } = render(PlanDetailComponent, {
      props: {
        plan: makePlanDetail({
          uuid: 'plan-archive-uuid',
          artifacts: [
            {
              uuid: 'artifact-1',
              planUuid: 'plan-archive-uuid',
              projectUuid: 'project-uuid',
              filename: 'report.txt',
              mimeType: 'text/plain',
              size: 12,
              sha256: 'abc',
              message: null,
              storagePath: '/tmp/report.txt',
              deletedAt: null,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              revision: 1,
              transferState: null,
            },
          ],
        }),
        projectId: '123',
      },
    });

    expect(body).toContain('href="/api/plans/plan-archive-uuid/artifacts/archive"');
    expect(body).toContain('Download ZIP');
  });

  test('hides artifact archive download button when only deleted artifacts exist', () => {
    const { body } = render(PlanDetailComponent, {
      props: {
        plan: makePlanDetail({
          uuid: 'plan-deleted-artifacts',
          artifacts: [
            {
              uuid: 'artifact-1',
              planUuid: 'plan-deleted-artifacts',
              projectUuid: 'project-uuid',
              filename: 'old.txt',
              mimeType: 'text/plain',
              size: 12,
              sha256: 'abc',
              message: null,
              storagePath: '/tmp/old.txt',
              deletedAt: '2026-01-01T00:00:00.000Z',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
              revision: 1,
              transferState: null,
            },
          ],
        }),
        projectId: '123',
      },
    });

    expect(body).not.toContain('/api/plans/plan-deleted-artifacts/artifacts/archive');
    expect(body).not.toContain('Download ZIP');
  });

  test('does not repeat the parent in the depended-on-by section', () => {
    const parent = {
      uuid: 'parent-plan',
      projectId: 123,
      planId: 10,
      title: 'Parent plan',
      status: 'in_progress' as const,
      displayStatus: 'in_progress' as const,
      isResolved: false,
    };
    const otherDependent = {
      uuid: 'other-dependent',
      projectId: 123,
      planId: 11,
      title: 'Other dependent',
      status: 'pending' as const,
      displayStatus: 'pending' as const,
      isResolved: false,
    };

    const { body } = render(PlanDetailComponent, {
      props: {
        plan: makePlanDetail({
          parent,
          dependents: [parent, otherDependent],
        }),
        projectId: '123',
      },
    });

    expect(body).toContain('Parent Plan');
    expect(body).toContain('Parent plan');
    expect(body).toContain('Depended on by');
    expect(body).toContain('Other dependent');
    expect(body.match(/Parent plan/g)).toHaveLength(1);
  });

  test('keeps siblings out of dependency sections and annotates sibling relationships', () => {
    const baseSibling = {
      uuid: 'base-sibling',
      projectId: 123,
      planId: 20,
      title: 'Base sibling',
      status: 'needs_review' as const,
      displayStatus: 'needs_review' as const,
      isResolved: false,
    };
    const dependentSibling = {
      uuid: 'dependent-sibling',
      projectId: 123,
      planId: 21,
      title: 'Dependent sibling',
      status: 'pending' as const,
      displayStatus: 'pending' as const,
      isResolved: false,
    };

    const { body } = render(PlanDetailComponent, {
      props: {
        plan: makePlanDetail({
          dependencies: [baseSibling],
          dependents: [dependentSibling],
          siblings: [baseSibling, dependentSibling],
          effectiveBasePlan: baseSibling,
        }),
        projectId: '123',
      },
    });

    expect(body).toContain('Sibling Plans');
    expect(body).toContain('Base sibling');
    expect(body).toContain('Dependent sibling');
    expect(body).toContain('Base Plan');
    expect(body).toContain('Depends on this');
    expect(body).not.toContain('Depends On');
    expect(body).not.toContain('Depended on by');
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
    expect(body).not.toContain('<div data-testid="action-config"><button>Generate</button>');
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

  test('shows Generate Proof in the action menu when proof is configured and plan is ready', () => {
    const { body } = render(PlanDetailComponent, {
      props: {
        plan: makePlanDetail({
          status: 'needs_review',
          displayStatus: 'needs_review',
          canUpdateDocs: false,
        }),
        projectId: '123',
        proofConfigured: true,
      },
    });

    expect(body).toContain('Generate Proof');
  });

  test('hides Generate Proof when proof is not configured', () => {
    const { body } = render(PlanDetailComponent, {
      props: {
        plan: makePlanDetail({
          status: 'needs_review',
          displayStatus: 'needs_review',
          canUpdateDocs: false,
        }),
        projectId: '123',
        proofConfigured: false,
      },
    });

    expect(body).not.toContain('Generate Proof');
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
    expect(body).not.toContain('<div data-testid="action-config"><button>Generate</button>');
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
    expect(body).not.toContain('<div data-testid="action-config"><button>Generate</button>');
  });

  test('groups Generate and Run Agent under Actions for a taskless non-simple plan', () => {
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

    expect(body).toContain('<div data-testid="action-config"><button>Actions</button>');
    expect(body).toContain('Run Agent');
    expect(body).toContain('Autoreview');
    expect(body).toContain('Shell');
    expect(body).not.toContain('<button>Autoreview</button>');
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

  test('shows Run children panel when the only eligible child is externally blocked', () => {
    const { body } = render(PlanDetailComponent, {
      props: {
        plan: makePlanDetail({
          epic: true,
          children: [
            {
              uuid: 'child-1',
              planId: 101,
              title: 'Blocked child',
              status: 'pending',
              displayStatus: 'blocked',
              taskCount: 2,
              doneTaskCount: 0,
              dependencies: ['external-1'],
              parentUuid: 'plan-1',
            },
          ],
          childExternalDependencyStatuses: {
            'external-1': {
              status: 'in_progress',
              planId: 99,
              title: 'External predecessor',
            },
          },
          prStatuses: [],
        }),
        projectId: '123',
      },
    });

    expect(body).toContain('Run children');
    expect(body).toContain('Blocked child');
    expect(body).toContain('Blocked by external dependency: #99 External predecessor');
    const checkboxMatch = body.match(/<input[^>]*aria-label="Select plan #101"[^>]*>/);
    expect(checkboxMatch?.[0]).toContain('disabled');
  });

  test('disables Generate review guide while a review is in progress', () => {
    const { body } = render(PlanDetailComponent, {
      props: {
        plan: makePlanDetail(),
        reviews: [makeReview({ status: 'in_progress' })],
        projectId: '123',
      },
    });

    expect(body).toMatch(/<button[^>]*disabled[^>]*>\s*Generate review guide\s*<\/button>/);
  });

  test('shows an empty state when the plan has no review guides', () => {
    const { body } = render(PlanDetailComponent, {
      props: {
        plan: makePlanDetail(),
        reviews: [],
        projectId: '123',
      },
    });

    expect(body).toContain('Review Guides');
    expect(body).toContain('No review guides yet.');
  });

  test('renders review guide history with status badges and viewer links', () => {
    const { body } = render(PlanDetailComponent, {
      props: {
        plan: makePlanDetail(),
        reviews: [
          makeReview({ id: 201, status: 'complete', issue_count: 5, unresolved_count: 2 }),
          makeReview({ id: 202, status: 'error', issue_count: 0, unresolved_count: 0 }),
          makeReview({ id: 203, status: 'pending', issue_count: 0, unresolved_count: 0 }),
        ],
        projectId: '123',
      },
    });

    expect(body).toContain('href="/projects/123/plans/plan-1/reviews/201"');
    expect(body).toContain('href="/projects/123/plans/plan-1/reviews/202"');
    expect(body).toContain('href="/projects/123/plans/plan-1/reviews/203"');
    expect(body).toContain('Complete');
    expect(body).toContain('Error');
    expect(body).toContain('Pending');
    expect(body).toContain('2/5 open');
    expect(body).not.toContain('No review guides yet.');
  });

  test('links PR-backed review guides to the PR review route', () => {
    const { body } = render(PlanDetailComponent, {
      props: {
        plan: makePlanDetail(),
        reviews: [
          makeReview({
            id: 204,
            pr_url: 'https://github.com/example/repo/pull/42',
            plan_uuid: null,
          }),
        ],
        projectId: '123',
      },
    });

    expect(body).toContain('href="/projects/123/prs/42/reviews/204"');
  });
});
