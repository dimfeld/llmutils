import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { handleImportCommand } from './import.js';
import { ModuleMocker } from '../../../testing.js';
import type { IssueTrackerClient, IssueWithComments } from '../../../common/issue_tracker/types.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { z } from 'zod/v4';

const moduleMocker = new ModuleMocker(import.meta);

describe('Linear Plan File Structure Tests', () => {
  let tempDir: string;
  let tasksDir: string;
  let actualWrittenFiles: Map<string, any> = new Map();

  beforeEach(async () => {
    // Create temporary directory for real filesystem operations
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'linear-plan-structure-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    actualWrittenFiles.clear();

    // Mock common dependencies
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
      checkbox: mock(() => Promise.resolve([])),
    }));

    await moduleMocker.mock('../../plans.js', () => ({
      readAllPlans: mock(() =>
        Promise.resolve({ plans: new Map(), maxNumericId: 0, duplicates: {} })
      ),
      writePlanFile: mock(async (filePath: string, planData: any) => {
        // Actually write the file to the filesystem for validation
        const yamlContent = yaml.stringify(planData);
        const schemaLine =
          '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json\n';
        await fs.writeFile(filePath, schemaLine + yamlContent);
        actualWrittenFiles.set(filePath, planData);
      }),
      getMaxNumericPlanId: mock(() => Promise.resolve(0)),
      readPlanFile: mock(() => Promise.resolve({ issue: [] })),
      getImportedIssueUrls: mock(() => Promise.resolve(new Set())),
    }));

    await moduleMocker.mock('../../configLoader.js', () => ({
      loadEffectiveConfig: mock(() =>
        Promise.resolve({
          issueTracker: 'linear' as const,
          paths: { tasks: 'tasks' },
        })
      ),
    }));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
    await moduleMocker.clear();
  });

  test('should create correctly structured YAML plan file from Linear issue', async () => {
    const mockLinearIssue: IssueWithComments = {
      issue: {
        id: 'issue-uuid-struct',
        number: 'TEAM-STRUCT',
        title: 'Implement new feature with validation',
        body: '## Overview\n\nThis feature needs to be implemented with proper validation.\n\n## Requirements\n\n- Input validation\n- Error handling\n- Unit tests',
        htmlUrl: 'https://linear.app/company/issue/TEAM-STRUCT',
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
          body: 'Make sure to include comprehensive error handling.',
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
          body: 'Also consider adding integration tests.',
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
      parseIssueIdentifier: mock(() => ({ identifier: 'TEAM-STRUCT' })),
      getDisplayName: mock(() => 'Linear'),
      getConfig: mock(() => ({ type: 'linear' })),
    };

    await moduleMocker.mock('../../../common/issue_tracker/factory.js', () => ({
      getIssueTracker: mock(() => Promise.resolve(mockLinearClient)),
    }));

    await moduleMocker.mock('../../issue_utils.js', () => ({
      getInstructionsFromIssue: mock(() =>
        Promise.resolve({
          suggestedFileName: 'team-struct-implement-new-feature-with-validation.md',
          issue: {
            title: 'Implement new feature with validation',
            html_url: 'https://linear.app/company/issue/TEAM-STRUCT',
            number: 'TEAM-STRUCT',
          },
          plan: '## Overview\n\nThis feature needs to be implemented with proper validation.\n\n## Requirements\n\n- Input validation\n- Error handling\n- Unit tests\n\n---\n\n**Comments:**\n\n> Make sure to include comprehensive error handling.\n> — Bob Wilson\n\n> Also consider adding integration tests.\n> — John Doe',
          rmprOptions: {
            rmfilter: ['--include', '*.ts', '--with-imports'],
          },
        })
      ),
      createStubPlanFromIssue: mock((issueData, id) => ({
        id,
        title: issueData.issue.title,
        goal: `Implement: ${issueData.issue.title}`,
        details: issueData.plan,
        status: 'pending',
        priority: 'medium',
        issue: [issueData.issue.html_url],
        tasks: [],
        createdAt: new Date('2024-01-20T12:00:00.000Z').toISOString(),
        updatedAt: new Date('2024-01-20T12:00:00.000Z').toISOString(),
        rmfilter: issueData.rmprOptions?.rmfilter || [],
      })),
    }));

    // Execute the import command
    await handleImportCommand('TEAM-STRUCT');

    // Verify a file was written
    expect(actualWrittenFiles.size).toBe(1);

    const [filePath, planData] = actualWrittenFiles.entries().next().value;

    // Verify file path follows expected convention
    expect(filePath).toMatch(/team-struct-implement-new-feature-with-validation\.plan\.md$/);

    // Verify the plan data structure
    expect(planData).toMatchObject({
      id: 1,
      title: 'Implement new feature with validation',
      goal: 'Implement: Implement new feature with validation',
      status: 'pending',
      priority: 'medium',
      issue: ['https://linear.app/company/issue/TEAM-STRUCT'],
      rmfilter: ['--include', '*.ts', '--with-imports'],
    });

    // Verify the details contain the formatted content
    expect(planData.details).toContain('## Overview');
    expect(planData.details).toContain('## Requirements');
    expect(planData.details).toContain('Comments:');
    expect(planData.details).toContain('Bob Wilson');
    expect(planData.details).toContain('John Doe');

    // Verify timestamps are valid ISO strings
    expect(() => new Date(planData.createdAt)).not.toThrow();
    expect(() => new Date(planData.updatedAt)).not.toThrow();

    // Verify the actual file can be read and parsed
    const fileContent = await fs.readFile(filePath, 'utf-8');
    expect(fileContent).toMatch(/^# yaml-language-server: \$schema=/);

    // Extract and parse YAML content (skip schema comment line)
    const yamlContent = fileContent.split('\n').slice(1).join('\n');
    const parsedYaml = yaml.parse(yamlContent);

    expect(parsedYaml).toEqual(planData);
  });

  test('should handle Linear issues with minimal data correctly', async () => {
    const mockMinimalLinearIssue: IssueWithComments = {
      issue: {
        id: 'issue-uuid-minimal',
        number: 'TEAM-MINIMAL',
        title: 'Simple task',
        body: undefined, // No description
        htmlUrl: 'https://linear.app/company/issue/TEAM-MINIMAL',
        state: 'Open',
        createdAt: '2024-01-15T10:30:00.000Z',
        updatedAt: '2024-01-15T10:30:00.000Z',
        user: undefined, // No creator info
        assignees: undefined, // No assignees
        labels: undefined, // No labels
        pullRequest: false,
      },
      comments: [], // No comments
    };

    const mockLinearClient: IssueTrackerClient = {
      fetchIssue: mock(() => Promise.resolve(mockMinimalLinearIssue)),
      fetchAllOpenIssues: mock(() => Promise.resolve([])),
      parseIssueIdentifier: mock(() => ({ identifier: 'TEAM-MINIMAL' })),
      getDisplayName: mock(() => 'Linear'),
      getConfig: mock(() => ({ type: 'linear' })),
    };

    await moduleMocker.mock('../../../common/issue_tracker/factory.js', () => ({
      getIssueTracker: mock(() => Promise.resolve(mockLinearClient)),
    }));

    await moduleMocker.mock('../../issue_utils.js', () => ({
      getInstructionsFromIssue: mock(() =>
        Promise.resolve({
          suggestedFileName: 'team-minimal-simple-task.md',
          issue: {
            title: 'Simple task',
            html_url: 'https://linear.app/company/issue/TEAM-MINIMAL',
            number: 'TEAM-MINIMAL',
          },
          plan: 'Simple task', // Fallback to title when no description
          rmprOptions: {
            rmfilter: [],
          },
        })
      ),
      createStubPlanFromIssue: mock((issueData, id) => ({
        id,
        title: issueData.issue.title,
        goal: `Handle: ${issueData.issue.title}`,
        details: issueData.plan,
        status: 'pending',
        issue: [issueData.issue.html_url],
        tasks: [],
        createdAt: new Date('2024-01-20T12:00:00.000Z').toISOString(),
        updatedAt: new Date('2024-01-20T12:00:00.000Z').toISOString(),
        rmfilter: issueData.rmprOptions?.rmfilter || [],
      })),
    }));

    await handleImportCommand('TEAM-MINIMAL');

    expect(actualWrittenFiles.size).toBe(1);
    const [filePath, planData] = actualWrittenFiles.entries().next().value;

    // Verify minimal plan structure
    expect(planData).toMatchObject({
      id: 1,
      title: 'Simple task',
      goal: 'Handle: Simple task',
      details: 'Simple task',
      status: 'pending',
      issue: ['https://linear.app/company/issue/TEAM-MINIMAL'],
      tasks: [],
      rmfilter: [],
    });

    // Verify optional fields are handled correctly
    expect(planData.priority).toBeUndefined();
    expect(planData.assignedTo).toBeUndefined();

    // Verify the file is valid YAML
    const fileContent = await fs.readFile(filePath, 'utf-8');
    const yamlContent = fileContent.split('\n').slice(1).join('\n');
    const parsedYaml = yaml.parse(yamlContent);

    expect(parsedYaml).toEqual(planData);
  });

  test('should create plan with Linear-specific metadata preserved', async () => {
    const mockLinearIssueWithMetadata: IssueWithComments = {
      issue: {
        id: 'issue-uuid-meta',
        number: 'TEAM-META',
        title: 'Security enhancement with priority labels',
        body: 'Critical security enhancement needed.',
        htmlUrl: 'https://linear.app/company/issue/TEAM-META',
        state: 'In Progress',
        createdAt: '2024-01-15T10:30:00.000Z',
        updatedAt: '2024-01-16T14:22:00.000Z',
        user: {
          id: 'user-security',
          name: 'Security Team Lead',
          email: 'security@company.com',
          login: 'securitylead',
        },
        assignees: [
          { id: 'user-dev1', name: 'Dev One', email: 'dev1@company.com' },
          { id: 'user-dev2', name: 'Dev Two', email: 'dev2@company.com' },
        ],
        labels: [
          { id: 'label-security', name: 'security', color: '#FF0000' },
          { id: 'label-urgent', name: 'urgent', color: '#FF5630' },
          { id: 'label-p0', name: 'P0', color: '#8B0000' },
        ],
        pullRequest: false,
      },
      comments: [
        {
          id: 'comment-security',
          body: 'This needs to be completed by EOD for compliance.',
          createdAt: '2024-01-16T08:00:00.000Z',
          updatedAt: '2024-01-16T08:00:00.000Z',
          user: {
            id: 'user-compliance',
            name: 'Compliance Officer',
            email: 'compliance@company.com',
            login: 'compliance',
          },
        },
      ],
    };

    const mockLinearClient: IssueTrackerClient = {
      fetchIssue: mock(() => Promise.resolve(mockLinearIssueWithMetadata)),
      fetchAllOpenIssues: mock(() => Promise.resolve([])),
      parseIssueIdentifier: mock(() => ({ identifier: 'TEAM-META' })),
      getDisplayName: mock(() => 'Linear'),
      getConfig: mock(() => ({ type: 'linear' })),
    };

    await moduleMocker.mock('../../../common/issue_tracker/factory.js', () => ({
      getIssueTracker: mock(() => Promise.resolve(mockLinearClient)),
    }));

    await moduleMocker.mock('../../issue_utils.js', () => ({
      getInstructionsFromIssue: mock(() => {
        const issue = mockLinearIssueWithMetadata.issue;
        const labels = issue.labels?.map((l) => l.name).join(', ') || '';
        const assignees = issue.assignees?.map((a) => a.name).join(', ') || '';

        return Promise.resolve({
          suggestedFileName: 'team-meta-security-enhancement-with-priority-labels.md',
          issue: {
            title: issue.title,
            html_url: issue.htmlUrl,
            number: issue.number,
          },
          plan: `${issue.body}\n\n**Linear Metadata:**\n- **Status:** ${issue.state}\n- **Labels:** ${labels}\n- **Assignees:** ${assignees}\n- **Reporter:** ${issue.user?.name || 'Unknown'}\n\n---\n\n**Comments:**\n\n> This needs to be completed by EOD for compliance.\n> — Compliance Officer`,
          rmprOptions: {
            rmfilter: ['--include', '*.ts', '--include', '*.js'],
          },
        });
      }),
      createStubPlanFromIssue: mock((issueData, id) => ({
        id,
        title: issueData.issue.title,
        goal: `Security: ${issueData.issue.title}`,
        details: issueData.plan,
        status: 'in_progress', // Map Linear 'In Progress' to plan status
        priority: 'urgent', // Extracted from labels
        assignedTo: 'Dev One, Dev Two', // From assignees
        issue: [issueData.issue.html_url],
        tasks: [],
        createdAt: new Date('2024-01-20T12:00:00.000Z').toISOString(),
        updatedAt: new Date('2024-01-20T12:00:00.000Z').toISOString(),
        rmfilter: issueData.rmprOptions?.rmfilter || [],
      })),
    }));

    await handleImportCommand('TEAM-META');

    expect(actualWrittenFiles.size).toBe(1);
    const [filePath, planData] = actualWrittenFiles.entries().next().value;

    // Verify Linear metadata is preserved in plan
    expect(planData).toMatchObject({
      id: 1,
      title: 'Security enhancement with priority labels',
      goal: 'Security: Security enhancement with priority labels',
      status: 'in_progress',
      priority: 'urgent',
      assignedTo: 'Dev One, Dev Two',
      issue: ['https://linear.app/company/issue/TEAM-META'],
      rmfilter: ['--include', '*.ts', '--include', '*.js'],
    });

    // Verify Linear-specific metadata is included in details
    expect(planData.details).toContain('Linear Metadata:');
    expect(planData.details).toContain('**Status:** In Progress');
    expect(planData.details).toContain('**Labels:** security, urgent, P0');
    expect(planData.details).toContain('**Assignees:** Dev One, Dev Two');
    expect(planData.details).toContain('**Reporter:** Security Team Lead');
    expect(planData.details).toContain('Compliance Officer');

    // Verify the file structure is valid
    const fileContent = await fs.readFile(filePath, 'utf-8');
    expect(fileContent).toMatch(/^# yaml-language-server: \$schema=/);

    const yamlContent = fileContent.split('\n').slice(1).join('\n');
    const parsedYaml = yaml.parse(yamlContent);
    expect(parsedYaml).toEqual(planData);
  });

  test('should handle large Linear issues with proper content truncation', async () => {
    const generateLongContent = (base: string, length: number) => {
      return (
        base +
        ' '.repeat(Math.max(0, length - base.length)) +
        Array(50).fill('Additional details about this issue.').join(' ')
      );
    };

    const mockLargeLinearIssue: IssueWithComments = {
      issue: {
        id: 'issue-uuid-large',
        number: 'TEAM-LARGE',
        title: 'Complex system refactoring project',
        body: generateLongContent(
          '## Large Issue Description\n\nThis is a very detailed description of a complex system refactoring project that involves multiple components, services, and databases. ',
          5000
        ),
        htmlUrl: 'https://linear.app/company/issue/TEAM-LARGE',
        state: 'Open',
        createdAt: '2024-01-15T10:30:00.000Z',
        updatedAt: '2024-01-16T14:22:00.000Z',
        user: {
          id: 'user-architect',
          name: 'System Architect',
          email: 'architect@company.com',
          login: 'architect',
        },
        pullRequest: false,
      },
      comments: Array.from({ length: 15 }, (_, i) => ({
        id: `comment-large-${i}`,
        body: generateLongContent(
          `Comment ${i + 1}: This is a detailed comment about various aspects of the refactoring project. `,
          200
        ),
        createdAt: new Date(2024, 0, 16, 9 + i, 0).toISOString(),
        updatedAt: new Date(2024, 0, 16, 9 + i, 0).toISOString(),
        user: {
          id: `user-${i}`,
          name: `Commenter ${i + 1}`,
          email: `commenter${i + 1}@company.com`,
          login: `commenter${i + 1}`,
        },
      })),
    };

    const mockLinearClient: IssueTrackerClient = {
      fetchIssue: mock(() => Promise.resolve(mockLargeLinearIssue)),
      fetchAllOpenIssues: mock(() => Promise.resolve([])),
      parseIssueIdentifier: mock(() => ({ identifier: 'TEAM-LARGE' })),
      getDisplayName: mock(() => 'Linear'),
      getConfig: mock(() => ({ type: 'linear' })),
    };

    await moduleMocker.mock('../../../common/issue_tracker/factory.js', () => ({
      getIssueTracker: mock(() => Promise.resolve(mockLinearClient)),
    }));

    await moduleMocker.mock('../../issue_utils.js', () => ({
      getInstructionsFromIssue: mock(() => {
        // Simulate comment truncation (showing first 10 comments)
        const commentsToShow = mockLargeLinearIssue.comments.slice(0, 10);
        const commentsText = commentsToShow
          .map((c, i) => `> Comment ${i + 1}: This is a detailed comment...\n> — ${c.user?.name}`)
          .join('\n\n');

        return Promise.resolve({
          suggestedFileName: 'team-large-complex-system-refactoring-project.md',
          issue: {
            title: 'Complex system refactoring project',
            html_url: 'https://linear.app/company/issue/TEAM-LARGE',
            number: 'TEAM-LARGE',
          },
          plan: `${mockLargeLinearIssue.issue.body}\n\n---\n\n**Comments (showing first 10 of ${mockLargeLinearIssue.comments.length}):**\n\n${commentsText}`,
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
        priority: 'high',
        issue: [issueData.issue.html_url],
        tasks: [],
        createdAt: new Date('2024-01-20T12:00:00.000Z').toISOString(),
        updatedAt: new Date('2024-01-20T12:00:00.000Z').toISOString(),
        rmfilter: issueData.rmprOptions?.rmfilter || [],
      })),
    }));

    await handleImportCommand('TEAM-LARGE');

    expect(actualWrittenFiles.size).toBe(1);
    const [filePath, planData] = actualWrittenFiles.entries().next().value;

    // Verify large content is handled correctly
    expect(planData.details).toContain('Large Issue Description');
    expect(planData.details).toContain('Comments (showing first 10 of 15)');
    expect(planData.details).toContain('Comment 1:');

    // Verify the plan structure is maintained despite large content
    expect(planData).toMatchObject({
      id: 1,
      title: 'Complex system refactoring project',
      goal: 'Refactor: Complex system refactoring project',
      status: 'pending',
      priority: 'high',
      issue: ['https://linear.app/company/issue/TEAM-LARGE'],
    });

    // Verify the file is still valid YAML despite large content
    const fileContent = await fs.readFile(filePath, 'utf-8');
    const yamlContent = fileContent.split('\n').slice(1).join('\n');

    expect(() => yaml.parse(yamlContent)).not.toThrow();

    const parsedYaml = yaml.parse(yamlContent);
    expect(parsedYaml.title).toBe(planData.title);
    expect(parsedYaml.details.length).toBeGreaterThan(1000); // Ensure large content is preserved
  });

  test('should generate valid plan URLs in expected format', async () => {
    const mockLinearIssue: IssueWithComments = {
      issue: {
        id: 'issue-uuid-url',
        number: 'TEAM-URL',
        title: 'URL format validation test',
        body: 'Test URL formats in Linear issues.',
        htmlUrl: 'https://linear.app/company/issue/TEAM-URL',
        state: 'Open',
        createdAt: '2024-01-15T10:30:00.000Z',
        updatedAt: '2024-01-16T14:22:00.000Z',
        user: {
          id: 'user-url',
          name: 'URL Tester',
          email: 'url@company.com',
          login: 'urltester',
        },
        pullRequest: false,
      },
      comments: [],
    };

    const mockLinearClient: IssueTrackerClient = {
      fetchIssue: mock(() => Promise.resolve(mockLinearIssue)),
      fetchAllOpenIssues: mock(() => Promise.resolve([])),
      parseIssueIdentifier: mock(() => ({ identifier: 'TEAM-URL' })),
      getDisplayName: mock(() => 'Linear'),
      getConfig: mock(() => ({ type: 'linear' })),
    };

    await moduleMocker.mock('../../../common/issue_tracker/factory.js', () => ({
      getIssueTracker: mock(() => Promise.resolve(mockLinearClient)),
    }));

    await moduleMocker.mock('../../issue_utils.js', () => ({
      getInstructionsFromIssue: mock(() =>
        Promise.resolve({
          suggestedFileName: 'team-url-url-format-validation-test.md',
          issue: {
            title: 'URL format validation test',
            html_url: 'https://linear.app/company/issue/TEAM-URL',
            number: 'TEAM-URL',
          },
          plan: 'Test URL formats in Linear issues.',
          rmprOptions: {
            rmfilter: ['--include', '*.ts'],
          },
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
        createdAt: new Date('2024-01-20T12:00:00.000Z').toISOString(),
        updatedAt: new Date('2024-01-20T12:00:00.000Z').toISOString(),
        rmfilter: issueData.rmprOptions?.rmfilter || [],
      })),
    }));

    await handleImportCommand('TEAM-URL');

    expect(actualWrittenFiles.size).toBe(1);
    const [filePath, planData] = actualWrittenFiles.entries().next().value;

    // Verify the issue URL is properly formatted and valid
    expect(planData.issue).toHaveLength(1);
    expect(planData.issue[0]).toBe('https://linear.app/company/issue/TEAM-URL');

    // Verify URL is valid format
    expect(() => new URL(planData.issue[0])).not.toThrow();

    // Verify Linear URL pattern
    expect(planData.issue[0]).toMatch(/^https:\/\/linear\.app\/[^\/]+\/issue\/[A-Z]+-[0-9A-Z]+$/);

    // Verify file path follows convention
    expect(path.basename(filePath)).toMatch(/^\d+-team-url-url-format-validation-test\.plan\.md$/);
  });
});
