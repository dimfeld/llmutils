import { describe, expect, test, vi, type Mock } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import type { PlanDetail } from '$lib/server/db_queries.js';
import type { PrStatusRow } from '$tim/db/pr_status.js';
import type { PrStatusDetailWithRequiredChecks } from '$lib/server/required_check_rollup.js';
import { invalidateAll } from '$app/navigation';
import { updatePlanMetadata } from '$lib/remote/plan_metadata.remote.js';
import { startReviewIssuesFix } from '$lib/remote/plan_actions.remote.js';
import PlanDetailComponent from './PlanDetail.svelte';

vi.mock('$app/navigation', () => ({
  afterNavigate: vi.fn(),
  goto: vi.fn(),
  invalidateAll: vi.fn(),
}));

vi.mock('$lib/remote/plan_actions.remote.js', () => ({
  startGenerate: vi.fn(),
  startAgent: vi.fn(),
  startChat: vi.fn(),
  startRebase: vi.fn(),
  startReview: vi.fn(),
  startReviewIssuesFix: vi.fn(),
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

vi.mock('$lib/remote/review_issue_actions.remote.js', () => ({
  removeReviewIssue: vi.fn(),
  convertReviewIssueToTask: vi.fn(),
  clearReviewIssues: vi.fn(),
}));

vi.mock('$lib/remote/sync_status.remote.js', () => ({
  getPlanSyncStatus: vi.fn(() => ({ current: null })),
}));

vi.mock('$lib/remote/plan_metadata.remote.js', () => ({
  updatePlanMetadata: vi.fn(),
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
    note: null,
    tasks: [],
    taskCounts: { done: 0, total: 0 },
    reviewIssueCount: 0,
    dependencies: [],
    dependents: [],
    siblings: [],
    children: [],
    basePlan: null,
    effectiveBasePlan: null,
    effectiveBaseBranch: null,
    effectiveBaseBranchSource: null,
    childExternalDependencyStatuses: {},
    assignment: null,
    parent: null,
    prStatuses: [makePrStatusDetail()],
    reviewIssues: undefined,
    artifacts: [],
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
  test('starts a review issue fixer session from saved review issues', async () => {
    (startReviewIssuesFix as Mock).mockResolvedValueOnce({ status: 'started', planId: 1 });

    renderPlan(
      makePlanDetail({
        reviewIssues: [
          {
            severity: 'major',
            category: 'bug',
            content: 'Fix persisted review feedback',
          },
        ],
        prStatuses: [],
      })
    );

    await page.getByRole('button', { name: 'Fix saved review issues' }).click();

    await vi.waitFor(() => {
      expect(startReviewIssuesFix).toHaveBeenCalledWith({ planUuid: 'plan-1' });
    });
  });

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
    await expect
      .element(page.getByRole('button', { name: 'Generate', exact: true }))
      .not.toBeInTheDocument();
  });

  test('shows Run Agent as its own button for a simple plan with incomplete tasks', async () => {
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
    await expect
      .element(page.getByRole('button', { name: 'Generate', exact: true }))
      .not.toBeInTheDocument();
  });

  test('shows Run Agent and Generate as standalone buttons for a taskless non-simple plan', async () => {
    const screen = renderPlan(
      makePlanDetail({
        status: 'in_progress',
        displayStatus: 'in_progress',
        simple: false,
        tasks: [],
        taskCounts: { done: 0, total: 0 },
        prStatuses: [],
      })
    );

    await expect
      .element(page.getByRole('button', { name: 'Actions', exact: true }))
      .toBeInTheDocument();
    // Run Agent and Generate are standalone buttons, not buried in the dropdown.
    await expect
      .element(page.getByRole('button', { name: 'Run Agent', exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole('button', { name: 'Generate', exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole('button', { name: 'Autoreview', exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole('button', { name: 'Shell', exact: true }))
      .toBeInTheDocument();
    await screen.getByRole('button', { name: 'Actions', exact: true }).click();
    // Run Agent and Generate are not also in the dropdown.
    await expect.element(page.getByRole('menuitem', { name: 'Run Agent' })).not.toBeInTheDocument();
    await expect.element(page.getByRole('menuitem', { name: 'Generate' })).not.toBeInTheDocument();
  });

  test('hides Autoreview for a pending plan', async () => {
    renderPlan(
      makePlanDetail({
        status: 'pending',
        displayStatus: 'pending',
        simple: false,
        tasks: [],
        taskCounts: { done: 0, total: 0 },
        prStatuses: [],
      })
    );

    await expect
      .element(page.getByRole('button', { name: 'Run Agent', exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole('button', { name: 'Generate', exact: true }))
      .toBeInTheDocument();
    // Pending plans have no work to review yet, so Autoreview is hidden.
    await expect
      .element(page.getByRole('button', { name: 'Autoreview', exact: true }))
      .not.toBeInTheDocument();
  });
});

describe('PlanDetail note editor', () => {
  test('saves note changes inline through the metadata update command', async () => {
    (updatePlanMetadata as Mock).mockResolvedValueOnce({ planUuid: 'plan-1' });
    (invalidateAll as Mock).mockResolvedValueOnce(undefined);

    renderPlan(
      makePlanDetail({
        note: 'Existing note',
        prStatuses: [],
      })
    );

    await page.getByRole('button', { name: 'Edit note' }).click();
    await page.getByLabelText('Plan note').fill('Updated note');
    await page.getByRole('button', { name: 'Save' }).click();

    await vi.waitFor(() => {
      expect(updatePlanMetadata).toHaveBeenCalledWith({
        projectId: 123,
        planUuid: 'plan-1',
        note: 'Updated note',
      });
    });
    await vi.waitFor(() => {
      expect(invalidateAll).toHaveBeenCalled();
    });
  });

  test('submits note changes with command-enter from the textarea', async () => {
    (updatePlanMetadata as Mock).mockResolvedValueOnce({ planUuid: 'plan-1' });
    (invalidateAll as Mock).mockResolvedValueOnce(undefined);

    renderPlan(
      makePlanDetail({
        note: 'Existing note',
        prStatuses: [],
      })
    );

    await page.getByRole('button', { name: 'Edit note' }).click();
    await page.getByLabelText('Plan note').fill('Keyboard note');
    const textarea = document.querySelector('[aria-label="Plan note"]') as HTMLTextAreaElement;
    textarea.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      })
    );

    await vi.waitFor(() => {
      expect(updatePlanMetadata).toHaveBeenCalledWith({
        projectId: 123,
        planUuid: 'plan-1',
        note: 'Keyboard note',
      });
    });
  });
});
