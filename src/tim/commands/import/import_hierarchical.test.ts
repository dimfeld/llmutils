import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleImportCommand } from './import.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PlanSchema } from '../../planSchema.js';
import type {
  IssueTrackerClient,
  IssueWithComments,
  IssueData,
} from '../../../common/issue_tracker/types.js';

vi.mock('../../../common/issue_tracker/factory.js', () => ({
  getIssueTracker: vi.fn(),
}));

vi.mock('../../plans.js', () => ({
  writePlanFile: vi.fn(),
  getMaxNumericPlanId: vi.fn(),
  readPlanFile: vi.fn(),
  resolvePlanFromDb: vi.fn(),
}));

vi.mock('../../plans_db.js', () => ({
  loadPlansFromDb: vi.fn(),
}));

vi.mock('../../plan_materialize.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../plan_materialize.js')>();
  return {
    ...actual,
    resolveProjectContext: vi.fn(),
  };
});

vi.mock('../../assignments/workspace_identifier.js', () => ({
  getRepositoryIdentity: vi.fn(),
}));

vi.mock('../../db/database.js', () => ({
  getDatabase: vi.fn(),
}));

vi.mock('../../db/plan.js', () => ({
  upsertPlan: vi.fn(),
}));

vi.mock('../../db/plan_sync.js', () => ({
  toPlanUpsertInput: vi.fn(),
}));

vi.mock('../../utils/references.js', () => ({
  ensureReferences: vi.fn(),
}));

vi.mock('../../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(),
}));

vi.mock('../../../common/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../common/git.js')>();
  return {
    ...actual,
    getGitRoot: vi.fn(),
  };
});

vi.mock('../../../logging.js', () => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../issue_utils.js', () => ({
  getInstructionsFromIssue: vi.fn(),
  createStubPlanFromIssue: vi.fn(),
  getHierarchicalInstructionsFromIssue: vi.fn(),
}));

vi.mock('../../../common/formatting.js', () => ({
  singleLineWithPrefix: vi.fn(),
  limitLines: vi.fn(),
}));

vi.mock('../../../common/comment_options.js', () => ({
  parseCommandOptionsFromComment: vi.fn(),
  combineRmprOptions: vi.fn(),
}));

import { getIssueTracker } from '../../../common/issue_tracker/factory.js';
import {
  writePlanFile,
  getMaxNumericPlanId,
  readPlanFile,
  resolvePlanFromDb,
} from '../../plans.js';
import { loadPlansFromDb } from '../../plans_db.js';
import { resolveProjectContext } from '../../plan_materialize.js';
import { getRepositoryIdentity } from '../../assignments/workspace_identifier.js';
import { getDatabase } from '../../db/database.js';
import { upsertPlan } from '../../db/plan.js';
import { toPlanUpsertInput } from '../../db/plan_sync.js';
import { ensureReferences } from '../../utils/references.js';
import { loadEffectiveConfig } from '../../configLoader.js';
import { getGitRoot } from '../../../common/git.js';
import { log } from '../../../logging.js';
import {
  getInstructionsFromIssue,
  createStubPlanFromIssue,
  getHierarchicalInstructionsFromIssue,
} from '../../issue_utils.js';
import { singleLineWithPrefix, limitLines } from '../../../common/formatting.js';
import {
  parseCommandOptionsFromComment,
  combineRmprOptions,
} from '../../../common/comment_options.js';

// Mock Linear issue with children
const mockParentIssue: IssueData = {
  id: 'TEAM-123',
  number: 'TEAM-123',
  title: 'Parent Issue - Auth System',
  body: 'This is the main authentication system implementation',
  htmlUrl: 'https://linear.app/team/issue/TEAM-123',
  state: 'open',
  createdAt: '2023-01-01T00:00:00Z',
  updatedAt: '2023-01-01T00:00:00Z',
  user: { id: 'user1', login: 'author', name: 'Author' },
  assignees: [],
};

const mockChildIssue1: IssueData = {
  id: 'TEAM-124',
  number: 'TEAM-124',
  title: 'Child Issue - Database Setup',
  body: 'Set up the database schema for authentication',
  htmlUrl: 'https://linear.app/team/issue/TEAM-124',
  state: 'open',
  createdAt: '2023-01-01T00:00:00Z',
  updatedAt: '2023-01-01T00:00:00Z',
  user: { id: 'user1', login: 'author', name: 'Author' },
  assignees: [],
};

const mockChildIssue2: IssueData = {
  id: 'TEAM-125',
  number: 'TEAM-125',
  title: 'Child Issue - API Endpoints',
  body: 'Implement the REST API endpoints for auth',
  htmlUrl: 'https://linear.app/team/issue/TEAM-125',
  state: 'open',
  createdAt: '2023-01-01T00:00:00Z',
  updatedAt: '2023-01-01T00:00:00Z',
  user: { id: 'user1', login: 'author', name: 'Author' },
  assignees: [],
};

const mockHierarchicalIssue: IssueWithComments = {
  issue: mockParentIssue,
  comments: [],
  children: [
    {
      issue: mockChildIssue1,
      comments: [],
    },
    {
      issue: mockChildIssue2,
      comments: [],
    },
  ],
};

let mockConfig: any;
let gitRootDir: string;
let transactionImmediateSpy: ReturnType<typeof vi.fn>;
let upsertPlanSpy: ReturnType<typeof vi.fn>;

const mockPlansResult = {
  plans: new Map(),
  maxNumericId: 5,
  duplicates: {},
};

describe('Hierarchical Linear Import', () => {
  beforeEach(async () => {
    vi.clearAllMocks();

    gitRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-import-hier-'));
    mockConfig = {
      issueTracker: 'linear',
      paths: {
        tasks: 'tasks',
      },
    };

    // Mock Linear issue tracker client with hierarchical support
    const mockLinearIssueTracker: IssueTrackerClient = {
      fetchIssue: vi.fn(() => Promise.resolve(mockHierarchicalIssue)),
      fetchIssueWithChildren: vi.fn(() => Promise.resolve(mockHierarchicalIssue)),
      fetchAllOpenIssues: vi.fn(() =>
        Promise.resolve([mockParentIssue, mockChildIssue1, mockChildIssue2])
      ),
      parseIssueIdentifier: vi.fn(() => ({ identifier: 'TEAM-123' })),
      getDisplayName: vi.fn(() => 'Linear'),
      getConfig: vi.fn(() => ({ type: 'linear' })),
    };

    vi.mocked(getIssueTracker).mockResolvedValue(mockLinearIssueTracker);

    vi.mocked(writePlanFile).mockResolvedValue(undefined);
    vi.mocked(getMaxNumericPlanId).mockResolvedValue(5);
    vi.mocked(readPlanFile).mockResolvedValue({ issue: [] });
    vi.mocked(resolvePlanFromDb).mockResolvedValue({
      plan: {
        id: 6,
        title: 'Existing plan',
        goal: '',
        details: '',
        status: 'pending',
        tasks: [],
        issue: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      planPath: null,
    });

    transactionImmediateSpy = vi.fn((callback: () => void) => callback());
    upsertPlanSpy = vi.mocked(upsertPlan);
    upsertPlanSpy.mockReturnValue({} as any);

    vi.mocked(getDatabase).mockReturnValue({
      transaction: (callback: () => void) => {
        const wrapped = () => callback();
        (wrapped as any).immediate = () => transactionImmediateSpy(callback);
        return wrapped;
      },
    } as any);

    vi.mocked(toPlanUpsertInput).mockImplementation((plan: PlanSchema) => ({
      planId: plan.id,
      title: plan.title,
      uuid: plan.uuid ?? `uuid-${plan.id}`,
      status: plan.status ?? 'pending',
      epic: false,
      tasks: [],
      dependencyUuids: [],
      tags: [],
    }));

    vi.mocked(ensureReferences).mockImplementation((plan: PlanSchema) => ({
      updatedPlan: {
        ...plan,
        uuid: plan.uuid ?? `uuid-${plan.id}`,
      },
    }));

    vi.mocked(resolveProjectContext).mockResolvedValue({
      projectId: 1,
      maxNumericId: 5,
      rows: [],
      planIdToUuid: new Map(),
      uuidToPlanId: new Map(),
      duplicatePlanIds: new Set(),
      repository: {
        repositoryId: `test-repo-${gitRootDir}`,
        remoteUrl: null,
        gitRoot: gitRootDir,
      },
    });

    vi.mocked(loadPlansFromDb).mockReturnValue(mockPlansResult);

    vi.mocked(getRepositoryIdentity).mockResolvedValue({
      repositoryId: `test-repo-${gitRootDir}`,
      remoteUrl: null,
      gitRoot: gitRootDir,
    });

    vi.mocked(loadEffectiveConfig).mockResolvedValue(mockConfig);

    vi.mocked(getGitRoot).mockResolvedValue(gitRootDir);

    vi.mocked(singleLineWithPrefix).mockImplementation((prefix, text) => prefix + text);
    vi.mocked(limitLines).mockImplementation((text) => text);
    vi.mocked(parseCommandOptionsFromComment).mockReturnValue({ options: null });
    vi.mocked(combineRmprOptions).mockReturnValue({ rmfilter: [] });

    // Mock the hierarchical selection
    vi.mocked(getInstructionsFromIssue).mockResolvedValue({
      suggestedFileName: 'issue-team-123-parent-issue-auth-system.md',
      issue: mockParentIssue,
      plan: mockParentIssue.body,
      rmprOptions: null,
    });

    vi.mocked(createStubPlanFromIssue).mockImplementation((issueData, planId) => ({
      id: planId,
      title: issueData.issue.title,
      details: issueData.plan,
      status: 'pending',
      issue: [issueData.issue.html_url || issueData.issue.htmlUrl],
      tasks: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    vi.mocked(getHierarchicalInstructionsFromIssue).mockResolvedValue({
      parentIssue: {
        suggestedFileName: 'issue-team-123-parent-issue-auth-system.md',
        issue: {
          ...mockParentIssue,
          html_url: mockParentIssue.htmlUrl,
        },
        plan: mockParentIssue.body,
        rmprOptions: null,
      },
      childIssues: [
        {
          issueData: {
            suggestedFileName: 'issue-team-124-child-issue-database-setup.md',
            issue: {
              ...mockChildIssue1,
              html_url: mockChildIssue1.htmlUrl,
            },
            plan: mockChildIssue1.body,
            rmprOptions: null,
          },
          selectedContent: [mockChildIssue1.body!],
        },
        {
          issueData: {
            suggestedFileName: 'issue-team-125-child-issue-api-endpoints.md',
            issue: {
              ...mockChildIssue2,
              html_url: mockChildIssue2.htmlUrl,
            },
            plan: mockChildIssue2.body,
            rmprOptions: null,
          },
          selectedContent: [mockChildIssue2.body!],
        },
      ],
    });
  });

  afterEach(async () => {
    await fs.rm(gitRootDir, { recursive: true, force: true });
  });

  test('should import Linear issue with children when --with-subissues flag is provided', async () => {
    await handleImportCommand('TEAM-123', { withSubissues: true });

    // Verify that hierarchical instructions were fetched
    expect(getHierarchicalInstructionsFromIssue).toHaveBeenCalledWith(
      expect.objectContaining({ getDisplayName: expect.any(Function) }),
      'TEAM-123',
      false
    );

    // Plans are written to DB via writeImportedPlansToDbTransactionally, not writePlanFile
    expect(writePlanFile).not.toHaveBeenCalled();
    expect(transactionImmediateSpy.mock.calls.length).toBeGreaterThan(0);
    expect(upsertPlanSpy).toHaveBeenCalledTimes(3);

    // Verify the upsert calls contain the expected plan data
    const upsertCalls = upsertPlanSpy.mock.calls.map((call: any) => call[2]);
    const parentUpsert = upsertCalls.find((u: any) => u.title === 'Parent Issue - Auth System');
    expect(parentUpsert).toBeDefined();
    expect(parentUpsert.planId).toBe(6);

    const child1Upsert = upsertCalls.find((u: any) => u.title === 'Child Issue - Database Setup');
    expect(child1Upsert).toBeDefined();
    expect(child1Upsert.planId).toBe(7);

    const child2Upsert = upsertCalls.find((u: any) => u.title === 'Child Issue - API Endpoints');
    expect(child2Upsert).toBeDefined();
    expect(child2Upsert.planId).toBe(8);
  });

  test('does not write any files if the transactional DB batch fails', async () => {
    upsertPlanSpy.mockReturnValueOnce({} as any);
    upsertPlanSpy.mockImplementationOnce(() => {
      throw new Error('DB write failed');
    });

    await expect(handleImportCommand('TEAM-123', { withSubissues: true })).rejects.toThrow(
      'DB write failed'
    );

    expect(transactionImmediateSpy.mock.calls.length).toBeGreaterThan(0);
    expect(writePlanFile).not.toHaveBeenCalled();
  });

  test('should import Linear issue with children into one plan when --with-merged-subissues is provided', async () => {
    await handleImportCommand('TEAM-123', { withMergedSubissues: true });

    expect(getHierarchicalInstructionsFromIssue).toHaveBeenCalledWith(
      expect.objectContaining({ getDisplayName: expect.any(Function) }),
      'TEAM-123',
      false
    );

    expect(writePlanFile).toHaveBeenCalledTimes(1);
    const [planPath, planData] = vi.mocked(writePlanFile).mock.calls[0];

    expect(planPath).toMatch(/6-issue-team-123-parent-issue-auth-system\.plan\.md$/);
    expect(planData).toMatchObject({
      id: 6,
      title: 'Parent Issue - Auth System',
      issue: [
        'https://linear.app/team/issue/TEAM-123',
        'https://linear.app/team/issue/TEAM-124',
        'https://linear.app/team/issue/TEAM-125',
      ],
    });
    expect(planData.details).toContain('This is the main authentication system implementation');
    expect(planData.details).toContain('## Subissue TEAM-124: Child Issue - Database Setup');
    expect(planData.details).toContain('## Subissue TEAM-125: Child Issue - API Endpoints');
  });

  test('should fallback to regular import when Linear tracker does not support hierarchical fetching', async () => {
    // Mock a tracker without fetchIssueWithChildren
    const mockBasicTracker = {
      fetchIssue: vi.fn(() => Promise.resolve(mockHierarchicalIssue)),
      fetchAllOpenIssues: vi.fn(() =>
        Promise.resolve([mockParentIssue, mockChildIssue1, mockChildIssue2])
      ),
      parseIssueIdentifier: vi.fn(() => ({ identifier: 'TEAM-123' })),
      getDisplayName: vi.fn(() => 'Linear'),
      getConfig: vi.fn(() => ({ type: 'linear' })),
    };

    vi.mocked(getIssueTracker).mockResolvedValue(mockBasicTracker);

    await handleImportCommand('TEAM-123', { withSubissues: true });

    // Should fallback to regular issue instruction fetching
    expect(getInstructionsFromIssue).toHaveBeenCalledWith(mockBasicTracker, 'TEAM-123', false);

    // Should only write 1 file (parent only)
    expect(writePlanFile).toHaveBeenCalledTimes(1);
  });

  test('should show warning when --with-subissues is used with non-Linear tracker', async () => {
    const mockGitHubTracker = {
      fetchIssue: vi.fn(() => Promise.resolve(mockHierarchicalIssue)),
      fetchAllOpenIssues: vi.fn(() => Promise.resolve([])),
      parseIssueIdentifier: vi.fn(() => ({ identifier: '123' })),
      getDisplayName: vi.fn(() => 'GitHub'),
      getConfig: vi.fn(() => ({ type: 'github' })),
    };

    vi.mocked(getIssueTracker).mockResolvedValue(mockGitHubTracker);

    await handleImportCommand('123', { withSubissues: true });

    expect(log).toHaveBeenCalledWith(
      'Warning: --with-subissues flag is only supported for Linear issue tracker. Importing without subissues.'
    );
  });

  test('should show warning when --with-merged-subissues is used with non-Linear tracker', async () => {
    const mockGitHubTracker = {
      fetchIssue: vi.fn(() => Promise.resolve(mockHierarchicalIssue)),
      fetchAllOpenIssues: vi.fn(() => Promise.resolve([])),
      parseIssueIdentifier: vi.fn(() => ({ identifier: '123' })),
      getDisplayName: vi.fn(() => 'GitHub'),
      getConfig: vi.fn(() => ({ type: 'github' })),
    };

    vi.mocked(getIssueTracker).mockResolvedValue(mockGitHubTracker);

    await handleImportCommand('123', { withMergedSubissues: true });

    expect(log).toHaveBeenCalledWith(
      'Warning: --with-merged-subissues flag is only supported for Linear issue tracker. Importing without subissues.'
    );
  });

  test('should provide hierarchical workflow message when --with-subissues is successful', async () => {
    await handleImportCommand('TEAM-123', { withSubissues: true });

    expect(log).toHaveBeenCalledWith(
      'Use "tim generate" to add tasks to these plans, or use "tim agent --next-ready <parent-plan>" for hierarchical workflow.'
    );
  });

  test('should provide merged workflow message when --with-merged-subissues is successful', async () => {
    await handleImportCommand('TEAM-123', { withMergedSubissues: true });

    expect(log).toHaveBeenCalledWith('Use "tim generate" to add tasks to this merged plan.');
  });
});
