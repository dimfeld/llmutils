import { describe, test, expect } from 'bun:test';
import { getCombinedTitle, getCombinedGoal, getCombinedTitleFromSummary } from './display_utils.js';
import type { PlanSchema, PlanSummary } from './planSchema.js';

describe('getCombinedTitle', () => {
  test('returns title when no project', () => {
    const plan: PlanSchema = {
      id: '1',
      title: 'My Task Title',
      goal: 'Test goal',
      details: 'Details',
      tasks: [],
    };

    const result = getCombinedTitle(plan);
    expect(result).toBe('My Task Title');
  });

  test('combines project and title when project exists', () => {
    const plan: PlanSchema = {
      id: '1',
      title: 'My Task Title',
      goal: 'Test goal',
      details: 'Details',
      project: {
        title: 'project-123',
        goal: 'Project goal',
        details: 'Project details',
      },
      tasks: [],
    };

    const result = getCombinedTitle(plan);
    expect(result).toBe('project-123 - My Task Title');
  });

  test('handles empty title with project', () => {
    const plan: PlanSchema = {
      id: '1',
      title: '',
      goal: 'Test goal',
      details: 'Details',
      project: {
        title: 'project-123',
        goal: 'Project goal',
        details: 'Project details',
      },
      tasks: [],
    };

    const result = getCombinedTitle(plan);
    expect(result).toBe('project-123');
  });

  test('returns Untitled when no title or project', () => {
    const plan: PlanSchema = {
      id: '1',
      title: '',
      goal: 'Test goal',
      details: 'Details',
      tasks: [],
    };

    const result = getCombinedTitle(plan);
    expect(result).toBe('Untitled');
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

  test('combines project and goal when project exists and goals differ', () => {
    const plan: PlanSchema = {
      id: '1',
      title: 'Test Plan',
      goal: 'Phase goal',
      details: 'Details',
      project: {
        title: 'project-456',
        goal: 'Project goal',
        details: 'Project details',
      },
      tasks: [],
    };

    const result = getCombinedGoal(plan);
    expect(result).toBe('Project goal - Phase goal');
  });

  test('returns phase goal when project and phase goals are the same', () => {
    const plan: PlanSchema = {
      id: '1',
      title: 'Test Plan',
      goal: 'Same goal',
      details: 'Details',
      project: {
        title: 'project-456',
        goal: 'Same goal',
        details: 'Project details',
      },
      tasks: [],
    };

    const result = getCombinedGoal(plan);
    expect(result).toBe('Same goal');
  });

  test('returns project goal when phase goal is empty', () => {
    const plan: PlanSchema = {
      id: '1',
      title: 'Test Plan',
      goal: '',
      details: 'Details',
      project: {
        title: 'project-456',
        goal: 'Project goal only',
        details: 'Project details',
      },
      tasks: [],
    };

    const result = getCombinedGoal(plan);
    expect(result).toBe('Project goal only');
  });

  test('returns empty string when no goals exist', () => {
    const plan: PlanSchema = {
      id: '1',
      title: 'Test Plan',
      goal: '',
      details: 'Details',
      tasks: [],
    };

    const result = getCombinedGoal(plan);
    expect(result).toBe('');
  });
});

describe('getCombinedTitleFromSummary', () => {
  test('returns title when no project', () => {
    const summary = {
      title: 'Summary Title',
      goal: 'Summary goal',
    };

    const result = getCombinedTitleFromSummary(summary);
    expect(result).toBe('Summary Title');
  });

  test('combines project and title when project exists', () => {
    const summary = {
      title: 'Summary Title',
      goal: 'Summary goal',
      project: {
        title: 'project-789',
        goal: 'Project goal',
        details: 'Project details',
      },
    };

    const result = getCombinedTitleFromSummary(summary);
    expect(result).toBe('project-789 - Summary Title');
  });

  test('returns project title when summary title is empty', () => {
    const summary = {
      title: '',
      goal: 'Summary goal',
      project: {
        title: 'project-only',
        goal: 'Project goal',
        details: 'Project details',
      },
    };

    const result = getCombinedTitleFromSummary(summary);
    expect(result).toBe('project-only');
  });

  test('returns goal when no title exists', () => {
    const summary = {
      title: '',
      goal: 'Summary goal',
    };

    const result = getCombinedTitleFromSummary(summary);
    expect(result).toBe('Summary goal');
  });

  test('returns Untitled when no title or goal', () => {
    const summary = {
      title: '',
      goal: '',
    };

    const result = getCombinedTitleFromSummary(summary);
    expect(result).toBe('Untitled');
  });

  test('handles full plan summary with project', () => {
    const summary = {
      title: 'Full Summary',
      goal: 'Complete goal',
      project: {
        title: 'full-project',
        goal: 'Project goal',
        details: 'Project details',
      },
    };

    const result = getCombinedTitleFromSummary(summary);
    expect(result).toBe('full-project - Full Summary');
  });
});
