import { describe, test, expect } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  getCombinedTitle,
  getCombinedGoal,
  getCombinedTitleFromSummary,
  formatWorkspacePath,
  extractIssueNumber,
  buildDescriptionFromPlan,
} from './display_utils.js';
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

describe('formatWorkspacePath', () => {
  const homeDir = os.homedir();

  test('returns "this workspace" for current workspace', () => {
    const workspace = path.join(homeDir, 'projects', 'app');
    const formatted = formatWorkspacePath(workspace, { currentWorkspace: workspace });
    expect(formatted).toBe('this workspace');
  });

  test('prefers relative path when shorter', () => {
    const current = path.join(homeDir, 'projects', 'repo');
    const sibling = path.join(homeDir, 'projects', 'other-feature');
    const formatted = formatWorkspacePath(sibling, { currentWorkspace: current });
    expect(formatted).toBe(path.relative(current, sibling));
  });

  test('abbreviates home directory', () => {
    const sample = path.join(homeDir, 'workspace', 'feature-one');
    const formatted = formatWorkspacePath(sample);
    expect(formatted.startsWith('~')).toBe(true);
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

describe('extractIssueNumber', () => {
  test('extracts GitHub issue number from URL', () => {
    const url = 'https://github.com/owner/repo/issues/123';
    expect(extractIssueNumber(url)).toBe('#123');
  });

  test('extracts GitLab issue number from URL', () => {
    const url = 'https://gitlab.com/owner/repo/issues/456';
    expect(extractIssueNumber(url)).toBe('#456');
  });

  test('extracts Linear issue ID from URL', () => {
    const url = 'https://linear.app/team/issue/PROJ-789';
    expect(extractIssueNumber(url)).toBe('PROJ-789');
  });

  test('extracts Jira issue ID from URL', () => {
    const url = 'https://company.atlassian.net/browse/TEAM-123';
    expect(extractIssueNumber(url)).toBe('TEAM-123');
  });

  test('returns undefined for URL without issue pattern', () => {
    const url = 'https://github.com/owner/repo';
    expect(extractIssueNumber(url)).toBeUndefined();
  });
});

describe('buildDescriptionFromPlan', () => {
  test('builds description from plan title only', () => {
    const plan: PlanSchema = {
      id: '1',
      title: 'Add New Feature',
      goal: 'Implement feature',
      details: 'Details',
      tasks: [],
    };

    expect(buildDescriptionFromPlan(plan)).toBe('Add New Feature');
  });

  test('builds description with issue number from GitHub URL', () => {
    const plan: PlanSchema = {
      id: '1',
      title: 'Fix Bug',
      goal: 'Fix the bug',
      details: 'Details',
      issue: ['https://github.com/owner/repo/issues/789'],
      tasks: [],
    };

    expect(buildDescriptionFromPlan(plan)).toBe('#789 Fix Bug');
  });

  test('builds description with Linear issue ID', () => {
    const plan: PlanSchema = {
      id: '1',
      title: 'New Feature',
      goal: 'Add feature',
      details: 'Details',
      issue: ['https://linear.app/team/issue/DF-456'],
      tasks: [],
    };

    expect(buildDescriptionFromPlan(plan)).toBe('DF-456 New Feature');
  });

  test('uses first issue when multiple are present', () => {
    const plan: PlanSchema = {
      id: '1',
      title: 'Multiple Issues',
      goal: 'Handle issues',
      details: 'Details',
      issue: [
        'https://github.com/owner/repo/issues/111',
        'https://github.com/owner/repo/issues/222',
      ],
      tasks: [],
    };

    expect(buildDescriptionFromPlan(plan)).toBe('#111 Multiple Issues');
  });

  test('combines project and phase title with issue', () => {
    const plan: PlanSchema = {
      id: '1',
      title: 'Phase One',
      goal: 'Complete phase',
      details: 'Details',
      project: {
        title: 'Big Project',
        goal: 'Complete project',
        details: 'Project details',
      },
      issue: ['https://github.com/owner/repo/issues/999'],
      tasks: [],
    };

    expect(buildDescriptionFromPlan(plan)).toBe('#999 Big Project - Phase One');
  });

  test('falls back to goal when no title', () => {
    const plan: PlanSchema = {
      id: '1',
      title: '',
      goal: 'Main Goal',
      details: 'Details',
      tasks: [],
    };

    expect(buildDescriptionFromPlan(plan)).toBe('Main Goal');
  });
});
