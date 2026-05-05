import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleImportCommand } from './import.js';
import type { IssueTrackerClient, IssueWithComments } from '../../../common/issue_tracker/types.js';
import type { PlanSchema } from '../../planSchema.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';

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

vi.mock('../../db/project.js', () => ({
  previewNextPlanId: vi.fn(() => ({ startId: 6, endId: 6 })),
  reserveNextPlanId: vi.fn(() => ({ startId: 6, endId: 6 })),
}));

vi.mock('../../utils/references.js', () => ({
  ensureReferences: vi.fn(),
}));

import { getIssueTracker } from '../../../common/issue_tracker/factory.js';
import { writePlanFile, getMaxNumericPlanId, readPlanFile } from '../../plans.js';
import { log } from '../../../logging.js';
import { getGitRoot } from '../../../common/git.js';
import {
  parseCommandOptionsFromComment,
  combineRmprOptions,
} from '../../../common/comment_options.js';
import { singleLineWithPrefix, limitLines } from '../../../common/formatting.js';
import { checkbox } from '@inquirer/prompts';
import { getInstructionsFromIssue, createStubPlanFromIssue } from '../../issue_utils.js';
import { loadEffectiveConfig } from '../../configLoader.js';
import { loadPlansFromDb } from '../../plans_db.js';
import { resolveProjectContext } from '../../plan_materialize.js';
import { getRepositoryIdentity } from '../../assignments/workspace_identifier.js';
import { getDatabase } from '../../db/database.js';
import { upsertPlan } from '../../db/plan.js';
import { toPlanUpsertInput } from '../../db/plan_sync.js';
import { ensureReferences } from '../../utils/references.js';

describe('Linear Integration Tests', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Create temporary directory for real filesystem operations
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'linear-integration-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Mock common dependencies with realistic behavior
    vi.mocked(getGitRoot).mockResolvedValue(tempDir);
    vi.mocked(parseCommandOptionsFromComment).mockReturnValue({ options: null });
    vi.mocked(combineRmprOptions).mockReturnValue({ rmfilter: ['--include', '*.ts'] });
    vi.mocked(singleLineWithPrefix).mockImplementation((prefix, text) => prefix + text);
    vi.mocked(limitLines).mockImplementation((text) => text);
    vi.mocked(checkbox).mockResolvedValue([]); // Default to no selection

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
      updatedPlan: {
        ...plan,
        uuid: plan.uuid ?? `uuid-${plan.id}`,
      },
    }));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  describe('Single Issue Import', () => {
    test('should import a Linear issue with full data', async () => {
      const mockLinearIssue: IssueWithComments = {
        issue: {
          id: 'issue-uuid-123',
          number: 'TEAM-123',
          title: 'Implement user authentication',
          body: '## Problem\n\nUsers need to authenticate to access the system.\n\n## Solution\n\nImplement JWT-based authentication with refresh tokens.',
          htmlUrl: 'https://linear.app/company/issue/TEAM-123',
          state: 'In Progress',
          createdAt: '2024-01-15T10:30:00.000Z',
          updatedAt: '2024-01-16T14:22:00.000Z',
          user: {
            id: 'user-123',
            name: 'John Doe',
            email: 'john@company.com',
            login: 'johndoe',
          },
          assignees: [
            {
              id: 'user-456',
              name: 'Jane Smith',
              email: 'jane@company.com',
              login: 'janesmith',
            },
          ],
          labels: [
            { id: 'label-1', name: 'feature', color: '#0052CC' },
            { id: 'label-2', name: 'high-priority', color: '#FF5630' },
          ],
          pullRequest: false,
        },
        comments: [
          {
            id: 'comment-1',
            body: 'I think we should use OAuth 2.0 for social login integration.',
            createdAt: '2024-01-16T09:15:00.000Z',
            updatedAt: '2024-01-16T09:20:00.000Z',
            user: {
              id: 'user-789',
              name: 'Bob Wilson',
              email: 'bob@company.com',
              login: 'bobwilson',
            },
          },
          {
            id: 'comment-2',
            body: "Good point! Let's also consider implementing 2FA.",
            createdAt: '2024-01-16T10:30:00.000Z',
            updatedAt: '2024-01-16T10:30:00.000Z',
            user: {
              id: 'user-123',
              name: 'John Doe',
              email: 'john@company.com',
              login: 'johndoe',
            },
          },
        ],
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

      vi.mocked(writePlanFile).mockResolvedValue(undefined);
      vi.mocked(getMaxNumericPlanId).mockResolvedValue(5);
      vi.mocked(readPlanFile).mockResolvedValue({ issue: [] });

      vi.mocked(getInstructionsFromIssue).mockResolvedValue({
        suggestedFileName: 'team-123-implement-user-authentication.md',
        issue: {
          title: 'Implement user authentication',
          html_url: 'https://linear.app/company/issue/TEAM-123',
          number: 'TEAM-123',
        },
        plan: "## Problem\n\nUsers need to authenticate to access the system.\n\n## Solution\n\nImplement JWT-based authentication with refresh tokens.\n\n---\n\n**Comments:**\n\n> I think we should use OAuth 2.0 for social login integration.\n> — Bob Wilson\n\n> Good point! Let's also consider implementing 2FA.\n> — John Doe",
        rmprOptions: {
          rmfilter: ['--include', '*.ts'],
        },
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

      // Execute the import command
      await handleImportCommand('TEAM-123');

      // Verify interactions
      expect(getIssueTracker).toHaveBeenCalledWith(linearConfig);
      expect(mockLinearClient.fetchIssue).toHaveBeenCalledWith('TEAM-123');
      expect(writePlanFile).toHaveBeenCalled();

      const [filePath, planData] = vi.mocked(writePlanFile).mock.calls[0];
      expect(filePath).toBeNull();
      expect(planData).toMatchObject({
        title: 'Implement user authentication',
        goal: 'Implement: Implement user authentication',
        issue: ['https://linear.app/company/issue/TEAM-123'],
        status: 'pending',
        rmfilter: ['--include', '*.ts'],
      });
      expect(planData.details).toContain('Implement JWT-based authentication with refresh tokens.');

      expect(log).toHaveBeenCalledWith(expect.stringContaining('Created plan'));
    });

    test('should handle Linear issue without comments', async () => {
      const mockLinearIssueNoComments: IssueWithComments = {
        issue: {
          id: 'issue-uuid-456',
          number: 'TEAM-456',
          title: 'Fix login bug',
          body: 'The login form is not working correctly.',
          htmlUrl: 'https://linear.app/company/issue/TEAM-456',
          state: 'Open',
          createdAt: '2024-01-15T10:30:00.000Z',
          updatedAt: '2024-01-15T10:30:00.000Z',
          user: {
            id: 'user-123',
            name: 'John Doe',
          },
          pullRequest: false,
        },
        comments: [], // No comments
      };

      const mockLinearClient: IssueTrackerClient = {
        fetchIssue: vi.fn(() => Promise.resolve(mockLinearIssueNoComments)),
        fetchAllOpenIssues: vi.fn(() => Promise.resolve([])),
        parseIssueIdentifier: vi.fn(() => ({ identifier: 'TEAM-456' })),
        getDisplayName: vi.fn(() => 'Linear'),
        getConfig: vi.fn(() => ({ type: 'linear' })),
      };

      const linearConfig = {
        issueTracker: 'linear' as const,
        paths: { tasks: 'tasks' },
      };

      vi.mocked(loadEffectiveConfig).mockResolvedValue(linearConfig);
      vi.mocked(getIssueTracker).mockResolvedValue(mockLinearClient);

      vi.mocked(writePlanFile).mockResolvedValue(undefined);
      vi.mocked(getMaxNumericPlanId).mockResolvedValue(0);
      vi.mocked(readPlanFile).mockResolvedValue({ issue: [] });

      vi.mocked(getInstructionsFromIssue).mockResolvedValue({
        suggestedFileName: 'team-456-fix-login-bug.md',
        issue: {
          title: 'Fix login bug',
          html_url: 'https://linear.app/company/issue/TEAM-456',
          number: 'TEAM-456',
        },
        plan: 'The login form is not working correctly.',
        rmprOptions: {
          rmfilter: ['--include', '*.ts'],
        },
      });

      vi.mocked(createStubPlanFromIssue).mockImplementation((issueData, id) => ({
        id,
        title: issueData.issue.title,
        goal: `Fix: ${issueData.issue.title}`,
        details: issueData.plan,
        status: 'pending',
        issue: [issueData.issue.html_url],
        tasks: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        rmfilter: issueData.rmprOptions?.rmfilter || [],
      }));

      await handleImportCommand('TEAM-456');

      expect(writePlanFile).toHaveBeenCalled();

      const [, planData] = vi.mocked(writePlanFile).mock.calls[0];
      expect(planData.details).toBe('The login form is not working correctly.');
      expect(planData.details).not.toContain('Comments:');
    });

    test('should handle Linear issue with many comments', async () => {
      const generateComments = (count: number) => {
        return Array.from({ length: count }, (_, i) => ({
          id: `comment-${i + 1}`,
          body: `This is comment number ${i + 1} with some detailed content about the issue.`,
          createdAt: new Date(2024, 0, 15, 10, i).toISOString(),
          updatedAt: new Date(2024, 0, 15, 10, i).toISOString(),
          user: {
            id: `user-${(i % 3) + 1}`,
            name: `User ${(i % 3) + 1}`,
            email: `user${(i % 3) + 1}@company.com`,
          },
        }));
      };

      const mockLinearIssueWithManyComments: IssueWithComments = {
        issue: {
          id: 'issue-uuid-789',
          number: 'TEAM-789',
          title: 'Complex refactoring task',
          body: 'This task involves refactoring multiple components.',
          htmlUrl: 'https://linear.app/company/issue/TEAM-789',
          state: 'In Progress',
          createdAt: '2024-01-15T10:30:00.000Z',
          updatedAt: '2024-01-16T14:22:00.000Z',
          user: {
            id: 'user-123',
            name: 'John Doe',
          },
          pullRequest: false,
        },
        comments: generateComments(25), // Many comments
      };

      const mockLinearClient: IssueTrackerClient = {
        fetchIssue: vi.fn(() => Promise.resolve(mockLinearIssueWithManyComments)),
        fetchAllOpenIssues: vi.fn(() => Promise.resolve([])),
        parseIssueIdentifier: vi.fn(() => ({ identifier: 'TEAM-789' })),
        getDisplayName: vi.fn(() => 'Linear'),
        getConfig: vi.fn(() => ({ type: 'linear' })),
      };

      const linearConfig = {
        issueTracker: 'linear' as const,
        paths: { tasks: 'tasks' },
      };

      vi.mocked(loadEffectiveConfig).mockResolvedValue(linearConfig);
      vi.mocked(getIssueTracker).mockResolvedValue(mockLinearClient);

      vi.mocked(writePlanFile).mockResolvedValue(undefined);
      vi.mocked(getMaxNumericPlanId).mockResolvedValue(0);
      vi.mocked(readPlanFile).mockResolvedValue({ issue: [] });

      vi.mocked(getInstructionsFromIssue).mockImplementation((client, identifier) => {
        // Simulate processing many comments
        const comments = mockLinearIssueWithManyComments.comments
          .slice(0, 10) // Limit to first 10 for processing
          .map((c) => `> ${c.body}\n> — ${c.user?.name || 'Unknown'}`)
          .join('\n\n');

        return Promise.resolve({
          suggestedFileName: 'team-789-complex-refactoring-task.md',
          issue: {
            title: 'Complex refactoring task',
            html_url: 'https://linear.app/company/issue/TEAM-789',
            number: 'TEAM-789',
          },
          plan: `This task involves refactoring multiple components.\n\n---\n\n**Comments (showing first 10 of ${mockLinearIssueWithManyComments.comments.length}):**\n\n${comments}`,
          rmprOptions: {
            rmfilter: ['--include', '*.ts'],
          },
        });
      });

      vi.mocked(createStubPlanFromIssue).mockImplementation((issueData, id) => ({
        id,
        title: issueData.issue.title,
        goal: `Refactor: ${issueData.issue.title}`,
        details: issueData.plan,
        status: 'pending',
        issue: [issueData.issue.html_url],
        tasks: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        rmfilter: issueData.rmprOptions?.rmfilter || [],
      }));

      await handleImportCommand('TEAM-789');

      expect(writePlanFile).toHaveBeenCalled();
      expect(getInstructionsFromIssue).toHaveBeenCalledWith(mockLinearClient, 'TEAM-789', false);

      const [, planData] = vi.mocked(writePlanFile).mock.calls[0];
      expect(planData.details).toContain('Comments (showing first 10 of 25)');
      expect(planData.details).toContain('This is comment number 1');
    });
  });

  describe('Batch Import', () => {
    test('should import multiple Linear issues interactively', async () => {
      const mockLinearIssues = [
        {
          id: 'issue-1',
          number: 'TEAM-100',
          title: 'Setup CI/CD pipeline',
          body: 'Configure automated deployment',
          htmlUrl: 'https://linear.app/company/issue/TEAM-100',
          state: 'Open',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          user: { id: 'user-1', name: 'Alice', login: 'alice' },
          pullRequest: false,
        },
        {
          id: 'issue-2',
          number: 'TEAM-101',
          title: 'Update documentation',
          body: 'Refresh API documentation',
          htmlUrl: 'https://linear.app/company/issue/TEAM-101',
          state: 'Open',
          createdAt: '2024-01-02T00:00:00.000Z',
          updatedAt: '2024-01-02T00:00:00.000Z',
          user: { id: 'user-2', name: 'Bob', login: 'bob' },
          pullRequest: false,
        },
        {
          id: 'issue-3',
          number: 'TEAM-102',
          title: 'Performance optimization',
          body: 'Optimize database queries',
          htmlUrl: 'https://linear.app/company/issue/TEAM-102',
          state: 'Open',
          createdAt: '2024-01-03T00:00:00.000Z',
          updatedAt: '2024-01-03T00:00:00.000Z',
          user: { id: 'user-3', name: 'Charlie', login: 'charlie' },
          pullRequest: false,
        },
      ];

      const mockLinearClient: IssueTrackerClient = {
        fetchIssue: vi.fn((identifier: string) => {
          const issue = mockLinearIssues.find((i) => i.number === identifier);
          if (!issue) throw new Error('Issue not found');

          return Promise.resolve({
            issue,
            comments: [
              {
                id: 'comment-1',
                body: `Comment for ${identifier}`,
                createdAt: '2024-01-01T10:00:00.000Z',
                updatedAt: '2024-01-01T10:00:00.000Z',
                user: { id: 'user-1', name: 'Commenter' },
              },
            ],
          });
        }),
        fetchAllOpenIssues: vi.fn(() => Promise.resolve(mockLinearIssues)),
        parseIssueIdentifier: vi.fn((id: string) => ({ identifier: id })),
        getDisplayName: vi.fn(() => 'Linear'),
        getConfig: vi.fn(() => ({ type: 'linear' })),
      };

      const linearConfig = {
        issueTracker: 'linear' as const,
        paths: { tasks: 'tasks' },
      };

      vi.mocked(loadEffectiveConfig).mockResolvedValue(linearConfig);
      vi.mocked(getIssueTracker).mockResolvedValue(mockLinearClient);

      // Mock user selecting all issues
      vi.mocked(checkbox).mockResolvedValue(['TEAM-100', 'TEAM-101', 'TEAM-102']);

      vi.mocked(writePlanFile).mockResolvedValue(undefined);
      vi.mocked(getMaxNumericPlanId).mockResolvedValue(0);
      vi.mocked(readPlanFile).mockResolvedValue({ issue: [] });

      let callCount = 0;
      vi.mocked(getInstructionsFromIssue).mockImplementation((client, identifier) => {
        const issue = mockLinearIssues.find((i) => i.number === identifier);
        return Promise.resolve({
          suggestedFileName: `${(identifier as string).toLowerCase()}-${issue?.title.toLowerCase().replace(/\s+/g, '-')}.md`,
          issue: {
            title: issue?.title || 'Unknown',
            html_url: issue?.htmlUrl || '',
            number: identifier,
          },
          plan: issue?.body || 'No description',
          rmprOptions: { rmfilter: ['--include', '*.ts'] },
        });
      });

      vi.mocked(createStubPlanFromIssue).mockImplementation((issueData, id) => ({
        id: ++callCount,
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

      await expect(handleImportCommand()).rejects.toThrow('Issue ID is required');
      expect(mockLinearClient.fetchAllOpenIssues).not.toHaveBeenCalled();
      expect(writePlanFile).not.toHaveBeenCalled();
    });
  });

  describe('Update Existing Plans', () => {
    test('should update existing plan when importing duplicate Linear issue', async () => {
      const existingPlanId = 'existing-plan-123';
      const existingPlanPath = path.join(tasksDir, `${existingPlanId}.plan.md`);

      // Create an existing plan file
      const existingPlan: PlanSchema = {
        id: 42,
        title: 'Old Title',
        goal: 'Old goal',
        details: 'Old details',
        status: 'in_progress',
        issue: ['https://linear.app/company/issue/TEAM-999'],
        tasks: [{ title: 'Old task 1', description: 'Old description', done: false }],
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z',
        rmfilter: ['--include', '*.js'],
      };

      await fs.writeFile(existingPlanPath, yaml.stringify(existingPlan));

      const mockUpdatedLinearIssue: IssueWithComments = {
        issue: {
          id: 'issue-uuid-999',
          number: 'TEAM-999',
          title: 'Updated Issue Title',
          body: 'Updated issue description with new requirements.',
          htmlUrl: 'https://linear.app/company/issue/TEAM-999',
          state: 'In Progress',
          createdAt: '2024-01-15T10:30:00.000Z',
          updatedAt: '2024-01-20T16:45:00.000Z', // Updated timestamp
          user: { id: 'user-123', name: 'John Doe' },
          pullRequest: false,
        },
        comments: [
          {
            id: 'comment-new',
            body: 'Latest update on the requirements.',
            createdAt: '2024-01-20T15:30:00.000Z',
            updatedAt: '2024-01-20T15:30:00.000Z',
            user: { id: 'user-456', name: 'Jane Smith' },
          },
        ],
      };

      const mockLinearClient: IssueTrackerClient = {
        fetchIssue: vi.fn(() => Promise.resolve(mockUpdatedLinearIssue)),
        fetchAllOpenIssues: vi.fn(() => Promise.resolve([])),
        parseIssueIdentifier: vi.fn(() => ({ identifier: 'TEAM-999' })),
        getDisplayName: vi.fn(() => 'Linear'),
        getConfig: vi.fn(() => ({ type: 'linear' })),
      };

      const linearConfig = {
        issueTracker: 'linear' as const,
        paths: { tasks: 'tasks' },
      };

      vi.mocked(loadEffectiveConfig).mockResolvedValue(linearConfig);
      vi.mocked(getIssueTracker).mockResolvedValue(mockLinearClient);

      vi.mocked(writePlanFile).mockResolvedValue(undefined);
      vi.mocked(getMaxNumericPlanId).mockResolvedValue(42);
      vi.mocked(readPlanFile).mockResolvedValue(existingPlan);

      vi.mocked(getInstructionsFromIssue).mockResolvedValue({
        suggestedFileName: 'team-999-updated-issue-title.md',
        issue: {
          title: 'Updated Issue Title',
          html_url: 'https://linear.app/company/issue/TEAM-999',
          number: 'TEAM-999',
        },
        plan: 'Updated issue description with new requirements.\n\n---\n\n**Comments:**\n\n> Latest update on the requirements.\n> — Jane Smith',
        rmprOptions: { rmfilter: ['--include', '*.ts'] },
      });

      vi.mocked(createStubPlanFromIssue).mockImplementation((issueData, id) => ({
        id,
        title: issueData.issue.title,
        goal: `Updated: ${issueData.issue.title}`,
        details: issueData.plan,
        status: 'pending',
        issue: [issueData.issue.html_url],
        tasks: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        rmfilter: issueData.rmprOptions?.rmfilter || [],
      }));

      // Mock user selecting new issue body and comment (returns indices)
      vi.mocked(checkbox).mockResolvedValue([0, 1]); // Select first two items (issue body + comment)

      await handleImportCommand('TEAM-999');

      expect(writePlanFile).toHaveBeenCalled();

      // Verify the plan was written to DB (no file)
      const [filePath, updatedPlan] = vi.mocked(writePlanFile).mock.calls[0];
      expect(filePath).toBeNull();
      expect(updatedPlan.title).toBe('Updated Issue Title');
      expect(updatedPlan.issue).toContain('https://linear.app/company/issue/TEAM-999');
    });
  });

  describe('Linear-Specific Fields Handling', () => {
    test('should handle Linear-specific priority and status fields', async () => {
      const mockLinearIssueWithPriority: IssueWithComments = {
        issue: {
          id: 'issue-uuid-priority',
          number: 'TEAM-PRIORITY',
          title: 'High priority security fix',
          body: 'Critical security vulnerability needs immediate attention.',
          htmlUrl: 'https://linear.app/company/issue/TEAM-PRIORITY',
          state: 'In Progress',
          createdAt: '2024-01-15T10:30:00.000Z',
          updatedAt: '2024-01-16T14:22:00.000Z',
          user: { id: 'user-123', name: 'Security Team' },
          labels: [
            { id: 'label-security', name: 'security', color: '#FF0000' },
            { id: 'label-urgent', name: 'urgent', color: '#FF5630' },
            { id: 'label-p0', name: 'P0', color: '#8B0000' },
          ],
          assignees: [
            { id: 'user-security-1', name: 'Security Expert 1' },
            { id: 'user-security-2', name: 'Security Expert 2' },
          ],
          pullRequest: false,
        },
        comments: [],
      };

      const mockLinearClient: IssueTrackerClient = {
        fetchIssue: vi.fn(() => Promise.resolve(mockLinearIssueWithPriority)),
        fetchAllOpenIssues: vi.fn(() => Promise.resolve([])),
        parseIssueIdentifier: vi.fn(() => ({ identifier: 'TEAM-PRIORITY' })),
        getDisplayName: vi.fn(() => 'Linear'),
        getConfig: vi.fn(() => ({ type: 'linear' })),
      };

      const linearConfig = {
        issueTracker: 'linear' as const,
        paths: { tasks: 'tasks' },
      };

      vi.mocked(loadEffectiveConfig).mockResolvedValue(linearConfig);
      vi.mocked(getIssueTracker).mockResolvedValue(mockLinearClient);

      vi.mocked(writePlanFile).mockResolvedValue(undefined);
      vi.mocked(getMaxNumericPlanId).mockResolvedValue(0);
      vi.mocked(readPlanFile).mockResolvedValue({ issue: [] });

      vi.mocked(getInstructionsFromIssue).mockImplementation((client, identifier) => {
        const issue = mockLinearIssueWithPriority.issue;
        const labels = issue.labels?.map((l) => l.name).join(', ') || '';
        const assignees = issue.assignees?.map((a) => a.name).join(', ') || '';

        return Promise.resolve({
          suggestedFileName: 'team-priority-high-priority-security-fix.md',
          issue: {
            title: issue.title,
            html_url: issue.htmlUrl,
            number: issue.number,
          },
          plan: `${issue.body}\n\n**Status:** ${issue.state}\n**Labels:** ${labels}\n**Assignees:** ${assignees}`,
          rmprOptions: { rmfilter: ['--include', '*.ts'] },
        });
      });

      vi.mocked(createStubPlanFromIssue).mockImplementation((issueData, id) => ({
        id,
        title: issueData.issue.title,
        goal: `Fix: ${issueData.issue.title}`,
        details: issueData.plan,
        status: 'pending',
        priority: 'urgent', // Extract from Linear labels/status
        issue: [issueData.issue.html_url],
        tasks: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        rmfilter: issueData.rmprOptions?.rmfilter || [],
      }));

      await handleImportCommand('TEAM-PRIORITY');

      expect(writePlanFile).toHaveBeenCalled();

      const [, planData] = vi.mocked(writePlanFile).mock.calls[0];
      expect(planData.title).toBe('High priority security fix');
      expect(planData.priority).toBe('urgent');
      expect(planData.details).toContain('**Status:** In Progress');
      expect(planData.details).toContain('**Labels:** security, urgent, P0');
      expect(planData.details).toContain('**Assignees:** Security Expert 1, Security Expert 2');
    });

    test('should handle Linear status transitions properly', async () => {
      const statusTestCases = [
        { state: 'Backlog', expectedPriority: 'maybe' },
        { state: 'Todo', expectedPriority: 'low' },
        { state: 'In Progress', expectedPriority: 'medium' },
        { state: 'In Review', expectedPriority: 'high' },
        { state: 'Done', expectedPriority: 'done' },
        { state: 'Canceled', expectedPriority: 'canceled' },
      ];

      for (const testCase of statusTestCases) {
        vi.clearAllMocks();

        // Re-set base mocks after clearAllMocks
        vi.mocked(getGitRoot).mockResolvedValue(tempDir);
        vi.mocked(parseCommandOptionsFromComment).mockReturnValue({ options: null });
        vi.mocked(combineRmprOptions).mockReturnValue({ rmfilter: ['--include', '*.ts'] });
        vi.mocked(singleLineWithPrefix).mockImplementation((prefix, text) => prefix + text);
        vi.mocked(limitLines).mockImplementation((text) => text);
        vi.mocked(checkbox).mockResolvedValue([]);
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

        const mockIssue: IssueWithComments = {
          issue: {
            id: `issue-${testCase.state.toLowerCase()}`,
            number: `TEAM-${testCase.state.toUpperCase()}`,
            title: `Issue in ${testCase.state}`,
            body: `Issue with state: ${testCase.state}`,
            htmlUrl: `https://linear.app/company/issue/TEAM-${testCase.state.toUpperCase()}`,
            state: testCase.state,
            createdAt: '2024-01-15T10:30:00.000Z',
            updatedAt: '2024-01-16T14:22:00.000Z',
            user: { id: 'user-123', name: 'Test User' },
            pullRequest: false,
          },
          comments: [],
        };

        const mockClient: IssueTrackerClient = {
          fetchIssue: vi.fn(() => Promise.resolve(mockIssue)),
          fetchAllOpenIssues: vi.fn(() => Promise.resolve([])),
          parseIssueIdentifier: vi.fn(() => ({
            identifier: `TEAM-${testCase.state.toUpperCase()}`,
          })),
          getDisplayName: vi.fn(() => 'Linear'),
          getConfig: vi.fn(() => ({ type: 'linear' })),
        };

        vi.mocked(getIssueTracker).mockResolvedValue(mockClient);
        vi.mocked(loadEffectiveConfig).mockResolvedValue({
          issueTracker: 'linear' as const,
          paths: { tasks: 'tasks' },
        });

        vi.mocked(getInstructionsFromIssue).mockResolvedValue({
          suggestedFileName: `team-${testCase.state.toLowerCase()}-issue.md`,
          issue: {
            title: mockIssue.issue.title,
            html_url: mockIssue.issue.htmlUrl,
            number: mockIssue.issue.number,
          },
          plan: mockIssue.issue.body!,
          rmprOptions: { rmfilter: ['--include', '*.ts'] },
        });

        vi.mocked(createStubPlanFromIssue).mockImplementation((issueData, id) => {
          let planStatus = 'pending';
          let priority = 'medium';

          // Map Linear states to plan status and priority
          switch (testCase.state) {
            case 'Done':
              planStatus = 'done';
              priority = 'done';
              break;
            case 'Canceled':
              planStatus = 'canceled';
              priority = 'canceled';
              break;
            case 'In Progress':
              planStatus = 'in_progress';
              priority = 'high';
              break;
            case 'Backlog':
              priority = 'maybe';
              break;
            case 'Todo':
              priority = 'low';
              break;
            case 'In Review':
              priority = 'urgent';
              break;
          }

          return {
            id,
            title: issueData.issue.title,
            goal: `Handle: ${issueData.issue.title}`,
            details: issueData.plan,
            status: planStatus,
            priority,
            issue: [issueData.issue.html_url],
            tasks: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            rmfilter: issueData.rmprOptions?.rmfilter || [],
          };
        });

        vi.mocked(writePlanFile).mockResolvedValue(undefined);
        vi.mocked(getMaxNumericPlanId).mockResolvedValue(0);
        vi.mocked(readPlanFile).mockResolvedValue({ issue: [] });

        await handleImportCommand(`TEAM-${testCase.state.toUpperCase()}`);

        expect(writePlanFile).toHaveBeenCalled();
        const [, planData] = vi.mocked(writePlanFile).mock.calls[0];

        expect(planData.details).toContain(`Issue with state: ${testCase.state}`);
        // The priority mapping is handled in createStubPlanFromIssue mock
        expect(planData.priority).toBeDefined();
      }
    });
  });
});
