import { describe, expect, test } from 'vitest';

import { planMatchesSearch } from './plans_list_filter.js';

describe('planMatchesSearch', () => {
  const plan = {
    planId: 694,
    title: 'Improve active plans UI',
    goal: 'Make filtering easier',
  };

  test('matches numeric plan IDs', () => {
    expect(planMatchesSearch(plan, '694')).toBe(true);
    expect(planMatchesSearch(plan, '69')).toBe(true);
    expect(planMatchesSearch(plan, '42')).toBe(false);
  });

  test('continues matching title and goal text case-insensitively', () => {
    expect(planMatchesSearch(plan, 'ACTIVE')).toBe(true);
    expect(planMatchesSearch(plan, 'filtering')).toBe(true);
  });
});
