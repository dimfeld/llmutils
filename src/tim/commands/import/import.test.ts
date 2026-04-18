import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleImportCommand } from './import.js';
import type { PlanSchema, PlanSchemaInput } from '../../planSchema.js';
import type { IssueTrackerClient, IssueWithComments } from '../../../common/issue_tracker/types.js';

vi.mock('../../issue_utils.js', () => ({
  getInstructionsFromIssue: vi.fn(),
  createStubPlanFromIssue: vi.fn(),
}));

vi.mock('../../../common/issue_tracker/factory.js', () => ({
  getIssueTracker: vi.fn(),
}));

vi.mock('../../plans.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../plans.js')>();
  return {
    ...actual,
    writePlanFile: vi.fn(),
    resolvePlanByNumericId: vi.fn(),
  };
});

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

vi.mock('@inquirer/prompts', () => ({
  checkbox: vi.fn(),
}));

vi.mock('../../../common/comment_options.js', () => ({
  parseCommandOptionsFromComment: vi.fn(),
  combineRmprOptions: vi.fn(),
}));

vi.mock('../../../common/formatting.js', () => ({
  singleLineWithPrefix: vi.fn(),
  limitLines: vi.fn(),
}));

vi.mock('../../assignments/workspace_identifier.js', () => ({
  getRepositoryIdentity: vi.fn(),
}));

import { getInstructionsFromIssue, createStubPlanFromIssue } from '../../issue_utils.js';
import { getIssueTracker } from '../../../common/issue_tracker/factory.js';
import { writePlanFile, resolvePlanByNumericId } from '../../plans.js';
import { loadPlansFromDb } from '../../plans_db.js';
import { resolveProjectContext } from '../../plan_materialize.js';
import { getDatabase } from '../../db/database.js';
import { upsertPlan } from '../../db/plan.js';
import { toPlanUpsertInput } from '../../db/plan_sync.js';
import { ensureReferences } from '../../utils/references.js';
import { loadEffectiveConfig } from '../../configLoader.js';
import { getGitRoot } from '../../../common/git.js';
import { log } from '../../../logging.js';
import { checkbox } from '@inquirer/prompts';
import {
  parseCommandOptionsFromComment,
  combineRmprOptions,
} from '../../../common/comment_options.js';
import { singleLineWithPrefix, limitLines } from '../../../common/formatting.js';
import { getRepositoryIdentity } from '../../assignments/workspace_identifier.js';

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

let mockConfig: any;
let gitRootDir: string;
let transactionImmediateSpy: ReturnType<typeof vi.fn>;
let toPlanUpsertInputSpy: ReturnType<typeof vi.fn>;
let ensureReferencesSpy: ReturnType<typeof vi.fn>;

const mockPlansResult = {
  plans: new Map(),
  maxNumericId: 5,
  duplicates: {},
};
let currentPlansResult = mockPlansResult;

describe('handleImportCommand', () => {
  beforeEach(async () => {
    vi.clearAllMocks();

    gitRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-import-unit-'));
    mockConfig = {
      issueTracker: 'github',
      paths: {
        tasks: 'tasks',
      },
    };

    // Mock issue tracker client
    const mockIssueTracker: IssueTrackerClient = {
      fetchIssue: vi.fn(() => Promise.resolve(mockIssueWithComments)),
      fetchAllOpenIssues: vi.fn(() => Promise.resolve(mockIssues)),
      parseIssueIdentifier: vi.fn(() => ({ identifier: '123' })),
      getDisplayName: vi.fn(() => 'GitHub'),
      getConfig: vi.fn(() => ({ type: 'github' })),
    };

    vi.mocked(getInstructionsFromIssue).mockResolvedValue(mockIssueData);
    vi.mocked(createStubPlanFromIssue).mockReturnValue({
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
    });

    vi.mocked(getIssueTracker).mockResolvedValue(mockIssueTracker);

    vi.mocked(writePlanFile).mockResolvedValue(undefined);
    vi.mocked(resolvePlanByNumericId).mockImplementation((planId: number) => {
      const plan = currentPlansResult.plans.get(planId);
      if (!plan) {
        throw new Error(`No plan found in the database for identifier: ${planId}`);
      }
      return Promise.resolve({
        plan,
        planPath: (plan as any).filename,
      });
    });

    vi.mocked(loadPlansFromDb).mockImplementation(() => currentPlansResult);

    vi.mocked(resolveProjectContext).mockResolvedValue({
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
    });

    transactionImmediateSpy = vi.fn((callback: () => void) => callback());
    vi.mocked(upsertPlan).mockReturnValue({} as any);

    toPlanUpsertInputSpy = vi.mocked(toPlanUpsertInput);
    toPlanUpsertInputSpy.mockImplementation((plan: PlanSchemaInput, filePath: string) => ({
      planId: plan.id,
      uuid: plan.uuid ?? `uuid-${plan.id}`,
      status: plan.status ?? 'pending',
      epic: false,
      filename: path.basename(filePath),
      tasks: [],
      dependencyUuids: [],
      tags: [],
    }));

    ensureReferencesSpy = vi.mocked(ensureReferences);
    ensureReferencesSpy.mockImplementation((plan: PlanSchema) => ({
      updatedPlan: {
        ...plan,
        uuid: plan.uuid ?? `uuid-${plan.id}`,
      },
    }));

    vi.mocked(getDatabase).mockReturnValue({
      transaction: (callback: () => void) => {
        const wrapped = () => callback();
        (wrapped as any).immediate = () => transactionImmediateSpy(callback);
        return wrapped;
      },
    } as any);

    vi.mocked(loadEffectiveConfig).mockResolvedValue(mockConfig);
    vi.mocked(getGitRoot).mockResolvedValue(gitRootDir);
    vi.mocked(checkbox).mockResolvedValue([0, 1]); // Return indices for selected items
    vi.mocked(parseCommandOptionsFromComment).mockReturnValue({ options: null });
    vi.mocked(combineRmprOptions).mockReturnValue({ rmfilter: ['--include', '*.ts'] });
    vi.mocked(singleLineWithPrefix).mockImplementation((prefix, text) => prefix + text);
    vi.mocked(limitLines).mockImplementation((text) => text);
    vi.mocked(getRepositoryIdentity).mockResolvedValue({
      repositoryId: `test-repo-${gitRootDir}`,
      remoteUrl: null,
      gitRoot: gitRootDir,
    });

    currentPlansResult = mockPlansResult;
  });

  afterEach(async () => {
    await fs.rm(gitRootDir, { recursive: true, force: true });
  });

  test('should import a single issue when --issue flag is provided', async () => {
    await handleImportCommand(undefined, { issue: '123' });

    expect(getIssueTracker).toHaveBeenCalledWith(mockConfig);
    expect(vi.mocked(getIssueTracker).mock.results[0].value).resolves.toMatchObject({
      fetchIssue: expect.any(Function),
    });
    expect(writePlanFile).toHaveBeenCalled();
  });

  test('should import a single issue when issue argument is provided', async () => {
    await handleImportCommand('456');

    expect(getIssueTracker).toHaveBeenCalledWith(mockConfig);
    expect(writePlanFile).toHaveBeenCalled();
  });

  test('should enter interactive mode when no issue is specified', async () => {
    // Override the issue tracker to return specific issues for this test
    const testIssueTracker: IssueTrackerClient = {
      fetchIssue: vi.fn(() => Promise.resolve(mockIssueWithComments)),
      fetchAllOpenIssues: vi.fn(() =>
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
      parseIssueIdentifier: vi.fn(() => ({ identifier: '100' })),
      getDisplayName: vi.fn(() => 'GitHub'),
      getConfig: vi.fn(() => ({ type: 'github' })),
    };

    vi.mocked(getIssueTracker).mockResolvedValue(testIssueTracker);

    // Mock the checkbox to return no selections to avoid actual import
    vi.mocked(checkbox).mockResolvedValue([]);

    await handleImportCommand();

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
    const testIssueTracker: IssueTrackerClient = {
      fetchIssue: vi.fn(() => Promise.resolve(mockIssueWithComments)),
      fetchAllOpenIssues: vi.fn(() =>
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
      parseIssueIdentifier: vi.fn(() => ({ identifier: '101' })),
      getDisplayName: vi.fn(() => 'GitHub'),
      getConfig: vi.fn(() => ({ type: 'github' })),
    };

    vi.mocked(getIssueTracker).mockResolvedValue(testIssueTracker);

    // Mock the checkbox to return no selections to avoid actual import
    vi.mocked(checkbox).mockResolvedValue([]);

    await handleImportCommand();

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
    const testIssueTracker: IssueTrackerClient = {
      fetchIssue: vi.fn(() => Promise.resolve(mockIssueWithComments)),
      fetchAllOpenIssues: vi.fn(() =>
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
      parseIssueIdentifier: vi.fn(() => ({ identifier: '100' })),
      getDisplayName: vi.fn(() => 'GitHub'),
      getConfig: vi.fn(() => ({ type: 'github' })),
    };

    vi.mocked(getIssueTracker).mockResolvedValue(testIssueTracker);
    currentPlansResult = mockPlansResult;

    // Mock the checkbox to return selected issues
    let checkboxCall = 0;
    vi.mocked(checkbox).mockImplementation(() => {
      checkboxCall++;
      return Promise.resolve(checkboxCall === 1 ? [100, 101] : []);
    });

    await handleImportCommand();

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
    const testIssueTracker: IssueTrackerClient = {
      fetchIssue: vi.fn(() => Promise.resolve(mockIssueWithComments)),
      fetchAllOpenIssues: vi.fn(() =>
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
      parseIssueIdentifier: vi.fn(() => ({ identifier: '100' })),
      getDisplayName: vi.fn(() => 'GitHub'),
      getConfig: vi.fn(() => ({ type: 'github' })),
    };

    vi.mocked(getIssueTracker).mockResolvedValue(testIssueTracker);
    vi.mocked(checkbox).mockResolvedValue([100, 101]);

    const loadPlansCalls: number[] = [];
    vi.mocked(loadPlansFromDb).mockImplementation(() => {
      loadPlansCalls.push(loadPlansCalls.length + 1);
      return currentPlansResult;
    });

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

    const testIssueTracker: IssueTrackerClient = {
      fetchAllOpenIssues: vi.fn(() =>
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
      fetchIssue: vi.fn((issueNumber: string) =>
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
      parseIssueIdentifier: vi.fn(() => ({ identifier: '100' })),
      getDisplayName: vi.fn(() => 'GitHub'),
      getConfig: vi.fn(() => ({ type: 'github' })),
    };

    vi.mocked(getIssueTracker).mockResolvedValue(testIssueTracker);

    vi.mocked(getInstructionsFromIssue).mockImplementation((_, issueNumber: string) =>
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
    );

    vi.mocked(createStubPlanFromIssue).mockImplementation((issueData, id) => ({
      id,
      title: issueData.issue.title,
      goal: `Implement: ${issueData.issue.title}`,
      details: issueData.plan,
      status: 'pending',
      issue: [issueData.issue.html_url],
      tasks: [],
      createdAt: '2023-01-01T00:00:00.000Z',
      updatedAt: '2023-01-01T00:00:00.000Z',
    }));

    vi.mocked(checkbox).mockResolvedValue([100, 101]);

    vi.mocked(writePlanFile).mockImplementation(
      async (filePath: string | null, plan: PlanSchema) => {
        currentPlansResult = {
          ...currentPlansResult,
          maxNumericId: Math.max(currentPlansResult.maxNumericId, plan.id ?? 0),
          plans: new Map(currentPlansResult.plans).set(plan.id!, {
            ...plan,
            filename:
              filePath ??
              (currentPlansResult.plans.get(plan.id ?? -1) as any)?.filename ??
              path.join(gitRootDir, 'tasks', `${plan.id}-updated.plan.md`),
          } as any),
        };
      }
    );

    await handleImportCommand();

    const persistedPlans = Array.from(currentPlansResult.plans.values());
    expect(persistedPlans).toHaveLength(1);
    expect(persistedPlans[0]?.title).toBe('Canonical issue updated');
    expect(vi.mocked(writePlanFile).mock.calls).toHaveLength(2);
    // Both calls should target the same plan (update, not duplicate)
    expect(vi.mocked(writePlanFile).mock.calls[1]?.[1]?.id).toBe(
      vi.mocked(writePlanFile).mock.calls[0]?.[1]?.id
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
    const testIssueTracker: IssueTrackerClient = {
      fetchIssue: vi.fn(() => Promise.resolve(issueWithComments)),
      fetchAllOpenIssues: vi.fn(() => Promise.resolve(mockIssues)),
      parseIssueIdentifier: vi.fn(() => ({ identifier: '123' })),
      getDisplayName: vi.fn(() => 'GitHub'),
      getConfig: vi.fn(() => ({ type: 'github' })),
    };

    vi.mocked(getIssueTracker).mockResolvedValue(testIssueTracker);

    // Mock checkbox to select the issue body (which will be the first item since it's not in existing details)
    vi.mocked(checkbox).mockResolvedValue([0]); // Select the first item (issue body)

    await handleImportCommand('123');

    expect(getIssueTracker).toHaveBeenCalledWith(mockConfig);
    expect(testIssueTracker.fetchIssue).toHaveBeenCalledWith('123');
    expect(log).toHaveBeenCalledWith(
      'Updating existing plan for issue: https://github.com/owner/repo/issues/123'
    );
    expect(writePlanFile).toHaveBeenCalled();

    const [filePath, planData] = vi.mocked(writePlanFile).mock.calls[0];

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

    expect(getIssueTracker).toHaveBeenCalledWith(mockConfig);
    expect(writePlanFile).toHaveBeenCalled();
    const [filePath, planData] = vi.mocked(writePlanFile).mock.calls[0];

    expect(filePath).toBeNull();
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
    const testIssueTracker: IssueTrackerClient = {
      fetchIssue: vi.fn(() => Promise.resolve(issueWithoutComments)),
      fetchAllOpenIssues: vi.fn(() => Promise.resolve(mockIssues)),
      parseIssueIdentifier: vi.fn(() => ({ identifier: '123' })),
      getDisplayName: vi.fn(() => 'GitHub'),
      getConfig: vi.fn(() => ({ type: 'github' })),
    };

    vi.mocked(getIssueTracker).mockResolvedValue(testIssueTracker);

    await handleImportCommand('123');

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

      vi.mocked(loadEffectiveConfig).mockResolvedValue(githubConfig);

      const mockIssueTracker: IssueTrackerClient = {
        fetchIssue: vi.fn(() => Promise.resolve(mockIssueWithComments)),
        fetchAllOpenIssues: vi.fn(() => Promise.resolve(mockIssues)),
        parseIssueIdentifier: vi.fn(() => ({ identifier: '123' })),
        getDisplayName: vi.fn(() => 'GitHub'),
        getConfig: vi.fn(() => ({ type: 'github' })),
      };
      vi.mocked(getIssueTracker).mockResolvedValue(mockIssueTracker);

      await handleImportCommand('123');

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

      vi.mocked(getInstructionsFromIssue).mockResolvedValue(linearIssueData);
      vi.mocked(createStubPlanFromIssue).mockReturnValue({
        id: 6,
        title: 'Linear Issue',
        goal: 'Implement: Linear Issue',
        details: 'This is a Linear issue description',
        status: 'pending',
        issue: ['https://linear.app/team/issue/TEAM-123'],
        tasks: [],
        createdAt: '2023-01-01T00:00:00.000Z',
        updatedAt: '2023-01-01T00:00:00.000Z',
      });

      vi.mocked(loadEffectiveConfig).mockResolvedValue(linearConfig);

      const mockLinearIssueTracker: IssueTrackerClient = {
        fetchIssue: vi.fn(() =>
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
              author: { login: 'linearuser', name: 'Linear User' },
            },
            comments: [],
          })
        ),
        fetchAllOpenIssues: vi.fn(() =>
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
        parseIssueIdentifier: vi.fn(() => ({ identifier: 'TEAM-123' })),
        getDisplayName: vi.fn(() => 'Linear'),
        getConfig: vi.fn(() => ({ type: 'linear' })),
      };

      vi.mocked(getIssueTracker).mockResolvedValue(mockLinearIssueTracker);

      await handleImportCommand('TEAM-123');

      expect(getIssueTracker).toHaveBeenCalledWith(linearConfig);
      expect(mockLinearIssueTracker.fetchIssue).toHaveBeenCalledWith('TEAM-123');
      expect(writePlanFile).toHaveBeenCalled();

      const [filePath, planData] = vi.mocked(writePlanFile).mock.calls[0];
      expect(filePath).toBeNull();
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
        vi.clearAllMocks();

        const expectedTracker: IssueTrackerClient = {
          fetchIssue: vi.fn(() => Promise.resolve(mockIssueWithComments)),
          fetchAllOpenIssues: vi.fn(() => Promise.resolve([])),
          parseIssueIdentifier: vi.fn(() => ({ identifier: '123' })),
          getDisplayName: vi.fn(() => (config.issueTracker === 'github' ? 'GitHub' : 'Linear')),
          getConfig: vi.fn(() => ({ type: config.issueTracker })),
        };

        vi.mocked(loadEffectiveConfig).mockResolvedValue(config);
        vi.mocked(getIssueTracker).mockResolvedValue(expectedTracker);
        vi.mocked(checkbox).mockResolvedValue([]); // No selections
        vi.mocked(getGitRoot).mockResolvedValue(gitRootDir);
        vi.mocked(parseCommandOptionsFromComment).mockReturnValue({ options: null });
        vi.mocked(combineRmprOptions).mockReturnValue({ rmfilter: [] });
        vi.mocked(singleLineWithPrefix).mockImplementation((prefix, text) => prefix + text);
        vi.mocked(limitLines).mockImplementation((text) => text);
        vi.mocked(loadPlansFromDb).mockReturnValue({
          plans: new Map(),
          maxNumericId: 0,
          duplicates: {},
        });
        vi.mocked(resolveProjectContext).mockResolvedValue({
          projectId: 1,
          maxNumericId: 0,
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
        vi.mocked(getRepositoryIdentity).mockResolvedValue({
          repositoryId: `test-repo-${gitRootDir}`,
          remoteUrl: null,
          gitRoot: gitRootDir,
        });
        vi.mocked(getDatabase).mockReturnValue({
          transaction: (callback: () => void) => {
            const wrapped = () => callback();
            (wrapped as any).immediate = () => callback();
            return wrapped;
          },
        } as any);
        vi.mocked(upsertPlan).mockReturnValue({} as any);
        vi.mocked(toPlanUpsertInput).mockImplementation((plan: any) => ({
          planId: plan.id,
          uuid: plan.uuid ?? `uuid-${plan.id}`,
          status: plan.status ?? 'pending',
          epic: false,
          tasks: [],
          dependencyUuids: [],
          tags: [],
        }));
        vi.mocked(ensureReferences).mockImplementation((plan: any) => ({
          updatedPlan: { ...plan, uuid: plan.uuid ?? `uuid-${plan.id}` },
        }));

        await handleImportCommand();

        expect(getIssueTracker).toHaveBeenCalledWith(config);
        expect(expectedTracker.fetchAllOpenIssues).toHaveBeenCalled();
        expect(log).toHaveBeenCalledWith('Fetching all open issues...');
      }
    });
  });
});
