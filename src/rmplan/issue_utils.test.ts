import { describe, test, expect } from 'bun:test';
import { createStubPlanFromIssue } from './issue_utils.js';
import type { IssueInstructionData } from './issue_utils.js';

describe('createStubPlanFromIssue', () => {
  test('creates plan with project data when issue has project', () => {
    const issueData: IssueInstructionData = {
      issue: {
        title: 'Test Issue with Project',
        html_url: 'https://linear.app/company/issue/TEAM-123',
        project: {
          name: 'My Project',
          description: 'This is a test project for our team',
        },
      },
      plan: 'Test issue description',
      suggestedFileName: 'test-issue.md',
    };

    const planId = 1;
    const result = createStubPlanFromIssue(issueData, planId);

    expect(result.project).toEqual({
      title: 'My Project',
      goal: 'This is a test project for our team',
      details: 'This is a test project for our team',
    });

    expect(result.id).toBe(1);
    expect(result.title).toBe('Test Issue with Project');
    expect(result.goal).toBeUndefined();
    expect(result.issue).toEqual(['https://linear.app/company/issue/TEAM-123']);
  });

  test('creates plan without project when issue has no project', () => {
    const issueData: IssueInstructionData = {
      issue: {
        title: 'Test Issue without Project',
        html_url: 'https://linear.app/company/issue/TEAM-124',
      },
      plan: 'Test issue description without project',
      suggestedFileName: 'test-issue-2.md',
    };

    const planId = 2;
    const result = createStubPlanFromIssue(issueData, planId);

    expect(result.project).toBeUndefined();
    expect(result.id).toBe(2);
    expect(result.title).toBe('Test Issue without Project');
  });

  test('creates plan with project when project has no description', () => {
    const issueData: IssueInstructionData = {
      issue: {
        title: 'Test Issue with Project No Desc',
        html_url: 'https://linear.app/company/issue/TEAM-125',
        project: {
          name: 'Project Without Description',
        },
      },
      plan: 'Test issue description',
      suggestedFileName: 'test-issue-3.md',
    };

    const planId = 3;
    const result = createStubPlanFromIssue(issueData, planId);

    expect(result.project).toEqual({
      title: 'Project Without Description',
      goal: 'Project Without Description',
      details: undefined,
    });
  });
});
