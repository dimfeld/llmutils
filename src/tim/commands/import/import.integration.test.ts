import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleImportCommand } from './import.js';
import type { IssueTrackerClient, IssueWithComments } from '../../../common/issue_tracker/types.js';
import type { Issue } from '@linear/sdk';

vi.mock('../../plans.js', () => ({
  writePlanFile: vi.fn(),
  getMaxNumericPlanId: vi.fn(),
  readPlanFile: vi.fn(),
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

vi.mock('../../issue_utils.js', () => ({
  getInstructionsFromIssue: vi.fn(),
  createStubPlanFromIssue: vi.fn(),
}));

vi.mock('../../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(),
}));

vi.mock('../../../common/issue_tracker/factory.js', () => ({
  getIssueTracker: vi.fn(),
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

vi.mock('../../db/project.js', () => ({
  previewNextPlanId: vi.fn(() => ({ startId: 6, endId: 6 })),
  reserveNextPlanId: vi.fn(() => ({ startId: 6, endId: 6 })),
}));

vi.mock('../../utils/references.js', () => ({
  ensureReferences: vi.fn(),
}));

import { writePlanFile, getMaxNumericPlanId, readPlanFile } from '../../plans.js';
import { getGitRoot } from '../../../common/git.js';
import { log } from '../../../logging.js';
import { checkbox } from '@inquirer/prompts';
import {
  parseCommandOptionsFromComment,
  combineRmprOptions,
} from '../../../common/comment_options.js';
import { singleLineWithPrefix, limitLines } from '../../../common/formatting.js';
import { getInstructionsFromIssue, createStubPlanFromIssue } from '../../issue_utils.js';
import { loadEffectiveConfig } from '../../configLoader.js';
import { getIssueTracker } from '../../../common/issue_tracker/factory.js';
import { loadPlansFromDb } from '../../plans_db.js';
import { resolveProjectContext } from '../../plan_materialize.js';
import { getRepositoryIdentity } from '../../assignments/workspace_identifier.js';
import { getDatabase } from '../../db/database.js';
import { upsertPlan } from '../../db/plan.js';
import { toPlanUpsertInput } from '../../db/plan_sync.js';
import { ensureReferences } from '../../utils/references.js';

let gitRootDir: string;

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
    vi.clearAllMocks();

    gitRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-import-int-'));

    // Mock common dependencies
    vi.mocked(writePlanFile).mockResolvedValue(undefined);
    vi.mocked(getMaxNumericPlanId).mockResolvedValue(5);
    vi.mocked(readPlanFile).mockResolvedValue({ issue: [] });

    vi.mocked(getGitRoot).mockResolvedValue(gitRootDir);

    vi.mocked(checkbox).mockResolvedValue([]); // Default to no selection

    vi.mocked(parseCommandOptionsFromComment).mockReturnValue({ options: null });
    vi.mocked(combineRmprOptions).mockReturnValue({ rmfilter: ['--include', '*.ts'] });

    vi.mocked(singleLineWithPrefix).mockImplementation((prefix, text) => prefix + text);
    vi.mocked(limitLines).mockImplementation((text) => text);

    vi.mocked(getInstructionsFromIssue).mockImplementation((client, issueId) => {
      // Return different data based on the issue ID pattern
      if (issueId.toString().startsWith('LIN-') || issueId.toString() === '123') {
        return Promise.resolve(mockLinearIssueData);
      } else {
        return Promise.resolve(mockGitHubIssueData);
      }
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

    // Set up DB mocks
    vi.mocked(loadPlansFromDb).mockReturnValue(mockPlansResult);
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
    vi.mocked(getRepositoryIdentity).mockResolvedValue({
      repositoryId: `test-repo-${gitRootDir}`,
      remoteUrl: null,
      gitRoot: gitRootDir,
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
      updatedPlan: {
        ...plan,
        uuid: plan.uuid ?? `uuid-${plan.id}`,
      },
    }));
  });

  afterEach(async () => {
    await fs.rm(gitRootDir, { recursive: true, force: true });
  });

  test('should work with Linear configuration', async () => {
    const linearConfig = {
      issueTracker: 'linear',
      paths: { tasks: 'tasks' },
    };

    // Create Linear client mock
    const mockLinearClient: IssueTrackerClient = {
      fetchIssue: vi.fn(() => Promise.resolve(mockLinearIssueWithComments)),
      fetchAllOpenIssues: vi.fn(() => Promise.resolve(mockLinearIssues)),
      parseIssueIdentifier: vi.fn(() => ({ identifier: 'LIN-123' })),
      getDisplayName: vi.fn(() => 'Linear'),
      getConfig: vi.fn(() => ({ type: 'linear' })),
    };

    vi.mocked(loadEffectiveConfig).mockResolvedValue(linearConfig);
    vi.mocked(getIssueTracker).mockResolvedValue(mockLinearClient);

    await handleImportCommand('LIN-123');

    expect(getIssueTracker).toHaveBeenCalledWith(linearConfig);
    expect(mockLinearClient.fetchIssue).toHaveBeenCalledWith('LIN-123');
    expect(writePlanFile).toHaveBeenCalled();

    const [filePath, planData] = vi.mocked(writePlanFile).mock.calls[0];
    expect(filePath).toBeNull();
    expect(planData).toMatchObject({
      title: 'Linear Issue Example',
      issue: ['https://linear.app/team/issue/LIN-123'],
    });

    expect(log).toHaveBeenCalledWith(expect.stringContaining(`Created plan ${planData.id}`));
  });

  test('should work with GitHub configuration', async () => {
    const githubConfig = {
      issueTracker: 'github',
      paths: { tasks: 'tasks' },
    };

    // Create GitHub client mock
    const mockGitHubClient: IssueTrackerClient = {
      fetchIssue: vi.fn(() => Promise.resolve(mockGitHubIssueWithComments)),
      fetchAllOpenIssues: vi.fn(() => Promise.resolve(mockGitHubIssues)),
      parseIssueIdentifier: vi.fn(() => ({ identifier: '456' })),
      getDisplayName: vi.fn(() => 'GitHub'),
      getConfig: vi.fn(() => ({ type: 'github' })),
    };

    vi.mocked(loadEffectiveConfig).mockResolvedValue(githubConfig);
    vi.mocked(getIssueTracker).mockResolvedValue(mockGitHubClient);

    await handleImportCommand('456');

    expect(getIssueTracker).toHaveBeenCalledWith(githubConfig);
    expect(mockGitHubClient.fetchIssue).toHaveBeenCalledWith('456');
    expect(writePlanFile).toHaveBeenCalled();

    const [filePath, planData] = vi.mocked(writePlanFile).mock.calls[0];
    expect(filePath).toBeNull();
    expect(planData).toMatchObject({
      title: 'GitHub Issue Example',
      issue: ['https://github.com/owner/repo/issues/456'],
    });

    expect(log).toHaveBeenCalledWith(expect.stringContaining(`Created plan ${planData.id}`));
  });

  test('requires an issue ID for Linear imports', async () => {
    await expect(handleImportCommand()).rejects.toThrow('Issue ID is required');
    expect(getIssueTracker).not.toHaveBeenCalled();
    expect(writePlanFile).not.toHaveBeenCalled();
  });

  test('requires an issue ID for GitHub imports', async () => {
    await expect(handleImportCommand()).rejects.toThrow('Issue ID is required');
    expect(getIssueTracker).not.toHaveBeenCalled();
    expect(writePlanFile).not.toHaveBeenCalled();
  });

  test('should handle factory errors gracefully', async () => {
    const invalidConfig = {
      issueTracker: 'github',
      paths: { tasks: 'tasks' },
    };

    vi.mocked(loadEffectiveConfig).mockResolvedValue(invalidConfig);

    // Mock factory to throw an error (e.g., missing API key)
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
    expect((thrownError as Error).message).toBe('GITHUB_TOKEN environment variable is required');
  });

  test('should maintain backward compatibility', async () => {
    // Test that the command works without issueTracker config (defaults to github)
    const legacyConfig = {
      paths: { tasks: 'tasks' },
      // No issueTracker property - should default to github
    };

    const mockGitHubClient: IssueTrackerClient = {
      fetchIssue: vi.fn(() => Promise.resolve(mockGitHubIssueWithComments)),
      fetchAllOpenIssues: vi.fn(() => Promise.resolve(mockGitHubIssues)),
      parseIssueIdentifier: vi.fn(() => ({ identifier: '456' })),
      getDisplayName: vi.fn(() => 'GitHub'),
      getConfig: vi.fn(() => ({ type: 'github' })),
    };

    vi.mocked(loadEffectiveConfig).mockResolvedValue(legacyConfig);
    vi.mocked(getIssueTracker).mockResolvedValue(mockGitHubClient);

    await handleImportCommand('456');

    expect(getIssueTracker).toHaveBeenCalledWith(legacyConfig);
    expect(mockGitHubClient.fetchIssue).toHaveBeenCalledWith('456');
    expect(writePlanFile).toHaveBeenCalled();

    // Should still work with GitHub as the default
    const [filePath, planData] = vi.mocked(writePlanFile).mock.calls[0];
    expect(planData).toMatchObject({
      title: 'GitHub Issue Example',
      issue: ['https://github.com/owner/repo/issues/456'],
    });
  });
});
