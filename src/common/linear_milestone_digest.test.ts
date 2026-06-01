import { describe, expect, test } from 'vitest';

import {
  fetchLinearMilestonesDueOrOverdue,
  getWeekDateRange,
  type LinearClientLike,
} from './linear_milestone_digest.js';

interface FakeConnection<TNode> {
  nodes: TNode[];
  pageInfo: { hasNextPage: boolean };
  fetchNext: () => Promise<FakeConnection<TNode>>;
}

interface FakeProject {
  archivedAt?: string | null;
  canceledAt?: string | null;
  completedAt?: string | null;
  name: string;
  trashed?: boolean | null;
  url?: string | null;
  lead?: Promise<{ displayName?: string; name?: string } | undefined>;
  milestones: FakeMilestone[];
  status?: Promise<{ type?: string } | undefined>;
  projectMilestones: () => Promise<FakeConnection<FakeMilestone>>;
}

interface FakeMilestone {
  archivedAt?: string | null;
  name: string;
  issueAssignees?: Array<{ displayName?: string; name?: string } | undefined>;
  status?: string;
  targetDate?: string | null;
  url?: string | null;
  project?: Promise<FakeProject | undefined>;
  issues?: () => Promise<FakeConnection<FakeIssue>>;
}

interface FakeIssue {
  assignee?: Promise<{ displayName?: string; name?: string } | undefined>;
}

const MONDAY_JUNE_1_2026_10AM_UTC = Date.parse('2026-06-01T10:00:00.000Z');

function connection<TNode>(nodes: TNode[]): FakeConnection<TNode> {
  return {
    nodes,
    pageInfo: { hasNextPage: false },
    fetchNext: async (): Promise<FakeConnection<TNode>> => {
      throw new Error('unexpected pagination');
    },
  };
}

function project(options: {
  name: string;
  lead?: { displayName?: string; name?: string };
  status?: string;
  completedAt?: string | null;
  milestones: FakeMilestone[];
}): FakeProject {
  const fakeProject: FakeProject = {
    name: options.name,
    url: `https://linear.app/acme/project/${options.name.toLowerCase().replaceAll(' ', '-')}`,
    completedAt: options.completedAt ?? null,
    lead: Promise.resolve(options.lead),
    milestones: options.milestones,
    status: Promise.resolve({ type: options.status }),
    projectMilestones: async (): Promise<FakeConnection<FakeMilestone>> =>
      connection(options.milestones),
  };

  for (const milestone of options.milestones) {
    milestone.project = Promise.resolve(fakeProject);
    milestone.issues = async function (this: FakeMilestone): Promise<FakeConnection<FakeIssue>> {
      return connection(
        (this.issueAssignees ?? []).map((assignee) => ({
          assignee: Promise.resolve(assignee),
        }))
      );
    };
  }

  return fakeProject;
}

function client(projects: FakeProject[]): LinearClientLike {
  return {
    projectMilestones: async (): Promise<FakeConnection<FakeMilestone>> =>
      connection(projects.flatMap((fakeProject) => fakeProject.milestones)),
  };
}

describe('common/linear_milestone_digest', () => {
  test('computes the current Monday through Sunday date range in the configured timezone', () => {
    expect(getWeekDateRange(MONDAY_JUNE_1_2026_10AM_UTC, 'UTC')).toEqual({
      startDate: '2026-06-01',
      endDate: '2026-06-07',
    });

    expect(getWeekDateRange(Date.parse('2026-06-07T23:00:00.000Z'), 'UTC')).toEqual({
      startDate: '2026-06-01',
      endDate: '2026-06-07',
    });
  });

  test('uses shared issue assignee as owner and falls back to project lead', async () => {
    const entries = await fetchLinearMilestonesDueOrOverdue({
      nowMs: MONDAY_JUNE_1_2026_10AM_UTC,
      timezone: 'UTC',
      client: client([
        project({
          name: 'Launch Project',
          lead: { displayName: 'Dana Lead', name: 'Dana Name' },
          status: 'started',
          milestones: [
            {
              name: 'Overdue',
              issueAssignees: [{ displayName: 'Shared Owner' }, { displayName: 'Shared Owner' }],
              targetDate: '2026-05-29',
              status: 'started',
              url: 'https://linear.app/acme/project/milestone/overdue',
            },
            {
              name: 'Beta',
              issueAssignees: [{ displayName: 'Dana Lead' }, { displayName: 'Other Owner' }],
              targetDate: '2026-06-05',
              status: 'started',
              url: 'https://linear.app/acme/project/milestone/beta',
            },
            { name: 'Done', targetDate: '2026-06-04', status: 'completed' },
            { name: 'Next week', targetDate: '2026-06-08', status: 'started' },
          ],
        }),
        project({
          name: 'Completed Project',
          lead: { displayName: 'Closed Lead' },
          status: 'completed',
          milestones: [{ name: 'Should skip', targetDate: '2026-06-03', status: 'started' }],
        }),
        project({
          name: 'Unassigned Project',
          status: 'planned',
          milestones: [
            {
              name: 'Alpha',
              issueAssignees: [{ displayName: 'Nobody' }, undefined],
              targetDate: '2026-06-02',
              status: 'planned',
            },
          ],
        }),
      ]),
    });

    expect(entries).toEqual([
      {
        milestoneName: 'Overdue',
        milestoneUrl: 'https://linear.app/acme/project/milestone/overdue',
        targetDate: '2026-05-29',
        projectName: 'Launch Project',
        projectUrl: 'https://linear.app/acme/project/launch-project',
        milestoneOwner: 'Shared Owner',
      },
      {
        milestoneName: 'Alpha',
        milestoneUrl: null,
        targetDate: '2026-06-02',
        projectName: 'Unassigned Project',
        projectUrl: 'https://linear.app/acme/project/unassigned-project',
        milestoneOwner: 'Unassigned',
      },
      {
        milestoneName: 'Beta',
        milestoneUrl: 'https://linear.app/acme/project/milestone/beta',
        targetDate: '2026-06-05',
        projectName: 'Launch Project',
        projectUrl: 'https://linear.app/acme/project/launch-project',
        milestoneOwner: 'Dana Lead',
      },
    ]);
  });
});
