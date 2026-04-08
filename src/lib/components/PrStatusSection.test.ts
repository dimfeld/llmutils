import { render } from 'svelte/server';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  PrStatusDetail,
  PrStatusRow,
  PrCheckRunRow,
  PrReviewRow,
  PrLabelRow,
  PrReviewThreadDetail,
  PrReviewThreadRow,
  PrReviewThreadCommentRow,
} from '$tim/db/pr_status.js';
import PrStatusSection from './PrStatusSection.svelte';

const mockGetPrStatus = vi.fn();
const mockRefreshPrStatus = vi.fn();
const mockFullRefreshPrStatus = vi.fn();
const mockStartFixThreads = vi.fn();
const sessionManager = {
  sessions: new Map<string, { status: string; sessionInfo: { planUuid?: string } }>(),
  onEvent: vi.fn(() => () => {}),
};
vi.mock('$lib/remote/pr_status.remote.js', () => ({
  getPrStatus: (...args: unknown[]) => mockGetPrStatus(...args),
  refreshPrStatus: (...args: unknown[]) => mockRefreshPrStatus(...args),
  fullRefreshPrStatus: (...args: unknown[]) => mockFullRefreshPrStatus(...args),
}));
vi.mock('$lib/remote/review_thread_actions.remote.js', () => ({
  startFixThreads: (...args: unknown[]) => mockStartFixThreads(...args),
}));

vi.mock('$lib/stores/session_state.svelte.js', () => ({
  useSessionManager: () => sessionManager,
}));

function makePrStatus(overrides: Partial<PrStatusRow> = {}): PrStatusRow {
  return {
    id: 1,
    pr_url: 'https://github.com/owner/repo/pull/42',
    owner: 'owner',
    repo: 'repo',
    pr_number: 42,
    author: 'testuser',
    title: 'Add feature X',
    state: 'open',
    draft: 0,
    mergeable: 'MERGEABLE',
    head_sha: 'abc123',
    base_branch: 'main',
    head_branch: 'feature-x',
    requested_reviewers: null,
    review_decision: null,
    check_rollup_state: 'success',
    merged_at: null,
    additions: null,
    deletions: null,
    changed_files: null,
    pr_updated_at: null,
    latest_commit_pushed_at: null,
    last_fetched_at: new Date().toISOString(),
    created_at: '2026-03-18T10:00:00.000Z',
    updated_at: '2026-03-18T10:00:00.000Z',
    ...overrides,
  };
}

function makeCheck(overrides: Partial<PrCheckRunRow> = {}): PrCheckRunRow {
  return {
    id: 1,
    pr_status_id: 1,
    name: 'CI / build',
    source: 'check_run',
    status: 'completed',
    conclusion: 'success',
    details_url: 'https://github.com/owner/repo/actions/runs/123',
    started_at: '2026-03-18T10:00:00.000Z',
    completed_at: '2026-03-18T10:01:00.000Z',
    ...overrides,
  };
}

function makeReview(overrides: Partial<PrReviewRow> = {}): PrReviewRow {
  return {
    id: 1,
    pr_status_id: 1,
    author: 'reviewer1',
    state: 'APPROVED',
    submitted_at: '2026-03-18T10:05:00.000Z',
    ...overrides,
  };
}

function makeLabel(overrides: Partial<PrLabelRow> = {}): PrLabelRow {
  return {
    id: 1,
    pr_status_id: 1,
    name: 'enhancement',
    color: '0075ca',
    ...overrides,
  };
}

function makePrDetail(
  overrides: {
    status?: Partial<PrStatusRow>;
    checks?: PrCheckRunRow[];
    reviews?: PrReviewRow[];
    reviewRequests?: PrStatusDetail['reviewRequests'];
    labels?: PrLabelRow[];
    reviewThreads?: PrReviewThreadDetail[];
  } = {}
): PrStatusDetail {
  return {
    status: makePrStatus(overrides.status),
    checks: overrides.checks ?? [],
    reviews: overrides.reviews ?? [],
    reviewRequests: overrides.reviewRequests ?? [],
    labels: overrides.labels ?? [],
    reviewThreads: overrides.reviewThreads,
  };
}

function makeReviewThreadRow(overrides: Partial<PrReviewThreadRow> = {}): PrReviewThreadRow {
  return {
    id: 1,
    pr_status_id: 1,
    thread_id: 'thread-1',
    path: 'src/example.ts',
    line: 42,
    original_line: 42,
    original_start_line: null,
    start_line: null,
    diff_side: 'RIGHT',
    start_diff_side: null,
    is_resolved: 0,
    is_outdated: 0,
    subject_type: 'LINE',
    ...overrides,
  };
}

function makeReviewThreadComment(
  overrides: Partial<PrReviewThreadCommentRow> = {}
): PrReviewThreadCommentRow {
  return {
    id: 1,
    review_thread_id: 1,
    comment_id: 'comment-1',
    database_id: 1234,
    author: 'reviewer1',
    body: 'Please rename this.',
    diff_hunk: '@@ -42,1 +42,1 @@',
    state: 'COMMENTED',
    created_at: '2026-03-18T10:05:00.000Z',
    ...overrides,
  };
}

function makeReviewThreadDetail(
  overrides: {
    thread?: Partial<PrReviewThreadRow>;
    comments?: PrReviewThreadCommentRow[];
  } = {}
): PrReviewThreadDetail {
  const thread = makeReviewThreadRow(overrides.thread);
  return {
    thread,
    comments: overrides.comments ?? [
      makeReviewThreadComment({
        review_thread_id: thread.id,
        id: thread.id,
        database_id: 1234 + thread.id,
      }),
    ],
  };
}

async function renderSection(props: {
  planUuid?: string;
  prUrls: string[];
  invalidPrUrls?: string[];
  prStatuses: PrStatusDetail[];
}) {
  mockGetPrStatus.mockReturnValue(
    Promise.resolve({
      prUrls: props.prUrls,
      invalidPrUrls: props.invalidPrUrls ?? [],
      prStatuses: props.prStatuses,
      tokenConfigured: true,
    })
  );

  return await render(PrStatusSection, {
    props: {
      planUuid: props.planUuid ?? 'plan-uuid-1',
    },
  });
}

describe('PrStatusSection', () => {
  beforeEach(() => {
    sessionManager.sessions.clear();
    mockStartFixThreads.mockReset();
  });

  test('renders with the session manager available for client-side PR subscriptions', async () => {
    const { body } = await renderSection({ prUrls: [], prStatuses: [] });
    expect(body).toContain('Pull Requests');
  });

  test('renders refresh and full-refresh controls', async () => {
    mockRefreshPrStatus.mockResolvedValue({ error: undefined });
    mockFullRefreshPrStatus.mockResolvedValue({ error: undefined });

    const { body } = await renderSection({ prUrls: [], prStatuses: [] });

    expect(body).toContain('aria-label="Refresh PR status"');
    expect(body).toContain('aria-label="Fully refresh PR status from GitHub"');
    expect(body).toContain('Full Refresh');
  });

  test('hides the full-refresh control when no GitHub token is configured', async () => {
    mockGetPrStatus.mockReturnValue(
      Promise.resolve({
        prUrls: [],
        invalidPrUrls: [],
        prStatuses: [],
        tokenConfigured: false,
      })
    );

    const { body } = await render(PrStatusSection, {
      props: {
        planUuid: 'plan-uuid-1',
      },
    });

    expect(body).toContain('aria-label="Refresh PR status"');
    expect(body).not.toContain('aria-label="Fully refresh PR status from GitHub"');
    expect(body).not.toContain('Full Refresh');
  });

  test('renders "Pull Requests" heading', async () => {
    const { body } = await renderSection({ prUrls: [], prStatuses: [] });
    expect(body).toContain('Pull Requests');
  });

  test('refresh button has aria-label', async () => {
    const { body } = await renderSection({ prUrls: [], prStatuses: [] });
    expect(body).toContain('aria-label="Refresh PR status"');
  });

  test('renders invalid PR entries as a warning block', async () => {
    const { body } = await renderSection({
      prUrls: [],
      invalidPrUrls: ['https://github.com/owner/repo/issues/42'],
      prStatuses: [],
    });

    expect(body).toContain('Invalid pull request entries');
    expect(body).toContain('https://github.com/owner/repo/issues/42');
  });

  test('renders PR number and title as a link', async () => {
    const detail = makePrDetail({ status: { pr_number: 42, title: 'Add feature X' } });
    const { body } = await renderSection({
      prUrls: ['https://github.com/owner/repo/pull/42'],
      prStatuses: [detail],
    });

    expect(body).toContain('#42');
    expect(body).toContain('Add feature X');
    expect(body).toContain('href="https://github.com/owner/repo/pull/42"');
  });

  test('renders state badge for open PR', async () => {
    const detail = makePrDetail({ status: { state: 'open' } });
    const { body } = await renderSection({
      prUrls: [detail.status.pr_url],
      prStatuses: [detail],
    });

    expect(body).toContain('Open');
  });

  test('renders state badge for merged PR', async () => {
    const detail = makePrDetail({ status: { state: 'merged', merged_at: '2026-03-18T12:00:00Z' } });
    const { body } = await renderSection({
      prUrls: [detail.status.pr_url],
      prStatuses: [detail],
    });

    expect(body).toContain('Merged');
  });

  test('renders Draft badge for draft PRs', async () => {
    const detail = makePrDetail({ status: { state: 'open', draft: 1 } });
    const { body } = await renderSection({
      prUrls: [detail.status.pr_url],
      prStatuses: [detail],
    });

    expect(body).toContain('Draft');
  });

  test('renders checks passing badge', async () => {
    const detail = makePrDetail({ status: { check_rollup_state: 'success' } });
    const { body } = await renderSection({
      prUrls: [detail.status.pr_url],
      prStatuses: [detail],
    });

    expect(body).toContain('Checks passing');
  });

  test('renders checks failing badge', async () => {
    const detail = makePrDetail({ status: { check_rollup_state: 'failure' } });
    const { body } = await renderSection({
      prUrls: [detail.status.pr_url],
      prStatuses: [detail],
    });

    expect(body).toContain('Checks failing');
  });

  test('renders checks pending badge', async () => {
    const detail = makePrDetail({ status: { check_rollup_state: 'pending' } });
    const { body } = await renderSection({
      prUrls: [detail.status.pr_url],
      prStatuses: [detail],
    });

    expect(body).toContain('Checks pending');
  });

  test('renders error check runs as failures', async () => {
    const detail = makePrDetail({
      checks: [makeCheck({ conclusion: 'error', name: 'CI / error' })],
    });
    const { body } = await renderSection({
      prUrls: [detail.status.pr_url],
      prStatuses: [detail],
    });

    expect(body).toContain('CI / error');
    expect(body).toContain('text-red-600');
    expect(body).toContain('✗');
    expect(body).toContain('error');
  });

  test('renders review decision badges', async () => {
    const approved = makePrDetail({ status: { review_decision: 'APPROVED' } });
    const { body: bodyApproved } = await renderSection({
      prUrls: [approved.status.pr_url],
      prStatuses: [approved],
    });
    expect(bodyApproved).toContain('Approved');

    const changesRequested = makePrDetail({
      status: {
        review_decision: 'CHANGES_REQUESTED',
        pr_url: 'https://github.com/o/r/pull/2',
        pr_number: 2,
      },
    });
    const { body: bodyCR } = await renderSection({
      prUrls: [changesRequested.status.pr_url],
      prStatuses: [changesRequested],
    });
    expect(bodyCR).toContain('Changes Requested');

    const reviewRequired = makePrDetail({
      status: {
        review_decision: 'REVIEW_REQUIRED',
        pr_url: 'https://github.com/o/r/pull/3',
        pr_number: 3,
      },
    });
    const { body: bodyRR } = await renderSection({
      prUrls: [reviewRequired.status.pr_url],
      prStatuses: [reviewRequired],
    });
    expect(bodyRR).toContain('Review Required');
  });

  test('renders conflict badge when mergeable is CONFLICTING', async () => {
    const detail = makePrDetail({ status: { mergeable: 'CONFLICTING' } });
    const { body } = await renderSection({
      prUrls: [detail.status.pr_url],
      prStatuses: [detail],
    });

    expect(body).toContain('Conflicts');
  });

  test('does not render conflict badge when mergeable is MERGEABLE', async () => {
    const detail = makePrDetail({ status: { mergeable: 'MERGEABLE' } });
    const { body } = await renderSection({
      prUrls: [detail.status.pr_url],
      prStatuses: [detail],
    });

    expect(body).not.toContain('Conflicts');
  });

  test('renders labels as colored chips', async () => {
    const detail = makePrDetail({
      labels: [
        makeLabel({ name: 'enhancement', color: '0075ca' }),
        makeLabel({ id: 2, name: 'bug', color: 'd73a4a' }),
      ],
    });
    const { body } = await renderSection({
      prUrls: [detail.status.pr_url],
      prStatuses: [detail],
    });

    expect(body).toContain('enhancement');
    expect(body).toContain('bug');
    expect(body).toContain('background-color: #0075ca');
    expect(body).toContain('background-color: #d73a4a');
  });

  test('renders expandable check runs section', async () => {
    const detail = makePrDetail({
      checks: [
        makeCheck({ name: 'CI / build', conclusion: 'success' }),
        makeCheck({ id: 2, name: 'CI / lint', conclusion: 'failure' }),
      ],
    });
    const { body } = await renderSection({
      prUrls: [detail.status.pr_url],
      prStatuses: [detail],
    });

    expect(body).toContain('2 checks');
    expect(body).toContain('CI / build');
    expect(body).toContain('CI / lint');
  });

  test('renders singular "check" for single check run', async () => {
    const detail = makePrDetail({
      checks: [makeCheck({ name: 'CI / build' })],
    });
    const { body } = await renderSection({
      prUrls: [detail.status.pr_url],
      prStatuses: [detail],
    });

    expect(body).toContain('1 check');
    // Should not say "1 checks"
    expect(body).not.toMatch(/1 checks/);
  });

  test('renders expandable reviews section', async () => {
    const detail = makePrDetail({
      reviews: [
        makeReview({ author: 'alice', state: 'APPROVED' }),
        makeReview({ id: 2, author: 'bob', state: 'CHANGES_REQUESTED' }),
      ],
    });
    const { body } = await renderSection({
      prUrls: [detail.status.pr_url],
      prStatuses: [detail],
    });

    expect(body).toContain('2 reviews');
    expect(body).toContain('alice');
    expect(body).toContain('bob');
  });

  test('renders raw URL link for PR without cached status', async () => {
    const unknownUrl = 'https://github.com/owner/repo/pull/99';
    const { body } = await renderSection({
      prUrls: [unknownUrl],
      prStatuses: [],
    });

    expect(body).toContain(`href="${unknownUrl}"`);
    expect(body).toContain(unknownUrl);
    // Should NOT contain PR number or title since there's no status
    expect(body).not.toContain('#99');
  });

  test('renders multiple PRs with mixed status availability', async () => {
    const cachedUrl = 'https://github.com/owner/repo/pull/42';
    const uncachedUrl = 'https://github.com/owner/repo/pull/99';
    const detail = makePrDetail({
      status: { pr_url: cachedUrl, pr_number: 42, title: 'Known PR' },
    });

    const { body } = await renderSection({
      prUrls: [cachedUrl, uncachedUrl],
      prStatuses: [detail],
    });

    // Cached PR shows structured content
    expect(body).toContain('#42');
    expect(body).toContain('Known PR');
    // Uncached PR shows raw URL
    expect(body).toContain(uncachedUrl);
  });

  test('renders webhook-only PR statuses even when the plan has no explicit pull_request URLs', async () => {
    const detail = makePrDetail({
      status: {
        pr_url: 'https://github.com/owner/repo/pull/77',
        pr_number: 77,
        title: 'Webhook PR',
      },
    });

    const { body } = await renderSection({
      prUrls: [],
      prStatuses: [detail],
    });

    expect(body).toContain('#77');
    expect(body).toContain('Webhook PR');
  });

  test('does not render check runs section when there are no checks', async () => {
    const detail = makePrDetail({ checks: [] });
    const { body } = await renderSection({
      prUrls: [detail.status.pr_url],
      prStatuses: [detail],
    });

    expect(body).not.toContain('check');
  });

  test('does not render reviews section when there are no reviews', async () => {
    const detail = makePrDetail({ reviews: [] });
    const { body } = await renderSection({
      prUrls: [detail.status.pr_url],
      prStatuses: [detail],
    });

    expect(body).not.toContain('review');
  });

  test('renders review threads section with unresolved count and GitHub links', async () => {
    const detail = makePrDetail({
      reviewThreads: [
        makeReviewThreadDetail({
          thread: { id: 1, thread_id: 'thread-1', path: 'src/b.ts', line: 7, is_resolved: 1 },
          comments: [makeReviewThreadComment({ id: 1, review_thread_id: 1, database_id: 7001 })],
        }),
        makeReviewThreadDetail({
          thread: {
            id: 2,
            thread_id: 'thread-2',
            path: 'src/a.ts',
            line: 3,
            is_resolved: 0,
            is_outdated: 1,
          },
          comments: [
            makeReviewThreadComment({
              id: 2,
              review_thread_id: 2,
              database_id: 7002,
              author: 'alice',
              body: 'This is outdated but still visible.',
            }),
          ],
        }),
      ],
    });
    const { body } = await renderSection({
      prUrls: [detail.status.pr_url],
      prStatuses: [detail],
    });

    expect(body).toContain('2 review threads');
    expect(body).toContain('(1 unresolved)');
    expect(body).toContain('Resolved');
    expect(body).toContain('Outdated');
    expect(body).toContain('href="https://github.com/owner/repo/pull/42#discussion_r7002"');
    expect(body).toContain('src/a.ts:3');
    expect(body).toContain('Copy');
    expect(body).toContain('Convert to Task');
    expect(body).toContain('Fix Unresolved');
  });

  test('passes planUuid through to the review thread list actions', async () => {
    const detail = makePrDetail({
      reviewThreads: [
        makeReviewThreadDetail({
          thread: {
            id: 2,
            thread_id: 'thread-with-plan',
            path: 'src/actionable.ts',
            line: 8,
            is_resolved: 0,
          },
        }),
      ],
    });

    const { body } = await renderSection({
      planUuid: 'plan-custom-uuid',
      prUrls: [detail.status.pr_url],
      prStatuses: [detail],
    });

    expect(body).toContain('Convert to Task');
    expect(body).toContain('Fix Unresolved');
  });

  test('hides the Fix Unresolved button when there are no unresolved review threads', async () => {
    const detail = makePrDetail({
      reviewThreads: [
        makeReviewThreadDetail({
          thread: {
            id: 10,
            thread_id: 'thread-resolved-only',
            path: 'src/resolved-only.ts',
            line: 4,
            is_resolved: 1,
          },
        }),
      ],
    });

    const { body } = await renderSection({
      prUrls: [detail.status.pr_url],
      prStatuses: [detail],
    });

    expect(body).not.toContain('Fix Unresolved');
  });

  test('renders Fix Unresolved as disabled with Session Active label when the plan already has an active session', async () => {
    sessionManager.sessions.set('conn-active', {
      status: 'active',
      sessionInfo: { planUuid: 'plan-active' },
    });

    const detail = makePrDetail({
      reviewThreads: [
        makeReviewThreadDetail({
          thread: {
            id: 11,
            thread_id: 'thread-active',
            path: 'src/active.ts',
            line: 21,
            is_resolved: 0,
          },
        }),
      ],
    });

    const { body } = await renderSection({
      planUuid: 'plan-active',
      prUrls: [detail.status.pr_url],
      prStatuses: [detail],
    });

    expect(body).toContain('Session Active');
    expect(body).toContain('aria-label="Fix all unresolved review threads"');
    expect(body).toContain('<button disabled=""');
  });

  test('renders check run details URL as link', async () => {
    const detail = makePrDetail({
      checks: [makeCheck({ details_url: 'https://github.com/owner/repo/actions/runs/123' })],
    });
    const { body } = await renderSection({
      prUrls: [detail.status.pr_url],
      prStatuses: [detail],
    });

    expect(body).toContain('href="https://github.com/owner/repo/actions/runs/123"');
    expect(body).toContain('Details');
  });

  test('renders check run status icons correctly', async () => {
    const detail = makePrDetail({
      checks: [
        makeCheck({ id: 1, name: 'passing', conclusion: 'success', status: 'completed' }),
        makeCheck({ id: 2, name: 'failing', conclusion: 'failure', status: 'completed' }),
        makeCheck({ id: 3, name: 'running', conclusion: null, status: 'in_progress' }),
      ],
    });
    const { body } = await renderSection({
      prUrls: [detail.status.pr_url],
      prStatuses: [detail],
    });

    // Success check mark
    expect(body).toContain('✓');
    // Failure cross
    expect(body).toContain('✗');
    // In-progress circle
    expect(body).toContain('◌');
  });

  test('renders reviewer state labels', async () => {
    const detail = makePrDetail({
      reviews: [
        makeReview({ id: 1, author: 'alice', state: 'APPROVED' }),
        makeReview({ id: 2, author: 'bob', state: 'CHANGES_REQUESTED' }),
        makeReview({ id: 3, author: 'carol', state: 'COMMENTED' }),
      ],
    });
    const { body } = await renderSection({
      prUrls: [detail.status.pr_url],
      prStatuses: [detail],
    });

    expect(body).toContain('Approved');
    expect(body).toContain('Changes requested');
    expect(body).toContain('Commented');
  });

  test('label uses light text on dark background color', async () => {
    // 000000 is black - should get white text
    const detail = makePrDetail({
      labels: [makeLabel({ name: 'dark-label', color: '000000' })],
    });
    const { body } = await renderSection({
      prUrls: [detail.status.pr_url],
      prStatuses: [detail],
    });

    expect(body).toContain('background-color: #000000; color: #fff');
  });

  test('label uses dark text on light background color', async () => {
    // ffffff is white - should get black text
    const detail = makePrDetail({
      labels: [makeLabel({ name: 'light-label', color: 'ffffff' })],
    });
    const { body } = await renderSection({
      prUrls: [detail.status.pr_url],
      prStatuses: [detail],
    });

    expect(body).toContain('background-color: #ffffff; color: #000');
  });

  test('renders full diff stats when additions, deletions, and changed_files are available', async () => {
    const detail = makePrDetail({
      status: { additions: 42, deletions: 17, changed_files: 3 },
    });
    const { body } = await renderSection({
      prUrls: [detail.status.pr_url],
      prStatuses: [detail],
    });

    expect(body).toContain('3 files changed');
    expect(body).toContain('+42');
    expect(body).toContain('-17');
  });

  test('does not render diff stats when changed_files is null', async () => {
    const detail = makePrDetail({
      status: { additions: 42, deletions: 17, changed_files: null },
    });
    const { body } = await renderSection({
      prUrls: [detail.status.pr_url],
      prStatuses: [detail],
    });

    expect(body).not.toContain('files changed');
    expect(body).not.toContain('text-green-600');
    expect(body).not.toContain('text-red-600');
  });

  test('does not render diff stats when additions and deletions are null', async () => {
    const detail = makePrDetail();
    // additions, deletions, changed_files are null by default in makePrStatus

    const { body } = await renderSection({
      prUrls: [detail.status.pr_url],
      prStatuses: [detail],
    });

    expect(body).not.toContain('files changed');
    expect(body).not.toContain('text-green-600');
    expect(body).not.toContain('text-red-600');
  });
});
