import { describe, expect, test } from 'bun:test';
import { planSchema } from './planSchema.js';

describe('planSchema progressNotes', () => {
  test('accepts valid progressNotes', () => {
    const plan = {
      title: 'Test Plan',
      goal: 'Do a thing',
      details: 'Some details',
      tasks: [],
      progressNotes: [
        { timestamp: new Date().toISOString(), text: 'Initial setup complete' },
        { timestamp: new Date().toISOString(), text: 'Found edge case with parser' },
      ],
    };

    const parsed = planSchema.parse(plan);
    expect(parsed.progressNotes?.length).toBe(2);
    expect(parsed.progressNotes?.[0].text).toBe('Initial setup complete');
  });

  test('rejects invalid timestamp format', () => {
    const plan = {
      title: 'Test Plan',
      goal: 'Do a thing',
      details: 'Some details',
      tasks: [],
      progressNotes: [{ timestamp: 'not-a-date', text: 'oops' }],
    } as any;

    expect(() => planSchema.parse(plan)).toThrow();
  });

  test('rejects missing required fields in note', () => {
    const planMissingText = {
      title: 'Test Plan',
      goal: 'Do a thing',
      details: 'Some details',
      tasks: [],
      progressNotes: [{ timestamp: new Date().toISOString() }],
    } as any;

    expect(() => planSchema.parse(planMissingText)).toThrow();
  });

  test('handles empty progressNotes array', () => {
    const plan = {
      title: 'Test Plan',
      goal: 'Do a thing',
      details: 'Some details',
      tasks: [],
      progressNotes: [],
    };

    const parsed = planSchema.parse(plan);
    expect(parsed.progressNotes).toEqual([]);
  });

  test('backward compatibility without progressNotes', () => {
    const plan = {
      title: 'Test Plan',
      goal: 'Do a thing',
      details: 'Some details',
      tasks: [],
    };

    const parsed = planSchema.parse(plan);
    expect(parsed.progressNotes === undefined || parsed.progressNotes.length === 0).toBe(true);
  });
});
