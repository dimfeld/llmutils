import { render } from 'svelte/server';
import { describe, expect, test, vi } from 'vitest';

vi.mock('$app/navigation', () => ({
  goto: vi.fn(),
  invalidateAll: vi.fn(),
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
  searchPlanPicker: vi.fn(async () => []),
}));

import NewPlanPage from './+page.svelte';

describe('new plan page', () => {
  test('renders the shared create form with route load data', () => {
    const { body } = render(NewPlanPage, {
      props: {
        data: {
          numericProjectId: 7,
        },
      },
    });

    expect(body).toContain('New Plan');
    expect(body).toContain('Create a new plan for this project.');
    expect(body).toContain('id="plan-title"');
    expect(body).toContain('href="/projects/7/plans"');
  });
});
