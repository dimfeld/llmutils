import { describe, expect, test } from 'vitest';

import type { PrReviewRow, PrStatusRow, PrReviewThreadDetail } from '$tim/db/pr_status.js';
import {
  buildShepherdList,
  evaluatePrShepherd,
  getPrShepherdNotificationFlags,
  groupPrsByMergedDay,
  groupPrsIntoStacks,
  type PrShepherdInput,
} from './pr_shepherd.js';

function makeStatus(overrides: Partial<PrStatusRow> = {}): PrStatusRow {
  return {
    id: 1,
    pr_url: 'https://github.com/example/repo/pull/1',
    owner: 'example',
    repo: 'repo',
    pr_number: 1,
    author: 'me',
    title: 'PR',
    state: 'open',
    draft: 0,
    mergeable: 'MERGEABLE',
    head_sha: 'head',
    base_sha: 'base',
    base_branch: 'main',
    head_branch: 'feature',
    requested_reviewers: null,
    review_decision: 'APPROVED',
    check_rollup_state: 'success',
    merged_at: null,
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
    ...overrides,
  };
}

const humanApproval: PrReviewRow = {
  id: 1,
  pr_status_id: 1,
  author: 'reviewer',
  state: 'APPROVED',
  body: null,
  submitted_at: '2026-01-01T00:00:00.000Z',
};

function makeThread(isResolved: boolean): PrReviewThreadDetail {
  return {
    thread: {
      id: 1,
      pr_status_id: 1,
      thread_id: `thread-${isResolved}`,
      path: 'a.ts',
      line: 1,
      original_line: 1,
      original_start_line: null,
      start_line: null,
      diff_side: 'RIGHT',
      start_diff_side: null,
      is_resolved: isResolved ? 1 : 0,
      is_outdated: 0,
      subject_type: 'LINE',
    },
    comments: [],
  };
}

function makePr(
  statusOverrides: Partial<PrStatusRow> = {},
  extra: Partial<PrShepherdInput> = {}
): PrShepherdInput {
  return {
    status: makeStatus(statusOverrides),
    reviews: [humanApproval],
    reviewThreads: [],
    ...extra,
  };
}

describe('evaluatePrShepherd', () => {
  test('approved, passing, mergeable PR is ready', () => {
    expect(evaluatePrShepherd(makePr())).toEqual({ status: 'ready', attention: [] });
  });

  test('merged and closed PRs are done', () => {
    expect(evaluatePrShepherd(makePr({ state: 'merged' })).status).toBe('done');
    expect(evaluatePrShepherd(makePr({ state: 'closed' })).status).toBe('done');
  });

  test('draft PRs are paused but still list their problems', () => {
    const evaluation = evaluatePrShepherd(makePr({ draft: 1, mergeable: 'CONFLICTING' }));
    expect(evaluation.status).toBe('paused');
    expect(evaluation.attention.map((item) => item.kind)).toEqual(['conflicts']);
  });

  test('collects every blocking problem', () => {
    const evaluation = evaluatePrShepherd(
      makePr(
        {
          mergeable: 'CONFLICTING',
          check_rollup_state: 'failure',
          review_decision: 'CHANGES_REQUESTED',
        },
        { reviewThreads: [makeThread(false), makeThread(false), makeThread(true)] }
      )
    );
    expect(evaluation.status).toBe('needs_attention');
    expect(evaluation.attention).toEqual([
      { kind: 'conflicts', label: 'Merge conflicts', blocking: true },
      { kind: 'ci_failed', label: 'CI failing', blocking: true },
      { kind: 'changes_requested', label: 'Changes requested', blocking: true },
      { kind: 'unresolved_threads', label: '2 unresolved threads', blocking: true },
    ]);
  });

  test('behind base is a hint and does not block ready', () => {
    const evaluation = evaluatePrShepherd(makePr({ behind_by: 3 }));
    expect(evaluation.status).toBe('ready');
    expect(evaluation.attention).toEqual([
      { kind: 'behind_base', label: '3 commits behind main', blocking: false },
    ]);
  });

  test('behind base is not shown when the PR has conflicts', () => {
    const evaluation = evaluatePrShepherd(makePr({ behind_by: 3, mergeable: 'CONFLICTING' }));
    expect(evaluation.attention.map((item) => item.kind)).toEqual(['conflicts']);
  });

  test('a queued PR is in the merge queue even when it has other problems', () => {
    const queuedAt = '2026-01-02T00:00:00.000Z';
    expect(evaluatePrShepherd(makePr({ merge_queue_enqueued_at: queuedAt })).status).toBe(
      'in_merge_queue'
    );

    const evaluation = evaluatePrShepherd(
      makePr({ merge_queue_enqueued_at: queuedAt, check_rollup_state: 'failure' })
    );
    expect(evaluation.status).toBe('in_merge_queue');
    expect(evaluation.attention.map((item) => item.kind)).toEqual(['ci_failed']);
    expect(getPrShepherdNotificationFlags(evaluation)).toEqual([]);
  });

  test('a merged PR with a stale merge queue entry is done', () => {
    expect(
      evaluatePrShepherd(
        makePr({ state: 'merged', merge_queue_enqueued_at: '2026-01-02T00:00:00.000Z' })
      ).status
    ).toBe('done');
  });

  test('pending checks wait before review', () => {
    expect(
      evaluatePrShepherd(makePr({ check_rollup_state: 'pending', review_decision: null })).status
    ).toBe('waiting_checks');
  });

  test('PR without a human approval waits for review', () => {
    expect(evaluatePrShepherd(makePr({}, { reviews: [] })).status).toBe('waiting_review');
    expect(
      evaluatePrShepherd(makePr({}, { reviews: [{ ...humanApproval, author: 'helper[bot]' }] }))
        .status
    ).toBe('waiting_review');
  });
});

describe('getPrShepherdNotificationFlags', () => {
  test('reports conflicts and ready', () => {
    expect(getPrShepherdNotificationFlags(evaluatePrShepherd(makePr()))).toEqual(['ready']);
    expect(
      getPrShepherdNotificationFlags(evaluatePrShepherd(makePr({ mergeable: 'CONFLICTING' })))
    ).toEqual(['conflicts']);
  });

  test('reports nothing for drafts and closed PRs', () => {
    expect(
      getPrShepherdNotificationFlags(
        evaluatePrShepherd(makePr({ draft: 1, mergeable: 'CONFLICTING' }))
      )
    ).toEqual([]);
    expect(getPrShepherdNotificationFlags(evaluatePrShepherd(makePr({ state: 'merged' })))).toEqual(
      []
    );
  });
});

interface TestPr {
  status: PrStatusRow;
  reviews: PrReviewRow[];
  reviewThreads: PrReviewThreadDetail[];
  shepherd: { source: 'auto' } | null;
}

function stackPr(
  prNumber: number,
  baseBranch: string,
  headBranch: string,
  options: { shepherded?: boolean; repo?: string; status?: Partial<PrStatusRow> } = {}
): TestPr {
  return {
    status: makeStatus({
      id: prNumber,
      pr_number: prNumber,
      pr_url: `https://github.com/example/${options.repo ?? 'repo'}/pull/${prNumber}`,
      repo: options.repo ?? 'repo',
      base_branch: baseBranch,
      head_branch: headBranch,
      ...options.status,
    }),
    reviews: [humanApproval],
    reviewThreads: [],
    shepherd: options.shepherded === false ? null : { source: 'auto' },
  };
}

describe('groupPrsIntoStacks', () => {
  test('orders a stack from the trunk to the tip with depths', () => {
    const top = stackPr(3, 'b', 'c');
    const bottom = stackPr(1, 'main', 'a');
    const middle = stackPr(2, 'a', 'b');
    const single = stackPr(10, 'main', 'solo');

    const groups = groupPrsIntoStacks([top, single, middle, bottom]);
    expect(
      groups.map((group) => group.map((entry) => [entry.pr.status.pr_number, entry.depth]))
    ).toEqual([
      [
        [1, 0],
        [2, 1],
        [3, 2],
      ],
      [[10, 0]],
    ]);
  });

  test('keeps sibling branches in one group and separates repositories', () => {
    const groups = groupPrsIntoStacks([
      stackPr(1, 'main', 'a'),
      stackPr(3, 'a', 'c'),
      stackPr(2, 'a', 'b'),
      stackPr(4, 'a', 'x', { repo: 'other' }),
    ]);
    expect(groups.map((group) => group.map((entry) => entry.pr.status.pr_number))).toEqual([
      [1, 2, 3],
      [4],
    ]);
  });

  test('handles a branch cycle without looping', () => {
    const groups = groupPrsIntoStacks([stackPr(1, 'b', 'a'), stackPr(2, 'a', 'b')]);
    expect(groups.map((group) => group.map((entry) => entry.pr.status.pr_number))).toEqual([
      [1, 2],
    ]);
  });
});

describe('buildShepherdList', () => {
  test('keeps unwatched stack members with their stack and sorts urgent groups first', () => {
    const readyPr = stackPr(1, 'main', 'ready');
    const stackBase = stackPr(5, 'main', 'base', { shepherded: false });
    const stackTop = stackPr(6, 'base', 'top', {
      status: { mergeable: 'CONFLICTING' },
    });
    const unwatched = stackPr(9, 'main', 'other', { shepherded: false });
    const closed = stackPr(12, 'main', 'closed', { status: { state: 'closed' } });

    const list = buildShepherdList([readyPr, stackBase, stackTop, unwatched, closed]);
    expect(list.groups.map((group) => group.map((entry) => entry.pr.status.pr_number))).toEqual([
      [5, 6],
      [1],
    ]);
    expect(list.unwatched.map((pr) => pr.status.pr_number)).toEqual([9]);
  });
});

describe('groupPrsByMergedDay', () => {
  // Local times, so the test does not depend on the time zone of the test machine.
  const now = new Date(2026, 9, 21, 15, 0);
  const merged = (id: number, mergedAt: Date | string | null) => ({
    id,
    status: { merged_at: mergedAt instanceof Date ? mergedAt.toISOString() : mergedAt },
  });

  test('groups PRs by local merge day, newest first, with Today and Yesterday labels', () => {
    const groups = groupPrsByMergedDay(
      [
        merged(1, new Date(2026, 9, 19, 10, 0)),
        merged(2, new Date(2026, 9, 21, 9, 0)),
        merged(3, new Date(2026, 9, 20, 23, 30)),
        merged(4, new Date(2026, 9, 21, 14, 0)),
        merged(5, new Date(2026, 9, 20, 0, 15)),
      ],
      now
    );

    expect(groups.map((group) => group.key)).toEqual(['2026-10-21', '2026-10-20', '2026-10-19']);
    expect(groups[0].label).toBe('Today');
    expect(groups[1].label).toBe('Yesterday');
    expect(groups[2].label).toBe(
      new Date(2026, 9, 19).toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'short',
        day: 'numeric',
      })
    );
    expect(groups.map((group) => group.prs.map((pr) => pr.id))).toEqual([[4, 2], [3, 5], [1]]);
  });

  test('leaves out PRs without a valid merge time', () => {
    expect(groupPrsByMergedDay([merged(1, null), merged(2, 'not a date')], now)).toEqual([]);
  });
});
