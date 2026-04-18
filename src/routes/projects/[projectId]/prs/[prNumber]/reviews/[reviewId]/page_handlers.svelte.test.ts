import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { ReviewIssueRow } from '$tim/db/review.js';
import { createAnnotationClickHandler, createSaveEditHandler } from './page_handlers.js';

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

describe('createSaveEditHandler', () => {
  test('success path replaces the row with the server response', async () => {
    let issues = [makeIssue({ id: 1, content: 'before' }), makeIssue({ id: 2, content: 'other' })];
    const errorCalls: (string | null)[] = [];
    const server = makeIssue({ id: 1, content: 'server-canonical', updated_at: '2026-02-01Z' });

    const handler = createSaveEditHandler({
      getIssues: () => issues,
      setIssues: (next) => {
        issues = next;
      },
      setError: (m) => errorCalls.push(m),
      updateRemote: async () => server,
    });

    await handler(issues[0], { content: 'after' });

    expect(issues.find((i) => i.id === 1)).toEqual(server);
    expect(issues.find((i) => i.id === 2)?.content).toBe('other');
    expect(errorCalls).toEqual([null]);
  });

  test('failure reverts the optimistic update to the pre-edit snapshot', async () => {
    const before = makeIssue({ id: 1, content: 'before', suggestion: null });
    let issues: ReviewIssueRow[] = [before, makeIssue({ id: 2 })];
    const seen: ReviewIssueRow[][] = [];
    const errorCalls: (string | null)[] = [];

    const handler = createSaveEditHandler({
      getIssues: () => issues,
      setIssues: (next) => {
        issues = next;
        seen.push(next);
      },
      setError: (m) => errorCalls.push(m),
      updateRemote: async () => {
        throw new Error('server rejected');
      },
    });

    await expect(handler(before, { content: 'after' })).rejects.toThrow('server rejected');

    // Final state must be the pre-edit snapshot
    expect(issues.find((i) => i.id === 1)).toEqual(before);
    // Observed at least one optimistic intermediate state
    expect(seen.some((snapshot) => snapshot.find((i) => i.id === 1)?.content === 'after')).toBe(
      true
    );
    expect(errorCalls).toEqual([null, 'server rejected']);
  });

  test('failure when pre-edit snapshot is missing does not throw in revert', async () => {
    const before = makeIssue({ id: 99 });
    let issues: ReviewIssueRow[] = [makeIssue({ id: 1 })];

    const handler = createSaveEditHandler({
      getIssues: () => issues,
      setIssues: (next) => {
        issues = next;
      },
      setError: () => {},
      updateRemote: async () => {
        throw new Error('nope');
      },
    });

    await expect(handler(before, { content: 'x' })).rejects.toThrow('nope');
    // No row with id 99 existed, so nothing was patched or reverted.
    expect(issues.map((i) => i.id)).toEqual([1]);
  });

  test('extracts structured remote error bodies', async () => {
    let issues = [makeIssue({ id: 1 })];
    const errorCalls: (string | null)[] = [];

    const handler = createSaveEditHandler({
      getIssues: () => issues,
      setIssues: (next) => {
        issues = next;
      },
      setError: (m) => errorCalls.push(m),
      updateRemote: async () => {
        // Mimic SvelteKit's structured error shape
        throw { body: { message: 'validation failed' } };
      },
    });

    await expect(handler(issues[0], { content: 'x' })).rejects.toBeDefined();
    expect(errorCalls[errorCalls.length - 1]).toBe('validation failed');
  });
});

describe('createAnnotationClickHandler', () => {
  let host: HTMLElement;

  beforeEach(() => {
    vi.useFakeTimers();
    host = document.createElement('div');
    document.body.appendChild(host);
  });

  afterEach(() => {
    vi.useRealTimers();
    host.remove();
  });

  function mountCard(id: number, opts: { insideDetails?: boolean; open?: boolean } = {}) {
    const li = document.createElement('li');
    li.id = `review-issue-${id}`;
    li.scrollIntoView = vi.fn();

    if (opts.insideDetails) {
      const details = document.createElement('details');
      if (opts.open) details.open = true;
      const summary = document.createElement('summary');
      summary.textContent = 'group';
      details.appendChild(summary);
      const ul = document.createElement('ul');
      ul.appendChild(li);
      details.appendChild(ul);
      host.appendChild(details);
      return { li, details };
    }

    host.appendChild(li);
    return { li, details: null };
  }

  test('sets highlighted id, scrolls, and clears after the timeout', () => {
    const { li } = mountCard(42);
    const setHighlight = vi.fn();

    const handler = createAnnotationClickHandler({
      setHighlightedIssueId: setHighlight,
      clearHighlightAfterMs: 1500,
    });

    handler.handleAnnotationClick(42);
    expect(setHighlight).toHaveBeenNthCalledWith(1, 42);
    expect(li.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(handler.hasPendingTimer()).toBe(true);

    vi.advanceTimersByTime(1500);

    expect(setHighlight).toHaveBeenNthCalledWith(2, null);
    expect(handler.hasPendingTimer()).toBe(false);
  });

  test('forces a closed <details> open before scrolling', () => {
    const { li, details } = mountCard(7, { insideDetails: true, open: false });
    const setHighlight = vi.fn();

    const handler = createAnnotationClickHandler({
      setHighlightedIssueId: setHighlight,
    });

    expect(details!.open).toBe(false);
    handler.handleAnnotationClick(7);
    expect(details!.open).toBe(true);
    expect(li.scrollIntoView).toHaveBeenCalled();
  });

  test('consecutive clicks cancel the previous timer', () => {
    mountCard(1);
    mountCard(2);
    const setHighlight = vi.fn();

    const handler = createAnnotationClickHandler({
      setHighlightedIssueId: setHighlight,
      clearHighlightAfterMs: 1500,
    });

    handler.handleAnnotationClick(1);
    // Advance partway; the first timer would fire at 1500ms without intervention.
    vi.advanceTimersByTime(1000);
    expect(setHighlight).toHaveBeenCalledTimes(1);

    handler.handleAnnotationClick(2);
    expect(setHighlight).toHaveBeenNthCalledWith(2, 2);

    // 1400ms after the second click = 2400ms since the first. If the first
    // timer had not been cancelled, it would have fired at the 1500ms mark
    // and we'd see a `null` call. Verify it did not.
    vi.advanceTimersByTime(1400);
    expect(setHighlight).toHaveBeenCalledTimes(2);

    // Push past the second click's 1500ms window -> should clear now.
    vi.advanceTimersByTime(200);
    expect(setHighlight).toHaveBeenNthCalledWith(3, null);
    expect(handler.hasPendingTimer()).toBe(false);
  });

  test('cancel() clears a pending timer without firing the clear callback', () => {
    mountCard(5);
    const setHighlight = vi.fn();

    const handler = createAnnotationClickHandler({
      setHighlightedIssueId: setHighlight,
    });

    handler.handleAnnotationClick(5);
    expect(setHighlight).toHaveBeenCalledTimes(1);
    expect(handler.hasPendingTimer()).toBe(true);

    handler.cancel();
    expect(handler.hasPendingTimer()).toBe(false);

    vi.advanceTimersByTime(5000);
    // Timer should never have fired, so only the initial set call happened.
    expect(setHighlight).toHaveBeenCalledTimes(1);
  });

  test('missing element still highlights and schedules clear', () => {
    const setHighlight = vi.fn();
    const handler = createAnnotationClickHandler({
      setHighlightedIssueId: setHighlight,
    });

    // No card mounted for id 999
    expect(() => handler.handleAnnotationClick(999)).not.toThrow();
    expect(setHighlight).toHaveBeenCalledWith(999);
    vi.advanceTimersByTime(1500);
    expect(setHighlight).toHaveBeenLastCalledWith(null);
  });
});
