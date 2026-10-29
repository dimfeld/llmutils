import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import type { EnrichedProjectPr } from '$lib/remote/project_prs.remote.js';
import { shepherdPageTestState } from './shepherd_page_test_state.svelte.js';

const mocks = vi.hoisted(() => {
  const listeners: Array<(eventName: string, event: unknown) => void> = [];
  return {
    setPrShepherded: vi.fn(),
    listeners,
    sessionManager: {
      onEvent: vi.fn((listener: (eventName: string, event: unknown) => void) => {
        listeners.push(listener);
        return () => {};
      }),
      hasActiveSessionForPr: vi.fn(() => ({ active: false })),
    },
  };
});

vi.mock('$lib/remote/project_prs.remote.js', async () => {
  const { shepherdPageTestState: state } = await import('./shepherd_page_test_state.svelte.js');
  // Like a SvelteKit query: refresh() loads the data again after a network delay.
  const getProjectPrs = vi.fn(() => {
    void state.version;
    const value = state.value;
    const promise = new Promise((resolve) => setTimeout(() => resolve(value), 30));
    return Object.assign(promise, {
      refresh: vi.fn(() => {
        state.version += 1;
      }),
    });
  });
  return { getProjectPrs, refreshProjectPrs: vi.fn(async () => ({ newLinks: [] })) };
});

vi.mock('$lib/remote/pr_shepherd.remote.js', () => ({
  setPrShepherded: mocks.setPrShepherded,
  updateShepherdedPrBranch: vi.fn(),
  addPrStackToShepherdBot: vi.fn(),
  removePrStackFromShepherdBot: vi.fn(),
  setShepherdBotRunning: vi.fn(),
  getShepherdBotStatus: vi.fn(() =>
    Object.assign(
      Promise.resolve({
        running: false,
        activeRun: null,
        pendingTriggerCount: 0,
        nextDueAt: null,
        recentRuns: [],
        recentActions: [],
        stateMarkdown: '',
        statePath: '',
      }),
      { refresh: vi.fn() }
    )
  ),
}));

vi.mock('$lib/remote/review_thread_actions.remote.js', () => ({
  startFixPrThreads: vi.fn(),
  startPrCiFix: vi.fn(),
  startPrRebase: vi.fn(),
}));

vi.mock('$lib/stores/session_state.svelte.js', () => ({
  useSessionManager: () => mocks.sessionManager,
}));

import ShepherdPage from './+page.svelte';

function makePr(
  prNumber: number,
  options: { shepherded?: boolean; base?: string; head?: string; mergedAt?: string } = {}
) {
  return {
    status: {
      id: prNumber,
      pr_url: `https://github.com/example/repo/pull/${prNumber}`,
      owner: 'example',
      repo: 'repo',
      pr_number: prNumber,
      author: 'me',
      title: `PR number ${prNumber}`,
      state: options.mergedAt ? 'merged' : 'open',
      draft: 0,
      mergeable: 'MERGEABLE',
      head_sha: 'sha',
      base_sha: 'base',
      base_branch: options.base ?? 'main',
      head_branch: options.head ?? `feature-${prNumber}`,
      requested_reviewers: null,
      review_decision: null,
      check_rollup_state: 'success',
      merged_at: options.mergedAt ?? null,
      additions: null,
      deletions: null,
      changed_files: null,
      pr_updated_at: null,
      latest_commit_pushed_at: null,
      ready_at: null,
      behind_by: null,
      merge_queue_enqueued_at: null,
      last_fetched_at: '2026-01-01T00:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    },
    checks: [],
    reviews: [],
    reviewRequests: [],
    labels: [],
    reviewThreads: [],
    linkedPlans: [],
    projectId: 7,
    currentUserReviewRequestLabel: null,
    currentUserReviewRequestedAt: null,
    currentUserPushedAfterReview: false,
    currentUserReviewRequestStacked: false,
    isStackedOnOpenPr: false,
    currentUserNeedsReviewRequest: false,
    shepherd: options.shepherded
      ? { source: 'auto', enrolledAt: '2026-01-01T00:00:00.000Z', botEnabled: false }
      : null,
  } as unknown as EnrichedProjectPr;
}

function setPrs(prs: EnrichedProjectPr[], mergedPrs: EnrichedProjectPr[] = []): void {
  shepherdPageTestState.value = {
    authored: prs,
    reviewing: [],
    recentlyMerged: { authored: mergedPrs, reviewing: [] },
    username: 'me',
    hasData: true,
    tokenConfigured: true,
    webhookConfigured: true,
  };
}

let unmount: (() => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listeners.length = 0;
});

function emitPrUpdated(): void {
  for (const listener of mocks.listeners) {
    listener('pr:updated', { prUrls: [], projectIds: [7] });
  }
}

afterEach(() => {
  unmount?.();
  unmount = null;
});

describe('shepherd page', () => {
  test('a PR moves out of the other PRs section after Watch', async () => {
    setPrs([makePr(1, { shepherded: true }), makePr(2)]);
    const others = Array.from({ length: 40 }, (_, i) => makePr(100 + i));
    setPrs([makePr(1, { shepherded: true }), makePr(2), ...others]);
    mocks.setPrShepherded.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      setPrs([makePr(1, { shepherded: true }), makePr(2, { shepherded: true }), ...others]);
      emitPrUpdated();
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { shepherded: true };
    });

    unmount = render(ShepherdPage, {
      props: {
        data: { projectId: '7', projects: [], currentUsername: 'me', prFixExecutorOptions: [] },
      } as never,
    }).unmount;

    await expect.element(page.getByText('Your other open PRs (41)')).toBeVisible();
    await page.getByText('Your other open PRs (41)').click();
    await page.getByRole('button', { name: 'Add PR #2 to the shepherd list' }).click();

    await expect.poll(() => mocks.setPrShepherded.mock.calls.length).toBe(1);
    await expect.element(page.getByText('Your other open PRs (40)')).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect
      .element(page.getByRole('button', { name: 'Remove PR #2 from the shepherd list' }))
      .toBeVisible();
    expect(page.getByText('PR number 2').elements()).toHaveLength(1);
  });

  test('every PR row links to GitHub and Linear, whatever its status', async () => {
    // PR 1 is watched with no attention items, and PR 2 is not watched.
    setPrs([makePr(1, { shepherded: true }), makePr(2)]);

    unmount = render(ShepherdPage, {
      props: {
        data: { projectId: '7', projects: [], currentUsername: 'me', prFixExecutorOptions: [] },
      } as never,
    }).unmount;

    await page.getByText('Your other open PRs (1)').click();
    for (const prNumber of [1, 2]) {
      await expect
        .element(page.getByRole('link', { name: `View PR #${prNumber} in GitHub` }))
        .toHaveAttribute('href', `https://github.com/example/repo/pull/${prNumber}`);
      await expect
        .element(page.getByRole('link', { name: `View PR #${prNumber} in Linear` }))
        .toHaveAttribute('href', `linear://review/example/repo/pull/${prNumber}`);
    }
  });

  test('approved PRs show an Approved badge even when they cannot merge yet', async () => {
    const approve = (pr: EnrichedProjectPr): EnrichedProjectPr => {
      pr.status.review_decision = 'APPROVED';
      pr.reviews = [{ author: 'reviewer', state: 'APPROVED' }] as EnrichedProjectPr['reviews'];
      return pr;
    };
    const pending = approve(makePr(1, { shepherded: true }));
    pending.status.check_rollup_state = 'pending';
    const conflicting = approve(makePr(2, { shepherded: true }));
    conflicting.status.mergeable = 'CONFLICTING';
    const ready = approve(makePr(3, { shepherded: true }));
    const unapproved = makePr(4, { shepherded: true });
    setPrs([pending, conflicting, ready, unapproved]);

    unmount = render(ShepherdPage, {
      props: {
        data: { projectId: '7', projects: [], currentUsername: 'me', prFixExecutorOptions: [] },
      } as never,
    }).unmount;

    await expect.element(page.getByText('Waiting for checks')).toBeVisible();
    await expect.element(page.getByText('Needs attention')).toBeVisible();
    await expect.element(page.getByText('Ready to merge')).toBeVisible();
    // The ready PR already says it is approved, and PR 4 has no approval.
    expect(page.getByText('Approved', { exact: true }).elements()).toHaveLength(2);
  });

  test('watching a stacked PR moves the whole stack out of the other PRs section', async () => {
    const stack = (watched: boolean) => [
      makePr(1, { shepherded: true }),
      makePr(2, { shepherded: watched, base: 'main', head: 'a' }),
      makePr(3, { base: 'a', head: 'b' }),
      makePr(4, { base: 'b', head: 'c' }),
    ];
    setPrs(stack(false));
    mocks.setPrShepherded.mockImplementation(async () => {
      setPrs(stack(true));
      return { shepherded: true };
    });

    unmount = render(ShepherdPage, {
      props: {
        data: { projectId: '7', projects: [], currentUsername: 'me', prFixExecutorOptions: [] },
      } as never,
    }).unmount;

    await page.getByText('Your other open PRs (3)').click();
    await page.getByRole('button', { name: 'Add PR #2 to the shepherd list' }).click();

    await expect.poll(() => mocks.setPrShepherded.mock.calls.length).toBe(1);
    await expect.element(page.getByText(/Your other open PRs/)).not.toBeInTheDocument();
    for (const prNumber of [2, 3, 4]) {
      expect(page.getByText(`PR number ${prNumber}`).elements()).toHaveLength(1);
    }

    // Stacked PRs indent one level at most, however deep the stack is.
    const indent = (prNumber: number): string | undefined =>
      page.getByText(`PR number ${prNumber}`).element().closest('li')?.style.paddingLeft;
    expect(indent(2)).toBe('0.75rem');
    expect(indent(3)).toBe('2rem');
    expect(indent(4)).toBe('2rem');
  });

  test('recently merged PRs show in a collapsed section grouped by day', async () => {
    const now = new Date();
    const at = (daysBack: number, hour: number): string =>
      new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack, hour).toISOString();
    setPrs(
      [makePr(1, { shepherded: true })],
      [
        makePr(50, { mergedAt: at(0, 0) }),
        makePr(51, { mergedAt: at(1, 10) }),
        makePr(52, { mergedAt: at(1, 11) }),
      ]
    );

    unmount = render(ShepherdPage, {
      props: {
        data: { projectId: '7', projects: [], currentUsername: 'me', prFixExecutorOptions: [] },
      } as never,
    }).unmount;

    const summary = page.getByText('Recently merged (3)');
    await expect.element(summary).toBeVisible();
    await expect.element(page.getByText('PR number 50')).not.toBeVisible();

    await summary.click();
    await expect.element(page.getByRole('heading', { name: 'Today' })).toBeVisible();
    await expect.element(page.getByRole('heading', { name: 'Yesterday' })).toBeVisible();
    await expect
      .element(page.getByRole('link', { name: '#50 PR number 50' }))
      .toHaveAttribute('href', '/projects/7/prs/50');
    await expect
      .element(page.getByRole('link', { name: 'View PR #51 in GitHub' }))
      .toHaveAttribute('href', 'https://github.com/example/repo/pull/51');

    const yesterdayRows = page
      .getByRole('heading', { name: 'Yesterday' })
      .element()
      .closest('section')
      ?.querySelectorAll('li');
    expect(
      Array.from(yesterdayRows ?? []).map((row) => row.textContent?.match(/#\d+/)?.[0])
    ).toEqual(['#52', '#51']);
  });

  test('the recently merged section is hidden when nothing merged recently', async () => {
    setPrs([makePr(1, { shepherded: true })]);

    unmount = render(ShepherdPage, {
      props: {
        data: { projectId: '7', projects: [], currentUsername: 'me', prFixExecutorOptions: [] },
      } as never,
    }).unmount;

    await expect.element(page.getByText('PR number 1')).toBeVisible();
    await expect.element(page.getByText(/Recently merged/)).not.toBeInTheDocument();
  });
});
