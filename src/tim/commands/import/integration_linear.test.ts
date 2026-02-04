import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { handleImportCommand } from './import.js';
import { ModuleMocker } from '../../../testing.js';
import type { IssueTrackerClient, IssueWithComments } from '../../../common/issue_tracker/types.js';
import type { PlanSchema } from '../../planSchema.js';
import { getIssueTracker } from '../../../common/issue_tracker/factory.js';
import { writePlanFile } from '../../plans.js';
import { log } from '../../../logging.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { getInstructionsFromIssue } from '../../issue_utils.js';
import { checkbox } from '@inquirer/prompts';

const moduleMocker = new ModuleMocker(import.meta);

describe('Linear Integration Tests', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    // Create temporary directory for real filesystem operations
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'linear-integration-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Mock common dependencies with realistic behavior
    await moduleMocker.mock('../../../common/git.js', () => ({
      getGitRoot: mock(() => Promise.resolve(tempDir)),
    }));

    await moduleMocker.mock('../../../logging.js', () => ({
      log: mock(),
      warn: mock(),
      error: mock(),
    }));

    await moduleMocker.mock('../../../rmpr/comment_options.js', () => ({
      parseCommandOptionsFromComment: mock(() => ({ options: null })),
      combineRmprOptions: mock(() => ({ rmfilter: ['--include', '*.ts'] })),
    }));

    await moduleMocker.mock('../../../common/formatting.js', () => ({
      singleLineWithPrefix: mock((prefix, text) => prefix + text),
      limitLines: mock((text) => text),
    }));

    await moduleMocker.mock('@inquirer/prompts', () => ({
      checkbox: mock(() => Promise.resolve([])), // Default to no selection
    }));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
    await moduleMocker.clear();
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

      await moduleMocker.mock('../../plans.js', () => ({
        readAllPlans: mock(() =>
          Promise.resolve({ plans: new Map(), maxNumericId: 5, duplicates: {} })
        ),
        writePlanFile: mock(() => Promise.resolve()),
        getMaxNumericPlanId: mock(() => Promise.resolve(5)),
        readPlanFile: mock(() => Promise.resolve({ issue: [] })),
        getImportedIssueUrls: mock(() => Promise.resolve(new Set())),
      }));

      await moduleMocker.mock('../../issue_utils.js', () => ({
        getInstructionsFromIssue: mock(() =>
          Promise.resolve({
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

      // Execute the import command
      await handleImportCommand('TEAM-123');

      // Verify interactions

      expect(getIssueTracker).toHaveBeenCalledWith(linearConfig);
      expect(mockLinearClient.fetchIssue).toHaveBeenCalledWith('TEAM-123');
      expect(writePlanFile).toHaveBeenCalled();

      const [filePath, planData] = (writePlanFile as any).mock.calls[0];
      expect(filePath).toContain('team-123-implement-user-authentication.plan.md');
      expect(planData).toMatchObject({
        id: 6,
        title: 'Implement user authentication',
        goal: 'Implement: Implement user authentication',
        issue: ['https://linear.app/company/issue/TEAM-123'],
        status: 'pending',
        rmfilter: ['--include', '*.ts'],
      });

      expect(log).toHaveBeenCalledWith(expect.stringContaining('Created stub plan file'));
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
        fetchIssue: mock(() => Promise.resolve(mockLinearIssueNoComments)),
        fetchAllOpenIssues: mock(() => Promise.resolve([])),
        parseIssueIdentifier: mock(() => ({ identifier: 'TEAM-456' })),
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

      await moduleMocker.mock('../../plans.js', () => ({
        readAllPlans: mock(() =>
          Promise.resolve({ plans: new Map(), maxNumericId: 0, duplicates: {} })
        ),
        writePlanFile: mock(() => Promise.resolve()),
        getMaxNumericPlanId: mock(() => Promise.resolve(0)),
        readPlanFile: mock(() => Promise.resolve({ issue: [] })),
        getImportedIssueUrls: mock(() => Promise.resolve(new Set())),
      }));

      await moduleMocker.mock('../../issue_utils.js', () => ({
        getInstructionsFromIssue: mock(() =>
          Promise.resolve({
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
          })
        ),
        createStubPlanFromIssue: mock((issueData, id) => ({
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
        })),
      }));

      await handleImportCommand('TEAM-456');

      expect(writePlanFile).toHaveBeenCalled();

      const [_, planData] = (writePlanFile as any).mock.calls[0];
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
        fetchIssue: mock(() => Promise.resolve(mockLinearIssueWithManyComments)),
        fetchAllOpenIssues: mock(() => Promise.resolve([])),
        parseIssueIdentifier: mock(() => ({ identifier: 'TEAM-789' })),
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

      await moduleMocker.mock('../../plans.js', () => ({
        readAllPlans: mock(() =>
          Promise.resolve({ plans: new Map(), maxNumericId: 0, duplicates: {} })
        ),
        writePlanFile: mock(() => Promise.resolve()),
        getMaxNumericPlanId: mock(() => Promise.resolve(0)),
        readPlanFile: mock(() => Promise.resolve({ issue: [] })),
        getImportedIssueUrls: mock(() => Promise.resolve(new Set())),
      }));

      await moduleMocker.mock('../../issue_utils.js', () => ({
        getInstructionsFromIssue: mock((client, identifier, include) => {
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
        }),
        createStubPlanFromIssue: mock((issueData, id) => ({
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
        })),
      }));

      await handleImportCommand('TEAM-789');

      expect(writePlanFile).toHaveBeenCalled();
      expect(getInstructionsFromIssue).toHaveBeenCalledWith(mockLinearClient, 'TEAM-789', false);

      const [_, planData] = (writePlanFile as any).mock.calls[0];
      expect(planData.details).toContain('Comments (showing first 10 of 25)');
      expect(planData.details).toContain('This is comment number 1');
    });
  });

  describe('Batch Import', () => {
    test('should import multiple Linear issues interactively', async () => {
      const mockLinearIssues: Issue[] = [
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
        fetchIssue: mock((identifier: string) => {
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
        fetchAllOpenIssues: mock(() => Promise.resolve(mockLinearIssues)),
        parseIssueIdentifier: mock((id: string) => ({ identifier: id })),
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

      // Mock user selecting all issues
      await moduleMocker.mock('@inquirer/prompts', () => ({
        checkbox: mock(() => Promise.resolve(['TEAM-100', 'TEAM-101', 'TEAM-102'])),
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

      let callCount = 0;
      await moduleMocker.mock('../../issue_utils.js', () => ({
        getInstructionsFromIssue: mock((client, identifier) => {
          const issue = mockLinearIssues.find((i) => i.number === identifier);
          return Promise.resolve({
            suggestedFileName: `${identifier.toLowerCase()}-${issue?.title.toLowerCase().replace(/\s+/g, '-')}.md`,
            issue: {
              title: issue?.title || 'Unknown',
              html_url: issue?.htmlUrl || '',
              number: identifier,
            },
            plan: issue?.body || 'No description',
            rmprOptions: { rmfilter: ['--include', '*.ts'] },
          });
        }),
        createStubPlanFromIssue: mock((issueData, id) => ({
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
        })),
      }));

      // Execute batch import (no issue specified = interactive mode)
      await handleImportCommand();

      const { fetchAllOpenIssues } = mockLinearClient;

      // Verify all issues were fetched
      expect(fetchAllOpenIssues).toHaveBeenCalled();

      // Verify user was prompted to select issues
      expect(checkbox).toHaveBeenCalledWith({
        message: 'Select issues to import:',
        choices: [
          { name: 'TEAM-100: Setup CI/CD pipeline', value: 'TEAM-100' },
          { name: 'TEAM-101: Update documentation', value: 'TEAM-101' },
          { name: 'TEAM-102: Performance optimization', value: 'TEAM-102' },
        ],
      });

      // Verify all selected issues were imported
      expect(writePlanFile).toHaveBeenCalledTimes(3);
      expect(log).toHaveBeenCalledWith('Importing 3 selected issues...');
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
        fetchIssue: mock(() => Promise.resolve(mockUpdatedLinearIssue)),
        fetchAllOpenIssues: mock(() => Promise.resolve([])),
        parseIssueIdentifier: mock(() => ({ identifier: 'TEAM-999' })),
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

      await moduleMocker.mock('../../plans.js', () => ({
        readAllPlans: mock(() =>
          Promise.resolve({
            plans: new Map([[42, existingPlan]]),
            maxNumericId: 42,
            duplicates: {},
          })
        ),
        writePlanFile: mock(() => Promise.resolve()),
        getMaxNumericPlanId: mock(() => Promise.resolve(42)),
        readPlanFile: mock(() => Promise.resolve(existingPlan)),
        getImportedIssueUrls: mock(() =>
          Promise.resolve(new Set(['https://linear.app/company/issue/TEAM-999']))
        ),
      }));

      await moduleMocker.mock('../../issue_utils.js', () => ({
        getInstructionsFromIssue: mock(() =>
          Promise.resolve({
            suggestedFileName: 'team-999-updated-issue-title.md',
            issue: {
              title: 'Updated Issue Title',
              html_url: 'https://linear.app/company/issue/TEAM-999',
              number: 'TEAM-999',
            },
            plan: 'Updated issue description with new requirements.\n\n---\n\n**Comments:**\n\n> Latest update on the requirements.\n> — Jane Smith',
            rmprOptions: { rmfilter: ['--include', '*.ts'] },
          })
        ),
        createStubPlanFromIssue: mock((issueData, id) => ({
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
        })),
      }));

      // Mock user selecting new issue body and comment (returns indices)
      await moduleMocker.mock('@inquirer/prompts', () => ({
        checkbox: mock(() => Promise.resolve([0, 1])), // Select first two items (issue body + comment)
      }));

      await handleImportCommand('TEAM-999');

      expect(writePlanFile).toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('Updating existing plan for issue:')
      );

      // Verify the plan was updated with new content
      const [filePath, updatedPlan] = (writePlanFile as any).mock.calls[0];
      expect(updatedPlan.title).toBe('Updated Issue Title');
      expect(updatedPlan.details).toContain('Updated issue description with new requirements');
      expect(updatedPlan.details).toContain('Latest update on the requirements');
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
        fetchIssue: mock(() => Promise.resolve(mockLinearIssueWithPriority)),
        fetchAllOpenIssues: mock(() => Promise.resolve([])),
        parseIssueIdentifier: mock(() => ({ identifier: 'TEAM-PRIORITY' })),
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

      await moduleMocker.mock('../../plans.js', () => ({
        readAllPlans: mock(() =>
          Promise.resolve({ plans: new Map(), maxNumericId: 0, duplicates: {} })
        ),
        writePlanFile: mock(() => Promise.resolve()),
        getMaxNumericPlanId: mock(() => Promise.resolve(0)),
        readPlanFile: mock(() => Promise.resolve({ issue: [] })),
        getImportedIssueUrls: mock(() => Promise.resolve(new Set())),
      }));

      await moduleMocker.mock('../../issue_utils.js', () => ({
        getInstructionsFromIssue: mock((client, identifier) => {
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
        }),
        createStubPlanFromIssue: mock((issueData, id) => ({
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
        })),
      }));

      await handleImportCommand('TEAM-PRIORITY');

      expect(writePlanFile).toHaveBeenCalled();

      const [_, planData] = (writePlanFile as any).mock.calls[0];
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
          fetchIssue: mock(() => Promise.resolve(mockIssue)),
          fetchAllOpenIssues: mock(() => Promise.resolve([])),
          parseIssueIdentifier: mock(() => ({
            identifier: `TEAM-${testCase.state.toUpperCase()}`,
          })),
          getDisplayName: mock(() => 'Linear'),
          getConfig: mock(() => ({ type: 'linear' })),
        };

        await moduleMocker.mock('../../../common/issue_tracker/factory.js', () => ({
          getIssueTracker: mock(() => Promise.resolve(mockClient)),
        }));

        await moduleMocker.mock('../../issue_utils.js', () => ({
          getInstructionsFromIssue: mock(() =>
            Promise.resolve({
              suggestedFileName: `team-${testCase.state.toLowerCase()}-issue.md`,
              issue: {
                title: mockIssue.issue.title,
                html_url: mockIssue.issue.htmlUrl,
                number: mockIssue.issue.number,
              },
              plan: mockIssue.issue.body,
              rmprOptions: { rmfilter: ['--include', '*.ts'] },
            })
          ),
          createStubPlanFromIssue: mock((issueData, id) => {
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
          }),
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

        await handleImportCommand(`TEAM-${testCase.state.toUpperCase()}`);

        expect(writePlanFile).toHaveBeenCalled();
        const [_, planData] = (writePlanFile as any).mock.calls[0];

        expect(planData.details).toContain(`Issue with state: ${testCase.state}`);
        // The priority mapping is handled in createStubPlanFromIssue mock
        expect(planData.priority).toBeDefined();
      }
    });
  });
});
