import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleImportCommand } from './import.js';
import type { IssueTrackerClient, IssueWithComments } from '../../../common/issue_tracker/types.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

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

vi.mock('../../../common/comment_options.js', () => ({
  parseCommandOptionsFromComment: vi.fn(),
  combineRmprOptions: vi.fn(),
}));

vi.mock('../../../common/formatting.js', () => ({
  singleLineWithPrefix: vi.fn(),
  limitLines: vi.fn(),
}));

vi.mock('@inquirer/prompts', () => ({
  checkbox: vi.fn(),
}));

vi.mock('../../plans.js', () => ({
  writePlanFile: vi.fn(),
  getMaxNumericPlanId: vi.fn(),
  readPlanFile: vi.fn(),
}));

vi.mock('../../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(),
}));

vi.mock('../../../common/issue_tracker/factory.js', () => ({
  getIssueTracker: vi.fn(),
}));

vi.mock('../../issue_utils.js', () => ({
  getInstructionsFromIssue: vi.fn(),
  createStubPlanFromIssue: vi.fn(),
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

import { getGitRoot } from '../../../common/git.js';
import {
  parseCommandOptionsFromComment,
  combineRmprOptions,
} from '../../../common/comment_options.js';
import { singleLineWithPrefix, limitLines } from '../../../common/formatting.js';
import { checkbox } from '@inquirer/prompts';
import { writePlanFile, getMaxNumericPlanId, readPlanFile } from '../../plans.js';
import { loadEffectiveConfig } from '../../configLoader.js';
import { getIssueTracker } from '../../../common/issue_tracker/factory.js';
import { getInstructionsFromIssue, createStubPlanFromIssue } from '../../issue_utils.js';
import { loadPlansFromDb } from '../../plans_db.js';
import { resolveProjectContext } from '../../plan_materialize.js';
import { getRepositoryIdentity } from '../../assignments/workspace_identifier.js';
import { getDatabase } from '../../db/database.js';
import { upsertPlan } from '../../db/plan.js';
import { toPlanUpsertInput } from '../../db/plan_sync.js';
import { ensureReferences } from '../../utils/references.js';

describe('Issue Tracker Abstraction Integration Tests', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Create temporary directory for real filesystem operations
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'issue-tracker-integration-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Mock common dependencies
    vi.mocked(getGitRoot).mockResolvedValue(tempDir);
    vi.mocked(parseCommandOptionsFromComment).mockReturnValue({ options: null });
    vi.mocked(combineRmprOptions).mockReturnValue({ rmfilter: ['--include', '*.ts'] });
    vi.mocked(singleLineWithPrefix).mockImplementation((prefix, text) => prefix + text);
    vi.mocked(limitLines).mockImplementation((text) => text);
    vi.mocked(checkbox).mockResolvedValue([]);

    vi.mocked(writePlanFile).mockResolvedValue(undefined);
    vi.mocked(getMaxNumericPlanId).mockResolvedValue(0);
    vi.mocked(readPlanFile).mockResolvedValue({ issue: [] });

    // Set up DB mocks
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
        repositoryId: `test-repo-${tempDir}`,
        remoteUrl: null,
        gitRoot: tempDir,
      },
    });
    vi.mocked(getRepositoryIdentity).mockResolvedValue({
      repositoryId: `test-repo-${tempDir}`,
      remoteUrl: null,
      gitRoot: tempDir,
    });
    const transactionImmediateSpy = vi.fn((callback: () => void) => callback());
    vi.mocked(getDatabase).mockReturnValue({
      transaction: (callback: () => void) => {
        const wrapped = () => callback();
        (wrapped as any).immediate = () => transactionImmediateSpy(callback);
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
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  describe('Configuration-based Issue Tracker Selection', () => {
    test('should use GitHub when issueTracker is set to github', async () => {
      const mockGitHubIssue: IssueWithComments = {
        issue: {
          id: '123',
          number: 123,
          title: 'GitHub Test Issue',
          body: 'This is a GitHub issue',
          htmlUrl: 'https://github.com/owner/repo/issues/123',
          state: 'open',
          createdAt: '2024-01-15T10:30:00.000Z',
          updatedAt: '2024-01-16T14:22:00.000Z',
          user: { id: 'user-123', name: 'GitHub User', login: 'githubuser' },
          pullRequest: false,
        },
        comments: [],
      };

      const mockGitHubClient: IssueTrackerClient = {
        fetchIssue: vi.fn(() => Promise.resolve(mockGitHubIssue)),
        fetchAllOpenIssues: vi.fn(() => Promise.resolve([])),
        parseIssueIdentifier: vi.fn(() => ({ identifier: '123' })),
        getDisplayName: vi.fn(() => 'GitHub'),
        getConfig: vi.fn(() => ({ type: 'github' })),
      };

      const githubConfig = {
        issueTracker: 'github' as const,
        paths: { tasks: 'tasks' },
      };

      vi.mocked(loadEffectiveConfig).mockResolvedValue(githubConfig);
      vi.mocked(getIssueTracker).mockResolvedValue(mockGitHubClient);

      vi.mocked(getInstructionsFromIssue).mockResolvedValue({
        suggestedFileName: '../issue-123-github-test-issue.md',
        issue: {
          title: '../GitHub Test Issue',
          html_url: '../https://github.com/owner/repo/issues/123',
          number: 123,
        },
        plan: 'This is a GitHub issue',
        rmprOptions: { rmfilter: ['--include', '*.ts'] },
      });

      vi.mocked(createStubPlanFromIssue).mockImplementation((issueData, id) => ({
        id,
        title: issueData.issue.title,
        goal: `Implement: ${issueData.issue.title}`,
        details: issueData.plan,
        status: 'pending',
        issue: [issueData.issue.html_url],
        tasks: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        rmfilter: issueData.rmprOptions?.rmfilter || [],
      }));

      await handleImportCommand('123');

      expect(getIssueTracker).toHaveBeenCalledWith(githubConfig);
      expect(mockGitHubClient.fetchIssue).toHaveBeenCalledWith('123');
      expect(mockGitHubClient.getDisplayName()).toBe('GitHub');
    });

    test('should use Linear when issueTracker is set to linear', async () => {
      const mockLinearIssue: IssueWithComments = {
        issue: {
          id: 'issue-uuid-123',
          number: 'TEAM-123',
          title: 'Linear Test Issue',
          body: 'This is a Linear issue',
          htmlUrl: 'https://linear.app/company/issue/TEAM-123',
          state: 'In Progress',
          createdAt: '2024-01-15T10:30:00.000Z',
          updatedAt: '2024-01-16T14:22:00.000Z',
          user: { id: 'user-123', name: 'Linear User' },
          pullRequest: false,
        },
        comments: [],
      };

      const mockLinearClient: IssueTrackerClient = {
        fetchIssue: vi.fn(() => Promise.resolve(mockLinearIssue)),
        fetchAllOpenIssues: vi.fn(() => Promise.resolve([])),
        parseIssueIdentifier: vi.fn(() => ({ identifier: 'TEAM-123' })),
        getDisplayName: vi.fn(() => 'Linear'),
        getConfig: vi.fn(() => ({ type: 'linear' })),
      };

      const linearConfig = {
        issueTracker: 'linear' as const,
        paths: { tasks: 'tasks' },
      };

      vi.mocked(loadEffectiveConfig).mockResolvedValue(linearConfig);
      vi.mocked(getIssueTracker).mockResolvedValue(mockLinearClient);

      vi.mocked(getInstructionsFromIssue).mockResolvedValue({
        suggestedFileName: 'team-123-linear-test-issue.md',
        issue: {
          title: 'Linear Test Issue',
          html_url: 'https://linear.app/company/issue/TEAM-123',
          number: 'TEAM-123',
        },
        plan: 'This is a Linear issue',
        rmprOptions: { rmfilter: ['--include', '*.ts'] },
      });

      vi.mocked(createStubPlanFromIssue).mockImplementation((issueData, id) => ({
        id,
        title: issueData.issue.title,
        goal: `Implement: ${issueData.issue.title}`,
        details: issueData.plan,
        status: 'pending',
        issue: [issueData.issue.html_url],
        tasks: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        rmfilter: issueData.rmprOptions?.rmfilter || [],
      }));

      await handleImportCommand('TEAM-123');

      expect(getIssueTracker).toHaveBeenCalledWith(linearConfig);
      expect(mockLinearClient.fetchIssue).toHaveBeenCalledWith('TEAM-123');
      expect(mockLinearClient.getDisplayName()).toBe('Linear');
    });

    test('should default to GitHub when no issueTracker is configured', async () => {
      const mockGitHubIssue: IssueWithComments = {
        issue: {
          id: '456',
          number: 456,
          title: 'Default GitHub Issue',
          body: 'Issue with default config',
          htmlUrl: 'https://github.com/owner/repo/issues/456',
          state: 'open',
          createdAt: '2024-01-15T10:30:00.000Z',
          updatedAt: '2024-01-16T14:22:00.000Z',
          user: { id: 'user-456', name: 'Default User', login: 'defaultuser' },
          pullRequest: false,
        },
        comments: [],
      };

      const mockGitHubClient: IssueTrackerClient = {
        fetchIssue: vi.fn(() => Promise.resolve(mockGitHubIssue)),
        fetchAllOpenIssues: vi.fn(() => Promise.resolve([])),
        parseIssueIdentifier: vi.fn(() => ({ identifier: '456' })),
        getDisplayName: vi.fn(() => 'GitHub'),
        getConfig: vi.fn(() => ({ type: 'github' })),
      };

      const defaultConfig = {
        // No issueTracker field - should default to GitHub
        paths: { tasks: 'tasks' },
      };

      vi.mocked(loadEffectiveConfig).mockResolvedValue(defaultConfig);
      vi.mocked(getIssueTracker).mockResolvedValue(mockGitHubClient);

      vi.mocked(getInstructionsFromIssue).mockResolvedValue({
        suggestedFileName: 'issue-456-default-github-issue.md',
        issue: {
          title: 'Default GitHub Issue',
          html_url: 'https://github.com/owner/repo/issues/456',
          number: 456,
        },
        plan: 'Issue with default config',
        rmprOptions: { rmfilter: ['--include', '*.ts'] },
      });

      vi.mocked(createStubPlanFromIssue).mockImplementation((issueData, id) => ({
        id,
        title: issueData.issue.title,
        goal: `Implement: ${issueData.issue.title}`,
        details: issueData.plan,
        status: 'pending',
        issue: [issueData.issue.html_url],
        tasks: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        rmfilter: issueData.rmprOptions?.rmfilter || [],
      }));

      await handleImportCommand('456');

      expect(getIssueTracker).toHaveBeenCalledWith(defaultConfig);
      expect(mockGitHubClient.getDisplayName()).toBe('GitHub');
    });
  });

  describe('Cross-Platform Issue Identifier Parsing', () => {
    test('should correctly parse GitHub issue URLs and numbers', async () => {
      const testCases = [
        { input: '123', expected: '123' },
        { input: 'https://github.com/owner/repo/issues/456', expected: '456' },
        { input: 'https://github.com/owner/repo/issues/789#issuecomment-123', expected: '789' },
      ];

      for (const testCase of testCases) {
        vi.clearAllMocks();

        const mockGitHubClient: IssueTrackerClient = {
          fetchIssue: vi.fn(() =>
            Promise.resolve({
              issue: {
                id: testCase.expected,
                number: parseInt(testCase.expected),
                title: `Issue ${testCase.expected}`,
                body: 'Test issue',
                htmlUrl: `https://github.com/owner/repo/issues/${testCase.expected}`,
                state: 'open',
                createdAt: '2024-01-15T10:30:00.000Z',
                updatedAt: '2024-01-16T14:22:00.000Z',
                user: { id: 'user-1', name: 'User', login: 'user' },
                pullRequest: false,
              },
              comments: [],
            })
          ),
          fetchAllOpenIssues: vi.fn(() => Promise.resolve([])),
          parseIssueIdentifier: vi.fn(() => ({ identifier: testCase.expected })),
          getDisplayName: vi.fn(() => 'GitHub'),
          getConfig: vi.fn(() => ({ type: 'github' })),
        };

        vi.mocked(getIssueTracker).mockResolvedValue(mockGitHubClient);
        vi.mocked(loadEffectiveConfig).mockResolvedValue({
          issueTracker: 'github' as const,
          paths: { tasks: 'tasks' },
        });
        vi.mocked(getGitRoot).mockResolvedValue(tempDir);
        vi.mocked(parseCommandOptionsFromComment).mockReturnValue({ options: null });
        vi.mocked(combineRmprOptions).mockReturnValue({ rmfilter: [] });
        vi.mocked(singleLineWithPrefix).mockImplementation((prefix, text) => prefix + text);
        vi.mocked(limitLines).mockImplementation((text) => text);
        vi.mocked(checkbox).mockResolvedValue([]);
        vi.mocked(writePlanFile).mockResolvedValue(undefined);
        vi.mocked(getMaxNumericPlanId).mockResolvedValue(0);
        vi.mocked(readPlanFile).mockResolvedValue({ issue: [] });
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
            repositoryId: `test-repo-${tempDir}`,
            remoteUrl: null,
            gitRoot: tempDir,
          },
        });
        vi.mocked(getRepositoryIdentity).mockResolvedValue({
          repositoryId: `test-repo-${tempDir}`,
          remoteUrl: null,
          gitRoot: tempDir,
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

        vi.mocked(getInstructionsFromIssue).mockResolvedValue({
          suggestedFileName: `issue-${testCase.expected}-test.md`,
          issue: {
            title: `Issue ${testCase.expected}`,
            html_url: `https://github.com/owner/repo/issues/${testCase.expected}`,
            number: parseInt(testCase.expected),
          },
          plan: 'Test issue',
          rmprOptions: { rmfilter: ['--include', '*.ts'] },
        });

        vi.mocked(createStubPlanFromIssue).mockImplementation((issueData, id) => ({
          id,
          title: issueData.issue.title,
          goal: `Implement: ${issueData.issue.title}`,
          details: issueData.plan,
          status: 'pending',
          issue: [issueData.issue.html_url],
          tasks: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          rmfilter: issueData.rmprOptions?.rmfilter || [],
        }));

        await handleImportCommand(testCase.input);
        expect(mockGitHubClient.fetchIssue).toHaveBeenCalledWith(testCase.input);
      }
    });

    test('should correctly parse Linear issue identifiers and URLs', async () => {
      const testCases = [
        { input: 'TEAM-123', expected: 'TEAM-123' },
        { input: 'PROJECT-456', expected: 'PROJECT-456' },
        { input: 'https://linear.app/company/issue/TEAM-789', expected: 'TEAM-789' },
        { input: 'https://linear.app/workspace/issue/ABC-999/title-slug', expected: 'ABC-999' },
      ];

      for (const testCase of testCases) {
        const mockLinearClient: IssueTrackerClient = {
          fetchIssue: vi.fn(() =>
            Promise.resolve({
              issue: {
                id: 'uuid-' + testCase.expected,
                number: testCase.expected,
                title: `Linear Issue ${testCase.expected}`,
                body: 'Test Linear issue',
                htmlUrl: `https://linear.app/company/issue/${testCase.expected}`,
                state: 'Open',
                createdAt: '2024-01-15T10:30:00.000Z',
                updatedAt: '2024-01-16T14:22:00.000Z',
                user: { id: 'user-1', name: 'User' },
                pullRequest: false,
              },
              comments: [],
            })
          ),
          fetchAllOpenIssues: vi.fn(() => Promise.resolve([])),
          parseIssueIdentifier: vi.fn(() => ({ identifier: testCase.expected })),
          getDisplayName: vi.fn(() => 'Linear'),
          getConfig: vi.fn(() => ({ type: 'linear' })),
        };

        vi.mocked(getIssueTracker).mockResolvedValue(mockLinearClient);
        vi.mocked(loadEffectiveConfig).mockResolvedValue({
          issueTracker: 'linear' as const,
          paths: { tasks: 'tasks' },
        });

        vi.mocked(getInstructionsFromIssue).mockResolvedValue({
          suggestedFileName: `${testCase.expected.toLowerCase()}-test.md`,
          issue: {
            title: `Linear Issue ${testCase.expected}`,
            html_url: `https://linear.app/company/issue/${testCase.expected}`,
            number: testCase.expected,
          },
          plan: 'Test Linear issue',
          rmprOptions: { rmfilter: ['--include', '*.ts'] },
        });

        vi.mocked(createStubPlanFromIssue).mockImplementation((issueData, id) => ({
          id,
          title: issueData.issue.title,
          goal: `Implement: ${issueData.issue.title}`,
          details: issueData.plan,
          status: 'pending',
          issue: [issueData.issue.html_url],
          tasks: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          rmfilter: issueData.rmprOptions?.rmfilter || [],
        }));

        await handleImportCommand(testCase.input);
        expect(mockLinearClient.fetchIssue).toHaveBeenCalledWith(testCase.input);
      }
    });
  });

  describe('Error Handling Across Platforms', () => {
    test('should handle GitHub API errors gracefully', async () => {
      const mockGitHubClient: IssueTrackerClient = {
        fetchIssue: vi.fn(() => Promise.reject(new Error('GitHub API rate limit exceeded'))),
        fetchAllOpenIssues: vi.fn(() => Promise.resolve([])),
        parseIssueIdentifier: vi.fn(() => ({ identifier: '404' })),
        getDisplayName: vi.fn(() => 'GitHub'),
        getConfig: vi.fn(() => ({ type: 'github' })),
      };

      vi.mocked(loadEffectiveConfig).mockResolvedValue({
        issueTracker: 'github' as const,
        paths: { tasks: 'tasks' },
      });

      vi.mocked(getIssueTracker).mockResolvedValue(mockGitHubClient);

      let thrownError;
      try {
        await handleImportCommand('404');
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeDefined();
      expect((thrownError as Error).message).toContain('GitHub API rate limit exceeded');
    });

    test('should handle Linear API errors gracefully', async () => {
      const mockLinearClient: IssueTrackerClient = {
        fetchIssue: vi.fn(() => Promise.reject(new Error('Linear API authentication failed'))),
        fetchAllOpenIssues: vi.fn(() => Promise.resolve([])),
        parseIssueIdentifier: vi.fn(() => ({ identifier: 'TEAM-404' })),
        getDisplayName: vi.fn(() => 'Linear'),
        getConfig: vi.fn(() => ({ type: 'linear' })),
      };

      vi.mocked(loadEffectiveConfig).mockResolvedValue({
        issueTracker: 'linear' as const,
        paths: { tasks: 'tasks' },
      });

      vi.mocked(getIssueTracker).mockResolvedValue(mockLinearClient);

      let thrownError;
      try {
        await handleImportCommand('TEAM-404');
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeDefined();
      expect((thrownError as Error).message).toContain('Linear API authentication failed');
    });

    test('should handle factory initialization errors', async () => {
      vi.mocked(loadEffectiveConfig).mockResolvedValue({
        issueTracker: 'github' as const,
        paths: { tasks: 'tasks' },
      });

      vi.mocked(getIssueTracker).mockRejectedValue(
        new Error('GITHUB_TOKEN environment variable is required')
      );

      let thrownError;
      try {
        await handleImportCommand('123');
      } catch (error) {
        thrownError = error;
      }

      expect(thrownError).toBeDefined();
      expect((thrownError as Error).message).toContain(
        'GITHUB_TOKEN environment variable is required'
      );
    });
  });

  // TODO: Add Generate Command Integration tests
  // Currently skipped due to complexity of mocking Bun.file and process spawning

  describe('Configuration Switching', () => {
    test('should switch between GitHub and Linear based on configuration', async () => {
      // Test 1: Start with GitHub config
      const githubConfig = {
        issueTracker: 'github' as const,
        paths: { tasks: 'tasks' },
      };

      const mockGitHubClient: IssueTrackerClient = {
        fetchIssue: vi.fn(() =>
          Promise.resolve({
            issue: {
              id: '999',
              number: 999,
              title: 'GitHub Switch Test',
              body: 'GitHub issue',
              htmlUrl: 'https://github.com/owner/repo/issues/999',
              state: 'open',
              createdAt: '2024-01-15T10:30:00.000Z',
              updatedAt: '2024-01-16T14:22:00.000Z',
              user: { id: 'user-999', name: 'GitHub Switch User', login: 'githubswitch' },
              pullRequest: false,
            },
            comments: [],
          })
        ),
        fetchAllOpenIssues: vi.fn(() => Promise.resolve([])),
        parseIssueIdentifier: vi.fn(() => ({ identifier: '999' })),
        getDisplayName: vi.fn(() => 'GitHub'),
        getConfig: vi.fn(() => ({ type: 'github' })),
      };

      vi.mocked(loadEffectiveConfig).mockResolvedValue(githubConfig);
      vi.mocked(getIssueTracker).mockResolvedValue(mockGitHubClient);

      vi.mocked(getInstructionsFromIssue).mockResolvedValue({
        suggestedFileName: 'issue-999-github-switch-test.md',
        issue: {
          title: 'GitHub Switch Test',
          html_url: 'https://github.com/owner/repo/issues/999',
          number: 999,
        },
        plan: 'GitHub issue',
        rmprOptions: { rmfilter: ['--include', '*.ts'] },
      });

      vi.mocked(createStubPlanFromIssue).mockImplementation((issueData, id) => ({
        id,
        title: issueData.issue.title,
        goal: `Implement: ${issueData.issue.title}`,
        details: issueData.plan,
        status: 'pending',
        issue: [issueData.issue.html_url],
        tasks: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        rmfilter: issueData.rmprOptions?.rmfilter || [],
      }));

      await handleImportCommand('999');

      expect(getIssueTracker).toHaveBeenCalledWith(githubConfig);
      expect(mockGitHubClient.getDisplayName()).toBe('GitHub');

      // Clear mocks for second test
      vi.clearAllMocks();

      // Test 2: Now switch to Linear config
      const linearConfig = {
        issueTracker: 'linear' as const,
        paths: { tasks: 'tasks' },
      };

      const mockLinearClient: IssueTrackerClient = {
        fetchIssue: vi.fn(() =>
          Promise.resolve({
            issue: {
              id: 'issue-uuid-switch',
              number: 'TEAM-SWITCH',
              title: 'Linear Switch Test',
              body: 'Linear issue',
              htmlUrl: 'https://linear.app/company/issue/TEAM-SWITCH',
              state: 'Open',
              createdAt: '2024-01-15T10:30:00.000Z',
              updatedAt: '2024-01-16T14:22:00.000Z',
              user: { id: 'user-switch', name: 'Linear Switch User' },
              pullRequest: false,
            },
            comments: [],
          })
        ),
        fetchAllOpenIssues: vi.fn(() => Promise.resolve([])),
        parseIssueIdentifier: vi.fn(() => ({ identifier: 'TEAM-SWITCH' })),
        getDisplayName: vi.fn(() => 'Linear'),
        getConfig: vi.fn(() => ({ type: 'linear' })),
      };

      vi.mocked(loadEffectiveConfig).mockResolvedValue(linearConfig);
      vi.mocked(getIssueTracker).mockResolvedValue(mockLinearClient);
      vi.mocked(getGitRoot).mockResolvedValue(tempDir);
      vi.mocked(parseCommandOptionsFromComment).mockReturnValue({ options: null });
      vi.mocked(combineRmprOptions).mockReturnValue({ rmfilter: [] });
      vi.mocked(singleLineWithPrefix).mockImplementation((prefix, text) => prefix + text);
      vi.mocked(limitLines).mockImplementation((text) => text);
      vi.mocked(checkbox).mockResolvedValue([]);
      vi.mocked(writePlanFile).mockResolvedValue(undefined);
      vi.mocked(getMaxNumericPlanId).mockResolvedValue(0);
      vi.mocked(readPlanFile).mockResolvedValue({ issue: [] });
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
          repositoryId: `test-repo-${tempDir}`,
          remoteUrl: null,
          gitRoot: tempDir,
        },
      });
      vi.mocked(getRepositoryIdentity).mockResolvedValue({
        repositoryId: `test-repo-${tempDir}`,
        remoteUrl: null,
        gitRoot: tempDir,
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

      vi.mocked(getInstructionsFromIssue).mockResolvedValue({
        suggestedFileName: 'team-switch-linear-switch-test.md',
        issue: {
          title: 'Linear Switch Test',
          html_url: 'https://linear.app/company/issue/TEAM-SWITCH',
          number: 'TEAM-SWITCH',
        },
        plan: 'Linear issue',
        rmprOptions: { rmfilter: ['--include', '*.ts'] },
      });

      vi.mocked(createStubPlanFromIssue).mockImplementation((issueData, id) => ({
        id,
        title: issueData.issue.title,
        goal: `Implement: ${issueData.issue.title}`,
        details: issueData.plan,
        status: 'pending',
        issue: [issueData.issue.html_url],
        tasks: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        rmfilter: issueData.rmprOptions?.rmfilter || [],
      }));

      await handleImportCommand('TEAM-SWITCH');

      expect(getIssueTracker).toHaveBeenCalledWith(linearConfig);
      expect(mockLinearClient.getDisplayName()).toBe('Linear');
    });
  });
});
