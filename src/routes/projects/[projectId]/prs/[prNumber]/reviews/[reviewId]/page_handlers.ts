import type { ReviewIssuePatch } from './review_issue_editor_utils.js';
import { extractRemoteErrorMessage } from './remote_error.js';

export interface EditableReviewIssueRow {
  id: number;
  severity: NonNullable<ReviewIssuePatch['severity']>;
  category: NonNullable<ReviewIssuePatch['category']>;
  file: string | null;
  start_line: string | null;
  line: string | null;
  side: NonNullable<ReviewIssuePatch['side']>;
  content: string;
  suggestion: string | null;
}

export interface ReviewIssueRef {
  id: number;
}

export interface ApproximateAnnotationPosition {
  lineIndex: number;
  totalLines: number;
}

export function applyPatchToRow<Row extends EditableReviewIssueRow>(
  row: Row,
  patch: ReviewIssuePatch
): Row {
  const next = { ...row };
  if ('severity' in patch && patch.severity !== undefined) next.severity = patch.severity;
  if ('category' in patch && patch.category !== undefined) next.category = patch.category;
  if ('file' in patch) next.file = patch.file ?? null;
  if ('startLine' in patch) next.start_line = patch.startLine ?? null;
  if ('line' in patch) next.line = patch.line ?? null;
  if ('side' in patch && patch.side !== undefined) next.side = patch.side;
  if ('content' in patch && patch.content !== undefined) next.content = patch.content;
  if ('suggestion' in patch) next.suggestion = patch.suggestion ?? null;
  return next;
}

export interface SaveEditHandlerOptions<Row extends EditableReviewIssueRow> {
  getIssues: () => Row[];
  setIssues: (next: Row[]) => void;
  setError: (message: string | null) => void;
  updateRemote: (args: { issueId: number; patch: ReviewIssuePatch }) => Promise<Row>;
}

export function createSaveEditHandler<Row extends EditableReviewIssueRow>(
  options: SaveEditHandlerOptions<Row>
) {
  const { getIssues, setIssues, setError, updateRemote } = options;

  return async function handleSaveEdit(issue: Row, patch: ReviewIssuePatch) {
    setError(null);

    const snapshot = getIssues().find((i) => i.id === issue.id) ?? null;

    // Optimistic update
    setIssues(getIssues().map((row) => (row.id === issue.id ? applyPatchToRow(row, patch) : row)));

    try {
      const updated = await updateRemote({ issueId: issue.id, patch });
      setIssues(getIssues().map((row) => (row.id === issue.id ? updated : row)));
    } catch (err) {
      if (snapshot) {
        setIssues(getIssues().map((row) => (row.id === issue.id ? snapshot : row)));
      }
      setError(extractRemoteErrorMessage(err));
      throw err;
    }
  };
}

export interface AnnotationClickHandlerOptions {
  setHighlightedIssueId: (id: number | null) => void;
  clearHighlightAfterMs?: number;
  document?: Document;
}

export interface AnnotationClickHandler {
  handleAnnotationClick: (issueId: number) => void;
  cancel: () => void;
  hasPendingTimer: () => boolean;
}

export interface JumpToDiffHandlerOptions {
  getAnnotationNode: (issueId: number) => HTMLElement | null;
  getAnnotationLineNode: (issueId: number) => HTMLElement | null;
  getApproximateAnnotationPosition?: (issueId: number) => ApproximateAnnotationPosition | null;
  getDiffNode: (issueId: number) => HTMLElement | null;
  setHighlightedAnnotation: (node: HTMLElement) => void;
  setError: (message: string | null) => void;
  maxDiffScrollAttempts?: number;
  maxAnnotationScrollAttempts?: number;
  annotationRetryDelayMs?: number;
  getScrollContainer?: (node: HTMLElement) => HTMLElement;
  isElementVisible?: (node: HTMLElement, scrollContainer: HTMLElement) => boolean;
  waitForScrollEnd?: (scrollContainer: HTMLElement) => Promise<void>;
  wait?: (delayMs: number) => Promise<void>;
}

function isScrollableElement(node: HTMLElement): boolean {
  const overflowY = globalThis.getComputedStyle(node).overflowY;
  return /(auto|scroll|overlay)/.test(overflowY) && node.scrollHeight > node.clientHeight;
}

function getComposedParentElement(node: HTMLElement): HTMLElement | null {
  if (node.parentElement) {
    return node.parentElement;
  }

  const root = node.getRootNode();
  if (
    typeof ShadowRoot !== 'undefined' &&
    root instanceof ShadowRoot &&
    root.host instanceof HTMLElement
  ) {
    return root.host;
  }

  return null;
}

function defaultGetScrollContainer(node: HTMLElement): HTMLElement {
  let current: HTMLElement | null = getComposedParentElement(node);
  while (current) {
    if (isScrollableElement(current)) {
      return current;
    }
    current = getComposedParentElement(current);
  }

  return (
    (node.ownerDocument?.scrollingElement as HTMLElement | null) ??
    node.ownerDocument?.documentElement ??
    node
  );
}

function defaultIsElementVisible(node: HTMLElement, scrollContainer: HTMLElement): boolean {
  const nodeRect = node.getBoundingClientRect();
  if (!hasLayoutRect(nodeRect)) {
    return false;
  }

  const containerRect = getScrollContainerViewportRect(scrollContainer);

  return nodeRect.bottom > containerRect.top && nodeRect.top < containerRect.bottom;
}

function hasLayoutRect(rect: DOMRect | ClientRect): boolean {
  return rect.width > 0 || rect.height > 0 || rect.right !== rect.left || rect.bottom !== rect.top;
}

function hasMeasurableLayout(node: HTMLElement): boolean {
  return hasLayoutRect(node.getBoundingClientRect());
}

function getMeasurableLayoutNode(node: HTMLElement): HTMLElement | null {
  if (hasMeasurableLayout(node)) {
    return node;
  }

  for (const child of node.querySelectorAll<HTMLElement>('*')) {
    if (hasMeasurableLayout(child)) {
      return child;
    }
  }

  return null;
}

function getScrollContainerViewportRect(scrollContainer: HTMLElement): {
  top: number;
  bottom: number;
} {
  if (
    scrollContainer === scrollContainer.ownerDocument?.documentElement ||
    scrollContainer === scrollContainer.ownerDocument?.body
  ) {
    return {
      top: 0,
      bottom: globalThis.innerHeight,
    };
  }

  const rect = scrollContainer.getBoundingClientRect();
  return {
    top: rect.top,
    bottom: rect.bottom,
  };
}

function scrollNodeInsideContainer(
  node: HTMLElement,
  scrollContainer: HTMLElement,
  block: ScrollLogicalPosition
): boolean {
  const layoutNode = getMeasurableLayoutNode(node);
  if (!layoutNode) {
    return false;
  }

  const nodeRect = layoutNode.getBoundingClientRect();
  if (!hasLayoutRect(nodeRect)) {
    return false;
  }

  const containerRect = getScrollContainerViewportRect(scrollContainer);
  const containerHeight = containerRect.bottom - containerRect.top;

  let delta: number;
  if (block === 'center') {
    const nodeCenter = nodeRect.top + nodeRect.height / 2;
    const containerCenter = containerRect.top + containerHeight / 2;
    delta = nodeCenter - containerCenter;
  } else if (block === 'start') {
    delta = nodeRect.top - containerRect.top;
  } else if (block === 'end') {
    delta = nodeRect.bottom - containerRect.bottom;
  } else {
    if (nodeRect.top < containerRect.top) {
      delta = nodeRect.top - containerRect.top;
    } else if (nodeRect.bottom > containerRect.bottom) {
      delta = nodeRect.bottom - containerRect.bottom;
    } else {
      delta = 0;
    }
  }

  if (Math.abs(delta) < 1) {
    return true;
  }

  if (
    scrollContainer === scrollContainer.ownerDocument?.documentElement ||
    scrollContainer === scrollContainer.ownerDocument?.body
  ) {
    globalThis.scrollBy?.({ top: delta, behavior: 'smooth' });
    return true;
  }

  scrollContainer.scrollBy({ top: delta, behavior: 'smooth' });
  return true;
}

function scrollByInsideContainer(scrollContainer: HTMLElement, top: number): void {
  if (
    scrollContainer === scrollContainer.ownerDocument?.documentElement ||
    scrollContainer === scrollContainer.ownerDocument?.body
  ) {
    globalThis.scrollBy?.({ top, behavior: 'smooth' });
    return;
  }

  scrollContainer.scrollBy({ top, behavior: 'smooth' });
}

function defaultWaitForScrollEnd(scrollContainer: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    let resolved = false;
    let quietTimer: ReturnType<typeof setTimeout> | null = null;

    const finish = () => {
      if (resolved) {
        return;
      }
      resolved = true;
      cleanup();
      resolve();
    };

    const scheduleQuietFinish = () => {
      if (quietTimer) {
        clearTimeout(quietTimer);
      }
      quietTimer = setTimeout(finish, 100);
    };

    const onScrollEnd = () => finish();
    const onScroll = () => scheduleQuietFinish();

    const cleanup = () => {
      scrollContainer.removeEventListener('scrollend', onScrollEnd);
      scrollContainer.removeEventListener('scroll', onScroll);
      if (quietTimer) {
        clearTimeout(quietTimer);
      }
    };

    scrollContainer.addEventListener('scrollend', onScrollEnd);
    scrollContainer.addEventListener('scroll', onScroll, { passive: true });

    scheduleQuietFinish();
  });
}

export function createJumpToDiffHandler(options: JumpToDiffHandlerOptions) {
  const {
    getAnnotationNode,
    getAnnotationLineNode,
    getApproximateAnnotationPosition = () => null,
    getDiffNode,
    setHighlightedAnnotation,
    setError,
    maxDiffScrollAttempts = 4,
    maxAnnotationScrollAttempts = 4,
    annotationRetryDelayMs = 100,
    getScrollContainer = defaultGetScrollContainer,
    isElementVisible = defaultIsElementVisible,
    waitForScrollEnd = defaultWaitForScrollEnd,
    wait = (delayMs: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      }),
  } = options;

  async function scrollElementUntilVisible(
    node: HTMLElement,
    maxAttempts: number,
    block: ScrollLogicalPosition = 'center'
  ): Promise<boolean> {
    const scrollContainer = getScrollContainer(node);

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (!scrollNodeInsideContainer(node, scrollContainer, block)) {
        return false;
      }
      await waitForScrollEnd(scrollContainer);
      if (isElementVisible(node, scrollContainer)) {
        return true;
      }
    }

    return false;
  }

  async function scrollToApproximateLine(
    diffNode: HTMLElement,
    position: ApproximateAnnotationPosition
  ): Promise<boolean> {
    const diffRect = diffNode.getBoundingClientRect();
    if (!hasLayoutRect(diffRect)) {
      return false;
    }

    const scrollContainer = getScrollContainer(diffNode);
    const containerRect = getScrollContainerViewportRect(scrollContainer);
    const containerHeight = containerRect.bottom - containerRect.top;
    if (containerHeight <= 0) {
      return false;
    }

    const totalLines = Math.max(1, position.totalLines);
    const clampedLineIndex = Math.max(0, Math.min(position.lineIndex, totalLines - 1));
    const fraction = totalLines <= 1 ? 0 : clampedLineIndex / (totalLines - 1);
    const estimatedLineTop = diffRect.top + diffRect.height * fraction;
    const targetTop = estimatedLineTop - (containerRect.top + containerHeight);

    scrollByInsideContainer(scrollContainer, targetTop);
    await waitForScrollEnd(scrollContainer);
    return true;
  }

  async function centerRenderedLine(issueId: number): Promise<HTMLElement | null> {
    const maxAttempts = maxAnnotationScrollAttempts;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const node = getAnnotationLineNode(issueId);
      if (!node) {
        if (attempt < maxAttempts - 1) {
          await wait(annotationRetryDelayMs);
        }
        continue;
      }

      const scrollContainer = getScrollContainer(node);
      if (!scrollNodeInsideContainer(node, scrollContainer, 'center')) {
        if (attempt < maxAttempts - 1) {
          await wait(annotationRetryDelayMs);
        }
        continue;
      }

      await waitForScrollEnd(scrollContainer);

      const latestNode = getAnnotationLineNode(issueId);
      if (latestNode && getMeasurableLayoutNode(latestNode)) {
        return latestNode;
      }

      if (attempt < maxAttempts - 1) {
        await wait(annotationRetryDelayMs);
      }
    }

    return null;
  }

  function highlightAnnotationIfMounted(issueId: number): void {
    const annotationNode = getAnnotationNode(issueId);
    if (annotationNode) {
      setHighlightedAnnotation(annotationNode);
    }
  }

  async function centerRenderedLineAndHighlight(issueId: number): Promise<boolean> {
    const lineNode = await centerRenderedLine(issueId);
    if (!lineNode) {
      return false;
    }

    highlightAnnotationIfMounted(issueId);
    return true;
  }

  async function ensureDiffIsVisible(diffNode: HTMLElement): Promise<boolean> {
    const scrollContainer = getScrollContainer(diffNode);
    if (isElementVisible(diffNode, scrollContainer)) {
      return true;
    }

    return await scrollElementUntilVisible(diffNode, maxDiffScrollAttempts, 'start');
  }

  return async function handleJumpToDiff(issue: ReviewIssueRef) {
    setError(null);

    const initialLineNode = getAnnotationLineNode(issue.id);
    if (initialLineNode && getMeasurableLayoutNode(initialLineNode)) {
      const didScroll = await centerRenderedLineAndHighlight(issue.id);
      if (didScroll) {
        return;
      }
    }

    const diffNode = getDiffNode(issue.id);
    if (diffNode) {
      const diffVisible = await ensureDiffIsVisible(diffNode);
      if (!diffVisible) {
        setError(
          `The diff never stayed in view long enough to jump to the annotation. Try again after scrolling settles.`
        );
        return;
      }

      const approximatePosition = getApproximateAnnotationPosition(issue.id);
      if (approximatePosition) {
        const approximated = await scrollToApproximateLine(diffNode, approximatePosition);
        if (approximated) {
          const didScroll = await centerRenderedLineAndHighlight(issue.id);
          if (didScroll) {
            return;
          }
        }
      }

      const didScroll = await centerRenderedLineAndHighlight(issue.id);
      if (!didScroll) {
        setError(`No annotation rendered for this issue even after scrolling to the diff.`);
      }
      return;
    }

    setError(
      `No annotation rendered for this issue — the line may be outside the diff hunks shown in the guide.`
    );
  };
}

export function createAnnotationClickHandler(
  options: AnnotationClickHandlerOptions
): AnnotationClickHandler {
  const {
    setHighlightedIssueId,
    clearHighlightAfterMs = 1500,
    document: doc = globalThis.document,
  } = options;

  let timer: ReturnType<typeof setTimeout> | null = null;

  function cancel() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function handleAnnotationClick(issueId: number) {
    const el = doc?.getElementById(`review-issue-${issueId}`);
    if (el) {
      // Cards live inside user-collapsible <details> severity groups; force
      // the containing group open before scrolling so collapsed severities
      // don't appear to swallow the click.
      const details = el.closest('details') as HTMLDetailsElement | null;
      if (details && !details.open) details.open = true;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    setHighlightedIssueId(issueId);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      setHighlightedIssueId(null);
      timer = null;
    }, clearHighlightAfterMs);
  }

  return {
    handleAnnotationClick,
    cancel,
    hasPendingTimer: () => timer !== null,
  };
}
