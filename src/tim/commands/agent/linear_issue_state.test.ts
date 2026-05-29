import { beforeEach, describe, expect, test, vi } from 'vitest';
import { moveLinearIssuesToInProgressForAgentRun } from './linear_issue_state.js';
import { getIssueTracker } from '../../../common/issue_tracker/factory.js';
import { log, warn } from '../../../logging.js';
import type { IssueTrackerClient } from '../../../common/issue_tracker/types.js';
import type { PlanSchema } from '../../planSchema.js';

vi.mock('../../../common/issue_tracker/factory.js', () => ({
  getIssueTracker: vi.fn(),
}));

vi.mock('../../../logging.js', () => ({
  log: vi.fn(),
  warn: vi.fn(),
}));

describe('moveLinearIssuesToInProgressForAgentRun', () => {
  const basePlan: PlanSchema = {
    id: 123,
    title: 'Linear plan',
    goal: 'Move issue state',
    details: 'Ensure agent startup updates Linear',
    status: 'pending',
    tasks: [],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('moves Linear issue references through the issue tracker client', async () => {
    const transitionIssueToInProgressIfReady = vi.fn(async () => ({
      identifier: 'TEAM-123',
      fromState: 'Todo',
      toState: 'In Progress',
      changed: true,
    }));
    const tracker = makeTracker({
      transitionIssueToInProgressIfReady,
    });
    vi.mocked(getIssueTracker).mockResolvedValue(tracker);

    await moveLinearIssuesToInProgressForAgentRun(
      {
        ...basePlan,
        issue: ['https://linear.app/acme/issue/TEAM-123/do-the-work', 'not-a-linear-issue'],
      },
      { issueTracker: 'linear' } as any,
      77
    );

    expect(getIssueTracker).toHaveBeenCalledWith({ issueTracker: 'linear' }, { projectId: 77 });
    expect(transitionIssueToInProgressIfReady).toHaveBeenCalledWith(
      'https://linear.app/acme/issue/TEAM-123/do-the-work'
    );
    expect(transitionIssueToInProgressIfReady).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('Moved Linear issue TEAM-123 from Todo to In Progress.');
  });

  test('does nothing for non-Linear projects', async () => {
    await moveLinearIssuesToInProgressForAgentRun(
      { ...basePlan, issue: ['https://linear.app/acme/issue/TEAM-123/do-the-work'] },
      { issueTracker: 'github' } as any
    );

    expect(getIssueTracker).not.toHaveBeenCalled();
  });

  test('warns and continues when a Linear issue update fails', async () => {
    const tracker = makeTracker({
      transitionIssueToInProgressIfReady: vi.fn(async () => {
        throw new Error('Linear is unavailable');
      }),
    });
    vi.mocked(getIssueTracker).mockResolvedValue(tracker);

    await moveLinearIssuesToInProgressForAgentRun({ ...basePlan, issue: ['TEAM-123'] }, {
      issueTracker: 'linear',
    } as any);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to update Linear issue TEAM-123 before agent run')
    );
  });
});

function makeTracker(overrides: Partial<IssueTrackerClient>): IssueTrackerClient {
  return {
    fetchIssue: vi.fn() as any,
    fetchAllOpenIssues: vi.fn() as any,
    parseIssueIdentifier: vi.fn((spec: string) =>
      spec.includes('TEAM-123') ? { identifier: 'TEAM-123' } : null
    ),
    getDisplayName: vi.fn(() => 'Linear'),
    getConfig: vi.fn(() => ({ type: 'linear' })),
    ...overrides,
  };
}
