import { describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { ReviewCategory, ReviewIssueRow } from '$tim/db/review.js';
import ReviewIssueCard from './ReviewIssueCard.svelte';
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

interface OverrideableProps {
  actioning?: boolean;
  linkedPlanUuid?: string | null;
  onSaveEdit?: (issue: ReviewIssueRow, patch: ReviewIssuePatch) => Promise<void>;
  onJumpToDiff?: (issue: ReviewIssueRow) => void;
  onToggleResolved?: (issue: ReviewIssueRow) => void;
  onDelete?: (issue: ReviewIssueRow) => void;
  onAddToPlan?: (issue: ReviewIssueRow) => void;
}

function makeProps(issue: ReviewIssueRow, overrides: OverrideableProps = {}) {
  return {
    issue,
    actioning: overrides.actioning ?? false,
    linkedPlanUuid: overrides.linkedPlanUuid ?? null,
    categoryBadgeClass: (_c: ReviewCategory) => 'bg-gray-100',
    issueLocationLabel: (i: ReviewIssueRow) => (i.file ? `${i.file}:${i.line}` : null),
    formatCategory: (c: ReviewCategory) => c.charAt(0).toUpperCase() + c.slice(1),
    onCopyError: vi.fn(),
    onToggleResolved: overrides.onToggleResolved ?? vi.fn(),
    onDelete: overrides.onDelete ?? vi.fn(),
    onAddToPlan: overrides.onAddToPlan ?? vi.fn(),
    onSaveEdit: overrides.onSaveEdit ?? (async () => {}),
    onJumpToDiff: overrides.onJumpToDiff,
  };
}

describe('ReviewIssueCard (interactive)', () => {
  test('clicking Edit shows the editor and saving calls onSaveEdit with the patch', async () => {
    const issue = makeIssue({ content: 'Old content' });
    const onSaveEdit = vi.fn(async () => {});
    const screen = render(ReviewIssueCard, makeProps(issue, { onSaveEdit }));

    await screen.getByRole('button', { name: /^Edit$/ }).click();

    const contentBox = screen.getByLabelText('Content');
    await contentBox.clear();
    await contentBox.fill('Updated content');

    await screen.getByRole('button', { name: /^Save$/ }).click();

    await vi.waitFor(() => {
      expect(onSaveEdit).toHaveBeenCalledTimes(1);
    });
    expect(onSaveEdit.mock.calls[0][1]).toEqual({ content: 'Updated content' });
  });

  test('clicking Cancel restores the original values and leaves edit mode', async () => {
    const issue = makeIssue({ content: 'Keep me' });
    const onSaveEdit = vi.fn(async () => {});
    const screen = render(ReviewIssueCard, makeProps(issue, { onSaveEdit }));

    await screen.getByRole('button', { name: /^Edit$/ }).click();

    const contentBox = screen.getByLabelText('Content');
    await contentBox.clear();
    await contentBox.fill('Edits to discard');

    await screen.getByRole('button', { name: /^Cancel$/ }).click();

    // Back to view mode
    await expect.element(screen.getByRole('button', { name: /^Edit$/ })).toBeInTheDocument();
    expect(onSaveEdit).not.toHaveBeenCalled();

    // Re-entering shows the ORIGINAL values, not the discarded ones
    await screen.getByRole('button', { name: /^Edit$/ }).click();
    await expect.element(screen.getByLabelText('Content')).toHaveValue('Keep me');
  });

  test('save error reverts saving state and keeps the editor open', async () => {
    const issue = makeIssue({ content: 'Will fail' });
    const onSaveEdit = vi.fn(async () => {
      throw new Error('server rejected');
    });
    const screen = render(ReviewIssueCard, makeProps(issue, { onSaveEdit }));

    await screen.getByRole('button', { name: /^Edit$/ }).click();
    const contentBox = screen.getByLabelText('Content');
    await contentBox.clear();
    await contentBox.fill('New text');

    await screen.getByRole('button', { name: /^Save$/ }).click();

    await expect.element(page.getByText('server rejected')).toBeInTheDocument();
    // Editor still open — Save button still visible
    await expect.element(screen.getByRole('button', { name: /^Save$/ })).toBeInTheDocument();
  });

  test('header collapse button is disabled while editing', async () => {
    const issue = makeIssue({ content: 'Something' });
    const screen = render(ReviewIssueCard, makeProps(issue));

    const headerToggle = screen.getByRole('button', { expanded: true });
    await expect.element(headerToggle).toBeEnabled();

    await screen.getByRole('button', { name: /^Edit$/ }).click();

    await expect.element(screen.getByRole('button', { expanded: true })).toBeDisabled();
  });
});
