import { describe, expect, test, vi, beforeEach } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { ReviewIssueRow, ReviewIssueSide } from '$tim/db/review.js';
import NewReviewIssueModal from './NewReviewIssueModal.svelte';
import { buildCreateReviewIssueInput } from './new_issue_modal_utils.js';

const createReviewIssueMock = vi.fn();
vi.mock('$lib/remote/pr_review_submission.remote.js', () => ({
  createReviewIssue: (...args: unknown[]) => createReviewIssueMock(...args),
}));

function makeIssue(overrides: Partial<ReviewIssueRow> = {}): ReviewIssueRow {
  return {
    id: 100,
    review_id: 10,
    severity: 'minor',
    category: 'other',
    content: 'Created content',
    file: 'src/foo.ts',
    line: '10',
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

interface PropsOverrides {
  open?: boolean;
  reviewId?: number;
  file?: string;
  startLine?: number;
  endLine?: number;
  side?: ReviewIssueSide;
  onSaved?: (issue: ReviewIssueRow) => void;
  onClose?: () => void;
}

function makeProps(overrides: PropsOverrides = {}) {
  return {
    open: overrides.open ?? true,
    reviewId: overrides.reviewId ?? 10,
    file: overrides.file ?? 'src/foo.ts',
    startLine: overrides.startLine ?? 10,
    endLine: overrides.endLine ?? 12,
    side: overrides.side ?? ('RIGHT' as ReviewIssueSide),
    onSaved: overrides.onSaved ?? vi.fn(),
    onClose: overrides.onClose ?? vi.fn(),
  };
}

describe('NewReviewIssueModal', () => {
  beforeEach(() => {
    createReviewIssueMock.mockReset();
  });

  test('renders multi-line range label with en-dash', async () => {
    const screen = render(
      NewReviewIssueModal,
      makeProps({ file: 'src/foo.ts', startLine: 10, endLine: 12, side: 'RIGHT' })
    );

    await expect.element(page.getByText('src/foo.ts:10–12')).toBeInTheDocument();
    await expect.element(page.getByText('(RIGHT)')).toBeInTheDocument();
  });

  test('renders single-line range label when start equals end', async () => {
    const screen = render(
      NewReviewIssueModal,
      makeProps({ file: 'src/foo.ts', startLine: 7, endLine: 7, side: 'RIGHT' })
    );

    await expect.element(page.getByText('src/foo.ts:7')).toBeInTheDocument();
  });

  test('Save button is disabled until content is non-whitespace', async () => {
    const screen = render(NewReviewIssueModal, makeProps());

    const saveButton = screen.getByRole('button', { name: /Save issue/ });
    await expect.element(saveButton).toBeDisabled();

    const contentBox = screen.getByLabelText('Issue content');
    await contentBox.fill('Something');
    await expect.element(saveButton).toBeEnabled();

    await contentBox.clear();
    await expect.element(saveButton).toBeDisabled();
  });

  test('Save calls createReviewIssue with expected payload and fires onSaved + onClose', async () => {
    const created = makeIssue({ content: 'New content', file: 'src/foo.ts' });
    createReviewIssueMock.mockResolvedValueOnce(created);
    const onSaved = vi.fn();
    const onClose = vi.fn();

    const screen = render(
      NewReviewIssueModal,
      makeProps({
        reviewId: 10,
        file: 'src/foo.ts',
        startLine: 10,
        endLine: 12,
        side: 'RIGHT',
        onSaved,
        onClose,
      })
    );

    await screen.getByLabelText('Issue content').fill('New content');
    await screen.getByLabelText('Suggestion (optional)').fill('Do this instead');
    await screen.getByRole('button', { name: /Save issue/ }).click();

    await vi.waitFor(() => {
      expect(createReviewIssueMock).toHaveBeenCalledTimes(1);
    });

    const expectedInput = buildCreateReviewIssueInput({
      reviewId: 10,
      file: 'src/foo.ts',
      startLine: 10,
      endLine: 12,
      side: 'RIGHT',
      content: 'New content',
      suggestion: 'Do this instead',
    });
    expect(createReviewIssueMock).toHaveBeenCalledWith(expectedInput);

    await vi.waitFor(() => {
      expect(onSaved).toHaveBeenCalledWith(created);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  test('Cancel does not call createReviewIssue and calls onClose', async () => {
    const onClose = vi.fn();
    const screen = render(NewReviewIssueModal, makeProps({ onClose }));

    await screen.getByLabelText('Issue content').fill('Discard me');
    await screen.getByRole('button', { name: /^Cancel$/ }).click();

    expect(createReviewIssueMock).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('Save error keeps modal open with error message; onClose not called', async () => {
    createReviewIssueMock.mockRejectedValueOnce(new Error('boom'));
    const onSaved = vi.fn();
    const onClose = vi.fn();

    const screen = render(NewReviewIssueModal, makeProps({ onSaved, onClose }));

    await screen.getByLabelText('Issue content').fill('Trigger failure');
    await screen.getByRole('button', { name: /Save issue/ }).click();

    await expect.element(page.getByText('boom')).toBeInTheDocument();
    await expect.element(screen.getByRole('button', { name: /Save issue/ })).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
