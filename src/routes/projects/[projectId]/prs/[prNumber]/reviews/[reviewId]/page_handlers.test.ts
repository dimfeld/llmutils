// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  createAnnotationClickHandler,
  createJumpToDiffHandler,
  createSaveEditHandler,
  type EditableReviewIssueRow,
  type ReviewIssueRef,
} from './page_handlers.js';

interface TestReviewIssueRow extends EditableReviewIssueRow {
  review_id: number;
  source: string | null;
  submittedInPrReviewId: number | null;
  resolved: number;
  created_at: string;
  updated_at: string;
}

function makeIssue(overrides: Partial<TestReviewIssueRow> = {}): TestReviewIssueRow {
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
    let issues: TestReviewIssueRow[] = [before, makeIssue({ id: 2 })];
    const seen: TestReviewIssueRow[][] = [];
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
    let issues: TestReviewIssueRow[] = [makeIssue({ id: 1 })];

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

describe('createJumpToDiffHandler', () => {
  let issue: ReviewIssueRef;

  beforeEach(() => {
    vi.useFakeTimers();
    issue = makeIssue({ id: 7, file: 'src/app.ts', line: '42' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeNode() {
    const node = document.createElement('div');
    node.scrollIntoView = vi.fn();
    return node;
  }

  function mockRect(node: HTMLElement, rect: Partial<DOMRect>) {
    node.getBoundingClientRect = vi.fn(
      () =>
        ({
          x: 0,
          y: rect.top ?? 0,
          top: rect.top ?? 0,
          bottom: rect.bottom ?? 0,
          left: 0,
          right: rect.right ?? 100,
          width: rect.width ?? 100,
          height: (rect.bottom ?? 0) - (rect.top ?? 0),
          toJSON: () => ({}),
        }) as DOMRect
    );
  }

  test('jumps straight to the diff line when it is already rendered', async () => {
    const annotationNode = makeNode();
    const lineNode = makeNode();
    const diffNode = makeNode();
    const setError = vi.fn();
    const setHighlightedAnnotation = vi.fn();
    const scrollBy = vi.fn();
    diffNode.scrollBy = scrollBy;
    mockRect(diffNode, { top: 0, bottom: 100 });
    mockRect(annotationNode, { top: 180, bottom: 200 });
    mockRect(lineNode, { top: 180, bottom: 200 });

    const handler = createJumpToDiffHandler({
      getAnnotationNode: () => annotationNode,
      getAnnotationLineNode: () => lineNode,
      getDiffNode: () => diffNode,
      setHighlightedAnnotation,
      setError,
      getScrollContainer: () => diffNode,
      waitForScrollEnd: async () => {},
      isElementVisible: () => true,
    });

    await handler(issue);

    expect(setError).toHaveBeenCalledWith(null);
    expect(diffNode.scrollIntoView).not.toHaveBeenCalled();
    expect(annotationNode.scrollIntoView).not.toHaveBeenCalled();
    expect(lineNode.scrollIntoView).not.toHaveBeenCalled();
    expect(scrollBy).toHaveBeenCalledWith({
      top: 140,
      behavior: 'smooth',
    });
    expect(setHighlightedAnnotation).toHaveBeenCalledWith(annotationNode);
  });

  test('scrolls the diff wrapper into view when the line is unavailable and the diff is off screen', async () => {
    const annotationNode = makeNode();
    const diffNode = makeNode();
    const scrollContainer = makeNode();
    const setError = vi.fn();
    const setHighlightedAnnotation = vi.fn();
    let diffVisible = false;
    scrollContainer.scrollBy = vi.fn();
    mockRect(scrollContainer, { top: 0, bottom: 100 });
    mockRect(annotationNode, { top: 0, bottom: 0, right: 0, width: 0 });
    mockRect(diffNode, { top: 250, bottom: 350 });

    const handler = createJumpToDiffHandler({
      getAnnotationNode: () => annotationNode,
      getAnnotationLineNode: () => null,
      getDiffNode: () => diffNode,
      setHighlightedAnnotation,
      setError,
      getScrollContainer: () => scrollContainer,
      waitForScrollEnd: async () => {
        diffVisible = true;
      },
      isElementVisible: (node) => node === diffNode && diffVisible,
      maxAnnotationScrollAttempts: 1,
      wait: async () => {},
    });

    await handler(issue);

    expect(setError).toHaveBeenCalledWith(null);
    expect(setError).toHaveBeenLastCalledWith(
      'No annotation rendered for this issue even after scrolling to the diff.'
    );
    expect(scrollContainer.scrollBy).toHaveBeenCalledTimes(1);
    expect(scrollContainer.scrollBy).toHaveBeenCalledWith({
      top: 250,
      behavior: 'smooth',
    });
    expect(annotationNode.scrollIntoView).not.toHaveBeenCalled();
    expect(setHighlightedAnnotation).not.toHaveBeenCalled();
  });

  test('uses the rendered diff line even when the tracked annotation wrapper has no layout rect', async () => {
    const annotationWrapper = makeNode();
    const lineNode = makeNode();
    const diffNode = makeNode();
    const scrollContainer = makeNode();
    const setError = vi.fn();
    const setHighlightedAnnotation = vi.fn();
    scrollContainer.scrollBy = vi.fn();
    mockRect(scrollContainer, { top: 0, bottom: 100 });
    mockRect(annotationWrapper, { top: 0, bottom: 0, right: 0, width: 0 });
    mockRect(lineNode, { top: 180, bottom: 200 });

    const handler = createJumpToDiffHandler({
      getAnnotationNode: () => annotationWrapper,
      getAnnotationLineNode: () => lineNode,
      getDiffNode: () => diffNode,
      setHighlightedAnnotation,
      setError,
      getScrollContainer: () => scrollContainer,
      waitForScrollEnd: async () => {},
      isElementVisible: () => true,
    });

    await handler(issue);

    expect(setError).toHaveBeenCalledWith(null);
    expect(diffNode.scrollIntoView).not.toHaveBeenCalled();
    expect(scrollContainer.scrollBy).toHaveBeenCalledWith({
      top: 140,
      behavior: 'smooth',
    });
    expect(setHighlightedAnnotation).toHaveBeenCalledWith(annotationWrapper);
  });

  test('keeps re-scrolling the diff until it becomes visible, then scrolls the annotation once it is mounted', async () => {
    const annotationNode = makeNode();
    const diffNode = makeNode();
    const scrollContainer = makeNode();
    const setError = vi.fn();
    const setHighlightedAnnotation = vi.fn();
    let annotationMounted = false;
    let diffVisibilityChecks = 0;
    scrollContainer.scrollBy = vi.fn();
    mockRect(scrollContainer, { top: 0, bottom: 100 });
    mockRect(diffNode, { top: 250, bottom: 350 });
    mockRect(annotationNode, { top: 180, bottom: 200 });

    const handler = createJumpToDiffHandler({
      getAnnotationNode: () => (annotationMounted ? annotationNode : null),
      getAnnotationLineNode: () => (annotationMounted ? annotationNode : null),
      getDiffNode: () => diffNode,
      setHighlightedAnnotation,
      setError,
      getScrollContainer: () => scrollContainer,
      waitForScrollEnd: async () => {},
      isElementVisible: (node) => {
        if (node === diffNode) {
          diffVisibilityChecks += 1;
          if (diffVisibilityChecks >= 3) {
            annotationMounted = true;
            return true;
          }
          return false;
        }

        if (annotationMounted) {
          return true;
        }
        return false;
      },
      annotationRetryDelayMs: 0,
      wait: async () => {},
    });

    await handler(issue);

    expect(setError).toHaveBeenCalledWith(null);
    expect(scrollContainer.scrollBy).toHaveBeenCalledTimes(4);
    expect(diffNode.scrollIntoView).not.toHaveBeenCalled();
    expect(annotationNode.scrollIntoView).not.toHaveBeenCalled();
    expect(setHighlightedAnnotation).toHaveBeenCalledWith(annotationNode);
  });

  test('scrolls the diff into view, approximates the line position, then scrolls the rendered line', async () => {
    const annotationNode = makeNode();
    const lineNode = makeNode();
    const diffNode = makeNode();
    const scrollContainer = makeNode();
    const setError = vi.fn();
    const setHighlightedAnnotation = vi.fn();
    let diffVisible = false;
    let lineMounted = false;
    let scrollSettles = 0;
    scrollContainer.scrollBy = vi.fn();
    mockRect(scrollContainer, { top: 0, bottom: 100 });
    mockRect(diffNode, { top: 100, bottom: 1100 });
    mockRect(lineNode, { top: 180, bottom: 200 });

    const handler = createJumpToDiffHandler({
      getAnnotationNode: () => annotationNode,
      getAnnotationLineNode: () => (lineMounted ? lineNode : null),
      getApproximateAnnotationPosition: () => ({ lineIndex: 49, totalLines: 100 }),
      getDiffNode: () => diffNode,
      setHighlightedAnnotation,
      setError,
      getScrollContainer: () => scrollContainer,
      waitForScrollEnd: async () => {
        scrollSettles += 1;
        if (scrollSettles >= 1) {
          diffVisible = true;
        }
        if (scrollSettles >= 2) {
          lineMounted = true;
        }
      },
      isElementVisible: (node) => {
        if (node === diffNode) {
          return diffVisible;
        }
        return lineMounted;
      },
      wait: async () => {},
    });

    await handler(issue);

    expect(setError).toHaveBeenCalledWith(null);
    expect(scrollContainer.scrollBy).toHaveBeenNthCalledWith(1, {
      top: 100,
      behavior: 'smooth',
    });
    expect(scrollContainer.scrollBy).toHaveBeenNthCalledWith(2, {
      top: 494.9494949494949,
      behavior: 'smooth',
    });
    expect(scrollContainer.scrollBy).toHaveBeenNthCalledWith(3, {
      top: 140,
      behavior: 'smooth',
    });
    expect(setHighlightedAnnotation).toHaveBeenCalledWith(annotationNode);
  });

  test('reports an error when the diff never becomes visible', async () => {
    const diffNode = makeNode();
    const scrollContainer = makeNode();
    const setError = vi.fn();
    const setHighlightedAnnotation = vi.fn();

    const handler = createJumpToDiffHandler({
      getAnnotationNode: () => null,
      getAnnotationLineNode: () => null,
      getDiffNode: () => diffNode,
      setHighlightedAnnotation,
      setError,
      getScrollContainer: () => scrollContainer,
      waitForScrollEnd: async () => {},
      isElementVisible: () => false,
      maxDiffScrollAttempts: 2,
    });

    await handler(issue);

    expect(setError).toHaveBeenLastCalledWith(
      'The diff never stayed in view long enough to jump to the annotation. Try again after scrolling settles.'
    );
    expect(setHighlightedAnnotation).not.toHaveBeenCalled();
  });

  test('reports an error when neither the annotation nor the diff wrapper is available', async () => {
    const setError = vi.fn();
    const setHighlightedAnnotation = vi.fn();
    const handler = createJumpToDiffHandler({
      getAnnotationNode: () => null,
      getAnnotationLineNode: () => null,
      getDiffNode: () => null,
      setHighlightedAnnotation,
      setError,
    });

    await handler(issue);

    expect(setError).toHaveBeenLastCalledWith(
      'No annotation rendered for this issue — the line may be outside the diff hunks shown in the guide.'
    );
    expect(setHighlightedAnnotation).not.toHaveBeenCalled();
  });

  test('finds the scroll container across a shadow root boundary', async () => {
    const scrollContainer = document.createElement('div');
    scrollContainer.style.overflowY = 'auto';
    Object.defineProperty(scrollContainer, 'scrollHeight', { configurable: true, value: 200 });
    Object.defineProperty(scrollContainer, 'clientHeight', { configurable: true, value: 100 });

    const host = document.createElement('div');
    const shadowRoot = host.attachShadow({ mode: 'open' });
    const annotationNode = makeNode();
    shadowRoot.appendChild(annotationNode);
    scrollContainer.appendChild(host);
    document.body.appendChild(scrollContainer);

    const seenScrollContainers: HTMLElement[] = [];
    const setError = vi.fn();
    const setHighlightedAnnotation = vi.fn();

    try {
      const handler = createJumpToDiffHandler({
        getAnnotationNode: () => annotationNode,
        getAnnotationLineNode: () => annotationNode,
        getDiffNode: () => null,
        setHighlightedAnnotation,
        setError,
        waitForScrollEnd: async (node) => {
          seenScrollContainers.push(node);
        },
        isElementVisible: () => true,
      });

      await handler(issue);

      expect(seenScrollContainers).toEqual([scrollContainer]);
      expect(setHighlightedAnnotation).toHaveBeenCalledWith(annotationNode);
    } finally {
      scrollContainer.remove();
    }
  });
});
