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

const mockPlansResult = {
  plans: new Map(),
  maxNumericId: 5,
  duplicates: {},
};

describe('Hierarchical Linear Import', () => {
  beforeEach(async () => {
    gitRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-import-hier-'));
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
      readAllPlans: mock(() => Promise.resolve(mockPlansResult)),
      writePlanFile: mock(() => Promise.resolve()),
      getMaxNumericPlanId: mock(() => Promise.resolve(5)),
      readPlanFile: mock(() => Promise.resolve({ issue: [] })),
      getImportedIssueUrls: mock(() => Promise.resolve(new Set())),
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

    await moduleMocker.mock('../../../rmpr/comment_options.js', () => ({
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

    // Should have written 3 files: 1 parent + 2 children
    expect(writePlanFile).toHaveBeenCalledTimes(3);

    const writeCalls = (writePlanFile as any).mock.calls;

    // Check parent plan
    const parentPlanCall = writeCalls.find(
      (call: any) => call[1].title === 'Parent Issue - Auth System'
    );
    expect(parentPlanCall).toBeDefined();
    expect(parentPlanCall[0]).toMatch(/6-issue-team-123-parent-issue-auth-system\.plan\.md$/);
    expect(parentPlanCall[1]).toMatchObject({
      id: 6,
      title: 'Parent Issue - Auth System',
      dependencies: [7, 8], // Child plan IDs
    });

    // Check child plans
    const child1PlanCall = writeCalls.find(
      (call: any) => call[1].title === 'Child Issue - Database Setup'
    );
    expect(child1PlanCall).toBeDefined();
    expect(child1PlanCall[0]).toMatch(/7-issue-team-124-child-issue-database-setup\.plan\.md$/);
    expect(child1PlanCall[1]).toMatchObject({
      id: 7,
      title: 'Child Issue - Database Setup',
      parent: 6, // Parent plan ID
    });

    const child2PlanCall = writeCalls.find(
      (call: any) => call[1].title === 'Child Issue - API Endpoints'
    );
    expect(child2PlanCall).toBeDefined();
    expect(child2PlanCall[0]).toMatch(/8-issue-team-125-child-issue-api-endpoints\.plan\.md$/);
    expect(child2PlanCall[1]).toMatchObject({
      id: 8,
      title: 'Child Issue - API Endpoints',
      parent: 6, // Parent plan ID
    });
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

  test('should provide hierarchical workflow message when --with-subissues is successful', async () => {
    await handleImportCommand('TEAM-123', { withSubissues: true });

    const { log } = await import('../../../logging.js');
    expect(log).toHaveBeenCalledWith(
      'Use "rmplan generate" to add tasks to these plans, or use "rmplan agent --next-ready <parent-plan>" for hierarchical workflow.'
    );
  });
});
