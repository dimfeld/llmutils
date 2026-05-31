import { describe, expect, test, vi, beforeEach, type Mock } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.mock('$lib/remote/plan_picker.remote.js', () => ({
  searchPlanPicker: vi.fn(() => ({ current: null, error: null, loading: false })),
}));

import { searchPlanPicker } from '$lib/remote/plan_picker.remote.js';
import type { PlanPickerOption } from '$lib/server/plan_picker_queries.js';
import PlanPickerMulti from './PlanPickerMulti.svelte';

function pickerOption(
  uuid: string,
  planId: number | null,
  title: string | null,
  status: PlanPickerOption['status'] = 'pending'
): PlanPickerOption {
  return {
    uuid,
    projectId: 7,
    planId,
    title,
    status,
    priority: 'medium',
    parentUuid: null,
    basePlanUuid: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

function renderMultiPicker(
  props: Partial<{
    selected: PlanPickerOption[];
    currentPlanUuid: string | null;
  }> = {}
) {
  return render(PlanPickerMulti, {
    props: {
      projectId: 7,
      relation: 'dependency' as const,
      selected: [],
      label: 'Dependencies',
      id: 'test-multi-picker',
      currentPlanUuid: null,
      ...props,
    },
  });
}

describe('PlanPickerMulti interaction', () => {
  test('renders selected dependencies as removable chips', async () => {
    const deps = [pickerOption('dep-1', 20, 'First dep'), pickerOption('dep-2', 21, 'Second dep')];
    renderMultiPicker({ selected: deps });

    await expect.element(page.getByText('#20: First dep')).toBeVisible();
    await expect.element(page.getByText('#21: Second dep')).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Remove dependency #20' })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Remove dependency #21' })).toBeVisible();
  });

  test('removes a dependency when its remove button is clicked', async () => {
    const deps = [pickerOption('dep-1', 20, 'First dep'), pickerOption('dep-2', 21, 'Second dep')];
    renderMultiPicker({ selected: deps });

    await page.getByRole('button', { name: 'Remove dependency #20' }).click();

    await expect.element(page.getByText('#20: First dep')).not.toBeInTheDocument();
    await expect.element(page.getByText('#21: Second dep')).toBeVisible();
  });

  test('always shows search input alongside selected chips', async () => {
    const deps = [pickerOption('dep-1', 20, 'First dep')];
    renderMultiPicker({ selected: deps });

    await expect.element(page.getByPlaceholder('Search by plan number or title...')).toBeVisible();
  });

  test('filters already-selected plans from search results', async () => {
    const selectedDep = pickerOption('dep-1', 20, 'Already selected');
    const unselectedDep = pickerOption('dep-2', 21, 'Available plan');
    (searchPlanPicker as Mock).mockReturnValue({
      current: [selectedDep, unselectedDep],
      error: null,
      loading: false,
    });

    renderMultiPicker({ selected: [selectedDep] });

    const input = page.getByPlaceholder('Search by plan number or title...');
    await input.click();
    await input.fill('plan');

    await vi.waitFor(
      async () => {
        await expect.element(page.getByText('Available plan')).toBeVisible();
      },
      { timeout: 1000 }
    );

    const dropdown = page.getByText('Already selected');
    const dropdownElements = dropdown.elements();
    // "Already selected" text appears only in the chip, not in the dropdown
    expect(dropdownElements.length).toBe(1);
  });

  test('shows empty state when search returns no results', async () => {
    (searchPlanPicker as Mock).mockReturnValue({
      current: [],
      error: null,
      loading: false,
    });

    renderMultiPicker();

    const input = page.getByPlaceholder('Search by plan number or title...');
    await input.click();
    await input.fill('nonexistent');

    await vi.waitFor(
      async () => {
        await expect.element(page.getByText('No matching plans')).toBeVisible();
      },
      { timeout: 1000 }
    );
  });

  test('shows error state when search fails', async () => {
    (searchPlanPicker as Mock).mockReturnValue({
      current: null,
      error: new Error('Network error'),
      loading: false,
    });

    renderMultiPicker();

    const input = page.getByPlaceholder('Search by plan number or title...');
    await input.click();
    await input.fill('broken');

    await vi.waitFor(
      async () => {
        await expect.element(page.getByText('Failed to search plans')).toBeVisible();
      },
      { timeout: 1000 }
    );
  });

  test('adds a plan to the selection when a search result is clicked', async () => {
    const newDep = pickerOption('new-dep', 30, 'New dependency');
    (searchPlanPicker as Mock).mockReturnValue({
      current: [newDep],
      error: null,
      loading: false,
    });

    renderMultiPicker();

    const input = page.getByPlaceholder('Search by plan number or title...');
    await input.click();
    await input.fill('new');

    await vi.waitFor(
      async () => {
        await expect.element(page.getByText('New dependency')).toBeVisible();
      },
      { timeout: 1000 }
    );

    await page.getByText('New dependency').click();

    await expect.element(page.getByText('#30: New dependency')).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Remove dependency #30' })).toBeVisible();
  });

  test('renders unresolved search results without nullable field text', async () => {
    const unresolved = pickerOption('dangling-dependency-uuid', null, null, null);
    (searchPlanPicker as Mock).mockReturnValue({
      current: [unresolved],
      error: null,
      loading: false,
    });

    renderMultiPicker();

    const input = page.getByPlaceholder('Search by plan number or title...');
    await input.click();
    await input.fill('dangling');

    await vi.waitFor(
      async () => {
        await expect
          .element(page.getByText('Unresolved plan: dangling-dependency-uuid'))
          .toBeVisible();
        await expect.element(page.getByText('#null')).not.toBeInTheDocument();
        await expect.element(page.getByText('null')).not.toBeInTheDocument();
      },
      { timeout: 1000 }
    );
  });
});
