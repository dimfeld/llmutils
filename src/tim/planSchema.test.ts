import { describe, expect, test, vi } from 'vitest';
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

describe('planSchema finalization timestamps', () => {
  test('accepts valid docsUpdatedAt and lessonsAppliedAt datetime strings', () => {
    const plan = {
      id: 10,
      title: 'Finalization Plan',
      goal: 'Test goal',
      tasks: [],
      docsUpdatedAt: '2026-03-01T10:00:00.000Z',
      lessonsAppliedAt: '2026-03-02T12:00:00.000Z',
    };

    const parsed = planSchema.parse(plan);
    expect(parsed.docsUpdatedAt).toBe('2026-03-01T10:00:00.000Z');
    expect(parsed.lessonsAppliedAt).toBe('2026-03-02T12:00:00.000Z');
  });

  test('allows docsUpdatedAt and lessonsAppliedAt to be omitted', () => {
    const plan = {
      id: 11,
      title: 'No Timestamps',
      goal: 'Test goal',
      tasks: [],
    };

    const parsed = planSchema.parse(plan);
    expect(parsed.docsUpdatedAt).toBeUndefined();
    expect(parsed.lessonsAppliedAt).toBeUndefined();
  });

  test('rejects invalid datetime format for docsUpdatedAt', () => {
    const plan = {
      id: 12,
      title: 'Bad Timestamp',
      goal: 'Test goal',
      tasks: [],
      docsUpdatedAt: 'not-a-date',
    };

    expect(() => planSchema.parse(plan)).toThrow();
  });

  test('rejects invalid datetime format for lessonsAppliedAt', () => {
    const plan = {
      id: 13,
      title: 'Bad Timestamp',
      goal: 'Test goal',
      tasks: [],
      lessonsAppliedAt: '2026-13-01',
    };

    expect(() => planSchema.parse(plan)).toThrow();
  });
});
