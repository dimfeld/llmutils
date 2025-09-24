import { describe, test, expect } from 'bun:test';
import { appendResearchToPlan } from './research_utils.ts';
import type { PlanSchema } from './planSchema.js';

describe('appendResearchToPlan', () => {
  test('adds research section when none exists', () => {
    const plan: PlanSchema = {
      id: 1,
      title: 'Sample Plan',
      goal: 'Do something great',
      details: 'Existing details',
      status: 'pending',
      tasks: [],
    };

    const insertedAt = new Date('2024-03-04T05:06:07Z');
    const updated = appendResearchToPlan(plan, 'Key findings go here', { insertedAt });

    expect(updated.details).toContain('Existing details');
    expect(updated.details).toContain('## Research');
    expect(updated.details).toContain('Key findings go here');
    expect(updated.details).toContain('2024-03-04 05:06 UTC');
    expect(updated.updatedAt).toBe(insertedAt.toISOString());
  });

  test('appends to existing research heading without duplicating it', () => {
    const plan: PlanSchema = {
      id: 2,
      title: 'Plan with Research',
      goal: 'Goal',
      details: '## Research\n\n### 2024-01-01 10:00 UTC\n\nExisting notes',
      status: 'pending',
      tasks: [],
    };

    const updated = appendResearchToPlan(plan, 'Additional insight', {
      insertedAt: new Date('2024-02-02T03:04:05Z'),
    });

    const researchHeadingCount = (updated.details.match(/## Research/g) || []).length;
    expect(researchHeadingCount).toBe(1);
    expect(updated.details).toContain('Existing notes');
    expect(updated.details).toContain('Additional insight');
    expect(updated.details).toContain('2024-02-02 03:04 UTC');
  });

  test('returns original plan when research content is empty', () => {
    const plan: PlanSchema = {
      id: 3,
      title: 'Plan',
      goal: 'Goal',
      details: 'Details',
      status: 'pending',
      tasks: [],
    };

    const updated = appendResearchToPlan(plan, '   ');
    expect(updated).toBe(plan);
  });
});
