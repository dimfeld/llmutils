import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleImportCommand } from './import.js';
import { ModuleMocker } from '../../../testing.js';
import type { PlanSchema, PlanSchemaInput } from '../../planSchema.js';
import type { IssueTrackerClient, IssueWithComments } from '../../../common/issue_tracker/types.js';

const moduleMocker = new ModuleMocker(import.meta);

// Mock data for testing
const mockIssueData = {
  suggestedFileName: 'issue-123-test-issue.md',
  issue: {
    title: 'Test Issue',
    html_url: 'https://github.com/owner/repo/issues/123',
    number: 123,
  },
  plan: 'This is a test issue description',
  rmprOptions: {
    rmfilter: ['--include', '*.ts'],
  },
};

// Mock issue with comments data for the generic interface
const mockIssueWithComments: IssueWithComments = {
  issue: {
    id: '123',
    number: 123,
    title: 'Test Issue',
    body: 'This is a test issue description',
    htmlUrl: 'https://github.com/owner/repo/issues/123',
    state: 'open',
    createdAt: '2023-01-01T00:00:00Z',
    updatedAt: '2023-01-01T00:00:00Z',
    author: {
      login: 'testuser',
      name: 'Test User',
    },
  },
  comments: [],
};

// Mock issues list for the generic interface
const mockIssues = [
  {
    id: '123',
    number: 123,
    title: 'Test Issue 1',
    htmlUrl: 'https://github.com/owner/repo/issues/123',
    state: 'open',
    createdAt: '2023-01-01T00:00:00Z',
    updatedAt: '2023-01-01T00:00:00Z',
    author: {
      login: 'testuser',
      name: 'Test User',
    },
  },
  {
    id: '456',
    number: 456,
    title: 'Test Issue 2',
    htmlUrl: 'https://github.com/owner/repo/issues/456',
    state: 'open',
    createdAt: '2023-01-01T00:00:00Z',
    updatedAt: '2023-01-01T00:00:00Z',
    author: {
      login: 'testuser2',
      name: 'Test User 2',
    },
  },
];

// Mock issue tracker client
const mockIssueTracker: IssueTrackerClient = {
  fetchIssue: mock(() => Promise.resolve(mockIssueWithComments)),
  fetchAllOpenIssues: mock(() => Promise.resolve(mockIssues)),
  parseIssueIdentifier: mock(() => ({ identifier: '123' })),
  getDisplayName: mock(() => 'GitHub'),
  getConfig: mock(() => ({ type: 'github' })),
};

let mockConfig: any;
let gitRootDir: string;
let transactionImmediateSpy: ReturnType<typeof mock>;
let upsertPlanSpy: ReturnType<typeof mock>;
let toPlanUpsertInputSpy: ReturnType<typeof mock>;
let ensureReferencesSpy: ReturnType<typeof mock>;

const mockPlansResult = {
  plans: new Map(),
  maxNumericId: 5,
  duplicates: {},
};
let currentPlansResult = mockPlansResult;

// Mock Linear issue tracker client
const mockLinearIssueTracker: IssueTrackerClient = {
  fetchIssue: mock(() =>
    Promise.resolve({
      issue: {
        id: 'TEAM-123',
        number: 'TEAM-123',
        title: 'Linear Issue',
        body: 'This is a Linear issue description',
        htmlUrl: 'https://linear.app/team/issue/TEAM-123',
        state: 'open',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-01T00:00:00Z',
        author: {
          login: 'linearuser',
          name: 'Linear User',
        },
      },
      comments: [],
    })
  ),
  fetchAllOpenIssues: mock(() =>
    Promise.resolve([
      {
        id: 'TEAM-100',
        number: 'TEAM-100',
        title: 'Linear Issue 100',
        htmlUrl: 'https://linear.app/team/issue/TEAM-100',
        state: 'open',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-01T00:00:00Z',
        author: { login: 'linearuser', name: 'Linear User' },
      },
    ])
  ),
  parseIssueIdentifier: mock(() => ({ identifier: 'TEAM-123' })),
  getDisplayName: mock(() => 'Linear'),
  getConfig: mock(() => ({ type: 'linear' })),
};

describe('handleImportCommand', () => {
  beforeEach(async () => {
    gitRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-import-unit-'));
    mockConfig = {
      issueTracker: 'github',
      paths: {
        tasks: 'tasks',
      },
    };

    // Mock all the dependencies
    await moduleMocker.mock('../../issue_utils.js', () => ({
      getInstructionsFromIssue: mock(() => Promise.resolve(mockIssueData)),
      createStubPlanFromIssue: mock(() => ({
        id: 6,
        title: 'Test Issue',
        goal: 'Implement: Test Issue',
        details: 'This is a test issue description',
        status: 'pending',
        issue: ['https://github.com/owner/repo/issues/123'],
        tasks: [],
        createdAt: '2023-01-01T00:00:00.000Z',
        updatedAt: '2023-01-01T00:00:00.000Z',
        rmfilter: ['--include', '*.ts'],
      })),
    }));

    await moduleMocker.mock('../../../common/issue_tracker/factory.js', () => ({
      getIssueTracker: mock(() => Promise.resolve(mockIssueTracker)),
    }));

    await moduleMocker.mock('../../plans.js', () => ({
      writePlanFile: mock(() => Promise.resolve()),
      resolvePlanFromDb: mock((planArg: string) => {
        const plan = currentPlansResult.plans.get(Number(planArg));
        if (!plan) {
          throw new Error(`No plan found in the database for identifier: ${planArg}`);
        }

        return Promise.resolve({
          plan,
          planPath: plan.filename,
        });
      }),
    }));

    await moduleMocker.mock('../../plans_db.js', () => ({
      loadPlansFromDb: mock(() => currentPlansResult),
    }));

    await moduleMocker.mock('../../plan_materialize.js', () => ({
      resolveProjectContext: mock(() =>
        Promise.resolve({
          projectId: 1,
          maxNumericId: currentPlansResult.maxNumericId,
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

    transactionImmediateSpy = mock((callback: () => void) => callback());
    upsertPlanSpy = mock(() => ({}));
    toPlanUpsertInputSpy = mock((plan: PlanSchemaInput, filePath: string) => ({
      planId: plan.id,
      uuid: plan.uuid ?? `uuid-${plan.id}`,
      status: plan.status ?? 'pending',
      epic: false,
      filename: path.basename(filePath),
      tasks: [],
      dependencyUuids: [],
      tags: [],
    }));
    ensureReferencesSpy = mock((plan: PlanSchema) => ({
      updatedPlan: {
        ...plan,
        uuid: plan.uuid ?? `uuid-${plan.id}`,
      },
    }));

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
      toPlanUpsertInput: toPlanUpsertInputSpy,
    }));

    await moduleMocker.mock('../../utils/references.js', () => ({
      ensureReferences: ensureReferencesSpy,
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

    await moduleMocker.mock('@inquirer/prompts', () => ({
      checkbox: mock(() => Promise.resolve([0, 1])), // Return indices for selected items
    }));

    await moduleMocker.mock('../../../common/comment_options.js', () => ({
      parseCommandOptionsFromComment: mock(() => ({ options: null })),
      combineRmprOptions: mock(() => ({ rmfilter: ['--include', '*.ts'] })),
    }));

    await moduleMocker.mock('../../../common/formatting.js', () => ({
      singleLineWithPrefix: mock((prefix, text) => prefix + text),
      limitLines: mock((text) => text),
    }));

    currentPlansResult = mockPlansResult;
  });

  afterEach(async () => {
    moduleMocker.clear();
    await fs.rm(gitRootDir, { recursive: true, force: true });
  });

  test('should import a single issue when --issue flag is provided', async () => {
    await handleImportCommand(undefined, { issue: '123' });

    const { getIssueTracker } = await import('../../../common/issue_tracker/factory.js');
    const { writePlanFile } = await import('../../plans.js');

    expect(getIssueTracker).toHaveBeenCalledWith(mockConfig);
    expect(mockIssueTracker.fetchIssue).toHaveBeenCalledWith('123');
    expect(writePlanFile).toHaveBeenCalled();
  });

  test('should import a single issue when issue argument is provided', async () => {
    await handleImportCommand('456');

    const { getIssueTracker } = await import('../../../common/issue_tracker/factory.js');
    const { writePlanFile } = await import('../../plans.js');

    expect(getIssueTracker).toHaveBeenCalledWith(mockConfig);
    expect(mockIssueTracker.fetchIssue).toHaveBeenCalledWith('456');
    expect(writePlanFile).toHaveBeenCalled();
  });

  test('should enter interactive mode when no issue is specified', async () => {
    // Override the issue tracker to return specific issues for this test
    const testIssueTracker = {
      ...mockIssueTracker,
      fetchAllOpenIssues: mock(() =>
        Promise.resolve([
          {
            id: '100',
            number: 100,
            title: 'Issue 100',
            htmlUrl: 'https://github.com/owner/repo/issues/100',
            state: 'open',
            createdAt: '2023-01-01T00:00:00Z',
            updatedAt: '2023-01-01T00:00:00Z',
            author: { login: 'user', name: 'User' },
          },
          {
            id: '101',
            number: 101,
            title: 'Issue 101',
            htmlUrl: 'https://github.com/owner/repo/issues/101',
            state: 'open',
            createdAt: '2023-01-01T00:00:00Z',
            updatedAt: '2023-01-01T00:00:00Z',
            author: { login: 'user', name: 'User' },
          },
        ])
      ),
    };

    await moduleMocker.mock('../../../common/issue_tracker/factory.js', () => ({
      getIssueTracker: mock(() => Promise.resolve(testIssueTracker)),
    }));

    // Mock the checkbox to return no selections to avoid actual import
    await moduleMocker.mock('@inquirer/prompts', () => ({
      checkbox: mock(() => Promise.resolve([])),
    }));

    await handleImportCommand();

    const { getIssueTracker } = await import('../../../common/issue_tracker/factory.js');
    const { log } = await import('../../../logging.js');
    const { checkbox } = await import('@inquirer/prompts');

    expect(getIssueTracker).toHaveBeenCalledWith(mockConfig);
    expect(testIssueTracker.fetchAllOpenIssues).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('Fetching all open issues...');
    expect(log).toHaveBeenCalledWith('Found 2 open issues.');
    expect(checkbox).toHaveBeenCalledWith({
      message: 'Select issues to import:',
      choices: [
        { name: '100: Issue 100', value: 100 },
        { name: '101: Issue 101', value: 101 },
      ],
    });
    expect(log).toHaveBeenCalledWith('No issues selected for import.');
  });

  test('should exclude already imported issues in interactive mode', async () => {
    // Mock data where one issue is already imported
    const mockPlansWithImported = {
      plans: new Map([
        [
          1,
          {
            id: 1,
            goal: 'Imported plan',
            status: 'pending',
            details: 'Already imported',
            issue: ['https://github.com/owner/repo/issues/100'],
            tasks: [],
            filename: '/test/imported-plan.yml',
          },
        ],
      ]),
      maxNumericId: 5,
      duplicates: {},
    };
    currentPlansResult = mockPlansWithImported as typeof mockPlansResult;

    // Override the issue tracker to return specific issues for this test
    const testIssueTracker = {
      ...mockIssueTracker,
      fetchAllOpenIssues: mock(() =>
        Promise.resolve([
          {
            id: '100',
            number: 100,
            title: 'Issue 100',
            htmlUrl: 'https://github.com/owner/repo/issues/100',
            state: 'open',
            createdAt: '2023-01-01T00:00:00Z',
            updatedAt: '2023-01-01T00:00:00Z',
            author: { login: 'user', name: 'User' },
          },
          {
            id: '101',
            number: 101,
            title: 'Issue 101',
            htmlUrl: 'https://github.com/owner/repo/issues/101',
            state: 'open',
            createdAt: '2023-01-01T00:00:00Z',
            updatedAt: '2023-01-01T00:00:00Z',
            author: { login: 'user', name: 'User' },
          },
          {
            id: '102',
            number: 102,
            title: 'Issue 102',
            htmlUrl: 'https://github.com/owner/repo/issues/102',
            state: 'open',
            createdAt: '2023-01-01T00:00:00Z',
            updatedAt: '2023-01-01T00:00:00Z',
            author: { login: 'user', name: 'User' },
          },
        ])
      ),
    };

    await moduleMocker.mock('../../../common/issue_tracker/factory.js', () => ({
      getIssueTracker: mock(() => Promise.resolve(testIssueTracker)),
    }));

    // Mock the checkbox to return no selections to avoid actual import
    await moduleMocker.mock('@inquirer/prompts', () => ({
      checkbox: mock(() => Promise.resolve([])),
    }));

    await handleImportCommand();

    const { getIssueTracker } = await import('../../../common/issue_tracker/factory.js');
    const { log } = await import('../../../logging.js');
    const { checkbox } = await import('@inquirer/prompts');

    expect(getIssueTracker).toHaveBeenCalledWith(mockConfig);
    expect(testIssueTracker.fetchAllOpenIssues).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('Fetching all open issues...');
    expect(log).toHaveBeenCalledWith(
      'Found 3 open issues (1 already imported). Re-importing will update existing plans.'
    );

    // Verify that only non-imported issues are presented as choices
    expect(checkbox).toHaveBeenCalledWith({
      message: 'Select issues to import:',
      choices: [
        { name: '101: Issue 101', value: 101 },
        { name: '102: Issue 102', value: 102 },
      ],
    });
  });

  test('should import selected issues in interactive mode', async () => {
    // Override the issue tracker to return specific issues for this test
    const testIssueTracker = {
      ...mockIssueTracker,
      fetchAllOpenIssues: mock(() =>
        Promise.resolve([
          {
            id: '100',
            number: 100,
            title: 'Issue 100',
            htmlUrl: 'https://github.com/owner/repo/issues/100',
            state: 'open',
            createdAt: '2023-01-01T00:00:00Z',
            updatedAt: '2023-01-01T00:00:00Z',
            author: { login: 'user', name: 'User' },
          },
          {
            id: '101',
            number: 101,
            title: 'Issue 101',
            htmlUrl: 'https://github.com/owner/repo/issues/101',
            state: 'open',
            createdAt: '2023-01-01T00:00:00Z',
            updatedAt: '2023-01-01T00:00:00Z',
            author: { login: 'user', name: 'User' },
          },
        ])
      ),
      fetchIssue: mock(() => Promise.resolve(mockIssueWithComments)),
    };

    await moduleMocker.mock('../../../common/issue_tracker/factory.js', () => ({
      getIssueTracker: mock(() => Promise.resolve(testIssueTracker)),
    }));

    currentPlansResult = mockPlansResult;

    // Mock the checkbox to return selected issues
    let checkboxCall = 0;
    await moduleMocker.mock('@inquirer/prompts', () => ({
      checkbox: mock(() => {
        checkboxCall++;
        return Promise.resolve(checkboxCall === 1 ? [100, 101] : []);
      }),
    }));

    await handleImportCommand();

    const { getIssueTracker } = await import('../../../common/issue_tracker/factory.js');
    const { writePlanFile } = await import('../../plans.js');
    const { log } = await import('../../../logging.js');
    const { checkbox } = await import('@inquirer/prompts');

    // Verify checkbox was called with correct choices
    expect(checkbox).toHaveBeenCalledWith({
      message: 'Select issues to import:',
      choices: [
        { name: '100: Issue 100', value: 100 },
        { name: '101: Issue 101', value: 101 },
      ],
    });

    expect(getIssueTracker).toHaveBeenCalledWith(mockConfig);
    expect(testIssueTracker.fetchAllOpenIssues).toHaveBeenCalled();
    // Verify each selected issue was imported
    expect(testIssueTracker.fetchIssue).toHaveBeenCalledWith('100');
    expect(testIssueTracker.fetchIssue).toHaveBeenCalledWith('101');
    expect(writePlanFile).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith('Importing 2 selected issues...');
    expect(log).toHaveBeenCalledWith('Successfully imported 2 new issues.');
    expect(log).toHaveBeenCalledWith('Use "tim generate" to add tasks to these plans.');
  });

  test('refreshes plan snapshot after each successful interactive import', async () => {
    const testIssueTracker = {
      ...mockIssueTracker,
      fetchAllOpenIssues: mock(() =>
        Promise.resolve([
          {
            id: '100',
            number: 100,
            title: 'Parent issue',
            htmlUrl: 'https://github.com/owner/repo/issues/100',
            state: 'open',
            createdAt: '2023-01-01T00:00:00Z',
            updatedAt: '2023-01-01T00:00:00Z',
            author: { login: 'user', name: 'User' },
          },
          {
            id: '101',
            number: 101,
            title: 'Child issue',
            htmlUrl: 'https://github.com/owner/repo/issues/101',
            state: 'open',
            createdAt: '2023-01-01T00:00:00Z',
            updatedAt: '2023-01-01T00:00:00Z',
            author: { login: 'user', name: 'User' },
          },
        ])
      ),
    };

    await moduleMocker.mock('../../../common/issue_tracker/factory.js', () => ({
      getIssueTracker: mock(() => Promise.resolve(testIssueTracker)),
    }));

    await moduleMocker.mock('@inquirer/prompts', () => ({
      checkbox: mock(() => Promise.resolve([100, 101])),
    }));

    const loadPlansCalls: number[] = [];
    await moduleMocker.mock('../../plans_db.js', () => ({
      loadPlansFromDb: mock(() => {
        loadPlansCalls.push(loadPlansCalls.length + 1);
        return currentPlansResult;
      }),
    }));

    await handleImportCommand();

    expect(loadPlansCalls.length).toBe(3);
  });

  test('uses the refreshed snapshot so a later interactive import updates instead of duplicating', async () => {
    const initialPlans = new Map<number, PlanSchema & { filename: string }>();
    currentPlansResult = {
      plans: initialPlans,
      maxNumericId: 0,
      duplicates: {},
    } as typeof mockPlansResult;

    const testIssueTracker = {
      ...mockIssueTracker,
      fetchAllOpenIssues: mock(() =>
        Promise.resolve([
          {
            id: '100',
            number: 100,
            title: 'Canonical issue',
            htmlUrl: 'https://github.com/owner/repo/issues/100',
            state: 'open',
            createdAt: '2023-01-01T00:00:00Z',
            updatedAt: '2023-01-01T00:00:00Z',
            author: { login: 'user', name: 'User' },
          },
          {
            id: '101',
            number: 101,
            title: 'Alias issue',
            htmlUrl: 'https://github.com/owner/repo/issues/101',
            state: 'open',
            createdAt: '2023-01-01T00:00:00Z',
            updatedAt: '2023-01-01T00:00:00Z',
            author: { login: 'user', name: 'User' },
          },
        ])
      ),
      fetchIssue: mock((issueNumber: string) =>
        Promise.resolve({
          issue: {
            id: issueNumber,
            number: Number(issueNumber),
            title: issueNumber === '100' ? 'Canonical issue' : 'Canonical issue updated',
            body: issueNumber === '100' ? `${issueNumber} body` : undefined,
            htmlUrl: 'https://github.com/owner/repo/issues/100',
            state: 'open',
            createdAt: '2023-01-01T00:00:00Z',
            updatedAt: '2023-01-01T00:00:00Z',
            author: { login: 'user', name: 'User' },
          },
          comments: [],
        } satisfies IssueWithComments)
      ),
    };

    await moduleMocker.mock('../../../common/issue_tracker/factory.js', () => ({
      getIssueTracker: mock(() => Promise.resolve(testIssueTracker)),
    }));

    await moduleMocker.mock('../../issue_utils.js', () => ({
      getInstructionsFromIssue: mock((_, issueNumber: string) =>
        Promise.resolve({
          suggestedFileName:
            issueNumber === '100' ? 'canonical-issue.plan.md' : 'canonical-issue-updated.plan.md',
          issue: {
            title: issueNumber === '100' ? 'Canonical issue' : 'Canonical issue updated',
            html_url: 'https://github.com/owner/repo/issues/100',
            number: Number(issueNumber),
          },
          plan: `${issueNumber} body`,
          rmprOptions: null,
        })
      ),
      createStubPlanFromIssue: mock((issueData, id) => ({
        id,
        title: issueData.issue.title,
        goal: `Implement: ${issueData.issue.title}`,
        details: issueData.plan,
        status: 'pending',
        issue: [issueData.issue.html_url],
        tasks: [],
        createdAt: '2023-01-01T00:00:00.000Z',
        updatedAt: '2023-01-01T00:00:00.000Z',
      })),
    }));

    await moduleMocker.mock('@inquirer/prompts', () => ({
      checkbox: mock(() => Promise.resolve([100, 101])),
    }));

    const { writePlanFile } = await import('../../plans.js');
    (writePlanFile as ReturnType<typeof mock>).mockImplementation(
      async (filePath: string, plan: PlanSchema) => {
        currentPlansResult = {
          ...currentPlansResult,
          maxNumericId: Math.max(currentPlansResult.maxNumericId, plan.id ?? 0),
          plans: new Map(currentPlansResult.plans).set(plan.id!, {
            ...plan,
            filename:
              filePath ??
              currentPlansResult.plans.get(plan.id ?? -1)?.filename ??
              path.join(gitRootDir, 'tasks', `${plan.id}-updated.plan.md`),
          }),
        };
      }
    );

    await handleImportCommand();

    const persistedPlans = Array.from(currentPlansResult.plans.values());
    expect(persistedPlans).toHaveLength(1);
    expect(persistedPlans[0]?.title).toBe('Canonical issue updated');
    expect((writePlanFile as ReturnType<typeof mock>).mock.calls).toHaveLength(2);
    expect((writePlanFile as ReturnType<typeof mock>).mock.calls[1]?.[0]).toBe(
      (writePlanFile as ReturnType<typeof mock>).mock.calls[0]?.[0]
    );
  });

  test('should update existing plan when re-importing an issue', async () => {
    // Mock data where the issue is already imported
    const existingPlan: PlanSchema = {
      id: 3,
      title: 'Old Title',
      goal: 'Implement: Old Title',
      details: 'Old description',
      status: 'in_progress',
      issue: ['https://github.com/owner/repo/issues/123'],
      tasks: [{ id: 1, description: 'Existing task' }],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };

    const mockPlansWithExisting = {
      plans: new Map([
        [
          3,
          { ...existingPlan, filename: path.join(gitRootDir, 'tasks', 'issue-123-test-issue.yml') },
        ],
      ]),
      maxNumericId: 5,
      duplicates: {},
    };
    currentPlansResult = mockPlansWithExisting as typeof mockPlansResult;

    // Create a mock issue with comments for this test
    const issueWithComments: IssueWithComments = {
      issue: {
        id: '123',
        number: 123,
        title: 'Test Issue',
        body: 'This is a test issue description',
        htmlUrl: 'https://github.com/owner/repo/issues/123',
        state: 'open',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-01T00:00:00Z',
        author: { login: 'testuser', name: 'Test User' },
      },
      comments: [
        {
          id: 'comment1',
          body: 'This is a new comment',
          createdAt: '2023-01-01T00:00:00Z',
          updatedAt: '2023-01-01T00:00:00Z',
          user: { login: 'user1', name: 'User 1' },
        },
        {
          id: 'comment2',
          body: 'Old description',
          createdAt: '2023-01-01T00:00:00Z',
          updatedAt: '2023-01-01T00:00:00Z',
          user: { login: 'user2', name: 'User 2' },
        }, // This one is already in details
      ],
    };

    // Override the issue tracker to return the issue with comments
    const testIssueTracker = {
      ...mockIssueTracker,
      fetchIssue: mock(() => Promise.resolve(issueWithComments)),
    };

    await moduleMocker.mock('../../../common/issue_tracker/factory.js', () => ({
      getIssueTracker: mock(() => Promise.resolve(testIssueTracker)),
    }));

    // Mock checkbox to select the issue body (which will be the first item since it's not in existing details)
    await moduleMocker.mock('@inquirer/prompts', () => ({
      checkbox: mock(() => Promise.resolve([0])), // Select the first item (issue body)
    }));

    await handleImportCommand('123');

    const { getIssueTracker } = await import('../../../common/issue_tracker/factory.js');
    const { writePlanFile } = await import('../../plans.js');
    const { log } = await import('../../../logging.js');

    expect(getIssueTracker).toHaveBeenCalledWith(mockConfig);
    expect(testIssueTracker.fetchIssue).toHaveBeenCalledWith('123');
    expect(log).toHaveBeenCalledWith(
      'Updating existing plan for issue: https://github.com/owner/repo/issues/123'
    );
    expect(writePlanFile).toHaveBeenCalled();

    const [filePath, planData] = (writePlanFile as any).mock.calls[0];

    expect(filePath).toBe(path.join(gitRootDir, 'tasks', 'issue-123-test-issue.yml'));
    expect(planData).toMatchObject({
      id: 3, // Preserves existing ID
      title: 'Test Issue', // Updated from issue
      goal: 'Implement: Old Title', // Preserved
      details: 'Old description\n\nThis is a test issue description', // Old details + issue body (since body is not in existing details)
      status: 'in_progress', // Preserved
      issue: ['https://github.com/owner/repo/issues/123'], // Preserved
      tasks: [{ id: 1, description: 'Existing task' }], // Preserved
      createdAt: '2024-01-01T00:00:00Z', // Preserved
    });
    expect(planData.updatedAt).not.toBe('2024-01-01T00:00:00Z'); // Should be updated
    expect(log).toHaveBeenCalledWith('Added 1 new comment(s) to the plan.');
  });

  test('should create stub plan file with correct metadata', async () => {
    await handleImportCommand('123');

    const { getIssueTracker } = await import('../../../common/issue_tracker/factory.js');
    const { writePlanFile } = await import('../../plans.js');

    expect(getIssueTracker).toHaveBeenCalledWith(mockConfig);
    expect(mockIssueTracker.fetchIssue).toHaveBeenCalledWith('123');
    expect(writePlanFile).toHaveBeenCalled();
    const [filePath, planData] = (writePlanFile as any).mock.calls[0];

    expect(path.basename(filePath)).toBe('6-issue-123-test-issue.plan.md');
    expect(planData).toMatchObject({
      id: 6, // maxId + 1
      title: 'Test Issue',
      goal: 'Implement: Test Issue',
      details: 'This is a test issue description',
      status: 'pending',
      issue: ['https://github.com/owner/repo/issues/123'],
      tasks: [],
      rmfilter: ['--include', '*.ts'],
    });
    expect(planData.createdAt).toBeDefined();
    expect(planData.updatedAt).toBeDefined();
  });

  test('should update existing plan when importing duplicate issue', async () => {
    // Setup mock to return a plan with the same issue URL and content already matching the issue
    const mockExistingPlan: PlanSchema & { filename: string } = {
      id: 1,
      title: 'Test Issue', // Same as issue title so no title change
      goal: 'Existing plan',
      details: 'This is a test issue description', // Same as issue body so no new content
      issue: ['https://github.com/owner/repo/issues/123'], // Same URL as mockIssueData
      tasks: [],
      filename: path.join(gitRootDir, 'tasks', 'existing-plan.yml'),
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };

    const mockPlansWithDuplicate = {
      plans: new Map([[1, mockExistingPlan]]),
      maxNumericId: 5,
      duplicates: {},
    };
    currentPlansResult = mockPlansWithDuplicate as typeof mockPlansResult;

    // Create a mock issue without new comments
    const issueWithoutComments: IssueWithComments = {
      issue: {
        id: '123',
        number: 123,
        title: 'Test Issue',
        body: 'This is a test issue description',
        htmlUrl: 'https://github.com/owner/repo/issues/123',
        state: 'open',
        createdAt: '2023-01-01T00:00:00Z',
        updatedAt: '2023-01-01T00:00:00Z',
        author: { login: 'testuser', name: 'Test User' },
      },
      comments: [], // No comments
    };

    // Override the issue tracker
    const testIssueTracker = {
      ...mockIssueTracker,
      fetchIssue: mock(() => Promise.resolve(issueWithoutComments)),
    };

    await moduleMocker.mock('../../../common/issue_tracker/factory.js', () => ({
      getIssueTracker: mock(() => Promise.resolve(testIssueTracker)),
    }));

    await handleImportCommand('123');

    const { getIssueTracker } = await import('../../../common/issue_tracker/factory.js');
    const { writePlanFile } = await import('../../plans.js');
    const { log } = await import('../../../logging.js');

    expect(getIssueTracker).toHaveBeenCalledWith(mockConfig);
    expect(testIssueTracker.fetchIssue).toHaveBeenCalledWith('123');
    expect(writePlanFile).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      'Updating existing plan for issue: https://github.com/owner/repo/issues/123'
    );
    expect(log).toHaveBeenCalledWith(
      'No updates needed for plan 1 - all content is already up to date.'
    );
  });

  describe('Issue Tracker Abstraction', () => {
    test('should work with GitHub issue tracker configuration', async () => {
      const githubConfig = {
        issueTracker: 'github',
        paths: { tasks: 'tasks' },
      };

      await moduleMocker.mock('../../configLoader.js', () => ({
        loadEffectiveConfig: mock(() => Promise.resolve(githubConfig)),
      }));

      await moduleMocker.mock('../../../common/issue_tracker/factory.js', () => ({
        getIssueTracker: mock(() => Promise.resolve(mockIssueTracker)),
      }));

      await handleImportCommand('123');

      const { getIssueTracker } = await import('../../../common/issue_tracker/factory.js');
      expect(getIssueTracker).toHaveBeenCalledWith(githubConfig);
      expect(mockIssueTracker.fetchIssue).toHaveBeenCalledWith('123');
    });

    test('should work with Linear issue tracker configuration', async () => {
      const linearConfig = {
        issueTracker: 'linear',
        paths: { tasks: 'tasks' },
      };

      // Mock Linear-specific issue data
      const linearIssueData = {
        suggestedFileName: 'issue-team-123-linear-issue.md',
        issue: {
          title: 'Linear Issue',
          html_url: 'https://linear.app/team/issue/TEAM-123',
          number: 'TEAM-123',
        },
        plan: 'This is a Linear issue description',
        rmprOptions: null,
      };

      await moduleMocker.mock('../../issue_utils.js', () => ({
        getInstructionsFromIssue: mock(() => Promise.resolve(linearIssueData)),
        createStubPlanFromIssue: mock(() => ({
          id: 6,
          title: 'Linear Issue',
          goal: 'Implement: Linear Issue',
          details: 'This is a Linear issue description',
          status: 'pending',
          issue: ['https://linear.app/team/issue/TEAM-123'],
          tasks: [],
          createdAt: '2023-01-01T00:00:00.000Z',
          updatedAt: '2023-01-01T00:00:00.000Z',
        })),
      }));

      await moduleMocker.mock('../../configLoader.js', () => ({
        loadEffectiveConfig: mock(() => Promise.resolve(linearConfig)),
      }));

      await moduleMocker.mock('../../../common/issue_tracker/factory.js', () => ({
        getIssueTracker: mock(() => Promise.resolve(mockLinearIssueTracker)),
      }));

      await handleImportCommand('TEAM-123');

      const { getIssueTracker } = await import('../../../common/issue_tracker/factory.js');
      const { writePlanFile } = await import('../../plans.js');

      expect(getIssueTracker).toHaveBeenCalledWith(linearConfig);
      expect(mockLinearIssueTracker.fetchIssue).toHaveBeenCalledWith('TEAM-123');
      expect(writePlanFile).toHaveBeenCalled();

      const [filePath, planData] = (writePlanFile as any).mock.calls[0];
      expect(path.basename(filePath)).toBe('6-issue-team-123-linear-issue.plan.md');
      expect(planData).toMatchObject({
        id: 6,
        title: 'Linear Issue',
        issue: ['https://linear.app/team/issue/TEAM-123'],
      });
    });

    test('should handle both GitHub and Linear issues in interactive mode', async () => {
      // Test that the factory returns the correct tracker based on config
      const configs = [
        { issueTracker: 'github', paths: { tasks: 'tasks' } },
        { issueTracker: 'linear', paths: { tasks: 'tasks' } },
      ];

      for (const config of configs) {
        const expectedTracker =
          config.issueTracker === 'github' ? mockIssueTracker : mockLinearIssueTracker;

        await moduleMocker.mock('../../configLoader.js', () => ({
          loadEffectiveConfig: mock(() => Promise.resolve(config)),
        }));

        await moduleMocker.mock('../../../common/issue_tracker/factory.js', () => ({
          getIssueTracker: mock(() => Promise.resolve(expectedTracker)),
        }));

        await moduleMocker.mock('@inquirer/prompts', () => ({
          checkbox: mock(() => Promise.resolve([])), // No selections
        }));

        await handleImportCommand();

        const { getIssueTracker } = await import('../../../common/issue_tracker/factory.js');
        const { log } = await import('../../../logging.js');

        expect(getIssueTracker).toHaveBeenCalledWith(config);
        expect(expectedTracker.fetchAllOpenIssues).toHaveBeenCalled();
        expect(log).toHaveBeenCalledWith('Fetching all open issues...');
      }
    });
  });
});
