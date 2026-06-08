import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import type {
  ChildExternalDependencyInfo,
  ChildPlanSummary,
  PlanDetail,
} from '$lib/server/db_queries.js';
import { invalidateAll } from '$app/navigation';
import { startAgentMulti } from '$lib/remote/plan_actions.remote.js';
import PlanDetailComponent from './PlanDetail.svelte';
import RunChildrenPanel from './RunChildrenPanel.svelte';

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
  startAutoreview: vi.fn(),
  startShell: vi.fn(),
  startUpdateDocs: vi.fn(),
  startCreatePr: vi.fn(),
  startPlanReviewGuide: vi.fn(),
  startProof: vi.fn(),
  finishPlanQuick: vi.fn(),
  openInEditor: vi.fn(),
  startAgentMulti: vi.fn(),
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

const mockStartAgentMulti = vi.mocked(startAgentMulti);
const mockInvalidateAll = vi.mocked(invalidateAll);

function child(uuid: string, planId: number, overrides: Partial<ChildPlanSummary> = {}) {
  return {
    uuid,
    planId,
    title: `Child ${planId}`,
    status: 'pending',
    displayStatus: overrides.displayStatus ?? overrides.status ?? 'ready',
    taskCount: 4,
    doneTaskCount: 1,
    dependencies: [],
    ...overrides,
  } satisfies ChildPlanSummary;
}

function renderPanel(
  children: ChildPlanSummary[],
  externalPlanStatusByUuid: Record<string, ChildExternalDependencyInfo> = {}
) {
  return render(RunChildrenPanel, {
    props: {
      epicPlanUuid: 'epic-uuid',
      projectId: '123',
      children,
      externalPlanStatusByUuid,
    },
  });
}

function makePlanDetail(overrides: Partial<PlanDetail> = {}): PlanDetail {
  return {
    uuid: 'epic-uuid',
    projectId: 123,
    planId: 350,
    title: 'Epic plan',
    goal: 'Run children from the epic',
    details: null,
    status: 'in_progress',
    displayStatus: 'in_progress',
    priority: 'medium',
    branch: 'feature/run-children',
    parentUuid: null,
    epic: true,
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
    prStatuses: [],
    reviewIssues: undefined,
    artifacts: [],
    ...overrides,
  };
}

function checkboxFor(planId: number): HTMLInputElement {
  const checkbox = document.querySelector<HTMLInputElement>(
    `input[aria-label="Select plan #${planId}"]`
  );
  expect(checkbox).not.toBeNull();
  return checkbox!;
}

describe('RunChildrenPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockInvalidateAll.mockResolvedValue();
  });

  test('renders eligible children with row details', async () => {
    renderPanel([child('child-a', 101, { title: 'Build parser', status: 'in_progress' })]);

    await expect.element(page.getByRole('heading', { name: 'Run children' })).toBeInTheDocument();
    await expect.element(page.getByRole('link', { name: 'Build parser' })).toBeInTheDocument();
    await expect.element(page.getByText('#101')).toBeInTheDocument();
    await expect.element(page.getByText('1/4 tasks done')).toBeInTheDocument();
    await expect.element(page.getByRole('checkbox', { name: 'Select plan #101' })).toBeEnabled();
  });

  test('renders the child display status badge', async () => {
    renderPanel([
      child('blocked-child', 102, {
        title: 'Blocked by dependency',
        status: 'pending',
        displayStatus: 'blocked',
        dependencies: ['external-open'],
      }),
    ]);

    await expect.element(page.getByText('Blocked', { exact: true })).toBeInTheDocument();
  });

  test('omits children that are not agent-eligible', async () => {
    renderPanel([
      child('runnable-child', 115, { title: 'Runnable child' }),
      child('done-child', 116, {
        title: 'Done child',
        status: 'done',
        displayStatus: 'done',
        taskCount: 2,
        doneTaskCount: 2,
      }),
      child('no-task-child', 117, {
        title: 'No-task child',
        taskCount: 0,
        doneTaskCount: 0,
      }),
    ]);

    await expect.element(page.getByRole('link', { name: 'Runnable child' })).toBeInTheDocument();
    await expect.element(page.getByRole('link', { name: 'Done child' })).not.toBeInTheDocument();
    await expect.element(page.getByRole('link', { name: 'No-task child' })).not.toBeInTheDocument();
  });

  test('does not render from PlanDetail when no child is agent-eligible', async () => {
    render(PlanDetailComponent, {
      props: {
        plan: makePlanDetail({
          children: [
            child('done-child', 102, {
              status: 'done',
              taskCount: 2,
              doneTaskCount: 2,
            }),
          ],
        }),
        projectId: '123',
      },
    });

    await expect
      .element(page.getByRole('heading', { name: 'Run children' }))
      .not.toBeInTheDocument();
  });

  test('disables externally blocked children with a blocking dependency tooltip', async () => {
    renderPanel([child('blocked-child', 103, { dependencies: ['external-open'] })], {
      'external-open': { status: 'in_progress', planId: 999, title: 'External open plan' },
    });

    const checkbox = checkboxFor(103);
    expect(checkbox.disabled).toBe(true);
    expect(checkbox.closest('li')?.getAttribute('title')).toBe(
      'Blocked by external dependency: #999 External open plan (in_progress)'
    );
  });

  test('checking a downstream child auto-checks unfinished dependency predecessors', async () => {
    renderPanel([
      child('dependency-child', 104),
      child('downstream-child', 105, { dependencies: ['dependency-child'] }),
    ]);

    await page.getByRole('checkbox', { name: 'Select plan #105' }).click();

    expect(checkboxFor(104).checked).toBe(true);
    expect(checkboxFor(105).checked).toBe(true);
  });

  test('checking a stacked child auto-checks its base plan predecessor', async () => {
    renderPanel([
      child('base-child', 106),
      child('stacked-child', 107, { basePlanUuid: 'base-child' }),
    ]);

    await page.getByRole('checkbox', { name: 'Select plan #107' }).click();

    expect(checkboxFor(106).checked).toBe(true);
    expect(checkboxFor(107).checked).toBe(true);
  });

  test('unchecking a predecessor auto-unchecks currently selected transitive dependents', async () => {
    renderPanel([
      child('root-child', 108),
      child('middle-child', 109, { dependencies: ['root-child'] }),
      child('leaf-child', 110, { dependencies: ['middle-child'] }),
    ]);

    await page.getByRole('checkbox', { name: 'Select plan #110' }).click();
    await page.getByRole('checkbox', { name: 'Select plan #109' }).click();

    expect(checkboxFor(108).checked).toBe(true);
    expect(checkboxFor(109).checked).toBe(false);
    expect(checkboxFor(110).checked).toBe(false);
  });

  test('run selected invokes startAgentMulti with the selected child UUIDs', async () => {
    mockStartAgentMulti.mockResolvedValue({ status: 'started' });
    renderPanel([child('first-child', 111), child('second-child', 112)]);

    await page.getByRole('checkbox', { name: 'Select plan #112' }).click();
    await page.getByRole('button', { name: 'Run selected' }).click();

    await vi.waitFor(() => {
      expect(mockStartAgentMulti).toHaveBeenCalledWith({
        epicPlanUuid: 'epic-uuid',
        childUuids: ['second-child'],
      });
    });
  });

  test('shows an inline error banner when startAgentMulti rejects', async () => {
    mockStartAgentMulti.mockRejectedValue(new Error('launch failed'));
    renderPanel([child('failing-child', 113)]);

    await page.getByRole('checkbox', { name: 'Select plan #113' }).click();
    await page.getByRole('button', { name: 'Run selected' }).click();

    await expect.element(page.getByText('Error: launch failed')).toBeInTheDocument();
  });

  test('disables and does not auto-check a child whose in-list predecessor is externally blocked', async () => {
    renderPanel(
      [
        child('pred-child', 120, { dependencies: ['ext-open'] }),
        child('down-child', 121, { dependencies: ['pred-child'] }),
      ],
      { 'ext-open': { status: 'in_progress', planId: 998, title: 'Ext open' } }
    );

    // The directly-blocked predecessor is disabled (external block).
    const predCheckbox = checkboxFor(120);
    expect(predCheckbox.disabled).toBe(true);

    // The downstream child is also disabled because its closure would require
    // the unselectable predecessor.
    const downCheckbox = checkboxFor(121);
    expect(downCheckbox.disabled).toBe(true);
    expect(downCheckbox.closest('li')?.getAttribute('title')).toBe(
      'Blocked because in-list predecessor #120 has an unfinished external dependency'
    );
  });

  test('marks a downstream child transitively blocked when an in-list predecessor is deferred', async () => {
    renderPanel([
      child('deferred-pred', 122, { status: 'deferred' }),
      child('down-child', 123, { dependencies: ['deferred-pred'] }),
    ]);

    const downCheckbox = checkboxFor(123);
    expect(downCheckbox.disabled).toBe(true);
    expect(downCheckbox.closest('li')?.getAttribute('title')).toBe(
      'Blocked because in-list predecessor #122 is not agent-eligible'
    );
  });

  test('resets selection when epicPlanUuid prop changes', async () => {
    const initialChildren = [child('first-child', 130), child('second-child', 131)];
    const { rerender } = renderPanel(initialChildren);

    await page.getByRole('checkbox', { name: 'Select plan #131' }).click();
    expect(checkboxFor(131).checked).toBe(true);

    await rerender({
      epicPlanUuid: 'different-epic-uuid',
      projectId: '123',
      children: initialChildren,
      externalPlanStatusByUuid: {},
    });

    expect(checkboxFor(130).checked).toBe(false);
    expect(checkboxFor(131).checked).toBe(false);
    await expect.element(page.getByRole('button', { name: 'Run selected' })).toBeDisabled();
  });

  test('shows a generic success banner when the epic already has a running session', async () => {
    mockStartAgentMulti.mockResolvedValue({
      status: 'already_running',
      connectionId: 'session-123',
    });
    renderPanel([child('running-child', 114)]);

    await page.getByRole('checkbox', { name: 'Select plan #114' }).click();
    await page.getByRole('button', { name: 'Run selected' }).click();

    await expect
      .element(page.getByText('A session is already running for this epic'))
      .toBeInTheDocument();
    // The in-panel "View session" link was intentionally removed: the panel is
    // hidden by PlanDetail once activeSession.command === 'agent-multi', so the
    // top-of-page active-session pill is the single entry point.
    await expect.element(page.getByRole('link', { name: 'View session' })).not.toBeInTheDocument();
  });
});
