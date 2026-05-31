import { describe, expect, test, vi, beforeEach, type Mock } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.mock('$lib/remote/plan_picker.remote.js', () => ({
  searchPlanPicker: vi.fn(() => ({ current: null, error: null, loading: false })),
}));

import { searchPlanPicker } from '$lib/remote/plan_picker.remote.js';
import type { PlanPickerOption } from '$lib/server/plan_picker_queries.js';
import PlanPicker from './PlanPicker.svelte';

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

function renderPicker(
  props: Partial<{
    selected: PlanPickerOption | null;
    currentPlanUuid: string | null;
  }> = {}
) {
  return render(PlanPicker, {
    props: {
      projectId: 7,
      relation: 'parent' as const,
      selected: null,
      label: 'Parent Plan',
      id: 'test-picker',
      currentPlanUuid: null,
      ...props,
    },
  });
}

describe('PlanPicker interaction', () => {
  test('shows search input when no selection exists', async () => {
    renderPicker();

    await expect.element(page.getByPlaceholder('Search by plan number or title...')).toBeVisible();
  });

  test('shows selected plan with clear button when a plan is selected', async () => {
    const selected = pickerOption('sel-uuid', 42, 'Selected plan');
    renderPicker({ selected });

    await expect.element(page.getByText('#42: Selected plan')).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Clear Parent Plan' })).toBeVisible();
    await expect
      .element(page.getByPlaceholder('Search by plan number or title...'))
      .not.toBeInTheDocument();
  });

  test('clears selection when clear button is clicked', async () => {
    const selected = pickerOption('sel-uuid', 42, 'Selected plan');
    const screen = renderPicker({ selected });

    await page.getByRole('button', { name: 'Clear Parent Plan' }).click();

    await expect.element(page.getByPlaceholder('Search by plan number or title...')).toBeVisible();
    await expect.element(page.getByText('#42: Selected plan')).not.toBeInTheDocument();
  });

  test('shows searching state while debounce or query is pending', async () => {
    (searchPlanPicker as Mock).mockReturnValue({
      current: null,
      error: null,
      loading: true,
    });

    renderPicker();

    const input = page.getByPlaceholder('Search by plan number or title...');
    await input.fill('test');

    await expect.element(page.getByText('Searching...')).toBeVisible();
  });

  test('shows empty state when search returns no results', async () => {
    (searchPlanPicker as Mock).mockReturnValue({
      current: [],
      error: null,
      loading: false,
    });

    renderPicker();

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

    renderPicker();

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

  test('shows search results with plan number, title, and status', async () => {
    const results = [
      pickerOption('result-1', 10, 'First result', 'pending'),
      pickerOption('result-2', 11, 'Second result', 'in_progress'),
    ];
    (searchPlanPicker as Mock).mockReturnValue({
      current: results,
      error: null,
      loading: false,
    });

    renderPicker();

    const input = page.getByPlaceholder('Search by plan number or title...');
    await input.click();
    await input.fill('result');

    await vi.waitFor(
      async () => {
        await expect.element(page.getByText('#10: First result')).toBeVisible();
        await expect.element(page.getByText('#11: Second result')).toBeVisible();
      },
      { timeout: 1000 }
    );
  });

  test('renders unresolved search results without nullable field text', async () => {
    const results = [pickerOption('dangling-plan-uuid', null, null, null)];
    (searchPlanPicker as Mock).mockReturnValue({
      current: results,
      error: null,
      loading: false,
    });

    renderPicker();

    const input = page.getByPlaceholder('Search by plan number or title...');
    await input.click();
    await input.fill('dangling');

    await vi.waitFor(
      async () => {
        await expect.element(page.getByText('Unresolved plan: dangling-plan-uuid')).toBeVisible();
        await expect.element(page.getByText('#null')).not.toBeInTheDocument();
        await expect.element(page.getByText('null')).not.toBeInTheDocument();
      },
      { timeout: 1000 }
    );
  });

  test('selects a plan when a search result is clicked', async () => {
    const results = [pickerOption('pick-uuid', 55, 'Picked plan', 'in_progress')];
    (searchPlanPicker as Mock).mockReturnValue({
      current: results,
      error: null,
      loading: false,
    });

    renderPicker();

    const input = page.getByPlaceholder('Search by plan number or title...');
    await input.click();
    await input.fill('picked');

    await vi.waitFor(
      async () => {
        await expect.element(page.getByText('Picked plan')).toBeVisible();
      },
      { timeout: 1000 }
    );

    await page.getByText('Picked plan').click();

    await expect.element(page.getByText('#55: Picked plan')).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'Clear Parent Plan' })).toBeVisible();
    await expect
      .element(page.getByPlaceholder('Search by plan number or title...'))
      .not.toBeInTheDocument();
  });
});
