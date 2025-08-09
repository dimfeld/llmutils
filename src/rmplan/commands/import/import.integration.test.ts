import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { handleImportCommand } from './import.js';
import { ModuleMocker } from '../../testing.js';
import type {
  IssueTrackerClient,
  IssueWithComments,
  Issue,
} from '../../common/issue_tracker/types.js';
import type { PlanSchema } from '../planSchema.js';

const moduleMocker = new ModuleMocker(import.meta);

// Mock Linear-style issue data
const mockLinearIssueWithComments: IssueWithComments = {
  issue: {
    id: 'LIN-123',
    number: 123,
    title: 'Linear Issue Example',
    body: 'This is a Linear issue description',
    htmlUrl: 'https://linear.app/team/issue/LIN-123',
    state: 'open',
    createdAt: '2023-01-01T00:00:00Z',
    updatedAt: '2023-01-01T00:00:00Z',
    author: {
      login: 'linearuser',
      name: 'Linear User',
    },
  },
  comments: [
    {
      id: 'comment-linear-1',
      body: 'This is a Linear comment',
      createdAt: '2023-01-01T01:00:00Z',
      updatedAt: '2023-01-01T01:00:00Z',
      user: {
        login: 'linearuser2',
        name: 'Linear User 2',
      },
    },
  ],
};

// Mock GitHub-style issue data
const mockGitHubIssueWithComments: IssueWithComments = {
  issue: {
    id: '456',
    number: 456,
    title: 'GitHub Issue Example',
    body: 'This is a GitHub issue description',
    htmlUrl: 'https://github.com/owner/repo/issues/456',
    state: 'open',
    createdAt: '2023-01-01T00:00:00Z',
    updatedAt: '2023-01-01T00:00:00Z',
    author: {
      login: 'githubuser',
      name: 'GitHub User',
    },
  },
  comments: [
    {
      id: 'comment-github-1',
      body: 'This is a GitHub comment',
      createdAt: '2023-01-01T01:00:00Z',
      updatedAt: '2023-01-01T01:00:00Z',
      user: {
        login: 'githubuser2',
        name: 'GitHub User 2',
      },
    },
  ],
};

// Mock Linear issues list
const mockLinearIssues: Issue[] = [
  {
    id: 'LIN-100',
    number: 100,
    title: 'Linear Issue 1',
    htmlUrl: 'https://linear.app/team/issue/LIN-100',
    state: 'open',
    createdAt: '2023-01-01T00:00:00Z',
    updatedAt: '2023-01-01T00:00:00Z',
    author: { login: 'linearuser', name: 'Linear User' },
  },
  {
    id: 'LIN-101',
    number: 101,
    title: 'Linear Issue 2',
    htmlUrl: 'https://linear.app/team/issue/LIN-101',
    state: 'open',
    createdAt: '2023-01-01T00:00:00Z',
    updatedAt: '2023-01-01T00:00:00Z',
    author: { login: 'linearuser', name: 'Linear User' },
  },
];

// Mock GitHub issues list
const mockGitHubIssues: Issue[] = [
  {
    id: '200',
    number: 200,
    title: 'GitHub Issue 1',
    htmlUrl: 'https://github.com/owner/repo/issues/200',
    state: 'open',
    createdAt: '2023-01-01T00:00:00Z',
    updatedAt: '2023-01-01T00:00:00Z',
    author: { login: 'githubuser', name: 'GitHub User' },
  },
  {
    id: '201',
    number: 201,
    title: 'GitHub Issue 2',
    htmlUrl: 'https://github.com/owner/repo/issues/201',
    state: 'open',
    createdAt: '2023-01-01T00:00:00Z',
    updatedAt: '2023-01-01T00:00:00Z',
    author: { login: 'githubuser', name: 'GitHub User' },
  },
];

const mockPlansResult = {
  plans: new Map(),
  maxNumericId: 5,
  duplicates: {},
};

// Mock issue instruction data
const mockLinearIssueData = {
  suggestedFileName: 'linear-123-linear-issue-example.md',
  issue: {
    title: 'Linear Issue Example',
    html_url: 'https://linear.app/team/issue/LIN-123',
    number: 123,
  },
  plan: 'This is a Linear issue description',
  rmprOptions: {
    rmfilter: ['--include', '*.ts'],
  },
};

const mockGitHubIssueData = {
  suggestedFileName: 'issue-456-github-issue-example.md',
  issue: {
    title: 'GitHub Issue Example',
    html_url: 'https://github.com/owner/repo/issues/456',
    number: 456,
  },
  plan: 'This is a GitHub issue description',
  rmprOptions: {
    rmfilter: ['--include', '*.ts'],
  },
};

describe('handleImportCommand Integration Tests', () => {
  beforeEach(async () => {
    // Mock common dependencies
    await moduleMocker.mock('../plans.js', () => ({
      readAllPlans: mock(() => Promise.resolve(mockPlansResult)),
      writePlanFile: mock(() => Promise.resolve()),
      getMaxNumericPlanId: mock(() => Promise.resolve(5)),
      readPlanFile: mock(() => Promise.resolve({ issue: [] })),
      getImportedIssueUrls: mock(() => Promise.resolve(new Set())),
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: mock(() => Promise.resolve('/test/git/root')),
    }));

    await moduleMocker.mock('../../logging.js', () => ({
      log: mock(),
      warn: mock(),
      error: mock(),
    }));

    await moduleMocker.mock('@inquirer/prompts', () => ({
      checkbox: mock(() => Promise.resolve([])), // Default to no selection
    }));

    await moduleMocker.mock('../../rmpr/comment_options.js', () => ({
      parseCommandOptionsFromComment: mock(() => ({ options: null })),
      combineRmprOptions: mock(() => ({ rmfilter: ['--include', '*.ts'] })),
    }));

    await moduleMocker.mock('../../common/formatting.js', () => ({
      singleLineWithPrefix: mock((prefix, text) => prefix + text),
      limitLines: mock((text) => text),
    }));

    await moduleMocker.mock('../issue_utils.js', () => ({
      getInstructionsFromIssue: mock((client, issueId, include) => {
        // Return different data based on the issue ID pattern
        if (issueId.toString().startsWith('LIN-') || issueId.toString() === '123') {
          return Promise.resolve(mockLinearIssueData);
        } else {
          return Promise.resolve(mockGitHubIssueData);
        }
      }),
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
  });

  afterEach(async () => {
    return moduleMocker.clear();
  });

  test('should work with Linear configuration', async () => {
    const linearConfig = {
      issueTracker: 'linear',
      paths: { tasks: 'tasks' },
    };

    // Create Linear client mock
    const mockLinearClient: IssueTrackerClient = {
      fetchIssue: mock(() => Promise.resolve(mockLinearIssueWithComments)),
      fetchAllOpenIssues: mock(() => Promise.resolve(mockLinearIssues)),
      parseIssueIdentifier: mock(() => ({ identifier: 'LIN-123' })),
      getDisplayName: mock(() => 'Linear'),
      getConfig: mock(() => ({ type: 'linear' })),
    };

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: mock(() => Promise.resolve(linearConfig)),
    }));

    await moduleMocker.mock('../../common/issue_tracker/factory.js', () => ({
      getIssueTracker: mock(() => Promise.resolve(mockLinearClient)),
    }));

    await handleImportCommand('LIN-123');

    const { getIssueTracker } = await import('../../common/issue_tracker/factory.js');
    const { writePlanFile } = await import('../plans.js');
    const { log } = await import('../../logging.js');

    expect(getIssueTracker).toHaveBeenCalledWith(linearConfig);
    expect(mockLinearClient.fetchIssue).toHaveBeenCalledWith('LIN-123');
    expect(writePlanFile).toHaveBeenCalled();

    const [filePath, planData] = (writePlanFile as any).mock.calls[0];
    expect(filePath).toContain('linear-123-linear-issue-example.plan.md');
    expect(planData).toMatchObject({
      title: 'Linear Issue Example',
      issue: ['https://linear.app/team/issue/LIN-123'],
    });

    expect(log).toHaveBeenCalledWith(
      'Created stub plan file: /test/git/root/tasks/6-linear-123-linear-issue-example.plan.md'
    );
  });

  test('should work with GitHub configuration', async () => {
    const githubConfig = {
      issueTracker: 'github',
      paths: { tasks: 'tasks' },
    };

    // Create GitHub client mock
    const mockGitHubClient: IssueTrackerClient = {
      fetchIssue: mock(() => Promise.resolve(mockGitHubIssueWithComments)),
      fetchAllOpenIssues: mock(() => Promise.resolve(mockGitHubIssues)),
      parseIssueIdentifier: mock(() => ({ identifier: '456' })),
      getDisplayName: mock(() => 'GitHub'),
      getConfig: mock(() => ({ type: 'github' })),
    };

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: mock(() => Promise.resolve(githubConfig)),
    }));

    await moduleMocker.mock('../../common/issue_tracker/factory.js', () => ({
      getIssueTracker: mock(() => Promise.resolve(mockGitHubClient)),
    }));

    await handleImportCommand('456');

    const { getIssueTracker } = await import('../../common/issue_tracker/factory.js');
    const { writePlanFile } = await import('../plans.js');
    const { log } = await import('../../logging.js');

    expect(getIssueTracker).toHaveBeenCalledWith(githubConfig);
    expect(mockGitHubClient.fetchIssue).toHaveBeenCalledWith('456');
    expect(writePlanFile).toHaveBeenCalled();

    const [filePath, planData] = (writePlanFile as any).mock.calls[0];
    expect(filePath).toContain('issue-456-github-issue-example.plan.md');
    expect(planData).toMatchObject({
      title: 'GitHub Issue Example',
      issue: ['https://github.com/owner/repo/issues/456'],
    });

    expect(log).toHaveBeenCalledWith(
      'Created stub plan file: /test/git/root/tasks/6-issue-456-github-issue-example.plan.md'
    );
  });

  test('should work with Linear in interactive mode', async () => {
    const linearConfig = {
      issueTracker: 'linear',
      paths: { tasks: 'tasks' },
    };

    const mockLinearClient: IssueTrackerClient = {
      fetchIssue: mock(() => Promise.resolve(mockLinearIssueWithComments)),
      fetchAllOpenIssues: mock(() => Promise.resolve(mockLinearIssues)),
      parseIssueIdentifier: mock(() => ({ identifier: 'LIN-100' })),
      getDisplayName: mock(() => 'Linear'),
      getConfig: mock(() => ({ type: 'linear' })),
    };

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: mock(() => Promise.resolve(linearConfig)),
    }));

    await moduleMocker.mock('../../common/issue_tracker/factory.js', () => ({
      getIssueTracker: mock(() => Promise.resolve(mockLinearClient)),
    }));

    // Mock checkbox to select Linear issues
    await moduleMocker.mock('@inquirer/prompts', () => ({
      checkbox: mock(() => Promise.resolve([100, 101])),
    }));

    await handleImportCommand(); // No issue specified, should enter interactive mode

    const { getIssueTracker } = await import('../../common/issue_tracker/factory.js');
    const { writePlanFile } = await import('../plans.js');
    const { log } = await import('../../logging.js');
    const { checkbox } = await import('@inquirer/prompts');

    expect(getIssueTracker).toHaveBeenCalledWith(linearConfig);
    expect(mockLinearClient.fetchAllOpenIssues).toHaveBeenCalled();

    expect(log).toHaveBeenCalledWith('Fetching all open issues...');
    expect(log).toHaveBeenCalledWith('Found 2 open issues.');

    expect(checkbox).toHaveBeenCalledWith({
      message: 'Select issues to import:',
      choices: [
        { name: '100: Linear Issue 1', value: 100 },
        { name: '101: Linear Issue 2', value: 101 },
      ],
    });

    expect(log).toHaveBeenCalledWith('Importing 2 selected issues...');
    expect(writePlanFile).toHaveBeenCalledTimes(2);
  });

  test('should work with GitHub in interactive mode', async () => {
    const githubConfig = {
      issueTracker: 'github',
      paths: { tasks: 'tasks' },
    };

    const mockGitHubClient: IssueTrackerClient = {
      fetchIssue: mock(() => Promise.resolve(mockGitHubIssueWithComments)),
      fetchAllOpenIssues: mock(() => Promise.resolve(mockGitHubIssues)),
      parseIssueIdentifier: mock(() => ({ identifier: '200' })),
      getDisplayName: mock(() => 'GitHub'),
      getConfig: mock(() => ({ type: 'github' })),
    };

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: mock(() => Promise.resolve(githubConfig)),
    }));

    await moduleMocker.mock('../../common/issue_tracker/factory.js', () => ({
      getIssueTracker: mock(() => Promise.resolve(mockGitHubClient)),
    }));

    // Mock checkbox to select GitHub issues
    await moduleMocker.mock('@inquirer/prompts', () => ({
      checkbox: mock(() => Promise.resolve([200, 201])),
    }));

    await handleImportCommand(); // No issue specified, should enter interactive mode

    const { getIssueTracker } = await import('../../common/issue_tracker/factory.js');
    const { writePlanFile } = await import('../plans.js');
    const { log } = await import('../../logging.js');
    const { checkbox } = await import('@inquirer/prompts');

    expect(getIssueTracker).toHaveBeenCalledWith(githubConfig);
    expect(mockGitHubClient.fetchAllOpenIssues).toHaveBeenCalled();

    expect(log).toHaveBeenCalledWith('Fetching all open issues...');
    expect(log).toHaveBeenCalledWith('Found 2 open issues.');

    expect(checkbox).toHaveBeenCalledWith({
      message: 'Select issues to import:',
      choices: [
        { name: '200: GitHub Issue 1', value: 200 },
        { name: '201: GitHub Issue 2', value: 201 },
      ],
    });

    expect(log).toHaveBeenCalledWith('Importing 2 selected issues...');
    expect(writePlanFile).toHaveBeenCalledTimes(2);
  });

  test('should handle factory errors gracefully', async () => {
    const invalidConfig = {
      issueTracker: 'github',
      paths: { tasks: 'tasks' },
    };

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: mock(() => Promise.resolve(invalidConfig)),
    }));

    // Mock factory to throw an error (e.g., missing API key)
    await moduleMocker.mock('../../common/issue_tracker/factory.js', () => ({
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
    expect(thrownError.message).toBe('GITHUB_TOKEN environment variable is required');
  });

  test('should maintain backward compatibility', async () => {
    // Test that the command works without issueTracker config (defaults to github)
    const legacyConfig = {
      paths: { tasks: 'tasks' },
      // No issueTracker property - should default to github
    };

    const mockGitHubClient: IssueTrackerClient = {
      fetchIssue: mock(() => Promise.resolve(mockGitHubIssueWithComments)),
      fetchAllOpenIssues: mock(() => Promise.resolve(mockGitHubIssues)),
      parseIssueIdentifier: mock(() => ({ identifier: '456' })),
      getDisplayName: mock(() => 'GitHub'),
      getConfig: mock(() => ({ type: 'github' })),
    };

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: mock(() => Promise.resolve(legacyConfig)),
    }));

    await moduleMocker.mock('../../common/issue_tracker/factory.js', () => ({
      getIssueTracker: mock(() => Promise.resolve(mockGitHubClient)),
    }));

    await handleImportCommand('456');

    const { getIssueTracker } = await import('../../common/issue_tracker/factory.js');
    const { writePlanFile } = await import('../plans.js');

    expect(getIssueTracker).toHaveBeenCalledWith(legacyConfig);
    expect(mockGitHubClient.fetchIssue).toHaveBeenCalledWith('456');
    expect(writePlanFile).toHaveBeenCalled();

    // Should still work with GitHub as the default
    const [filePath, planData] = (writePlanFile as any).mock.calls[0];
    expect(planData).toMatchObject({
      title: 'GitHub Issue Example',
      issue: ['https://github.com/owner/repo/issues/456'],
    });
  });
});
