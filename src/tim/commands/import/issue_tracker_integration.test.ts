import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { handleImportCommand } from './import.js';
import { ModuleMocker } from '../../../testing.js';
import { getIssueTracker } from '../../../common/issue_tracker/factory.js';
import type { IssueTrackerClient, IssueWithComments } from '../../../common/issue_tracker/types.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

const moduleMocker = new ModuleMocker(import.meta);

// These tests do not properly sandbox themselves
describe.skip('Issue Tracker Abstraction Integration Tests', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    // Create temporary directory for real filesystem operations
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'issue-tracker-integration-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Mock common dependencies
    await moduleMocker.mock('../../../common/git.js', () => ({
      getGitRoot: mock(() => Promise.resolve(tempDir)),
    }));

    await moduleMocker.mock('../../../logging.js', () => ({
      log: mock(),
      warn: mock(),
      error: mock(),
    }));

    await moduleMocker.mock('../../../common/comment_options.js', () => ({
      parseCommandOptionsFromComment: mock(() => ({ options: null })),
      combineRmprOptions: mock(() => ({ rmfilter: ['--include', '*.ts'] })),
    }));

    await moduleMocker.mock('../../../common/formatting.js', () => ({
      singleLineWithPrefix: mock((prefix, text) => prefix + text),
      limitLines: mock((text) => text),
    }));

    await moduleMocker.mock('@inquirer/prompts', () => ({
      checkbox: mock(() => Promise.resolve([])),
    }));

    await moduleMocker.mock('../../plans.js', () => ({
      readAllPlans: mock(() =>
        Promise.resolve({ plans: new Map(), maxNumericId: 0, duplicates: {} })
      ),
      writePlanFile: mock(() => Promise.resolve()),
      getMaxNumericPlanId: mock(() => Promise.resolve(0)),
      readPlanFile: mock(() => Promise.resolve({ issue: [] })),
      getImportedIssueUrls: mock(() => Promise.resolve(new Set())),
    }));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
    moduleMocker.clear();
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
        fetchIssue: mock(() => Promise.resolve(mockGitHubIssue)),
        fetchAllOpenIssues: mock(() => Promise.resolve([])),
        parseIssueIdentifier: mock(() => ({ identifier: '123' })),
        getDisplayName: mock(() => 'GitHub'),
        getConfig: mock(() => ({ type: 'github' })),
      };

      const githubConfig = {
        issueTracker: 'github' as const,
        paths: { tasks: 'tasks' },
      };

      await moduleMocker.mock('../../configLoader.js', () => ({
        loadEffectiveConfig: mock(() => Promise.resolve(githubConfig)),
      }));

      await moduleMocker.mock('../../../common/issue_tracker/factory.js', () => ({
        getIssueTracker: mock(() => Promise.resolve(mockGitHubClient)),
      }));

      await moduleMocker.mock('../../issue_utils.js', () => ({
        getInstructionsFromIssue: mock(() =>
          Promise.resolve({
            suggestedFileName: '../issue-123-github-test-issue.md',
            issue: {
              title: '../GitHub Test Issue',
              html_url: '../https://github.com/owner/repo/issues/123',
              number: 123,
            },
            plan: 'This is a GitHub issue',
            rmprOptions: { rmfilter: ['--include', '*.ts'] },
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
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          rmfilter: issueData.rmprOptions?.rmfilter || [],
        })),
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
        fetchIssue: mock(() => Promise.resolve(mockLinearIssue)),
        fetchAllOpenIssues: mock(() => Promise.resolve([])),
        parseIssueIdentifier: mock(() => ({ identifier: 'TEAM-123' })),
        getDisplayName: mock(() => 'Linear'),
        getConfig: mock(() => ({ type: 'linear' })),
      };

      const linearConfig = {
        issueTracker: 'linear' as const,
        paths: { tasks: 'tasks' },
      };

      await moduleMocker.mock('../../configLoader.js', () => ({
        loadEffectiveConfig: mock(() => Promise.resolve(linearConfig)),
      }));

      await moduleMocker.mock('../../../common/issue_tracker/factory.js', () => ({
        getIssueTracker: mock(() => Promise.resolve(mockLinearClient)),
      }));

      await moduleMocker.mock('../../issue_utils.js', () => ({
        getInstructionsFromIssue: mock(() =>
          Promise.resolve({
            suggestedFileName: 'team-123-linear-test-issue.md',
            issue: {
              title: 'Linear Test Issue',
              html_url: 'https://linear.app/company/issue/TEAM-123',
              number: 'TEAM-123',
            },
            plan: 'This is a Linear issue',
            rmprOptions: { rmfilter: ['--include', '*.ts'] },
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
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          rmfilter: issueData.rmprOptions?.rmfilter || [],
        })),
      }));

      await handleImportCommand('TEAM-123');

      const { getIssueTracker } = await import('../../../common/issue_tracker/factory.js');
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
        fetchIssue: mock(() => Promise.resolve(mockGitHubIssue)),
        fetchAllOpenIssues: mock(() => Promise.resolve([])),
        parseIssueIdentifier: mock(() => ({ identifier: '456' })),
        getDisplayName: mock(() => 'GitHub'),
        getConfig: mock(() => ({ type: 'github' })),
      };

      const defaultConfig = {
        // No issueTracker field - should default to GitHub
        paths: { tasks: 'tasks' },
      };

      await moduleMocker.mock('../../configLoader.js', () => ({
        loadEffectiveConfig: mock(() => Promise.resolve(defaultConfig)),
      }));

      await moduleMocker.mock('../../../common/issue_tracker/factory.js', () => ({
        getIssueTracker: mock(() => Promise.resolve(mockGitHubClient)),
      }));

      await moduleMocker.mock('../../issue_utils.js', () => ({
        getInstructionsFromIssue: mock(() =>
          Promise.resolve({
            suggestedFileName: 'issue-456-default-github-issue.md',
            issue: {
              title: 'Default GitHub Issue',
              html_url: 'https://github.com/owner/repo/issues/456',
              number: 456,
            },
            plan: 'Issue with default config',
            rmprOptions: { rmfilter: ['--include', '*.ts'] },
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
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          rmfilter: issueData.rmprOptions?.rmfilter || [],
        })),
      }));

      await handleImportCommand('456');

      const { getIssueTracker } = await import('../../common/issue_tracker/factory.js');
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
        const mockGitHubClient: IssueTrackerClient = {
          fetchIssue: mock(() =>
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
          fetchAllOpenIssues: mock(() => Promise.resolve([])),
          parseIssueIdentifier: mock(() => ({ identifier: testCase.expected })),
          getDisplayName: mock(() => 'GitHub'),
          getConfig: mock(() => ({ type: 'github' })),
        };

        await moduleMocker.mock('../../../common/issue_tracker/factory.js', () => ({
          getIssueTracker: mock(() => Promise.resolve(mockGitHubClient)),
        }));

        await moduleMocker.mock('../../configLoader.js', () => ({
          loadEffectiveConfig: mock(() =>
            Promise.resolve({
              issueTracker: 'github' as const,
              paths: { tasks: 'tasks' },
            })
          ),
        }));

        await moduleMocker.mock('../../issue_utils.js', () => ({
          getInstructionsFromIssue: mock(() =>
            Promise.resolve({
              suggestedFileName: `issue-${testCase.expected}-test.md`,
              issue: {
                title: `Issue ${testCase.expected}`,
                html_url: `https://github.com/owner/repo/issues/${testCase.expected}`,
                number: parseInt(testCase.expected),
              },
              plan: 'Test issue',
              rmprOptions: { rmfilter: ['--include', '*.ts'] },
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
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            rmfilter: issueData.rmprOptions?.rmfilter || [],
          })),
        }));

        await handleImportCommand(testCase.input);
        expect(mockGitHubClient.fetchIssue).toHaveBeenCalledWith(testCase.input);

        // Clear mocks for next iteration
        moduleMocker.clear();
      }
    });

    // TODO This test isn't properly sandboxed
    test.skip('should correctly parse Linear issue identifiers and URLs', async () => {
      const testCases = [
        { input: 'TEAM-123', expected: 'TEAM-123' },
        { input: 'PROJECT-456', expected: 'PROJECT-456' },
        { input: 'https://linear.app/company/issue/TEAM-789', expected: 'TEAM-789' },
        { input: 'https://linear.app/workspace/issue/ABC-999/title-slug', expected: 'ABC-999' },
      ];

      for (const testCase of testCases) {
        const mockLinearClient: IssueTrackerClient = {
          fetchIssue: mock(() =>
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
          fetchAllOpenIssues: mock(() => Promise.resolve([])),
          parseIssueIdentifier: mock(() => ({ identifier: testCase.expected })),
          getDisplayName: mock(() => 'Linear'),
          getConfig: mock(() => ({ type: 'linear' })),
        };

        await moduleMocker.mock('../../../common/issue_tracker/factory.js', () => ({
          getIssueTracker: mock(() => Promise.resolve(mockLinearClient)),
        }));

        await moduleMocker.mock('../../configLoader.js', () => ({
          loadEffectiveConfig: mock(() =>
            Promise.resolve({
              issueTracker: 'linear' as const,
              paths: { tasks: 'tasks' },
            })
          ),
        }));

        await moduleMocker.mock('../../issue_utils.js', () => ({
          getInstructionsFromIssue: mock(() =>
            Promise.resolve({
              suggestedFileName: `${testCase.expected.toLowerCase()}-test.md`,
              issue: {
                title: `Linear Issue ${testCase.expected}`,
                html_url: `https://linear.app/company/issue/${testCase.expected}`,
                number: testCase.expected,
              },
              plan: 'Test Linear issue',
              rmprOptions: { rmfilter: ['--include', '*.ts'] },
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
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            rmfilter: issueData.rmprOptions?.rmfilter || [],
          })),
        }));

        await handleImportCommand(testCase.input);
        expect(mockLinearClient.fetchIssue).toHaveBeenCalledWith(testCase.input);

        // Clear mocks for next iteration
        moduleMocker.clear();
      }
    });
  });

  describe('Error Handling Across Platforms', () => {
    test('should handle GitHub API errors gracefully', async () => {
      const mockGitHubClient: IssueTrackerClient = {
        fetchIssue: mock(() => Promise.reject(new Error('GitHub API rate limit exceeded'))),
        fetchAllOpenIssues: mock(() => Promise.resolve([])),
        parseIssueIdentifier: mock(() => ({ identifier: '404' })),
        getDisplayName: mock(() => 'GitHub'),
        getConfig: mock(() => ({ type: 'github' })),
      };

      await moduleMocker.mock('../../configLoader.js', () => ({
        loadEffectiveConfig: mock(() =>
          Promise.resolve({
            issueTracker: 'github' as const,
            paths: { tasks: 'tasks' },
          })
        ),
      }));

      await moduleMocker.mock('../../../common/issue_tracker/factory.js', () => ({
        getIssueTracker: mock(() => Promise.resolve(mockGitHubClient)),
      }));

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
        fetchIssue: mock(() => Promise.reject(new Error('Linear API authentication failed'))),
        fetchAllOpenIssues: mock(() => Promise.resolve([])),
        parseIssueIdentifier: mock(() => ({ identifier: 'TEAM-404' })),
        getDisplayName: mock(() => 'Linear'),
        getConfig: mock(() => ({ type: 'linear' })),
      };

      await moduleMocker.mock('../../configLoader.js', () => ({
        loadEffectiveConfig: mock(() =>
          Promise.resolve({
            issueTracker: 'linear' as const,
            paths: { tasks: 'tasks' },
          })
        ),
      }));

      await moduleMocker.mock('../../../common/issue_tracker/factory.js', () => ({
        getIssueTracker: mock(() => Promise.resolve(mockLinearClient)),
      }));

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
      await moduleMocker.mock('../../configLoader.js', () => ({
        loadEffectiveConfig: mock(() =>
          Promise.resolve({
            issueTracker: 'github' as const,
            paths: { tasks: 'tasks' },
          })
        ),
      }));

      await moduleMocker.mock('../../../common/issue_tracker/factory.js', () => ({
        getIssueTracker: mock(() =>
          Promise.reject(new Error('GITHUB_TOKEN environment variable is required'))
        ),
      }));

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
        fetchIssue: mock(() =>
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
        fetchAllOpenIssues: mock(() => Promise.resolve([])),
        parseIssueIdentifier: mock(() => ({ identifier: '999' })),
        getDisplayName: mock(() => 'GitHub'),
        getConfig: mock(() => ({ type: 'github' })),
      };

      await moduleMocker.mock('../../configLoader.js', () => ({
        loadEffectiveConfig: mock(() => Promise.resolve(githubConfig)),
      }));

      await moduleMocker.mock('../../../common/issue_tracker/factory.js', () => ({
        getIssueTracker: mock(() => Promise.resolve(mockGitHubClient)),
      }));

      await moduleMocker.mock('../../issue_utils.js', () => ({
        getInstructionsFromIssue: mock(() =>
          Promise.resolve({
            suggestedFileName: 'issue-999-github-switch-test.md',
            issue: {
              title: 'GitHub Switch Test',
              html_url: 'https://github.com/owner/repo/issues/999',
              number: 999,
            },
            plan: 'GitHub issue',
            rmprOptions: { rmfilter: ['--include', '*.ts'] },
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
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          rmfilter: issueData.rmprOptions?.rmfilter || [],
        })),
      }));

      await handleImportCommand('999');

      const { getIssueTracker: getIssueTracker1 } =
        await import('../../common/issue_tracker/factory.js');
      expect(getIssueTracker1).toHaveBeenCalledWith(githubConfig);
      expect(mockGitHubClient.getDisplayName()).toBe('GitHub');

      // Clear mocks for second test
      moduleMocker.clear();

      // Test 2: Now switch to Linear config
      const linearConfig = {
        issueTracker: 'linear' as const,
        paths: { tasks: 'tasks' },
      };

      const mockLinearClient: IssueTrackerClient = {
        fetchIssue: mock(() =>
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
        fetchAllOpenIssues: mock(() => Promise.resolve([])),
        parseIssueIdentifier: mock(() => ({ identifier: 'TEAM-SWITCH' })),
        getDisplayName: mock(() => 'Linear'),
        getConfig: mock(() => ({ type: 'linear' })),
      };

      await moduleMocker.mock('../../configLoader.js', () => ({
        loadEffectiveConfig: mock(() => Promise.resolve(linearConfig)),
      }));

      await moduleMocker.mock('../../../common/issue_tracker/factory.js', () => ({
        getIssueTracker: mock(() => Promise.resolve(mockLinearClient)),
      }));

      await moduleMocker.mock('../../issue_utils.js', () => ({
        getInstructionsFromIssue: mock(() =>
          Promise.resolve({
            suggestedFileName: 'team-switch-linear-switch-test.md',
            issue: {
              title: 'Linear Switch Test',
              html_url: 'https://linear.app/company/issue/TEAM-SWITCH',
              number: 'TEAM-SWITCH',
            },
            plan: 'Linear issue',
            rmprOptions: { rmfilter: ['--include', '*.ts'] },
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
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          rmfilter: issueData.rmprOptions?.rmfilter || [],
        })),
      }));

      await handleImportCommand('TEAM-SWITCH');

      const { getIssueTracker: getIssueTracker2 } =
        await import('../../common/issue_tracker/factory.js');
      expect(getIssueTracker2).toHaveBeenCalledWith(linearConfig);
      expect(mockLinearClient.getDisplayName()).toBe('Linear');
    });
  });
});
