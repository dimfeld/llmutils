import { describe, test, expect } from 'bun:test';
import { getCombinedTitle, getCombinedGoal, getCombinedTitleFromSummary } from './display_utils.js';
import type { PlanSchema, PlanSummary } from './planSchema.js';

describe('getCombinedTitle', () => {
  test('returns title when no project', () => {
    const result = getCombinedTitle('My Task Title', undefined);
    expect(result).toBe('My Task Title');
  });

  test('combines project and title when project exists', () => {
    const result = getCombinedTitle('My Task Title', 'project-123');
    expect(result).toBe('[project-123] My Task Title');
  });

  test('handles empty title', () => {
    const result = getCombinedTitle('', 'project-123');
    expect(result).toBe('[project-123] ');
  });

  test('handles empty project', () => {
    const result = getCombinedTitle('My Task Title', '');
    expect(result).toBe('My Task Title');
  });
});

describe('getCombinedGoal', () => {
  test('returns goal when no project', () => {
    const plan: PlanSchema = {
      id: '1',
      title: 'Test Plan',
      goal: 'Achieve something great',
      details: 'Details',
      tasks: [],
    };

    const result = getCombinedGoal(plan);
    expect(result).toBe('Achieve something great');
  });

  test('combines project and goal when project exists', () => {
    const plan: PlanSchema = {
      id: '1',
      title: 'Test Plan',
      goal: 'Achieve something great',
      details: 'Details',
      project: 'project-456',
      tasks: [],
    };

    const result = getCombinedGoal(plan);
    expect(result).toBe('[project-456] Achieve something great');
  });

  test('handles empty goal', () => {
    const plan: PlanSchema = {
      id: '1',
      title: 'Test Plan',
      goal: '',
      details: 'Details',
      project: 'project-456',
      tasks: [],
    };

    const result = getCombinedGoal(plan);
    expect(result).toBe('[project-456] ');
  });

  test('handles missing goal', () => {
    const plan: PlanSchema = {
      id: '1',
      title: 'Test Plan',
      goal: 'Default goal',
      details: 'Details',
      tasks: [],
    };

    // Override goal to undefined
    (plan as any).goal = undefined;

    const result = getCombinedGoal(plan);
    expect(result).toBe('');
  });
});

describe('getCombinedTitleFromSummary', () => {
  test('returns title when no project', () => {
    const summary: PlanSummary = {
      id: '1',
      title: 'Summary Title',
      goal: 'Summary goal',
      filename: '/path/to/file.yml',
      taskCount: 5,
      stepCount: 10,
      hasPrompts: true,
    };

    const result = getCombinedTitleFromSummary(summary);
    expect(result).toBe('Summary Title');
  });

  test('combines project and title when project exists', () => {
    const summary: PlanSummary = {
      id: '1',
      title: 'Summary Title',
      goal: 'Summary goal',
      filename: '/path/to/file.yml',
      project: 'project-789',
      taskCount: 5,
      stepCount: 10,
      hasPrompts: true,
    };

    const result = getCombinedTitleFromSummary(summary);
    expect(result).toBe('[project-789] Summary Title');
  });

  test('handles numeric ID', () => {
    const summary: PlanSummary = {
      id: 123,
      title: 'Numeric ID Title',
      goal: 'Summary goal',
      filename: '/path/to/file.yml',
      project: 'project-num',
      taskCount: 2,
      stepCount: 4,
      hasPrompts: false,
    };

    const result = getCombinedTitleFromSummary(summary);
    expect(result).toBe('[project-num] Numeric ID Title');
  });

  test('handles empty title and project', () => {
    const summary: PlanSummary = {
      id: '1',
      title: '',
      goal: 'Summary goal',
      filename: '/path/to/file.yml',
      taskCount: 0,
      stepCount: 0,
      hasPrompts: false,
    };

    const result = getCombinedTitleFromSummary(summary);
    expect(result).toBe('');
  });

  test('handles all optional fields', () => {
    const summary: PlanSummary = {
      id: '1',
      title: 'Full Summary',
      goal: 'Complete goal',
      filename: '/path/to/file.yml',
      project: 'full-project',
      status: 'in_progress',
      priority: 'high',
      dependencies: ['dep1', 'dep2'],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-02T00:00:00Z',
      taskCount: 3,
      stepCount: 9,
      hasPrompts: true,
    };

    const result = getCombinedTitleFromSummary(summary);
    expect(result).toBe('[full-project] Full Summary');
  });
});
