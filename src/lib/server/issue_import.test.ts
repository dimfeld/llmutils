import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { IssueTrackerClient, IssueWithComments } from '$common/issue_tracker/types.js';
import type { PendingImportedPlanWrite } from '$tim/commands/import/import_helpers.js';
import type { PlanSchema } from '$tim/planSchema.js';

vi.mock('$tim/configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(),
}));

vi.mock('$common/issue_tracker/factory.js', () => ({
  getAvailableTrackers: vi.fn(),
  getAvailableTrackersForProject: vi.fn(),
  getIssueTracker: vi.fn(),
}));

vi.mock('$common/linear.js', () => ({
  createLinearClient: vi.fn(),
}));

vi.mock('$common/env.js', () => ({
  readDotEnvFromDirectory: vi.fn(),
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

vi.mock('$tim/assignments/workspace_identifier.js', () => ({
  getRepositoryIdentity: vi.fn(),
}));

vi.mock('$tim/plans_db.js', () => ({
  loadPlansFromDb: vi.fn(),
}));

vi.mock('$tim/plans.js', () => ({
  resolvePlanByNumericId: vi.fn(),
}));

vi.mock('$tim/workspace/workspace_info.js', () => ({
  getPreferredProjectGitRoot: vi.fn(),
}));

import { loadEffectiveConfig } from '$tim/configLoader.js';
import {
  getAvailableTrackers,
  getAvailableTrackersForProject,
  getIssueTracker,
} from '$common/issue_tracker/factory.js';
import { createLinearClient } from '$common/linear.js';
import { readDotEnvFromDirectory } from '$common/env.js';
import { createStubPlanFromIssue, parseIssueInput } from '$tim/issue_utils.js';
import { getGitRepository } from '$common/git.js';
import { getServerContext } from '$lib/server/init.js';
import { getProjectById } from '$tim/db/project.js';
import {
  reserveImportedPlanStartId,
  writeImportedPlansToDbTransactionally,
} from '$tim/commands/import/import_helpers.js';
import { getRepositoryIdentity } from '$tim/assignments/workspace_identifier.js';
import { loadPlansFromDb } from '$tim/plans_db.js';
import { resolvePlanByNumericId } from '$tim/plans.js';
import { getPreferredProjectGitRoot } from '$tim/workspace/workspace_info.js';
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
    vi.mocked(getAvailableTrackersForProject).mockResolvedValue({
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
    vi.mocked(createLinearClient).mockReturnValue(tracker);
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
    vi.mocked(getPreferredProjectGitRoot).mockReturnValue('/tmp/preferred-workspace');
    vi.mocked(readDotEnvFromDirectory).mockResolvedValue(null);
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
    vi.mocked(getRepositoryIdentity).mockResolvedValue({
      repositoryId: 'repo-id',
      remoteUrl: null,
      gitRoot: '/tmp/repo',
    });
    vi.mocked(loadPlansFromDb).mockReturnValue({
      plans: new Map<number, PlanSchema>(),
      duplicates: {},
    });
    vi.mocked(resolvePlanByNumericId).mockImplementation(async (planArg) => ({
      plan: {
        id: Number(planArg),
        uuid: `uuid-${String(planArg)}`,
        title: `Existing ${String(planArg)}`,
        goal: 'goal',
        details: '',
        status: 'pending',
        issue: [],
        dependencies: [],
        tasks: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      },
      planPath: null,
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

    test('prefers LINEAR_API_KEY from the preferred project git root when creating the tracker', async () => {
      const linearTracker: IssueTrackerClient = {
        ...tracker,
        fetchIssueWithChildren: vi.fn(),
        getDisplayName: vi.fn(() => 'Linear'),
        getConfig: vi.fn(() => ({ type: 'linear', apiKey: 'preferred-key' })),
      };
      vi.mocked(loadEffectiveConfig).mockResolvedValue({ issueTracker: 'linear' } as never);
      vi.mocked(readDotEnvFromDirectory).mockResolvedValue({
        LINEAR_API_KEY: 'preferred-key',
      });
      vi.mocked(createLinearClient).mockReturnValue(linearTracker);
      vi.mocked(linearTracker.fetchIssue).mockResolvedValue(makeIssue('ABC-1', 'Linear issue'));
      vi.mocked(parseIssueInput).mockReturnValue({
        identifier: 'ABC-1',
        isBranchName: false,
        originalInput: 'ABC-1',
      });

      await fetchIssueForImport('ABC-1', 'single', '/tmp/repo', 7);

      expect(getPreferredProjectGitRoot).toHaveBeenCalledWith({} as never, 7);
      expect(readDotEnvFromDirectory).toHaveBeenCalledWith('/tmp/preferred-workspace');
      expect(createLinearClient).toHaveBeenCalledWith({
        type: 'linear',
        apiKey: 'preferred-key',
      });
      expect(getIssueTracker).not.toHaveBeenCalledWith(
        expect.objectContaining({ issueTracker: 'linear' }),
        expect.anything()
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
      expect(reserveImportedPlanStartId).toHaveBeenCalledWith('/tmp/preferred-workspace', 1);
      expect(createStubPlanFromIssue).toHaveBeenCalledTimes(1);
      expect(vi.mocked(createStubPlanFromIssue).mock.calls[0]?.[0]).toMatchObject({
        issue: {
          title: 'Parent',
          html_url: issueData.issue.htmlUrl,
        },
        plan: 'Parent body\n\nSecond comment',
      });
    });

    test('updates existing single plan when imported issue URL matches', async () => {
      const issueData = makeIssue(1, 'Parent Updated', {
        body: 'Parent body',
        comments: ['New comment'],
        htmlUrl: 'https://tracker.test/issues/1',
      });
      const existingPlan: PlanSchema = {
        id: 41,
        uuid: 'uuid-existing-41',
        title: 'Old Parent Title',
        goal: 'goal',
        details: 'Parent body',
        status: 'pending',
        issue: ['https://tracker.test/issues/1'],
        tasks: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(loadPlansFromDb).mockReturnValue({
        plans: new Map([[41, existingPlan]]),
        duplicates: {},
      });
      vi.mocked(resolvePlanByNumericId).mockResolvedValue({
        plan: existingPlan,
        planPath: null,
      });

      const result = await createPlansFromIssue(7, issueData, 'single', {
        selectedParentContent: [0, 1],
        selectedChildIndices: [],
        selectedChildContent: {},
      });

      expect(result).toEqual({ planUuid: 'uuid-existing-41' });
      expect(reserveImportedPlanStartId).not.toHaveBeenCalled();
      expect(writeImportedPlansToDbTransactionally).toHaveBeenCalledTimes(1);
      const pendingWrites = vi.mocked(writeImportedPlansToDbTransactionally).mock.calls[0]?.[1];
      expect(pendingWrites).toHaveLength(1);
      expect(pendingWrites?.[0]?.plan).toMatchObject({
        id: 41,
        title: 'Parent Updated',
      });
      expect(pendingWrites?.[0]?.plan.details).toContain('Parent body');
      expect(pendingWrites?.[0]?.plan.details).toContain('New comment');
    });

    test('returns existing UUID without writing when single import is unchanged', async () => {
      const issueData = makeIssue(1, 'Parent', {
        body: 'Parent body',
        comments: ['Existing comment'],
        htmlUrl: 'https://tracker.test/issues/1',
      });
      const existingPlan: PlanSchema = {
        id: 41,
        uuid: 'uuid-existing-41',
        title: 'Parent',
        goal: 'goal',
        details: 'Parent body\n\nExisting comment',
        status: 'pending',
        issue: ['https://tracker.test/issues/1'],
        tasks: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(loadPlansFromDb).mockReturnValue({
        plans: new Map([[41, existingPlan]]),
        duplicates: {},
      });
      vi.mocked(resolvePlanByNumericId).mockResolvedValue({
        plan: existingPlan,
        planPath: null,
      });

      const result = await createPlansFromIssue(7, issueData, 'single', {
        selectedParentContent: [0, 1],
        selectedChildIndices: [],
        selectedChildContent: {},
      });

      expect(result).toEqual({ planUuid: 'uuid-existing-41' });
      expect(writeImportedPlansToDbTransactionally).not.toHaveBeenCalled();
      expect(reserveImportedPlanStartId).not.toHaveBeenCalled();
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

      expect(reserveImportedPlanStartId).toHaveBeenCalledWith('/tmp/preferred-workspace', 3);
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

    test('updates existing parent and child plans in separate mode and only reserves IDs for new plans', async () => {
      const childA = makeIssue(2, 'Child A updated', {
        body: 'Child A body',
        comments: ['Child A new'],
        htmlUrl: 'https://tracker.test/issues/2',
      });
      const childB = makeIssue(3, 'Child B', {
        body: 'Child B body',
        comments: ['Child B c1'],
        htmlUrl: 'https://tracker.test/issues/3',
      });
      const parentIssue = makeIssue(1, 'Parent updated', {
        body: 'Parent body',
        comments: ['Parent c1'],
        children: [childA, childB],
        htmlUrl: 'https://tracker.test/issues/1',
      });
      const existingParent: PlanSchema = {
        id: 100,
        uuid: 'uuid-parent-existing',
        title: 'Old parent',
        goal: 'goal',
        details: 'Parent body',
        status: 'pending',
        issue: ['https://tracker.test/issues/1'],
        dependencies: [101],
        tasks: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      const existingChildA: PlanSchema = {
        id: 101,
        uuid: 'uuid-child-a-existing',
        title: 'Old child A',
        goal: 'goal',
        details: 'Child A body',
        status: 'pending',
        issue: ['https://tracker.test/issues/2'],
        parent: 100,
        tasks: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(loadPlansFromDb).mockReturnValue({
        plans: new Map([
          [100, existingParent],
          [101, existingChildA],
        ]),
        duplicates: {},
      });
      vi.mocked(resolvePlanByNumericId).mockImplementation(async (planArg) => {
        if (String(planArg) === '100') {
          return { plan: existingParent, planPath: null };
        }
        if (String(planArg) === '101') {
          return { plan: existingChildA, planPath: null };
        }
        throw new Error(`Unexpected plan lookup: ${String(planArg)}`);
      });
      vi.mocked(reserveImportedPlanStartId).mockResolvedValue(200);

      const result = await createPlansFromIssue(7, parentIssue, 'separate', {
        selectedParentContent: [0, 1],
        selectedChildIndices: [0, 1],
        selectedChildContent: {
          0: [0, 1],
          1: [0],
        },
      });

      expect(result).toEqual({ planUuid: 'uuid-parent-existing' });
      expect(reserveImportedPlanStartId).toHaveBeenCalledWith('/tmp/preferred-workspace', 1);
      const pendingWrites = vi.mocked(writeImportedPlansToDbTransactionally).mock.calls[0]?.[1];
      expect(pendingWrites).toHaveLength(3);
      expect(pendingWrites?.[0]?.plan).toMatchObject({
        id: 101,
        parent: 100,
        title: 'Child A updated',
      });
      expect(pendingWrites?.[0]?.plan.details).toContain('Child A new');
      expect(pendingWrites?.[1]?.plan).toMatchObject({
        id: 200,
        parent: 100,
      });
      expect(pendingWrites?.[2]?.plan).toMatchObject({
        id: 100,
        title: 'Parent updated',
        dependencies: [101, 200],
      });
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

    test('updates existing merged parent plan without reserving IDs', async () => {
      const child = makeIssue(2, 'Child', {
        body: 'Child body',
        comments: ['Child c1'],
        htmlUrl: 'https://tracker.test/issues/2',
      });
      const parentIssue = makeIssue(1, 'Parent updated', {
        body: 'Parent body',
        comments: ['Parent c1'],
        children: [child],
        htmlUrl: 'https://tracker.test/issues/1',
      });
      const existingParent: PlanSchema = {
        id: 50,
        uuid: 'uuid-parent-50',
        title: 'Parent old',
        goal: 'goal',
        details: 'Parent body',
        status: 'pending',
        issue: ['https://tracker.test/issues/1'],
        tasks: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(loadPlansFromDb).mockReturnValue({
        plans: new Map([[50, existingParent]]),
        duplicates: {},
      });
      vi.mocked(resolvePlanByNumericId).mockResolvedValue({
        plan: existingParent,
        planPath: null,
      });

      const result = await createPlansFromIssue(7, parentIssue, 'merged', {
        selectedParentContent: [0],
        selectedChildIndices: [0],
        selectedChildContent: {
          0: [0],
        },
      });

      expect(result).toEqual({ planUuid: 'uuid-parent-50' });
      expect(reserveImportedPlanStartId).not.toHaveBeenCalled();
      const pendingWrites = vi.mocked(writeImportedPlansToDbTransactionally).mock.calls[0]?.[1];
      expect(pendingWrites).toHaveLength(1);
      expect(pendingWrites?.[0]?.plan).toMatchObject({
        id: 50,
        title: 'Parent updated',
        issue: ['https://tracker.test/issues/1', 'https://tracker.test/issues/2'],
      });
      expect(pendingWrites?.[0]?.plan.details).toContain('## Subissue 2: Child');
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

    test('creates empty child plan when selected subissue has only empty content', async () => {
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

      vi.mocked(reserveImportedPlanStartId).mockResolvedValue(200);
      vi.mocked(writeImportedPlansToDbTransactionally).mockResolvedValue([
        { plan: { id: 201, uuid: 'uuid-child' } as never, filePath: null },
        { plan: { id: 200, uuid: 'uuid-parent' } as never, filePath: null },
      ]);

      const result = await createPlansFromIssue(7, parent, 'separate', selected);

      expect(result).toEqual({ planUuid: 'uuid-parent' });
      expect(reserveImportedPlanStartId).toHaveBeenCalledWith('/tmp/preferred-workspace', 2);
    });

    test('throws when project has no git root', async () => {
      vi.mocked(getPreferredProjectGitRoot).mockReturnValue(null);
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

    // --- Single mode duplicate detection edge cases ---

    test('updates existing single plan when only title changed', async () => {
      const issueData = makeIssue(1, 'New Title', {
        body: 'Same body',
        htmlUrl: 'https://tracker.test/issues/1',
      });
      const existingPlan: PlanSchema = {
        id: 41,
        uuid: 'uuid-existing-41',
        title: 'Old Title',
        goal: 'goal',
        details: 'Same body',
        status: 'pending',
        issue: ['https://tracker.test/issues/1'],
        tasks: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(loadPlansFromDb).mockReturnValue({
        plans: new Map([[41, existingPlan]]),
        duplicates: {},
      });
      vi.mocked(resolvePlanByNumericId).mockResolvedValue({ plan: existingPlan, planPath: null });

      const result = await createPlansFromIssue(7, issueData, 'single', {
        selectedParentContent: [0],
        selectedChildIndices: [],
        selectedChildContent: {},
      });

      expect(result).toEqual({ planUuid: 'uuid-existing-41' });
      expect(writeImportedPlansToDbTransactionally).toHaveBeenCalledTimes(1);
      const pendingWrites = vi.mocked(writeImportedPlansToDbTransactionally).mock.calls[0]?.[1];
      expect(pendingWrites?.[0]?.plan).toMatchObject({ id: 41, title: 'New Title' });
    });

    test('updates existing single plan when existing details are empty and new content arrives', async () => {
      const issueData = makeIssue(1, 'Parent', {
        body: 'New content',
        htmlUrl: 'https://tracker.test/issues/1',
      });
      const existingPlan: PlanSchema = {
        id: 41,
        uuid: 'uuid-existing-41',
        title: 'Parent',
        goal: 'goal',
        details: undefined,
        status: 'pending',
        issue: ['https://tracker.test/issues/1'],
        tasks: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(loadPlansFromDb).mockReturnValue({
        plans: new Map([[41, existingPlan]]),
        duplicates: {},
      });
      vi.mocked(resolvePlanByNumericId).mockResolvedValue({ plan: existingPlan, planPath: null });

      const result = await createPlansFromIssue(7, issueData, 'single', {
        selectedParentContent: [0],
        selectedChildIndices: [],
        selectedChildContent: {},
      });

      expect(result).toEqual({ planUuid: 'uuid-existing-41' });
      expect(writeImportedPlansToDbTransactionally).toHaveBeenCalledTimes(1);
      const pendingWrites = vi.mocked(writeImportedPlansToDbTransactionally).mock.calls[0]?.[1];
      expect(pendingWrites?.[0]?.plan.details).toContain('New content');
    });

    test('allows metadata-only updates for existing single plan even when selected content is empty', async () => {
      const issueData = makeIssue(1, 'Parent renamed', {
        body: '',
        htmlUrl: 'https://tracker.test/issues/1',
      });
      const existingPlan: PlanSchema = {
        id: 41,
        uuid: 'uuid-existing-41',
        title: 'Parent',
        goal: 'goal',
        details: '',
        status: 'pending',
        issue: ['https://tracker.test/issues/1'],
        tasks: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(loadPlansFromDb).mockReturnValue({
        plans: new Map([[41, existingPlan]]),
        duplicates: {},
      });
      vi.mocked(resolvePlanByNumericId).mockResolvedValue({ plan: existingPlan, planPath: null });

      const result = await createPlansFromIssue(7, issueData, 'single', {
        selectedParentContent: [0],
        selectedChildIndices: [],
        selectedChildContent: {},
      });

      expect(result).toEqual({ planUuid: 'uuid-existing-41' });
      expect(writeImportedPlansToDbTransactionally).toHaveBeenCalledTimes(1);
      const pendingWrites = vi.mocked(writeImportedPlansToDbTransactionally).mock.calls[0]?.[1];
      expect(pendingWrites?.[0]?.plan).toMatchObject({
        id: 41,
        title: 'Parent renamed',
      });
    });

    // --- Separate mode duplicate detection edge cases ---

    test('does not call reserveImportedPlanStartId when all plans already exist in separate mode', async () => {
      const childA = makeIssue(2, 'Child A', {
        body: 'Child A body',
        htmlUrl: 'https://tracker.test/issues/2',
      });
      const parentIssue = makeIssue(1, 'Parent', {
        body: 'Parent body',
        children: [childA],
        htmlUrl: 'https://tracker.test/issues/1',
      });
      const existingParent: PlanSchema = {
        id: 100,
        uuid: 'uuid-parent',
        title: 'Parent',
        goal: 'goal',
        details: 'Parent body',
        status: 'pending',
        issue: ['https://tracker.test/issues/1'],
        dependencies: [101],
        tasks: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      const existingChildA: PlanSchema = {
        id: 101,
        uuid: 'uuid-child-a',
        title: 'Child A',
        goal: 'goal',
        details: 'Child A body',
        status: 'pending',
        issue: ['https://tracker.test/issues/2'],
        parent: 100,
        tasks: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(loadPlansFromDb).mockReturnValue({
        plans: new Map([
          [100, existingParent],
          [101, existingChildA],
        ]),
        duplicates: {},
      });
      vi.mocked(resolvePlanByNumericId).mockImplementation(async (planArg) => {
        if (String(planArg) === '100') return { plan: existingParent, planPath: null };
        if (String(planArg) === '101') return { plan: existingChildA, planPath: null };
        throw new Error(`Unexpected: ${String(planArg)}`);
      });

      await createPlansFromIssue(7, parentIssue, 'separate', {
        selectedParentContent: [0],
        selectedChildIndices: [0],
        selectedChildContent: { 0: [0] },
      });

      expect(reserveImportedPlanStartId).not.toHaveBeenCalled();
      expect(writeImportedPlansToDbTransactionally).not.toHaveBeenCalled();
    });

    test('updates child but not parent when only child title changed in separate mode', async () => {
      const childA = makeIssue(2, 'Child A Updated Title', {
        body: 'Child A body',
        htmlUrl: 'https://tracker.test/issues/2',
      });
      const parentIssue = makeIssue(1, 'Parent', {
        body: 'Parent body',
        children: [childA],
        htmlUrl: 'https://tracker.test/issues/1',
      });
      const existingParent: PlanSchema = {
        id: 100,
        uuid: 'uuid-parent',
        title: 'Parent',
        goal: 'goal',
        details: 'Parent body',
        status: 'pending',
        issue: ['https://tracker.test/issues/1'],
        dependencies: [101],
        tasks: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      const existingChildA: PlanSchema = {
        id: 101,
        uuid: 'uuid-child-a',
        title: 'Child A',
        goal: 'goal',
        details: 'Child A body',
        status: 'pending',
        issue: ['https://tracker.test/issues/2'],
        parent: 100,
        tasks: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(loadPlansFromDb).mockReturnValue({
        plans: new Map([
          [100, existingParent],
          [101, existingChildA],
        ]),
        duplicates: {},
      });
      vi.mocked(resolvePlanByNumericId).mockImplementation(async (planArg) => {
        if (String(planArg) === '100') return { plan: existingParent, planPath: null };
        if (String(planArg) === '101') return { plan: existingChildA, planPath: null };
        throw new Error(`Unexpected: ${String(planArg)}`);
      });
      vi.mocked(writeImportedPlansToDbTransactionally).mockResolvedValue([
        { plan: { id: 101, uuid: 'uuid-child-a' } as never, filePath: null },
      ]);

      const result = await createPlansFromIssue(7, parentIssue, 'separate', {
        selectedParentContent: [0],
        selectedChildIndices: [0],
        selectedChildContent: { 0: [0] },
      });

      // Parent UUID resolved from allPlans since parent not in writes
      expect(result).toEqual({ planUuid: 'uuid-parent' });
      expect(reserveImportedPlanStartId).not.toHaveBeenCalled();
      // Only child is written, not parent
      expect(writeImportedPlansToDbTransactionally).toHaveBeenCalledWith(
        '/tmp/preferred-workspace',
        [
          expect.objectContaining({
            plan: expect.objectContaining({
              id: 101,
              title: 'Child A Updated Title',
            }),
          }),
        ]
      );
    });

    test('creates new children when parent exists but children are new in separate mode', async () => {
      const childA = makeIssue(2, 'Child A new', {
        body: 'Child A body',
        htmlUrl: 'https://tracker.test/issues/2',
      });
      const parentIssue = makeIssue(1, 'Parent', {
        body: 'Parent body',
        children: [childA],
        htmlUrl: 'https://tracker.test/issues/1',
      });
      const existingParent: PlanSchema = {
        id: 100,
        uuid: 'uuid-parent',
        title: 'Parent',
        goal: 'goal',
        details: 'Parent body',
        status: 'pending',
        issue: ['https://tracker.test/issues/1'],
        dependencies: [],
        tasks: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(loadPlansFromDb).mockReturnValue({
        plans: new Map([[100, existingParent]]),
        duplicates: {},
      });
      vi.mocked(resolvePlanByNumericId).mockResolvedValue({ plan: existingParent, planPath: null });
      vi.mocked(reserveImportedPlanStartId).mockResolvedValue(200);

      const result = await createPlansFromIssue(7, parentIssue, 'separate', {
        selectedParentContent: [0],
        selectedChildIndices: [0],
        selectedChildContent: { 0: [0] },
      });

      expect(result).toEqual({ planUuid: 'uuid-parent' });
      // Only 1 new plan (the child), since parent already exists
      expect(reserveImportedPlanStartId).toHaveBeenCalledWith('/tmp/preferred-workspace', 1);
      const pendingWrites = vi.mocked(writeImportedPlansToDbTransactionally).mock.calls[0]?.[1];
      expect(pendingWrites).toHaveLength(2); // child + parent
      const childWrite = pendingWrites?.find((w) => w.plan.id === 200);
      expect(childWrite?.plan).toMatchObject({ parent: 100 });
      const parentWrite = pendingWrites?.find((w) => w.plan.id === 100);
      expect(parentWrite?.plan.dependencies).toContain(200);
    });

    test('creates new parent when children exist but parent is new in separate mode', async () => {
      const childA = makeIssue(2, 'Child A', {
        body: 'Child A body',
        htmlUrl: 'https://tracker.test/issues/2',
      });
      const parentIssue = makeIssue(1, 'Parent new', {
        body: 'Parent body',
        children: [childA],
        htmlUrl: 'https://tracker.test/issues/1',
      });
      const existingChildA: PlanSchema = {
        id: 101,
        uuid: 'uuid-child-a',
        title: 'Child A',
        goal: 'goal',
        details: 'Child A body',
        status: 'pending',
        issue: ['https://tracker.test/issues/2'],
        tasks: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(loadPlansFromDb).mockReturnValue({
        plans: new Map([[101, existingChildA]]),
        duplicates: {},
      });
      vi.mocked(resolvePlanByNumericId).mockResolvedValue({ plan: existingChildA, planPath: null });
      vi.mocked(reserveImportedPlanStartId).mockResolvedValue(200);

      const result = await createPlansFromIssue(7, parentIssue, 'separate', {
        selectedParentContent: [0],
        selectedChildIndices: [0],
        selectedChildContent: { 0: [0] },
      });

      // Only 1 new plan (the parent)
      expect(reserveImportedPlanStartId).toHaveBeenCalledWith('/tmp/preferred-workspace', 1);
      const pendingWrites = vi.mocked(writeImportedPlansToDbTransactionally).mock.calls[0]?.[1];
      expect(pendingWrites).toHaveLength(2); // existing child + new parent
      const parentWrite = pendingWrites?.find((w) => w.plan.id === 200);
      expect(parentWrite?.plan.dependencies).toContain(101);
      expect(result).toEqual({ planUuid: expect.stringContaining('uuid') });
    });

    // --- Merged mode duplicate detection edge cases ---

    test('deduplicates issue URLs when re-importing the same child URLs in merged mode', async () => {
      const child = makeIssue(2, 'Child', {
        body: 'Child body',
        htmlUrl: 'https://tracker.test/issues/2',
      });
      const parentIssue = makeIssue(1, 'Parent', {
        body: 'Parent body',
        children: [child],
        htmlUrl: 'https://tracker.test/issues/1',
      });
      const existingParent: PlanSchema = {
        id: 50,
        uuid: 'uuid-parent-50',
        title: 'Parent',
        goal: 'goal',
        details: 'Parent body',
        status: 'pending',
        // Both URLs already present
        issue: ['https://tracker.test/issues/1', 'https://tracker.test/issues/2'],
        tasks: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(loadPlansFromDb).mockReturnValue({
        plans: new Map([[50, existingParent]]),
        duplicates: {},
      });
      vi.mocked(resolvePlanByNumericId).mockResolvedValue({ plan: existingParent, planPath: null });

      await createPlansFromIssue(7, parentIssue, 'merged', {
        selectedParentContent: [0],
        selectedChildIndices: [0],
        selectedChildContent: { 0: [0] },
      });

      const pendingWrites = vi.mocked(writeImportedPlansToDbTransactionally).mock.calls[0]?.[1];
      // Issue URLs should not be duplicated
      expect(pendingWrites?.[0]?.plan.issue).toEqual([
        'https://tracker.test/issues/1',
        'https://tracker.test/issues/2',
      ]);
    });

    test('does not write existing merged plan when no title/content/url changes are found', async () => {
      const child = makeIssue(2, 'Child', {
        body: 'Child body',
        htmlUrl: 'https://tracker.test/issues/2',
      });
      const parentIssue = makeIssue(1, 'Parent', {
        body: 'Parent body',
        children: [child],
        htmlUrl: 'https://tracker.test/issues/1',
      });
      // Existing plan already has all content
      const existingDetails = 'Parent body\n\n## Subissue 2: Child\n\nChild body';
      const existingParent: PlanSchema = {
        id: 50,
        uuid: 'uuid-parent-50',
        title: 'Parent',
        goal: 'goal',
        details: existingDetails,
        status: 'pending',
        issue: ['https://tracker.test/issues/1', 'https://tracker.test/issues/2'],
        tasks: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(loadPlansFromDb).mockReturnValue({
        plans: new Map([[50, existingParent]]),
        duplicates: {},
      });
      vi.mocked(resolvePlanByNumericId).mockResolvedValue({ plan: existingParent, planPath: null });

      const result = await createPlansFromIssue(7, parentIssue, 'merged', {
        selectedParentContent: [0],
        selectedChildIndices: [0],
        selectedChildContent: { 0: [0] },
      });

      expect(result).toEqual({ planUuid: 'uuid-parent-50' });
      expect(writeImportedPlansToDbTransactionally).not.toHaveBeenCalled();
    });

    test('single mode does not match merged parent by child issue URL', async () => {
      const issueData = makeIssue(2, 'Child imported directly', {
        body: 'Child body',
        htmlUrl: 'https://tracker.test/issues/2',
      });
      const mergedParentPlan: PlanSchema = {
        id: 50,
        uuid: 'uuid-merged-parent',
        title: 'Merged parent',
        goal: 'goal',
        details: 'Merged details',
        status: 'pending',
        issue: ['https://tracker.test/issues/1', 'https://tracker.test/issues/2'],
        tasks: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(loadPlansFromDb).mockReturnValue({
        plans: new Map([[50, mergedParentPlan]]),
        duplicates: {},
      });
      vi.mocked(reserveImportedPlanStartId).mockResolvedValue(200);
      vi.mocked(writeImportedPlansToDbTransactionally).mockResolvedValue([
        {
          plan: { id: 200, uuid: 'uuid-new-child' } as never,
          filePath: null,
        },
      ]);

      const result = await createPlansFromIssue(7, issueData, 'single', {
        selectedParentContent: [0],
        selectedChildIndices: [],
        selectedChildContent: {},
      });

      expect(result).toEqual({ planUuid: 'uuid-new-child' });
      expect(reserveImportedPlanStartId).toHaveBeenCalledWith('/tmp/preferred-workspace', 1);
      expect(resolvePlanByNumericId).not.toHaveBeenCalled();
      expect(createStubPlanFromIssue).toHaveBeenCalledWith(
        expect.objectContaining({
          issue: expect.objectContaining({ html_url: 'https://tracker.test/issues/2' }),
        }),
        200
      );
    });

    test('separate mode does not match merged parent by child issue URL', async () => {
      const parentIssue = makeIssue(10, 'Parent', {
        body: 'Parent body',
        htmlUrl: 'https://tracker.test/issues/10',
        children: [
          makeIssue(2, 'Child', {
            body: 'Child body',
            htmlUrl: 'https://tracker.test/issues/2',
          }),
        ],
      });
      const mergedParentPlan: PlanSchema = {
        id: 50,
        uuid: 'uuid-merged-parent',
        title: 'Old merged parent',
        goal: 'goal',
        details: 'Merged details',
        status: 'pending',
        issue: ['https://tracker.test/issues/1', 'https://tracker.test/issues/2'],
        tasks: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(loadPlansFromDb).mockReturnValue({
        plans: new Map([[50, mergedParentPlan]]),
        duplicates: {},
      });
      vi.mocked(reserveImportedPlanStartId).mockResolvedValue(200);
      vi.mocked(writeImportedPlansToDbTransactionally).mockResolvedValue([
        { plan: { id: 201, uuid: 'uuid-child-201' } as never, filePath: null },
        { plan: { id: 200, uuid: 'uuid-parent-200' } as never, filePath: null },
      ]);

      const result = await createPlansFromIssue(7, parentIssue, 'separate', {
        selectedParentContent: [0],
        selectedChildIndices: [0],
        selectedChildContent: { 0: [0] },
      });

      // Should create new plans, not match the merged parent
      expect(result).toEqual({ planUuid: 'uuid-parent-200' });
      expect(reserveImportedPlanStartId).toHaveBeenCalledWith('/tmp/preferred-workspace', 2);
      expect(resolvePlanByNumericId).not.toHaveBeenCalled();
    });

    test('merged mode prefers primary-URL plan over merged parent with same URL', async () => {
      const parentIssue = makeIssue(2, 'Child as parent', {
        body: 'Child body',
        htmlUrl: 'https://tracker.test/issues/2',
      });
      // A merged parent that contains this URL as a secondary entry
      const mergedParentPlan: PlanSchema = {
        id: 50,
        uuid: 'uuid-merged-parent',
        title: 'Old merged parent',
        goal: 'goal',
        details: 'Merged details',
        status: 'pending',
        issue: ['https://tracker.test/issues/1', 'https://tracker.test/issues/2'],
        tasks: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      // A dedicated plan for issue 2 (primary URL match)
      const dedicatedPlan: PlanSchema = {
        id: 60,
        uuid: 'uuid-dedicated-child',
        title: 'Dedicated child plan',
        goal: 'goal',
        details: 'Existing child details',
        status: 'pending',
        issue: ['https://tracker.test/issues/2'],
        tasks: [],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      vi.mocked(loadPlansFromDb).mockReturnValue({
        plans: new Map([
          [50, mergedParentPlan],
          [60, dedicatedPlan],
        ]),
        duplicates: {},
      });
      vi.mocked(resolvePlanByNumericId).mockResolvedValue({
        plan: dedicatedPlan,
        planPath: null,
      });
      vi.mocked(writeImportedPlansToDbTransactionally).mockResolvedValue([
        { plan: { id: 60, uuid: 'uuid-dedicated-child' } as never, filePath: null },
      ]);

      const result = await createPlansFromIssue(7, parentIssue, 'merged', {
        selectedParentContent: [0],
        selectedChildIndices: [],
        selectedChildContent: {},
      });

      // Should update the dedicated plan, not the merged parent
      expect(result).toEqual({ planUuid: 'uuid-dedicated-child' });
      expect(resolvePlanByNumericId).toHaveBeenCalledWith(60, '/tmp/preferred-workspace');
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

    test('uses project-specific tracker availability when a project id is provided', async () => {
      vi.mocked(loadEffectiveConfig).mockResolvedValue({ issueTracker: 'linear' } as never);
      vi.mocked(getAvailableTrackers).mockReturnValue({
        github: false,
        linear: false,
        available: [],
        unavailable: ['github', 'linear'],
      });
      vi.mocked(getAvailableTrackersForProject).mockResolvedValue({
        github: false,
        linear: true,
        available: ['linear'],
        unavailable: ['github'],
      });

      const status = await getIssueTrackerStatus('/tmp/repo', 7);

      expect(getAvailableTrackersForProject).toHaveBeenCalledWith(7);
      expect(status).toEqual({
        available: true,
        trackerType: 'linear',
        displayName: 'Linear',
        supportsHierarchical: true,
      });
    });

    test('prefers the preferred project git root .env for linear availability', async () => {
      vi.mocked(loadEffectiveConfig).mockResolvedValue({ issueTracker: 'linear' } as never);
      vi.mocked(readDotEnvFromDirectory).mockResolvedValue({
        LINEAR_API_KEY: 'preferred-key',
      });
      vi.mocked(getAvailableTrackersForProject).mockResolvedValue({
        github: false,
        linear: false,
        available: [],
        unavailable: ['github', 'linear'],
      });

      const status = await getIssueTrackerStatus('/tmp/repo', 7);

      expect(getPreferredProjectGitRoot).toHaveBeenCalledWith({} as never, 7);
      expect(readDotEnvFromDirectory).toHaveBeenCalledWith('/tmp/preferred-workspace');
      expect(getAvailableTrackersForProject).not.toHaveBeenCalled();
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
