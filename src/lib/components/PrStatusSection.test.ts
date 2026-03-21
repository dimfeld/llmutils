import { render } from 'svelte/server';
import { describe, expect, test } from 'vitest';

import type {
  PrStatusDetail,
  PrStatusRow,
  PrCheckRunRow,
  PrReviewRow,
  PrLabelRow,
} from '$tim/db/pr_status.js';
import PrStatusSection from './PrStatusSection.svelte';

function makePrStatus(overrides: Partial<PrStatusRow> = {}): PrStatusRow {
  return {
    id: 1,
    pr_url: 'https://github.com/owner/repo/pull/42',
    owner: 'owner',
    repo: 'repo',
    pr_number: 42,
    title: 'Add feature X',
    state: 'open',
    draft: 0,
    mergeable: 'MERGEABLE',
    head_sha: 'abc123',
    base_branch: 'main',
    head_branch: 'feature-x',
    review_decision: null,
    check_rollup_state: 'success',
    merged_at: null,
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
    labels?: PrLabelRow[];
  } = {}
): PrStatusDetail {
  return {
    status: makePrStatus(overrides.status),
    checks: overrides.checks ?? [],
    reviews: overrides.reviews ?? [],
    labels: overrides.labels ?? [],
  };
}

function renderSection(props: {
  planUuid?: string;
  prUrls: string[];
  initialStatuses: PrStatusDetail[];
}) {
  return render(PrStatusSection, {
    props: {
      planUuid: props.planUuid ?? 'plan-uuid-1',
      prUrls: props.prUrls,
      initialStatuses: props.initialStatuses,
    },
  });
}

describe('PrStatusSection', () => {
  test('renders "Pull Requests" heading', () => {
    const { body } = renderSection({ prUrls: [], initialStatuses: [] });
    expect(body).toContain('Pull Requests');
  });

  test('renders PR number and title as a link', () => {
    const detail = makePrDetail({ status: { pr_number: 42, title: 'Add feature X' } });
    const { body } = renderSection({
      prUrls: ['https://github.com/owner/repo/pull/42'],
      initialStatuses: [detail],
    });

    expect(body).toContain('#42');
    expect(body).toContain('Add feature X');
    expect(body).toContain('href="https://github.com/owner/repo/pull/42"');
  });

  test('renders state badge for open PR', () => {
    const detail = makePrDetail({ status: { state: 'open' } });
    const { body } = renderSection({
      prUrls: [detail.status.pr_url],
      initialStatuses: [detail],
    });

    expect(body).toContain('Open');
  });

  test('renders state badge for merged PR', () => {
    const detail = makePrDetail({ status: { state: 'merged', merged_at: '2026-03-18T12:00:00Z' } });
    const { body } = renderSection({
      prUrls: [detail.status.pr_url],
      initialStatuses: [detail],
    });

    expect(body).toContain('Merged');
  });

  test('renders Draft badge for draft PRs', () => {
    const detail = makePrDetail({ status: { state: 'open', draft: 1 } });
    const { body } = renderSection({
      prUrls: [detail.status.pr_url],
      initialStatuses: [detail],
    });

    expect(body).toContain('Draft');
  });

  test('renders checks passing badge', () => {
    const detail = makePrDetail({ status: { check_rollup_state: 'success' } });
    const { body } = renderSection({
      prUrls: [detail.status.pr_url],
      initialStatuses: [detail],
    });

    expect(body).toContain('Checks passing');
  });

  test('renders checks failing badge', () => {
    const detail = makePrDetail({ status: { check_rollup_state: 'failure' } });
    const { body } = renderSection({
      prUrls: [detail.status.pr_url],
      initialStatuses: [detail],
    });

    expect(body).toContain('Checks failing');
  });

  test('renders checks pending badge', () => {
    const detail = makePrDetail({ status: { check_rollup_state: 'pending' } });
    const { body } = renderSection({
      prUrls: [detail.status.pr_url],
      initialStatuses: [detail],
    });

    expect(body).toContain('Checks pending');
  });

  test('renders review decision badges', () => {
    const approved = makePrDetail({ status: { review_decision: 'APPROVED' } });
    const { body: bodyApproved } = renderSection({
      prUrls: [approved.status.pr_url],
      initialStatuses: [approved],
    });
    expect(bodyApproved).toContain('Approved');

    const changesRequested = makePrDetail({
      status: {
        review_decision: 'CHANGES_REQUESTED',
        pr_url: 'https://github.com/o/r/pull/2',
        pr_number: 2,
      },
    });
    const { body: bodyCR } = renderSection({
      prUrls: [changesRequested.status.pr_url],
      initialStatuses: [changesRequested],
    });
    expect(bodyCR).toContain('Changes Requested');

    const reviewRequired = makePrDetail({
      status: {
        review_decision: 'REVIEW_REQUIRED',
        pr_url: 'https://github.com/o/r/pull/3',
        pr_number: 3,
      },
    });
    const { body: bodyRR } = renderSection({
      prUrls: [reviewRequired.status.pr_url],
      initialStatuses: [reviewRequired],
    });
    expect(bodyRR).toContain('Review Required');
  });

  test('renders conflict badge when mergeable is CONFLICTING', () => {
    const detail = makePrDetail({ status: { mergeable: 'CONFLICTING' } });
    const { body } = renderSection({
      prUrls: [detail.status.pr_url],
      initialStatuses: [detail],
    });

    expect(body).toContain('Conflicts');
  });

  test('does not render conflict badge when mergeable is MERGEABLE', () => {
    const detail = makePrDetail({ status: { mergeable: 'MERGEABLE' } });
    const { body } = renderSection({
      prUrls: [detail.status.pr_url],
      initialStatuses: [detail],
    });

    expect(body).not.toContain('Conflicts');
  });

  test('renders labels as colored chips', () => {
    const detail = makePrDetail({
      labels: [
        makeLabel({ name: 'enhancement', color: '0075ca' }),
        makeLabel({ id: 2, name: 'bug', color: 'd73a4a' }),
      ],
    });
    const { body } = renderSection({
      prUrls: [detail.status.pr_url],
      initialStatuses: [detail],
    });

    expect(body).toContain('enhancement');
    expect(body).toContain('bug');
    expect(body).toContain('background-color: #0075ca');
    expect(body).toContain('background-color: #d73a4a');
  });

  test('renders expandable check runs section', () => {
    const detail = makePrDetail({
      checks: [
        makeCheck({ name: 'CI / build', conclusion: 'success' }),
        makeCheck({ id: 2, name: 'CI / lint', conclusion: 'failure' }),
      ],
    });
    const { body } = renderSection({
      prUrls: [detail.status.pr_url],
      initialStatuses: [detail],
    });

    expect(body).toContain('2 checks');
    expect(body).toContain('CI / build');
    expect(body).toContain('CI / lint');
  });

  test('renders singular "check" for single check run', () => {
    const detail = makePrDetail({
      checks: [makeCheck({ name: 'CI / build' })],
    });
    const { body } = renderSection({
      prUrls: [detail.status.pr_url],
      initialStatuses: [detail],
    });

    expect(body).toContain('1 check');
    // Should not say "1 checks"
    expect(body).not.toMatch(/1 checks/);
  });

  test('renders expandable reviews section', () => {
    const detail = makePrDetail({
      reviews: [
        makeReview({ author: 'alice', state: 'APPROVED' }),
        makeReview({ id: 2, author: 'bob', state: 'CHANGES_REQUESTED' }),
      ],
    });
    const { body } = renderSection({
      prUrls: [detail.status.pr_url],
      initialStatuses: [detail],
    });

    expect(body).toContain('2 reviews');
    expect(body).toContain('alice');
    expect(body).toContain('bob');
  });

  test('renders raw URL link for PR without cached status', () => {
    const unknownUrl = 'https://github.com/owner/repo/pull/99';
    const { body } = renderSection({
      prUrls: [unknownUrl],
      initialStatuses: [],
    });

    expect(body).toContain(`href="${unknownUrl}"`);
    expect(body).toContain(unknownUrl);
    // Should NOT contain PR number or title since there's no status
    expect(body).not.toContain('#99');
  });

  test('renders multiple PRs with mixed status availability', () => {
    const cachedUrl = 'https://github.com/owner/repo/pull/42';
    const uncachedUrl = 'https://github.com/owner/repo/pull/99';
    const detail = makePrDetail({
      status: { pr_url: cachedUrl, pr_number: 42, title: 'Known PR' },
    });

    const { body } = renderSection({
      prUrls: [cachedUrl, uncachedUrl],
      initialStatuses: [detail],
    });

    // Cached PR shows structured content
    expect(body).toContain('#42');
    expect(body).toContain('Known PR');
    // Uncached PR shows raw URL
    expect(body).toContain(uncachedUrl);
  });

  test('does not render check runs section when there are no checks', () => {
    const detail = makePrDetail({ checks: [] });
    const { body } = renderSection({
      prUrls: [detail.status.pr_url],
      initialStatuses: [detail],
    });

    expect(body).not.toContain('check');
  });

  test('does not render reviews section when there are no reviews', () => {
    const detail = makePrDetail({ reviews: [] });
    const { body } = renderSection({
      prUrls: [detail.status.pr_url],
      initialStatuses: [detail],
    });

    expect(body).not.toContain('review');
  });

  test('renders check run details URL as link', () => {
    const detail = makePrDetail({
      checks: [makeCheck({ details_url: 'https://github.com/owner/repo/actions/runs/123' })],
    });
    const { body } = renderSection({
      prUrls: [detail.status.pr_url],
      initialStatuses: [detail],
    });

    expect(body).toContain('href="https://github.com/owner/repo/actions/runs/123"');
    expect(body).toContain('Details');
  });

  test('renders check run status icons correctly', () => {
    const detail = makePrDetail({
      checks: [
        makeCheck({ id: 1, name: 'passing', conclusion: 'success', status: 'completed' }),
        makeCheck({ id: 2, name: 'failing', conclusion: 'failure', status: 'completed' }),
        makeCheck({ id: 3, name: 'running', conclusion: null, status: 'in_progress' }),
      ],
    });
    const { body } = renderSection({
      prUrls: [detail.status.pr_url],
      initialStatuses: [detail],
    });

    // Success check mark
    expect(body).toContain('✓');
    // Failure cross
    expect(body).toContain('✗');
    // In-progress circle
    expect(body).toContain('◌');
  });

  test('renders reviewer state labels', () => {
    const detail = makePrDetail({
      reviews: [
        makeReview({ id: 1, author: 'alice', state: 'APPROVED' }),
        makeReview({ id: 2, author: 'bob', state: 'CHANGES_REQUESTED' }),
        makeReview({ id: 3, author: 'carol', state: 'COMMENTED' }),
      ],
    });
    const { body } = renderSection({
      prUrls: [detail.status.pr_url],
      initialStatuses: [detail],
    });

    expect(body).toContain('Approved');
    expect(body).toContain('Changes requested');
    expect(body).toContain('Commented');
  });

  test('label uses light text on dark background color', () => {
    // 000000 is black - should get white text
    const detail = makePrDetail({
      labels: [makeLabel({ name: 'dark-label', color: '000000' })],
    });
    const { body } = renderSection({
      prUrls: [detail.status.pr_url],
      initialStatuses: [detail],
    });

    expect(body).toContain('background-color: #000000; color: #fff');
  });

  test('label uses dark text on light background color', () => {
    // ffffff is white - should get black text
    const detail = makePrDetail({
      labels: [makeLabel({ name: 'light-label', color: 'ffffff' })],
    });
    const { body } = renderSection({
      prUrls: [detail.status.pr_url],
      initialStatuses: [detail],
    });

    expect(body).toContain('background-color: #ffffff; color: #000');
  });
});
