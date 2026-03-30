import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { handleImportCommand } from './import.js';
import { ModuleMocker } from '../../../testing.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PlanSchema } from '../../planSchema.js';
import type {
  IssueTrackerClient,
  IssueWithComments,
  IssueData,
} from '../../../common/issue_tracker/types.js';

const moduleMocker = new ModuleMocker(import.meta);

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

// Mock Linear issue tracker client with hierarchical support
const mockLinearIssueTracker: IssueTrackerClient = {
  fetchIssue: mock(() => Promise.resolve(mockHierarchicalIssue)),
  fetchIssueWithChildren: mock(() => Promise.resolve(mockHierarchicalIssue)),
  fetchAllOpenIssues: mock(() =>
    Promise.resolve([mockParentIssue, mockChildIssue1, mockChildIssue2])
  ),
  parseIssueIdentifier: mock(() => ({ identifier: 'TEAM-123' })),
  getDisplayName: mock(() => 'Linear'),
  getConfig: mock(() => ({ type: 'linear' })),
};

let mockConfig: any;
let gitRootDir: string;
let transactionImmediateSpy: ReturnType<typeof mock>;
let upsertPlanSpy: ReturnType<typeof mock>;

const mockPlansResult = {
  plans: new Map(),
  maxNumericId: 5,
  duplicates: {},
};

describe('Hierarchical Linear Import', () => {
  beforeEach(async () => {
    gitRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-import-hier-'));
    mockConfig = {
      issueTracker: 'linear',
      paths: {
        tasks: 'tasks',
      },
    };

    // Mock all dependencies
    await moduleMocker.mock('../../../common/issue_tracker/factory.js', () => ({
      getIssueTracker: mock(() => Promise.resolve(mockLinearIssueTracker)),
    }));

    await moduleMocker.mock('../../plans.js', () => ({
      writePlanFile: mock(() => Promise.resolve()),
      getMaxNumericPlanId: mock(() => Promise.resolve(5)),
      readPlanFile: mock(() => Promise.resolve({ issue: [] })),
      getImportedIssueUrls: mock(() => Promise.resolve(new Set())),
      resolvePlanFromDb: mock(() =>
        Promise.resolve({
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
        })
      ),
    }));

    transactionImmediateSpy = mock((callback: () => void) => callback());
    upsertPlanSpy = mock(() => ({}));

    await moduleMocker.mock('../../db/database.js', () => ({
      getDatabase: () => ({
        transaction: (callback: () => void) => {
          const wrapped = () => callback();
          wrapped.immediate = () => transactionImmediateSpy(callback);
          return wrapped;
        },
      }),
    }));

    await moduleMocker.mock('../../db/plan.js', () => ({
      upsertPlan: upsertPlanSpy,
    }));

    await moduleMocker.mock('../../db/plan_sync.js', () => ({
      toPlanUpsertInput: mock((plan: PlanSchema) => ({
        planId: plan.id,
        title: plan.title,
        uuid: plan.uuid ?? `uuid-${plan.id}`,
        status: plan.status ?? 'pending',
        epic: false,
        tasks: [],
        dependencyUuids: [],
        tags: [],
      })),
    }));

    await moduleMocker.mock('../../utils/references.js', () => ({
      ensureReferences: mock((plan: PlanSchema) => ({
        updatedPlan: {
          ...plan,
          uuid: plan.uuid ?? `uuid-${plan.id}`,
        },
      })),
    }));

    await moduleMocker.mock('../../plan_materialize.js', () => ({
      resolveProjectContext: mock(() =>
        Promise.resolve({
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
        })
      ),
    }));

    await moduleMocker.mock('../../plans_db.js', () => ({
      loadPlansFromDb: mock(() => mockPlansResult),
    }));

    await moduleMocker.mock('../../assignments/workspace_identifier.js', () => ({
      getRepositoryIdentity: mock(() =>
        Promise.resolve({
          repositoryId: `test-repo-${gitRootDir}`,
          remoteUrl: null,
          gitRoot: gitRootDir,
        })
      ),
    }));

    await moduleMocker.mock('../../configLoader.js', () => ({
      loadEffectiveConfig: mock(() => Promise.resolve(mockConfig)),
    }));

    await moduleMocker.mock('../../../common/git.js', () => ({
      getGitRoot: mock(() => Promise.resolve(gitRootDir)),
    }));

    await moduleMocker.mock('../../../logging.js', () => ({
      log: mock(),
      warn: mock(),
      error: mock(),
    }));

    // Mock the hierarchical selection to return some parent and child content
    await moduleMocker.mock('../../issue_utils.js', () => ({
      getInstructionsFromIssue: mock(() =>
        Promise.resolve({
          suggestedFileName: 'issue-team-123-parent-issue-auth-system.md',
          issue: mockParentIssue,
          plan: mockParentIssue.body,
          rmprOptions: null,
        })
      ),
      createStubPlanFromIssue: mock((issueData, planId) => ({
        id: planId,
        title: issueData.issue.title,
        details: issueData.plan,
        status: 'pending',
        issue: [issueData.issue.html_url || issueData.issue.htmlUrl],
        tasks: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
      getHierarchicalInstructionsFromIssue: mock(() =>
        Promise.resolve({
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
        })
      ),
    }));

    await moduleMocker.mock('../../../common/formatting.js', () => ({
      singleLineWithPrefix: mock((prefix, text) => prefix + text),
      limitLines: mock((text) => text),
    }));

    await moduleMocker.mock('../../../common/comment_options.js', () => ({
      parseCommandOptionsFromComment: mock(() => ({ options: null })),
      combineRmprOptions: mock(() => ({ rmfilter: [] })),
    }));
  });

  afterEach(async () => {
    moduleMocker.clear();
    await fs.rm(gitRootDir, { recursive: true, force: true });
  });

  test('should import Linear issue with children when --with-subissues flag is provided', async () => {
    await handleImportCommand('TEAM-123', { withSubissues: true });

    const { writePlanFile } = await import('../../plans.js');
    const { getHierarchicalInstructionsFromIssue } = await import('../../issue_utils.js');

    // Verify that hierarchical instructions were fetched
    expect(getHierarchicalInstructionsFromIssue).toHaveBeenCalledWith(
      mockLinearIssueTracker,
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
    upsertPlanSpy.mockImplementationOnce(() => ({}));
    upsertPlanSpy.mockImplementationOnce(() => {
      throw new Error('DB write failed');
    });

    const { writePlanFile } = await import('../../plans.js');

    await expect(handleImportCommand('TEAM-123', { withSubissues: true })).rejects.toThrow(
      'DB write failed'
    );

    expect(transactionImmediateSpy.mock.calls.length).toBeGreaterThan(0);
    expect(writePlanFile).not.toHaveBeenCalled();
  });

  test('should import Linear issue with children into one plan when --with-merged-subissues is provided', async () => {
    await handleImportCommand('TEAM-123', { withMergedSubissues: true });

    const { writePlanFile } = await import('../../plans.js');
    const { getHierarchicalInstructionsFromIssue } = await import('../../issue_utils.js');

    expect(getHierarchicalInstructionsFromIssue).toHaveBeenCalledWith(
      mockLinearIssueTracker,
      'TEAM-123',
      false
    );

    expect(writePlanFile).toHaveBeenCalledTimes(1);
    const [planPath, planData] = (writePlanFile as any).mock.calls[0];

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
      ...mockLinearIssueTracker,
      fetchIssueWithChildren: undefined,
    };

    await moduleMocker.mock('../../../common/issue_tracker/factory.js', () => ({
      getIssueTracker: mock(() => Promise.resolve(mockBasicTracker)),
    }));

    await handleImportCommand('TEAM-123', { withSubissues: true });

    const { getInstructionsFromIssue } = await import('../../issue_utils.js');
    const { writePlanFile } = await import('../../plans.js');

    // Should fallback to regular issue instruction fetching
    expect(getInstructionsFromIssue).toHaveBeenCalledWith(mockBasicTracker, 'TEAM-123', false);

    // Should only write 1 file (parent only)
    expect(writePlanFile).toHaveBeenCalledTimes(1);
  });

  test('should show warning when --with-subissues is used with non-Linear tracker', async () => {
    const mockGitHubTracker = {
      ...mockLinearIssueTracker,
      fetchIssueWithChildren: undefined,
      getDisplayName: mock(() => 'GitHub'),
      getConfig: mock(() => ({ type: 'github' })),
    };

    await moduleMocker.mock('../../../common/issue_tracker/factory.js', () => ({
      getIssueTracker: mock(() => Promise.resolve(mockGitHubTracker)),
    }));

    await handleImportCommand('123', { withSubissues: true });

    const { log } = await import('../../../logging.js');
    expect(log).toHaveBeenCalledWith(
      'Warning: --with-subissues flag is only supported for Linear issue tracker. Importing without subissues.'
    );
  });

  test('should show warning when --with-merged-subissues is used with non-Linear tracker', async () => {
    const mockGitHubTracker = {
      ...mockLinearIssueTracker,
      fetchIssueWithChildren: undefined,
      getDisplayName: mock(() => 'GitHub'),
      getConfig: mock(() => ({ type: 'github' })),
    };

    await moduleMocker.mock('../../../common/issue_tracker/factory.js', () => ({
      getIssueTracker: mock(() => Promise.resolve(mockGitHubTracker)),
    }));

    await handleImportCommand('123', { withMergedSubissues: true });

    const { log } = await import('../../../logging.js');
    expect(log).toHaveBeenCalledWith(
      'Warning: --with-merged-subissues flag is only supported for Linear issue tracker. Importing without subissues.'
    );
  });

  test('should provide hierarchical workflow message when --with-subissues is successful', async () => {
    await handleImportCommand('TEAM-123', { withSubissues: true });

    const { log } = await import('../../../logging.js');
    expect(log).toHaveBeenCalledWith(
      'Use "tim generate" to add tasks to these plans, or use "tim agent --next-ready <parent-plan>" for hierarchical workflow.'
    );
  });

  test('should provide merged workflow message when --with-merged-subissues is successful', async () => {
    await handleImportCommand('TEAM-123', { withMergedSubissues: true });

    const { log } = await import('../../../logging.js');
    expect(log).toHaveBeenCalledWith('Use "tim generate" to add tasks to this merged plan.');
  });
});
