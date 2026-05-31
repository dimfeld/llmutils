import { describe, expect, test, vi, type Mock } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { error as svelteKitError } from '@sveltejs/kit';

vi.mock('$app/navigation', () => ({
  goto: vi.fn(),
  invalidateAll: vi.fn(() => Promise.resolve()),
}));

vi.mock('$lib/remote/plan_metadata.remote.js', () => ({
  updatePlanMetadata: vi.fn(),
}));

vi.mock('$lib/remote/plan_picker.remote.js', () => ({
  searchPlanPicker: vi.fn(() => ({ current: null, error: null, loading: false })),
}));

import { goto, invalidateAll } from '$app/navigation';
import { updatePlanMetadata } from '$lib/remote/plan_metadata.remote.js';
import EditPlanPage from './+page.svelte';

function makeInitialValue() {
  return {
    title: 'Current edit title',
    goal: 'Current edit goal',
    details: 'Current edit details',
    priority: 'high',
    status: 'in_progress',
    simple: true,
    tags: ['backend', 'web'],
    parent: null,
    basePlan: null,
    dependencies: [],
  };
}

function renderPage(overrides: Partial<Parameters<typeof EditPlanPage>[0]['props']['data']> = {}) {
  return render(EditPlanPage, {
    props: {
      data: {
        planUuid: 'target-plan-uuid',
        planId: 42,
        title: 'Current edit title',
        routeProjectId: '7',
        actualProjectId: 7,
        cancelHref: '/projects/7/plans/target-plan-uuid',
        initialValue: makeInitialValue(),
        ...overrides,
      },
    },
  });
}

function remoteCommandError(status: number, body: { message: string }): unknown {
  try {
    svelteKitError(status, body);
  } catch (err) {
    return err;
  }
}

describe('edit plan page interaction', () => {
  test('populates the shared form from route data and disables unchanged save', async () => {
    renderPage();

    await expect.element(page.getByRole('heading', { name: 'Edit Plan' })).toBeVisible();
    await expect.element(page.getByPlaceholder('Plan title')).toHaveValue('Current edit title');
    await expect
      .element(page.getByPlaceholder('What should this plan accomplish?'))
      .toHaveValue('Current edit goal');
    await expect.element(page.getByRole('button', { name: 'Save' })).toBeDisabled();

    const prioritySelect = document.getElementById('plan-priority') as HTMLSelectElement;
    const statusSelect = document.getElementById('plan-status') as HTMLSelectElement;
    expect(prioritySelect.value).toBe('high');
    expect(statusSelect.value).toBe('in_progress');
    await expect
      .element(page.getByPlaceholder('e.g. frontend, bugfix, urgent'))
      .toHaveValue('backend, web');
  });

  test('successful submission calls updatePlanMetadata, invalidates, and returns to detail', async () => {
    (updatePlanMetadata as Mock).mockResolvedValueOnce({ planUuid: 'target-plan-uuid' });
    (invalidateAll as Mock).mockResolvedValueOnce(undefined);
    (goto as Mock).mockResolvedValueOnce(undefined);

    renderPage();

    await page.getByPlaceholder('Plan title').fill('Updated edit title');
    await page.getByRole('button', { name: 'Save' }).click();

    await vi.waitFor(() => {
      expect(updatePlanMetadata).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 7,
          planUuid: 'target-plan-uuid',
          title: 'Updated edit title',
          goal: 'Current edit goal',
          details: 'Current edit details',
          priority: 'high',
          status: 'in_progress',
          simple: true,
          tags: ['backend', 'web'],
          parentUuid: null,
          basePlanUuid: null,
          dependencyUuids: [],
        })
      );
    });
    await vi.waitFor(() => {
      expect(invalidateAll).toHaveBeenCalled();
      expect(goto).toHaveBeenCalledWith('/projects/7/plans/target-plan-uuid');
    });
  });

  test('uses the actual project id for all-project edit writes while returning to all-project detail', async () => {
    (updatePlanMetadata as Mock).mockResolvedValueOnce({ planUuid: 'target-plan-uuid' });
    (invalidateAll as Mock).mockResolvedValueOnce(undefined);
    (goto as Mock).mockResolvedValueOnce(undefined);

    renderPage({
      routeProjectId: 'all',
      actualProjectId: 9,
      cancelHref: '/projects/all/plans/target-plan-uuid',
    });

    await page.getByPlaceholder('Plan title').fill('All-project edit title');
    await page.getByRole('button', { name: 'Save' }).click();

    await vi.waitFor(() => {
      expect(updatePlanMetadata).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 9,
          planUuid: 'target-plan-uuid',
          title: 'All-project edit title',
        })
      );
    });
    await vi.waitFor(() => {
      expect(goto).toHaveBeenCalledWith('/projects/all/plans/target-plan-uuid');
    });
  });

  test('failed submission shows validation error and preserves edited input', async () => {
    (updatePlanMetadata as Mock).mockRejectedValueOnce(
      remoteCommandError(400, { message: 'Invalid tag: blocked' })
    );
    (goto as Mock).mockClear();

    renderPage();

    await page.getByPlaceholder('Plan title').fill('Edited title with invalid tag');
    await page.getByRole('button', { name: 'Save' }).click();

    await expect.element(page.getByText('Invalid tag: blocked')).toBeVisible();
    await expect
      .element(page.getByPlaceholder('Plan title'))
      .toHaveValue('Edited title with invalid tag');
    await expect.element(page.getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(goto).not.toHaveBeenCalled();
  });
});
