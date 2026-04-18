import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { render } from 'vitest-browser-svelte';

import type { ReviewIssueRow } from '$tim/db/review.js';
import PageHandlersHarness from './PageHandlersHarness.svelte';
import type { ReviewIssuePatch } from './review_issue_editor_utils.js';

function makeIssue(overrides: Partial<ReviewIssueRow> = {}): ReviewIssueRow {
  return {
    id: 1,
    review_id: 10,
    severity: 'minor',
    category: 'other',
    content: 'Original content',
    file: null,
    line: null,
    start_line: null,
    suggestion: null,
    source: null,
    side: 'RIGHT',
    submittedInPrReviewId: null,
    resolved: 0,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

interface HarnessApi {
  handleAnnotationClick: (issueId: number) => void;
  handleSaveEdit: (issue: ReviewIssueRow, patch: ReviewIssuePatch) => Promise<void>;
  getIssues: () => ReviewIssueRow[];
  getHighlightedIssueId: () => number | null;
  getError: () => string | null;
}

async function mountHarness(opts: {
  initialIssues: ReviewIssueRow[];
  updateRemote?: (args: { issueId: number; patch: ReviewIssuePatch }) => Promise<ReviewIssueRow>;
}) {
  let api: HarnessApi | null = null;
  const screen = render(PageHandlersHarness, {
    initialIssues: opts.initialIssues,
    updateRemote: opts.updateRemote ?? (async () => opts.initialIssues[0]),
    onReady: (a) => {
      api = a;
    },
  });
  await vi.waitFor(() => {
    if (!api) throw new Error('harness not ready');
  });
  return { screen, api: api! };
}

describe('annotation click integration (real DOM)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('click sets data-highlighted on the matching <li> and clears after timeout', async () => {
    const { api } = await mountHarness({
      initialIssues: [makeIssue({ id: 1, content: 'one' }), makeIssue({ id: 2, content: 'two' })],
    });

    api.handleAnnotationClick(2);

    await vi.waitFor(() => {
      const target = document.getElementById('review-issue-2');
      if (target?.getAttribute('data-highlighted') !== 'true') {
        throw new Error('not yet highlighted');
      }
    });

    const targetLi = document.getElementById('review-issue-2')!;
    const siblingLi = document.getElementById('review-issue-1')!;
    expect(targetLi.getAttribute('data-highlighted')).toBe('true');
    expect(siblingLi.getAttribute('data-highlighted')).toBeNull();

    vi.advanceTimersByTime(1500);

    await vi.waitFor(() => {
      if (document.getElementById('review-issue-2')?.getAttribute('data-highlighted') !== null) {
        throw new Error('still highlighted');
      }
    });
    expect(api.getHighlightedIssueId()).toBeNull();
  });

  test('consecutive clicks reset the timer — first target clears, second stays highlighted', async () => {
    const { api } = await mountHarness({
      initialIssues: [makeIssue({ id: 1, content: 'one' }), makeIssue({ id: 2, content: 'two' })],
    });

    api.handleAnnotationClick(1);
    await vi.waitFor(() => {
      if (document.getElementById('review-issue-1')?.getAttribute('data-highlighted') !== 'true') {
        throw new Error('issue 1 not highlighted');
      }
    });

    vi.advanceTimersByTime(1000);
    api.handleAnnotationClick(2);

    await vi.waitFor(() => {
      const one = document.getElementById('review-issue-1');
      const two = document.getElementById('review-issue-2');
      if (one?.getAttribute('data-highlighted') === 'true') {
        throw new Error('issue 1 should have lost highlight');
      }
      if (two?.getAttribute('data-highlighted') !== 'true') {
        throw new Error('issue 2 should be highlighted');
      }
    });

    // 1400ms after the second click: if the first timer had fired at its
    // scheduled 1500ms mark it would have cleared issue 2's highlight too.
    vi.advanceTimersByTime(1400);
    expect(document.getElementById('review-issue-2')?.getAttribute('data-highlighted')).toBe(
      'true'
    );

    vi.advanceTimersByTime(200);
    await vi.waitFor(() => {
      if (document.getElementById('review-issue-2')?.getAttribute('data-highlighted') !== null) {
        throw new Error('issue 2 should have cleared');
      }
    });
  });
});

describe('handleSaveEdit integration (real DOM)', () => {
  test('failed save reverts the rendered card content', async () => {
    const issue = makeIssue({ id: 1, content: 'Original content' });
    const updateRemote = vi.fn(async () => {
      throw new Error('server error');
    });
    const { api } = await mountHarness({ initialIssues: [issue], updateRemote });

    // Sanity: original content is rendered.
    await vi.waitFor(() => {
      const li = document.getElementById('review-issue-1');
      if (!li?.textContent?.includes('Original content')) {
        throw new Error('initial content not rendered');
      }
    });

    await expect(api.handleSaveEdit(issue, { content: 'New content' })).rejects.toThrow(
      'server error'
    );

    // After revert, original content is back in the DOM and new content is not.
    await vi.waitFor(() => {
      const li = document.getElementById('review-issue-1');
      const text = li?.textContent ?? '';
      if (!text.includes('Original content')) throw new Error('original not restored');
      if (text.includes('New content')) throw new Error('optimistic still present');
    });

    expect(api.getIssues()[0].content).toBe('Original content');
    expect(api.getError()).toBe('server error');
  });

  test('successful save updates the rendered card content', async () => {
    const issue = makeIssue({ id: 1, content: 'Original content' });
    const serverRow = makeIssue({
      id: 1,
      content: 'Server-returned content',
      updated_at: '2026-02-01T00:00:00.000Z',
    });
    const updateRemote = vi.fn(async () => serverRow);
    const { api } = await mountHarness({ initialIssues: [issue], updateRemote });

    await api.handleSaveEdit(issue, { content: 'Server-returned content' });

    await vi.waitFor(() => {
      const li = document.getElementById('review-issue-1');
      if (!li?.textContent?.includes('Server-returned content')) {
        throw new Error('server content not rendered');
      }
    });

    expect(api.getIssues()[0].content).toBe('Server-returned content');
    expect(api.getError()).toBeNull();
  });
});
