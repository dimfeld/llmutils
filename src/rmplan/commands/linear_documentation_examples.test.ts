import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { handleImportCommand } from './import.js';
import { handleGenerateCommand } from './generate.js';
import { ModuleMocker } from '../../testing.js';
import type {
  IssueTrackerClient,
  IssueWithComments,
  Issue,
} from '../../common/issue_tracker/types.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

const moduleMocker = new ModuleMocker(import.meta);

/**
 * Tests to validate that the Linear integration works as documented in the README and Linear integration docs.
 * These tests verify the specific examples and workflows mentioned in the documentation.
 */
describe('Linear Documentation Examples Validation', () => {
  let tempDir: string;
  let tasksDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'linear-doc-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Common mocks used in documentation examples
    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: mock(() => Promise.resolve(tempDir)),
    }));

    await moduleMocker.mock('../../logging.js', () => ({
      log: mock(),
      warn: mock(),
      error: mock(),
    }));

    await moduleMocker.mock('../../rmpr/comment_options.js', () => ({
      parseCommandOptionsFromComment: mock(() => ({ options: null })),
      combineRmprOptions: mock(() => ({ rmfilter: ['--include', '*.ts'] })),
    }));

    await moduleMocker.mock('../../common/formatting.js', () => ({
      singleLineWithPrefix: mock((prefix, text) => prefix + text),
      limitLines: mock((text) => text),
    }));

    await moduleMocker.mock('@inquirer/prompts', () => ({
      checkbox: mock(() => Promise.resolve([])),
    }));

    await moduleMocker.mock('../plans.js', () => ({
      readAllPlans: mock(() =>
        Promise.resolve({ plans: new Map(), maxNumericId: 5, duplicates: {} })
      ),
      writePlanFile: mock(() => Promise.resolve()),
      getMaxNumericPlanId: mock(() => Promise.resolve(5)),
      readPlanFile: mock(() => Promise.resolve({ issue: [] })),
      getImportedIssueUrls: mock(() => Promise.resolve(new Set())),
    }));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
    await moduleMocker.clear();
  });

  describe('README.md Examples', () => {
    test('should handle TEAM-456 issue example from README', async () => {
      // This validates the specific example: rmplan generate --issue TEAM-456 -- src/**/*.ts
      const mockLinearIssue: IssueWithComments = {
        issue: {
          id: 'issue-uuid-456',
          number: 'TEAM-456',
          title: 'Implement user authentication',
          body: '## Problem\n\nUsers need to authenticate to access protected resources in our application.\n\n## Solution\n\nImplement JWT-based authentication with the following components:\n- Login/registration endpoints\n- JWT token generation and validation\n- Protected route middleware\n- User session management',
          htmlUrl: 'https://linear.app/workspace/issue/TEAM-456',
          state: 'Todo',
          createdAt: '2024-01-15T10:30:00.000Z',
          updatedAt: '2024-01-16T14:22:00.000Z',
          user: {
            id: 'user-123',
            name: 'John Doe',
            email: 'john@company.com',
            login: 'johndoe',
          },
          pullRequest: false,
        },
        comments: [
          {
            id: 'comment-oauth',
            body: 'We should also consider implementing OAuth for social login integration.',
            createdAt: '2024-01-16T09:15:00.000Z',
            updatedAt: '2024-01-16T09:15:00.000Z',
            user: {
              id: 'user-alice',
              name: 'Alice Johnson',
              email: 'alice@company.com',
              login: 'alice',
            },
          },
          {
            id: 'comment-2fa',
            body: "Good point! Let's also add support for refresh tokens.",
            createdAt: '2024-01-16T10:30:00.000Z',
            updatedAt: '2024-01-16T10:30:00.000Z',
            user: {
              id: 'user-bob',
              name: 'Bob Smith',
              email: 'bob@company.com',
              login: 'bob',
            },
          },
        ],
      };

      const mockLinearClient: IssueTrackerClient = {
        fetchIssue: mock(() => Promise.resolve(mockLinearIssue)),
        fetchAllOpenIssues: mock(() => Promise.resolve([])),
        parseIssueIdentifier: mock(() => ({ identifier: 'TEAM-456' })),
        getDisplayName: mock(() => 'Linear'),
        getConfig: mock(() => ({ type: 'linear' })),
      };

      const linearConfig = {
        issueTracker: 'linear' as const,
        paths: { tasks: './tasks' },
        models: { planning: 'google/gemini-2.5-flash-preview-05-20' },
      };

      await moduleMocker.mock('../configLoader.js', () => ({
        loadEffectiveConfig: mock(() => Promise.resolve(linearConfig)),
      }));

      await moduleMocker.mock('../../common/issue_tracker/factory.js', () => ({
        getIssueTracker: mock(() => Promise.resolve(mockLinearClient)),
      }));

      await moduleMocker.mock('../issue_utils.js', () => ({
        getInstructionsFromIssue: mock(() =>
          Promise.resolve({
            suggestedFileName: 'team-456-implement-user-authentication.md',
            issue: {
              title: 'Implement user authentication',
              html_url: 'https://linear.app/workspace/issue/TEAM-456',
              number: 'TEAM-456',
            },
            plan: "## Problem\n\nUsers need to authenticate to access protected resources in our application.\n\n## Solution\n\nImplement JWT-based authentication with the following components:\n- Login/registration endpoints\n- JWT token generation and validation\n- Protected route middleware\n- User session management\n\n---\n\n**Comments:**\n\n> We should also consider implementing OAuth for social login integration.\n> — Alice Johnson (2024-01-16)\n\n> Good point! Let's also add support for refresh tokens.\n> — Bob Smith (2024-01-16)",
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

      // Execute import to create plan file structure as documented
      await handleImportCommand('TEAM-456');

      // Verify the issue structure matches documentation examples
      const { writePlanFile } = await import('../plans.js');
      const { log } = await import('../../logging.js');

      expect(writePlanFile).toHaveBeenCalled();
      const [filePath, planData] = (writePlanFile as any).mock.calls[0];
      
      // Validate file naming matches documentation
      expect(filePath).toContain('team-456-implement-user-authentication.plan.md');
      
      // Validate plan structure matches README example
      expect(planData).toMatchObject({
        id: 6,
        title: 'Implement user authentication',
        goal: 'Implement: Implement user authentication',
        issue: ['https://linear.app/workspace/issue/TEAM-456'],
        status: 'pending',
        rmfilter: ['--include', '*.ts'],
      });

      // Validate comment integration as documented
      expect(planData.details).toContain('Alice Johnson');
      expect(planData.details).toContain('Bob Smith');
      expect(planData.details).toContain('OAuth for social login');
      expect(planData.details).toContain('refresh tokens');

      expect(log).toHaveBeenCalledWith(expect.stringContaining('Created stub plan file'));
    });

    test('should support Linear URLs as documented', async () => {
      // Tests the example: rmplan import https://linear.app/workspace/issue/TEAM-123
      const mockLinearIssue: IssueWithComments = {
        issue: {
          id: 'issue-uuid-123',
          number: 'TEAM-123',
          title: 'Fix authentication bug',
          body: 'The login form is not working correctly after the recent update.',
          htmlUrl: 'https://linear.app/workspace/issue/TEAM-123',
          state: 'In Progress',
          createdAt: '2024-01-15T10:30:00.000Z',
          updatedAt: '2024-01-15T10:30:00.000Z',
          user: {
            id: 'user-123',
            name: 'Developer',
            login: 'dev',
          },
          pullRequest: false,
        },
        comments: [
          {
            id: 'comment-debug',
            body: 'I noticed the issue occurs when users have special characters in their passwords.',
            createdAt: '2024-01-15T11:00:00.000Z',
            updatedAt: '2024-01-15T11:00:00.000Z',
            user: {
              id: 'user-tester',
              name: 'QA Tester',
              login: 'qa',
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
        paths: { tasks: './tasks' },
      };

      await moduleMocker.mock('../configLoader.js', () => ({
        loadEffectiveConfig: mock(() => Promise.resolve(linearConfig)),
      }));

      await moduleMocker.mock('../../common/issue_tracker/factory.js', () => ({
        getIssueTracker: mock(() => Promise.resolve(mockLinearClient)),
      }));

      await moduleMocker.mock('../issue_utils.js', () => ({
        getInstructionsFromIssue: mock(() =>
          Promise.resolve({
            suggestedFileName: 'team-123-fix-authentication-bug.md',
            issue: {
              title: 'Fix authentication bug',
              html_url: 'https://linear.app/workspace/issue/TEAM-123',
              number: 'TEAM-123',
            },
            plan: "The login form is not working correctly after the recent update.\n\n---\n\n**Comments:**\n\n> I noticed the issue occurs when users have special characters in their passwords.\n> — QA Tester (2024-01-15)",
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

      // Test import with full URL (as documented)
      await handleImportCommand('https://linear.app/workspace/issue/TEAM-123');

      const { getIssueTracker } = await import('../../common/issue_tracker/factory.js');
      const { writePlanFile } = await import('../plans.js');

      expect(getIssueTracker).toHaveBeenCalledWith(linearConfig);
      expect(writePlanFile).toHaveBeenCalled();

      const [filePath, planData] = (writePlanFile as any).mock.calls[0];
      expect(filePath).toContain('team-123-fix-authentication-bug.plan.md');
      expect(planData.issue).toEqual(['https://linear.app/workspace/issue/TEAM-123']);
    });
  });

  describe('Linear Integration Documentation Examples', () => {
    test('should demonstrate interactive import workflow as documented', async () => {
      // Tests the interactive selection example from linear-integration.md
      const mockLinearIssues: Issue[] = [
        {
          id: 'issue-123',
          number: 'TEAM-123',
          title: 'Implement user authentication',
          body: 'Add JWT-based authentication system.',
          htmlUrl: 'https://linear.app/mycompany/issue/TEAM-123',
          state: 'Todo',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          user: { id: 'user-1', name: 'Developer 1', login: 'dev1' },
          pullRequest: false,
        },
        {
          id: 'issue-124',
          number: 'TEAM-124',
          title: 'Add password reset functionality',
          body: 'Users need to be able to reset forgotten passwords.',
          htmlUrl: 'https://linear.app/mycompany/issue/TEAM-124',
          state: 'Todo',
          createdAt: '2024-01-02T00:00:00.000Z',
          updatedAt: '2024-01-02T00:00:00.000Z',
          user: { id: 'user-2', name: 'Developer 2', login: 'dev2' },
          pullRequest: false,
        },
        {
          id: 'issue-125',
          number: 'TEAM-125',
          title: 'Create user profile page',
          body: 'Design and implement user profile management.',
          htmlUrl: 'https://linear.app/mycompany/issue/TEAM-125',
          state: 'Todo',
          createdAt: '2024-01-03T00:00:00.000Z',
          updatedAt: '2024-01-03T00:00:00.000Z',
          user: { id: 'user-3', name: 'Designer', login: 'designer' },
          pullRequest: false,
        },
        {
          id: 'issue-proj-001',
          number: 'PROJ-001',
          title: 'Database migration for user roles',
          body: 'Update database schema to support role-based access.',
          htmlUrl: 'https://linear.app/mycompany/issue/PROJ-001',
          state: 'Todo',
          createdAt: '2024-01-04T00:00:00.000Z',
          updatedAt: '2024-01-04T00:00:00.000Z',
          user: { id: 'user-4', name: 'Backend Developer', login: 'backend' },
          pullRequest: false,
        },
      ];

      const mockLinearClient: IssueTrackerClient = {
        fetchIssue: mock((identifier: string) => {
          const issue = mockLinearIssues.find((i) => i.number === identifier);
          if (!issue) throw new Error('Issue not found');

          return Promise.resolve({
            issue,
            comments: [],
          });
        }),
        fetchAllOpenIssues: mock(() => Promise.resolve(mockLinearIssues)),
        parseIssueIdentifier: mock((id: string) => ({ identifier: id })),
        getDisplayName: mock(() => 'Linear'),
        getConfig: mock(() => ({ type: 'linear' })),
      };

      const linearConfig = {
        issueTracker: 'linear' as const,
        paths: { tasks: './tasks' },
      };

      await moduleMocker.mock('../configLoader.js', () => ({
        loadEffectiveConfig: mock(() => Promise.resolve(linearConfig)),
      }));

      await moduleMocker.mock('../../common/issue_tracker/factory.js', () => ({
        getIssueTracker: mock(() => Promise.resolve(mockLinearClient)),
      }));

      // Mock user selecting the first two issues (TEAM-123 and TEAM-124)
      await moduleMocker.mock('@inquirer/prompts', () => ({
        checkbox: mock(() => Promise.resolve(['TEAM-123', 'TEAM-124'])),
      }));

      await moduleMocker.mock('../issue_utils.js', () => ({
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

      // Execute interactive import (no issue specified = interactive mode)
      await handleImportCommand();

      const { fetchAllOpenIssues } = mockLinearClient;
      const { checkbox } = await import('@inquirer/prompts');
      const { writePlanFile } = await import('../plans.js');
      const { log } = await import('../../logging.js');

      // Verify the workflow matches the documentation
      expect(fetchAllOpenIssues).toHaveBeenCalled();

      // Verify prompt shows the correct format as documented
      expect(checkbox).toHaveBeenCalledWith({
        message: 'Select issues to import:',
        choices: [
          { name: 'TEAM-123: Implement user authentication', value: 'TEAM-123' },
          { name: 'TEAM-124: Add password reset functionality', value: 'TEAM-124' },
          { name: 'TEAM-125: Create user profile page', value: 'TEAM-125' },
          { name: 'PROJ-001: Database migration for user roles', value: 'PROJ-001' },
        ],
      });

      // Verify selected issues were imported
      expect(writePlanFile).toHaveBeenCalledTimes(2);
      expect(log).toHaveBeenCalledWith('Importing 2 selected issues...');

      // Verify the log messages match expected format
      expect(log).toHaveBeenCalledWith('Found 4 open issues.');
    });

    test('should generate plan files with Linear-specific metadata format', async () => {
      // Validates the generated plan file structure shown in documentation
      const mockLinearIssue: IssueWithComments = {
        issue: {
          id: 'linear-issue-id-7',
          number: 'TEAM-007',
          title: 'Implement user authentication',
          body: '## Problem\n\nUsers need to authenticate to access protected resources in our application.\n\n## Solution\n\nImplement JWT-based authentication with the following components:\n- Login/registration endpoints\n- JWT token generation and validation\n- Protected route middleware\n- User session management',
          htmlUrl: 'https://linear.app/mycompany/issue/TEAM-007',
          state: 'Todo',
          createdAt: '2024-01-15T10:30:00.000Z',
          updatedAt: '2024-01-16T10:30:00.000Z',
          user: {
            id: 'user-creator',
            name: 'Issue Creator',
            login: 'creator',
          },
          pullRequest: false,
        },
        comments: [
          {
            id: 'comment-oauth-suggestion',
            body: 'We should also consider implementing OAuth for social login integration.',
            createdAt: '2024-01-15T12:00:00.000Z',
            updatedAt: '2024-01-15T12:00:00.000Z',
            user: {
              id: 'user-alice',
              name: 'Alice Johnson',
              login: 'alice',
            },
          },
          {
            id: 'comment-refresh-tokens',
            body: "Good point! Let's also add support for refresh tokens.",
            createdAt: '2024-01-16T09:00:00.000Z',
            updatedAt: '2024-01-16T09:00:00.000Z',
            user: {
              id: 'user-bob',
              name: 'Bob Smith',
              login: 'bob',
            },
          },
        ],
      };

      const mockLinearClient: IssueTrackerClient = {
        fetchIssue: mock(() => Promise.resolve(mockLinearIssue)),
        fetchAllOpenIssues: mock(() => Promise.resolve([])),
        parseIssueIdentifier: mock(() => ({ identifier: 'TEAM-007' })),
        getDisplayName: mock(() => 'Linear'),
        getConfig: mock(() => ({ type: 'linear' })),
      };

      const linearConfig = {
        issueTracker: 'linear' as const,
        paths: { tasks: './tasks' },
      };

      await moduleMocker.mock('../configLoader.js', () => ({
        loadEffectiveConfig: mock(() => Promise.resolve(linearConfig)),
      }));

      await moduleMocker.mock('../../common/issue_tracker/factory.js', () => ({
        getIssueTracker: mock(() => Promise.resolve(mockLinearClient)),
      }));

      await moduleMocker.mock('../issue_utils.js', () => ({
        getInstructionsFromIssue: mock(() =>
          Promise.resolve({
            suggestedFileName: 'team-007-implement-user-authentication.md',
            issue: {
              title: 'Implement user authentication',
              html_url: 'https://linear.app/mycompany/issue/TEAM-007',
              number: 'TEAM-007',
            },
            plan: "## Problem\n\nUsers need to authenticate to access protected resources in our application.\n\n## Solution\n\nImplement JWT-based authentication with the following components:\n- Login/registration endpoints\n- JWT token generation and validation\n- Protected route middleware\n- User session management\n\n---\n\n**Comments:**\n\n> We should also consider implementing OAuth for social login integration.\n> — Alice Johnson (2024-01-15)\n\n> Good point! Let's also add support for refresh tokens.\n> — Bob Smith (2024-01-16)",
            rmprOptions: {
              rmfilter: ['--include', '*.ts'],
            },
          })
        ),
        createStubPlanFromIssue: mock((issueData, id) => ({
          id: 7, // Matches documentation example
          title: issueData.issue.title,
          goal: `Implement: ${issueData.issue.title}`,
          details: issueData.plan,
          status: 'pending',
          issue: [issueData.issue.html_url],
          tasks: [],
          createdAt: '2024-01-16T10:30:00.000Z',
          updatedAt: '2024-01-16T10:30:00.000Z',
          rmfilter: issueData.rmprOptions?.rmfilter || [],
        })),
      }));

      await handleImportCommand('TEAM-007');

      const { writePlanFile } = await import('../plans.js');
      expect(writePlanFile).toHaveBeenCalled();

      const [_, planData] = (writePlanFile as any).mock.calls[0];

      // Validate the structure matches the documentation example exactly
      expect(planData).toMatchObject({
        id: 7,
        title: 'Implement user authentication',
        goal: 'Implement: Implement user authentication',
        status: 'pending',
        issue: ['https://linear.app/mycompany/issue/TEAM-007'],
        tasks: [],
        createdAt: '2024-01-16T10:30:00.000Z',
        updatedAt: '2024-01-16T10:30:00.000Z',
      });

      // Validate comment formatting matches documentation
      expect(planData.details).toContain('## Problem');
      expect(planData.details).toContain('## Solution');
      expect(planData.details).toContain('**Comments:**');
      expect(planData.details).toContain('> We should also consider implementing OAuth');
      expect(planData.details).toContain('— Alice Johnson (2024-01-15)');
      expect(planData.details).toContain('> Good point! Let\'s also add support for refresh tokens');
      expect(planData.details).toContain('— Bob Smith (2024-01-16)');
    });

    test('should validate standard Linear issue ID format TEAM-123', async () => {
      // Tests standard team-number format mentioned in documentation
      const mockLinearIssue: IssueWithComments = {
        issue: {
          id: 'issue-TEAM-123',
          number: 'TEAM-123',
          title: 'Test issue for TEAM-123',
          body: 'This is test issue TEAM-123',
          htmlUrl: 'https://linear.app/workspace/issue/TEAM-123',
          state: 'Todo',
          createdAt: '2024-01-15T10:30:00.000Z',
          updatedAt: '2024-01-15T10:30:00.000Z',
          user: { id: 'user-test', name: 'Test User', login: 'test' },
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
        paths: { tasks: './tasks' },
      };

      await moduleMocker.mock('../configLoader.js', () => ({
        loadEffectiveConfig: mock(() => Promise.resolve(linearConfig)),
      }));

      await moduleMocker.mock('../../common/issue_tracker/factory.js', () => ({
        getIssueTracker: mock(() => Promise.resolve(mockLinearClient)),
      }));

      await moduleMocker.mock('../issue_utils.js', () => ({
        getInstructionsFromIssue: mock(() =>
          Promise.resolve({
            suggestedFileName: 'team-123-test-issue.md',
            issue: {
              title: 'Test issue for TEAM-123',
              html_url: 'https://linear.app/workspace/issue/TEAM-123',
              number: 'TEAM-123',
            },
            plan: 'This is test issue TEAM-123',
            rmprOptions: { rmfilter: ['--include', '*.ts'] },
          })
        ),
        createStubPlanFromIssue: mock((issueData, id) => ({
          id,
          title: issueData.issue.title,
          goal: `Test: ${issueData.issue.title}`,
          details: issueData.plan,
          status: 'pending',
          issue: [issueData.issue.html_url],
          tasks: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          rmfilter: issueData.rmprOptions?.rmfilter || [],
        })),
      }));

      // Test the import with standard format
      await handleImportCommand('TEAM-123');

      expect(mockLinearClient.fetchIssue).toHaveBeenCalledWith('TEAM-123');
    });
  });

  describe('Output Format Validation', () => {
    test('should display status messages matching documentation examples', async () => {
      // Validates the exact output format shown in the documentation
      const mockLinearIssue: IssueWithComments = {
        issue: {
          id: 'issue-status-test',
          number: 'TEAM-123',
          title: 'Implement user authentication',
          body: 'Test issue for status validation',
          htmlUrl: 'https://linear.app/mycompany/issue/TEAM-123',
          state: 'Todo',
          createdAt: '2024-01-15T10:30:00.000Z',
          updatedAt: '2024-01-15T10:30:00.000Z',
          user: { id: 'user-test', name: 'Test User' },
          pullRequest: false,
        },
        comments: [
          { id: 'c1', body: 'Comment 1', createdAt: '2024-01-15T11:00:00.000Z', updatedAt: '2024-01-15T11:00:00.000Z', user: { id: 'u1', name: 'User 1' } },
          { id: 'c2', body: 'Comment 2', createdAt: '2024-01-15T12:00:00.000Z', updatedAt: '2024-01-15T12:00:00.000Z', user: { id: 'u2', name: 'User 2' } },
          { id: 'c3', body: 'Comment 3', createdAt: '2024-01-15T13:00:00.000Z', updatedAt: '2024-01-15T13:00:00.000Z', user: { id: 'u3', name: 'User 3' } },
        ],
      };

      const mockLinearClient: IssueTrackerClient = {
        fetchIssue: mock(() => Promise.resolve(mockLinearIssue)),
        fetchAllOpenIssues: mock(() => Promise.resolve([])),
        parseIssueIdentifier: mock(() => ({ identifier: 'TEAM-123' })),
        getDisplayName: mock(() => 'MyCompany'), // Workspace name
        getConfig: mock(() => ({ type: 'linear' })),
      };

      const linearConfig = {
        issueTracker: 'linear' as const,
        paths: { tasks: './tasks' },
      };

      await moduleMocker.mock('../configLoader.js', () => ({
        loadEffectiveConfig: mock(() => Promise.resolve(linearConfig)),
      }));

      await moduleMocker.mock('../../common/issue_tracker/factory.js', () => ({
        getIssueTracker: mock(() => Promise.resolve(mockLinearClient)),
      }));

      await moduleMocker.mock('../issue_utils.js', () => ({
        getInstructionsFromIssue: mock(() =>
          Promise.resolve({
            suggestedFileName: 'team-123-implement-user-authentication.md',
            issue: {
              title: 'Implement user authentication',
              html_url: 'https://linear.app/mycompany/issue/TEAM-123',
              number: 'TEAM-123',
            },
            plan: 'Test issue for status validation',
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
        })),
      }));

      await handleImportCommand('TEAM-123');

      const { log } = await import('../../logging.js');

      // Validate the actual log messages from the implementation
      const logCalls = (log as any).mock.calls.map((call: any[]) => call[0]);

      expect(logCalls).toContainEqual('Importing issue: TEAM-123');
      expect(logCalls).toContainEqual(expect.stringContaining('Created stub plan file'));
      expect(logCalls).toContainEqual('Plan ID: 6');
      expect(logCalls).toContainEqual('Use "rmplan generate" to add tasks to this plan.');
    });
  });
});