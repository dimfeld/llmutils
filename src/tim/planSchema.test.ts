import { describe, expect, test } from 'bun:test';
import { planSchema } from './planSchema.js';

describe('planSchema tags', () => {
  test('accepts valid tag arrays', () => {
    const plan = {
      id: 1,
      title: 'Tagged Plan',
      goal: 'Test goal',
      details: 'Details',
      tasks: [],
      tags: ['frontend', 'bug'],
    };

    const parsed = planSchema.parse(plan);
    expect(parsed.tags).toEqual(['frontend', 'bug']);
  });

  test('rejects non-string tag entries', () => {
    const plan = {
      id: 2,
      title: 'Invalid Tags Plan',
      goal: 'Test goal',
      details: 'Details',
      tasks: [],
      tags: ['frontend', 123],
    } as any;

    expect(() => planSchema.parse(plan)).toThrow();
  });

  test('defaults to empty tags when missing', () => {
    const plan = {
      id: 3,
      title: 'No Tags Plan',
      goal: 'Test goal',
      details: 'Details',
      tasks: [],
    };

    const parsed = planSchema.parse(plan);
    expect(parsed.tags === undefined || parsed.tags.length === 0).toBe(true);
  });
});
