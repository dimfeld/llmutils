import { describe, expect, test, vi, type Mock } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.mock('$app/navigation', () => ({
  goto: vi.fn(),
  invalidateAll: vi.fn(() => Promise.resolve()),
}));

vi.mock('$app/state', () => ({
  page: {
    params: { projectId: '7' },
  },
}));

vi.mock('$lib/remote/plan_metadata.remote.js', () => ({
  createPlan: vi.fn(),
}));

vi.mock('$lib/remote/plan_picker.remote.js', () => ({
  searchPlanPicker: vi.fn(() => ({ current: null, error: null, loading: false })),
}));

import { goto, invalidateAll } from '$app/navigation';
import { createPlan } from '$lib/remote/plan_metadata.remote.js';
import { searchPlanPicker } from '$lib/remote/plan_picker.remote.js';
import NewPlanPage from './+page.svelte';

function renderPage() {
  return render(NewPlanPage, {
    props: {
      data: { numericProjectId: 7 },
    },
  });
}

describe('new plan page interaction', () => {
  test('submit button is disabled when title is empty', async () => {
    renderPage();

    const submitButton = page.getByRole('button', { name: 'Create' });
    await expect.element(submitButton).toBeDisabled();
  });

  test('submit button enables after typing a title', async () => {
    renderPage();

    const titleInput = page.getByPlaceholder('Plan title');
    await titleInput.fill('My new plan');

    const submitButton = page.getByRole('button', { name: 'Create' });
    await expect.element(submitButton).toBeEnabled();
  });

  test('submit button disables when title is cleared back to empty', async () => {
    renderPage();

    const titleInput = page.getByPlaceholder('Plan title');
    await titleInput.fill('Temporary title');

    const submitButton = page.getByRole('button', { name: 'Create' });
    await expect.element(submitButton).toBeEnabled();

    await titleInput.fill('');
    await expect.element(submitButton).toBeDisabled();
  });

  test('successful submission calls createPlan, invalidates, and navigates to the new plan', async () => {
    const createdUuid = 'new-plan-uuid-123';
    (createPlan as Mock).mockResolvedValueOnce({
      planUuid: createdUuid,
      projectId: 7,
      planId: 42,
    });
    (invalidateAll as Mock).mockResolvedValueOnce(undefined);
    (goto as Mock).mockResolvedValueOnce(undefined);

    renderPage();

    await page.getByPlaceholder('Plan title').fill('Integration test plan');
    await page.getByRole('button', { name: 'Create' }).click();

    await vi.waitFor(() => {
      expect(createPlan).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 7,
          title: 'Integration test plan',
          priority: 'medium',
          status: 'pending',
          simple: false,
        })
      );
    });

    await vi.waitFor(() => {
      expect(invalidateAll).toHaveBeenCalled();
      expect(goto).toHaveBeenCalledWith(`/projects/7/plans/${createdUuid}`);
    });
  });

  test('failed submission shows error message and preserves form input', async () => {
    (createPlan as Mock).mockRejectedValueOnce({
      body: { message: 'Invalid tag: blocked' },
    });

    renderPage();

    await page.getByPlaceholder('Plan title').fill('Plan with bad tag');
    await page.getByRole('button', { name: 'Create' }).click();

    await expect.element(page.getByText('Invalid tag: blocked')).toBeVisible();
    await expect.element(page.getByPlaceholder('Plan title')).toHaveValue('Plan with bad tag');
    await expect.element(page.getByRole('button', { name: 'Create' })).toBeEnabled();
  });

  test('submit button shows loading state during submission', async () => {
    let resolveCreate: (value: unknown) => void;
    (createPlan as Mock).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        })
    );

    renderPage();

    await page.getByPlaceholder('Plan title').fill('Slow plan');
    await page.getByRole('button', { name: 'Create' }).click();

    await expect.element(page.getByRole('button', { name: 'Create...' })).toBeDisabled();

    resolveCreate!({ planUuid: 'uuid', projectId: 7, planId: 1 });
  });

  test('submits selected priority and status values', async () => {
    (createPlan as Mock).mockResolvedValueOnce({
      planUuid: 'uuid-priority',
      projectId: 7,
      planId: 43,
    });
    (invalidateAll as Mock).mockResolvedValueOnce(undefined);
    (goto as Mock).mockResolvedValueOnce(undefined);

    renderPage();

    await page.getByPlaceholder('Plan title').fill('Urgent plan');

    const prioritySelect = document.getElementById('plan-priority') as HTMLSelectElement;
    prioritySelect.value = 'urgent';
    prioritySelect.dispatchEvent(new Event('change', { bubbles: true }));

    const statusSelect = document.getElementById('plan-status') as HTMLSelectElement;
    statusSelect.value = 'in_progress';
    statusSelect.dispatchEvent(new Event('change', { bubbles: true }));

    await page.getByRole('button', { name: 'Create' }).click();

    await vi.waitFor(() => {
      expect(createPlan).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Urgent plan',
          priority: 'urgent',
          status: 'in_progress',
        })
      );
    });
  });

  test('submits tags as normalized array', async () => {
    (createPlan as Mock).mockResolvedValueOnce({
      planUuid: 'uuid-tags',
      projectId: 7,
      planId: 44,
    });
    (invalidateAll as Mock).mockResolvedValueOnce(undefined);
    (goto as Mock).mockResolvedValueOnce(undefined);

    renderPage();

    await page.getByPlaceholder('Plan title').fill('Tagged plan');
    await page.getByPlaceholder('e.g. frontend, bugfix, urgent').fill('Frontend, BUGFIX');
    await page.getByRole('button', { name: 'Create' }).click();

    await vi.waitFor(() => {
      expect(createPlan).toHaveBeenCalledWith(
        expect.objectContaining({
          tags: ['frontend', 'bugfix'],
        })
      );
    });
  });

  test('does not navigate on failed submission', async () => {
    (createPlan as Mock).mockRejectedValueOnce({
      body: { message: 'Server error' },
    });
    (goto as Mock).mockClear();

    renderPage();

    await page.getByPlaceholder('Plan title').fill('Failing plan');
    await page.getByRole('button', { name: 'Create' }).click();

    await vi.waitFor(async () => {
      await expect.element(page.getByText('Server error')).toBeVisible();
    });
    expect(goto).not.toHaveBeenCalled();
  });
});
