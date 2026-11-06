import { beforeEach, describe, expect, test, vi, type Mock } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.mock('$lib/remote/pr_status.remote.js', () => ({
  getRecentReviewersForRepo: vi.fn(),
  getAssignableReviewersForRepo: vi.fn(),
  requestPrReviewers: vi.fn(),
}));

import {
  getAssignableReviewersForRepo,
  getRecentReviewersForRepo,
  requestPrReviewers,
} from '$lib/remote/pr_status.remote.js';
import ReviewerPicker from './ReviewerPicker.svelte';

interface FakeResource<T> {
  current: T | undefined;
  error: unknown;
  loading: boolean;
  refresh: Mock;
}

function resource<T>(current: T | undefined, overrides: Partial<FakeResource<T>> = {}) {
  return { current, error: null, loading: false, refresh: vi.fn(), ...overrides };
}

const baseProps = {
  owner: 'example',
  repo: 'repo',
  prNumber: 7,
  prUrl: 'https://github.com/example/repo/pull/7',
};

beforeEach(() => {
  vi.clearAllMocks();
  (getRecentReviewersForRepo as unknown as Mock).mockReturnValue(resource(['carol', 'alice']));
  (getAssignableReviewersForRepo as unknown as Mock).mockReturnValue(
    resource(['alice', 'author', 'bob', 'carol', 'dave'])
  );
  (requestPrReviewers as unknown as Mock).mockResolvedValue({ success: true });
});

describe('ReviewerPicker', () => {
  test('does not load reviewers until the dropdown opens', async () => {
    render(ReviewerPicker, { props: { ...baseProps, exclude: [] } });

    await expect.element(page.getByRole('button', { name: 'Request reviewers' })).toBeVisible();
    expect(getRecentReviewersForRepo).not.toHaveBeenCalled();
    expect(getAssignableReviewersForRepo).not.toHaveBeenCalled();
  });

  test('requests several reviewers selected in one open of the dropdown', async () => {
    const onRequested = vi.fn();
    render(ReviewerPicker, {
      props: { ...baseProps, exclude: ['author', 'dave'], onRequested },
    });

    await page.getByRole('button', { name: 'Request reviewers' }).click();

    await expect.element(page.getByText('Recent reviewers')).toBeVisible();
    await expect.element(page.getByRole('option', { name: 'author' })).not.toBeInTheDocument();
    await expect.element(page.getByRole('option', { name: 'dave' })).not.toBeInTheDocument();

    await page.getByRole('option', { name: 'carol' }).click();
    await page.getByRole('option', { name: 'bob' }).click();

    // The dropdown stays open after each selection.
    await page.getByRole('button', { name: 'Request 2 reviewers' }).click();

    expect(requestPrReviewers).toHaveBeenCalledWith({
      ...baseProps,
      reviewers: ['carol', 'bob'],
    });
    await vi.waitFor(() => expect(onRequested).toHaveBeenCalledWith(['carol', 'bob']));
  });

  test('a second click on a reviewer removes it from the selection', async () => {
    render(ReviewerPicker, { props: { ...baseProps, exclude: [] } });

    await page.getByRole('button', { name: 'Request reviewers' }).click();
    await page.getByRole('option', { name: 'alice' }).click();
    await expect.element(page.getByRole('button', { name: 'Request 1 reviewer' })).toBeVisible();

    await page.getByRole('option', { name: 'alice' }).click();
    await expect.element(page.getByRole('button', { name: 'Select reviewers' })).toBeDisabled();
  });

  test('shows the request error and keeps the selection', async () => {
    (requestPrReviewers as unknown as Mock).mockRejectedValue(
      new Error('Reviews may only be requested from collaborators')
    );
    render(ReviewerPicker, { props: { ...baseProps, exclude: [] } });

    await page.getByRole('button', { name: 'Request reviewers' }).click();
    await page.getByRole('option', { name: 'bob' }).click();
    await page.getByRole('button', { name: 'Request 1 reviewer' }).click();

    await expect
      .element(page.getByText('Reviews may only be requested from collaborators'))
      .toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Request 1 reviewer' })).toBeVisible();
  });

  test('shows an error with retry when the full list fails, and keeps recent reviewers', async () => {
    const failed = resource<string[]>(undefined, { error: new Error('GitHub is down') });
    (getAssignableReviewersForRepo as unknown as Mock).mockReturnValue(failed);
    render(ReviewerPicker, { props: { ...baseProps, exclude: [] } });

    await page.getByRole('button', { name: 'Request reviewers' }).click();

    await expect.element(page.getByText('GitHub is down')).toBeVisible();
    await expect.element(page.getByRole('option', { name: 'carol' })).toBeVisible();
    await page.getByRole('button', { name: 'Retry' }).click();
    expect(failed.refresh).toHaveBeenCalled();
  });

  test('offers a typed username that is in no list', async () => {
    render(ReviewerPicker, { props: { ...baseProps, exclude: [] } });

    await page.getByRole('button', { name: 'Request reviewers' }).click();
    await page.getByPlaceholder('Search people...').fill('@new-person');

    await page.getByRole('option', { name: 'new-person' }).click();
    await page.getByRole('button', { name: 'Request 1 reviewer' }).click();

    expect(requestPrReviewers).toHaveBeenCalledWith({ ...baseProps, reviewers: ['new-person'] });
  });
});
