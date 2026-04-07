import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { IssueTrackerClient, IssueWithComments } from '$common/issue_tracker/types.js';
import type { PendingImportedPlanWrite } from '$tim/commands/import/import_helpers.js';

vi.mock('$tim/configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(),
}));

vi.mock('$common/issue_tracker/factory.js', () => ({
  getAvailableTrackers: vi.fn(),
  getIssueTracker: vi.fn(),
}));

vi.mock('$tim/issue_utils.js', () => ({
  parseIssueInput: vi.fn(),
  createStubPlanFromIssue: vi.fn(),
}));

vi.mock('$common/git.js', () => ({
  getGitRepository: vi.fn(),
}));

vi.mock('$lib/server/init.js', () => ({
  getServerContext: vi.fn(),
}));

vi.mock('$tim/db/project.js', () => ({
  getProjectById: vi.fn(),
}));

vi.mock('$tim/commands/import/import_helpers.js', () => ({
  reserveImportedPlanStartId: vi.fn(),
  writeImportedPlansToDbTransactionally: vi.fn(),
}));

import { loadEffectiveConfig } from '$tim/configLoader.js';
import { getAvailableTrackers, getIssueTracker } from '$common/issue_tracker/factory.js';
import { createStubPlanFromIssue, parseIssueInput } from '$tim/issue_utils.js';
import { getGitRepository } from '$common/git.js';
import { getServerContext } from '$lib/server/init.js';
import { getProjectById } from '$tim/db/project.js';
import {
  reserveImportedPlanStartId,
  writeImportedPlansToDbTransactionally,
} from '$tim/commands/import/import_helpers.js';
import {
  createPlansFromIssue,
  fetchIssueForImport,
  getIssueTrackerStatus,
  type SelectedIssueContent,
} from './issue_import.js';

function makeIssue(
  number: number | string,
  title: string,
  options?: {
    body?: string;
    comments?: string[];
    children?: IssueWithComments[];
    htmlUrl?: string;
  }
): IssueWithComments {
  const body = options?.body ?? `${title} body`;
  const comments = options?.comments ?? [];
  return {
    issue: {
      id: `${number}`,
      number,
      title,
      body,
      htmlUrl: options?.htmlUrl ?? `https://tracker.test/issues/${number}`,
      state: 'open',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    },
    comments: comments.map((comment, index) => ({
      id: `${number}-comment-${index + 1}`,
      body: comment,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    })),
    children: options?.children,
  };
}

function defaultSelectedContent(): SelectedIssueContent {
  return {
    selectedParentContent: [0],
    selectedChildIndices: [],
    selectedChildContent: {},
  };
}

describe('issue_import server helpers', () => {
  let tracker: IssueTrackerClient;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAvailableTrackers).mockReturnValue({
      github: true,
      linear: true,
      available: ['github', 'linear'],
      unavailable: [],
    });
    vi.mocked(loadEffectiveConfig).mockResolvedValue({ issueTracker: 'github' } as never);

    tracker = {
      fetchIssue: vi.fn(),
      fetchIssueWithChildren: vi.fn(),
      fetchAllOpenIssues: vi.fn(),
      parseIssueIdentifier: vi.fn(),
      getDisplayName: vi.fn(() => 'GitHub'),
      getConfig: vi.fn(() => ({ type: 'github' })),
    };
    vi.mocked(getIssueTracker).mockResolvedValue(tracker);
    vi.mocked(parseIssueInput).mockReturnValue({
      identifier: '123',
      isBranchName: false,
      originalInput: '123',
    });
    vi.mocked(getGitRepository).mockResolvedValue('owner/repo');

    vi.mocked(getServerContext).mockResolvedValue({
      db: {} as never,
      config: {} as never,
    });
    vi.mocked(getProjectById).mockReturnValue({
      id: 7,
      name: 'repo',
      repository_id: 'repo-id',
      last_git_root: '/tmp/repo',
    } as never);
    vi.mocked(createStubPlanFromIssue).mockImplementation((issueInstruction, planId) => ({
      id: planId,
      title: issueInstruction.issue.title,
      goal: `Implement: ${issueInstruction.issue.title}`,
      details: issueInstruction.plan,
      status: 'pending',
      issue: [issueInstruction.issue.html_url],
      tasks: [],
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    }));
    vi.mocked(reserveImportedPlanStartId).mockResolvedValue(100);
    vi.mocked(writeImportedPlansToDbTransactionally).mockImplementation(
      async (_repoRoot: string, pendingWrites: PendingImportedPlanWrite[]) =>
        pendingWrites.map((entry) => ({
          ...entry,
          plan: {
            ...entry.plan,
            uuid: entry.plan.uuid ?? `uuid-${entry.plan.id}`,
          },
        }))
    );
  });

  describe('fetchIssueForImport', () => {
    test('expands numeric github identifiers using repo context', async () => {
      const issue = makeIssue(123, 'Parent');
      vi.mocked(tracker.fetchIssue).mockResolvedValue(issue);

      const result = await fetchIssueForImport('123', 'single', '/tmp/repo');

      expect(tracker.fetchIssue).toHaveBeenCalledWith('owner/repo#123');
      expect(result.issueData).toEqual(issue);
      expect(result.tracker).toEqual({
        available: true,
        trackerType: 'github',
        displayName: 'GitHub',
        supportsHierarchical: true,
      });
    });

    test('uses parsed branch identifier when issue id was parsed from a branch name', async () => {
      vi.mocked(parseIssueInput).mockReturnValue({
        identifier: '123',
        isBranchName: true,
        originalInput: 'feature/fix-123',
      });
      vi.mocked(tracker.fetchIssue).mockResolvedValue(makeIssue(123, 'Branch issue'));

      await fetchIssueForImport('feature/fix-123', 'single', '/tmp/repo');

      expect(tracker.fetchIssue).toHaveBeenCalledWith('owner/repo#123');
    });

    test('uses hierarchical fetch when mode requires it and tracker supports it', async () => {
      const issue = makeIssue(1, 'Parent', { children: [makeIssue(2, 'Child')] });
      vi.mocked(tracker.fetchIssueWithChildren!).mockResolvedValue(issue);

      const result = await fetchIssueForImport('ABC-1', 'separate', '/tmp/repo');

      expect(tracker.fetchIssueWithChildren).toHaveBeenCalledWith('ABC-1');
      expect(tracker.fetchIssue).not.toHaveBeenCalled();
      expect(result.issueData.children?.length).toBe(1);
    });

    test('falls back to single fetch when hierarchical fetch is unavailable', async () => {
      const nonHierarchicalTracker: IssueTrackerClient = {
        ...tracker,
        fetchIssueWithChildren: undefined,
      };
      vi.mocked(getIssueTracker).mockResolvedValue(nonHierarchicalTracker);
      vi.mocked(nonHierarchicalTracker.fetchIssue).mockResolvedValue(makeIssue(1, 'Parent'));

      await fetchIssueForImport('ABC-1', 'merged', '/tmp/repo');

      expect(nonHierarchicalTracker.fetchIssue).toHaveBeenCalledWith('ABC-1');
    });

    test('throws for empty identifiers', async () => {
      await expect(fetchIssueForImport('', 'single', '/tmp/repo')).rejects.toThrow(
        'Invalid issue identifier'
      );
      await expect(fetchIssueForImport('   ', 'single', '/tmp/repo')).rejects.toThrow(
        'Invalid issue identifier'
      );
    });

    test('passes unrecognized identifiers directly to tracker', async () => {
      vi.mocked(parseIssueInput).mockReturnValue(null);
      vi.mocked(tracker.fetchIssue).mockResolvedValue(makeIssue(123, 'Qualified'));

      await fetchIssueForImport('owner/repo#123', 'single', '/tmp/repo');
      expect(tracker.fetchIssue).toHaveBeenCalledWith('owner/repo#123');
    });

    test('passes #123 format directly to tracker', async () => {
      vi.mocked(parseIssueInput).mockReturnValue(null);
      vi.mocked(tracker.fetchIssue).mockResolvedValue(makeIssue(123, 'Hash ref'));

      await fetchIssueForImport('#123', 'single', '/tmp/repo');
      expect(tracker.fetchIssue).toHaveBeenCalledWith('#123');
    });

    test('passes owner/repo/123 format directly to tracker', async () => {
      vi.mocked(parseIssueInput).mockReturnValue(null);
      vi.mocked(tracker.fetchIssue).mockResolvedValue(makeIssue(123, 'Slash ref'));

      await fetchIssueForImport('owner/repo/123', 'single', '/tmp/repo');
      expect(tracker.fetchIssue).toHaveBeenCalledWith('owner/repo/123');
    });

    test('throws when configured tracker is unavailable', async () => {
      vi.mocked(loadEffectiveConfig).mockResolvedValue({ issueTracker: 'linear' } as never);
      vi.mocked(getAvailableTrackers).mockReturnValue({
        github: true,
        linear: false,
        available: ['github'],
        unavailable: ['linear'],
      });

      await expect(fetchIssueForImport('ABC-1', 'single', '/tmp/repo')).rejects.toThrow(
        'Linear issue tracker is not configured'
      );
    });
  });

  describe('createPlansFromIssue', () => {
    test('creates a single imported plan from selected parent content', async () => {
      const issueData = makeIssue(1, 'Parent', {
        body: 'Parent body',
        comments: ['Ignored', 'Second comment'],
      });
      const selected: SelectedIssueContent = {
        selectedParentContent: [0, 2],
        selectedChildIndices: [],
        selectedChildContent: {},
      };
      vi.mocked(reserveImportedPlanStartId).mockResolvedValue(41);
      vi.mocked(writeImportedPlansToDbTransactionally).mockResolvedValue([
        {
          plan: {
            id: 41,
            uuid: 'uuid-parent',
          } as never,
          filePath: null,
        },
      ]);

      const result = await createPlansFromIssue(7, issueData, 'single', selected);

      expect(result).toEqual({ planUuid: 'uuid-parent' });
      expect(reserveImportedPlanStartId).toHaveBeenCalledWith('/tmp/repo', 1);
      expect(createStubPlanFromIssue).toHaveBeenCalledTimes(1);
      expect(vi.mocked(createStubPlanFromIssue).mock.calls[0]?.[0]).toMatchObject({
        issue: {
          title: 'Parent',
          html_url: issueData.issue.htmlUrl,
        },
        plan: 'Parent body\n\nSecond comment',
      });
    });

    test('creates parent and children plans in separate mode', async () => {
      const childA = makeIssue(2, 'Child A', { body: 'Child A body', comments: ['Child A c1'] });
      const childB = makeIssue(3, 'Child B', { body: 'Child B body', comments: ['Child B c1'] });
      const parent = makeIssue(1, 'Parent', {
        body: 'Parent body',
        comments: ['Parent c1'],
        children: [childA, childB],
      });
      const selected: SelectedIssueContent = {
        selectedParentContent: [0],
        selectedChildIndices: [1, 0],
        selectedChildContent: {
          0: [0],
          1: [0, 1],
        },
      };
      vi.mocked(reserveImportedPlanStartId).mockResolvedValue(100);

      await createPlansFromIssue(7, parent, 'separate', selected);

      expect(reserveImportedPlanStartId).toHaveBeenCalledWith('/tmp/repo', 3);
      expect(writeImportedPlansToDbTransactionally).toHaveBeenCalledTimes(1);
      const pendingWrites = vi.mocked(writeImportedPlansToDbTransactionally).mock.calls[0]?.[1];
      expect(pendingWrites).toHaveLength(3);
      expect(pendingWrites?.[0]?.plan).toMatchObject({
        id: 101,
        parent: 100,
      });
      expect(pendingWrites?.[1]?.plan).toMatchObject({
        id: 102,
        parent: 100,
      });
      expect(pendingWrites?.[2]?.plan).toMatchObject({
        id: 100,
        dependencies: [101, 102],
      });

      // Child plans should not have rmprOptions (matching CLI behavior)
      const childCalls = vi.mocked(createStubPlanFromIssue).mock.calls.filter(
        (call) => call[1] !== 100 // exclude parent plan
      );
      for (const call of childCalls) {
        expect(call[0].rmprOptions).toBeNull();
      }
    });

    test('creates merged parent details and issue links in merged mode', async () => {
      const child = makeIssue(2, 'Child', { body: 'Child body', comments: ['Child c1'] });
      const parent = makeIssue(1, 'Parent', {
        body: 'Parent body',
        comments: ['Parent c1'],
        children: [child],
      });
      const selected: SelectedIssueContent = {
        selectedParentContent: [0],
        selectedChildIndices: [0],
        selectedChildContent: {
          0: [0],
        },
      };
      vi.mocked(reserveImportedPlanStartId).mockResolvedValue(50);

      await createPlansFromIssue(7, parent, 'merged', selected);

      const pendingWrites = vi.mocked(writeImportedPlansToDbTransactionally).mock.calls[0]?.[1];
      expect(pendingWrites).toHaveLength(1);
      expect(pendingWrites?.[0]?.plan).toMatchObject({
        id: 50,
        issue: [parent.issue.htmlUrl, child.issue.htmlUrl],
      });
      expect(pendingWrites?.[0]?.plan.details).toContain('Parent body');
      expect(pendingWrites?.[0]?.plan.details).toContain('## Subissue 2: Child');
      expect(pendingWrites?.[0]?.plan.details).toContain('Child body');
    });

    test('throws when single mode has no non-empty selected content', async () => {
      const issueData = makeIssue(1, 'Parent', {
        body: '   ',
        comments: ['  '],
      });
      const selected: SelectedIssueContent = {
        selectedParentContent: [0, 1],
        selectedChildIndices: [],
        selectedChildContent: {},
      };

      await expect(createPlansFromIssue(7, issueData, 'single', selected)).rejects.toThrow(
        'Select at least one parent content item'
      );
    });

    test('throws when separate mode has no selected non-empty content', async () => {
      const child = makeIssue(2, 'Child', { body: ' ', comments: ['   '] });
      const parent = makeIssue(1, 'Parent', {
        body: ' ',
        comments: ['  '],
        children: [child],
      });
      const selected: SelectedIssueContent = {
        selectedParentContent: [0],
        selectedChildIndices: [0],
        selectedChildContent: {
          0: [0, 1],
        },
      };

      await expect(createPlansFromIssue(7, parent, 'separate', selected)).rejects.toThrow(
        'Select at least one parent or subissue content item'
      );
    });

    test('throws when selected subissue has only empty content', async () => {
      const child = makeIssue(2, 'Child', { body: ' ', comments: ['  '] });
      const parent = makeIssue(1, 'Parent', {
        body: 'Parent body',
        comments: [],
        children: [child],
      });
      const selected: SelectedIssueContent = {
        selectedParentContent: [0],
        selectedChildIndices: [0],
        selectedChildContent: {
          0: [0, 1],
        },
      };

      await expect(createPlansFromIssue(7, parent, 'separate', selected)).rejects.toThrow(
        'Selected subissue 2 has no non-empty content selected.'
      );
    });

    test('throws when project has no git root', async () => {
      vi.mocked(getProjectById).mockReturnValue({
        id: 7,
        name: 'repo',
        repository_id: 'repo-id',
        last_git_root: null,
      } as never);

      await expect(
        createPlansFromIssue(7, makeIssue(1, 'Parent'), 'single', defaultSelectedContent())
      ).rejects.toThrow('Project does not have a git root configured');
    });
  });

  describe('getIssueTrackerStatus', () => {
    test('returns tracker status and capabilities based on config and availability', async () => {
      vi.mocked(loadEffectiveConfig).mockResolvedValue({ issueTracker: 'linear' } as never);
      vi.mocked(getAvailableTrackers).mockReturnValue({
        github: false,
        linear: true,
        available: ['linear'],
        unavailable: ['github'],
      });

      const status = await getIssueTrackerStatus('/tmp/repo');

      expect(status).toEqual({
        available: true,
        trackerType: 'linear',
        displayName: 'Linear',
        supportsHierarchical: true,
      });
    });

    test('defaults to github when tracker is not set in config', async () => {
      vi.mocked(loadEffectiveConfig).mockResolvedValue({} as never);
      vi.mocked(getAvailableTrackers).mockReturnValue({
        github: false,
        linear: true,
        available: ['linear'],
        unavailable: ['github'],
      });

      const status = await getIssueTrackerStatus('/tmp/repo');

      expect(status).toEqual({
        available: false,
        trackerType: 'github',
        displayName: 'GitHub',
        supportsHierarchical: false,
      });
    });
  });
});
