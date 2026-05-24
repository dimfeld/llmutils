import { beforeEach, describe, expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { ReviewRow } from '$tim/db/review.js';

vi.mock('$lib/components/Diff.svelte', async () => {
  const mod = await import('./__mocks__/DiffStub.svelte');
  return { default: mod.default };
});

import ReviewGuideView from './ReviewGuideView.svelte';

const DIFF_STYLE_STORAGE_KEY = 'tim.reviewGuide.diffStyle';

function makeReview(overrides: Partial<ReviewRow> = {}): ReviewRow {
  return {
    id: 10,
    project_id: 1,
    pr_status_id: null,
    pr_url: null,
    branch: null,
    base_branch: 'main',
    reviewed_sha: 'abcdef1234567890',
    review_guide: [
      '# Summary',
      '',
      '```unified-diff',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
      '```',
    ].join('\n'),
    status: 'complete',
    error_message: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    plan_uuid: 'plan-uuid-1',
    ...overrides,
  };
}

describe('ReviewGuideView diff layout toggle', () => {
  beforeEach(() => {
    localStorage.removeItem(DIFF_STYLE_STORAGE_KEY);
  });

  test('switches review guide diffs from stacked to side-by-side', async () => {
    render(ReviewGuideView, {
      props: {
        review: makeReview(),
        issues: [],
        projectId: '1',
        backHref: '/projects/1/plans/plan-uuid-1',
        backLabel: 'Back to plan #7001',
      },
    });

    const diff = page.getByTestId('diff-stub');
    await expect.element(diff).toHaveAttribute('data-diff-style', 'unified');

    await page.getByRole('button', { name: 'Side by side' }).click();

    await expect.element(diff).toHaveAttribute('data-diff-style', 'split');
    expect(localStorage.getItem(DIFF_STYLE_STORAGE_KEY)).toBe('split');
    await expect
      .element(page.getByRole('button', { name: 'Side by side' }))
      .toHaveAttribute('aria-pressed', 'true');
  });

  test('restores the persisted diff layout choice', async () => {
    localStorage.setItem(DIFF_STYLE_STORAGE_KEY, 'split');

    render(ReviewGuideView, {
      props: {
        review: makeReview(),
        issues: [],
        projectId: '1',
        backHref: '/projects/1/plans/plan-uuid-1',
        backLabel: 'Back to plan #7001',
      },
    });

    await expect.element(page.getByTestId('diff-stub')).toHaveAttribute('data-diff-style', 'split');
    await expect
      .element(page.getByRole('button', { name: 'Side by side' }))
      .toHaveAttribute('aria-pressed', 'true');
  });
});
