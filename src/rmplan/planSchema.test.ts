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
        {
          timestamp: new Date().toISOString(),
          text: 'Found edge case with parser',
          source: 'tester: Parser Task',
        },
      ],
    };

    const parsed = planSchema.parse(plan);
    expect(parsed.progressNotes?.length).toBe(2);
    expect(parsed.progressNotes?.[0].text).toBe('Initial setup complete');
    expect(parsed.progressNotes?.[1].source).toBe('tester: Parser Task');
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

describe('planSchema tags', () => {
  test('accepts valid tag arrays', () => {
    const plan = {
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
      title: 'No Tags Plan',
      goal: 'Test goal',
      details: 'Details',
      tasks: [],
    };

    const parsed = planSchema.parse(plan);
    expect(parsed.tags === undefined || parsed.tags.length === 0).toBe(true);
  });
});
