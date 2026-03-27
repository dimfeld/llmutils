import { render } from 'svelte/server';
import { describe, expect, test, vi } from 'vitest';

import type { PlanDisplayStatus } from '$lib/server/db_queries.js';
import FilterChips from './FilterChips.svelte';

function renderChips(
  activeFilters: PlanDisplayStatus[] = [],
  statusCounts: Partial<Record<PlanDisplayStatus, number>> = {}
) {
  return render(FilterChips, {
    props: {
      activeFilters,
      statusCounts,
      onToggle: vi.fn(),
      onReset: vi.fn(),
    },
  });
}

describe('FilterChips', () => {
  test('renders aria-pressed="false" for inactive filters', () => {
    const { body } = renderChips([], { in_progress: 2 });
    // All buttons should have aria-pressed="false" when no filters active
    expect(body).toContain('aria-pressed="false"');
    expect(body).not.toContain('aria-pressed="true"');
  });

  test('renders aria-pressed="true" for active filters', () => {
    const { body } = renderChips(['in_progress'], { in_progress: 2 });
    expect(body).toContain('aria-pressed="true"');
  });

  test('mixed active and inactive filters have correct aria-pressed values', () => {
    const { body } = renderChips(['in_progress', 'ready'], { in_progress: 2, ready: 1 });
    // Should have both true and false values
    expect(body).toContain('aria-pressed="true"');
    expect(body).toContain('aria-pressed="false"');
  });
});
