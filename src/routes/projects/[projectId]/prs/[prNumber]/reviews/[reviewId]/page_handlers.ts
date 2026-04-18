import type { ReviewIssueRow } from '$tim/db/review.js';
import type { ReviewIssuePatch } from './review_issue_editor_utils.js';
import { extractRemoteErrorMessage } from './remote_error.js';

export function applyPatchToRow(row: ReviewIssueRow, patch: ReviewIssuePatch): ReviewIssueRow {
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

export interface SaveEditHandlerOptions {
  getIssues: () => ReviewIssueRow[];
  setIssues: (next: ReviewIssueRow[]) => void;
  setError: (message: string | null) => void;
  updateRemote: (args: { issueId: number; patch: ReviewIssuePatch }) => Promise<ReviewIssueRow>;
}

export function createSaveEditHandler(options: SaveEditHandlerOptions) {
  const { getIssues, setIssues, setError, updateRemote } = options;

  return async function handleSaveEdit(issue: ReviewIssueRow, patch: ReviewIssuePatch) {
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
