import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { handleImportCommand } from './import.js';
import { ModuleMocker } from '../../../testing.js';
import type { IssueTrackerClient, IssueWithComments } from '../../../common/issue_tracker/types.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { z } from 'zod/v4';
import { phaseSchema } from '../../planSchema.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('Plan File Validation Tests', () => {
  let tempDir: string;
  let tasksDir: string;
  let actualWrittenFiles: Map<string, any> = new Map();

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-validation-test-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    actualWrittenFiles.clear();

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
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
    await moduleMocker.clear();
  });

  test('should generate valid YAML structure for Linear issues', async () => {
    const mockLinearIssue: IssueWithComments = {
      issue: {
        id: 'issue-linear-validation',
        number: 'VALID-123',
        title: 'Schema validation test',
        body: 'Test schema validation for Linear issues.',
        htmlUrl: 'https://linear.app/company/issue/VALID-123',
        state: 'Open',
        createdAt: '2024-01-15T10:30:00.000Z',
        updatedAt: '2024-01-16T14:22:00.000Z',
        user: { id: 'user-1', name: 'Tester' },
        pullRequest: false,
      },
      comments: [],
    };

    const mockLinearClient: IssueTrackerClient = {
      fetchIssue: mock(() => Promise.resolve(mockLinearIssue)),
      fetchAllOpenIssues: mock(() => Promise.resolve([])),
      parseIssueIdentifier: mock(() => ({ identifier: 'VALID-123' })),
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

    await moduleMocker.mock('../../issue_utils.js', () => ({
      getInstructionsFromIssue: mock(() =>
        Promise.resolve({
          suggestedFileName: 'valid-123-schema-validation-test.md',
          issue: {
            title: 'Schema validation test',
            html_url: 'https://linear.app/company/issue/VALID-123',
            number: 'VALID-123',
          },
          plan: 'Test schema validation for Linear issues.',
          rmprOptions: {
            rmfilter: ['--include', '*.ts'],
          },
        })
      ),
      createStubPlanFromIssue: mock((issueData, id) => ({
        id,
        title: issueData.issue.title,
        goal: `Validate: ${issueData.issue.title}`,
        details: issueData.plan,
        status: 'pending',
        priority: 'medium',
        issue: [issueData.issue.html_url],
        tasks: [
          {
            title: 'Implement validation',
            description: 'Add proper validation logic',
            done: false,
          },
        ],
        createdAt: new Date('2024-01-20T12:00:00.000Z').toISOString(),
        updatedAt: new Date('2024-01-20T12:00:00.000Z').toISOString(),
        rmfilter: issueData.rmprOptions?.rmfilter || [],
      })),
    }));

    await handleImportCommand('VALID-123');

    expect(actualWrittenFiles.size).toBe(1);
    const [filePath, planData] = actualWrittenFiles.entries().next().value;

    // Validate against the actual plan schema
    const validationResult = phaseSchema.safeParse(planData);

    if (!validationResult.success) {
      console.error('Schema validation errors:', validationResult.error.issues);
    }

    expect(validationResult.success).toBe(true);

    // Verify all required schema fields are present and valid
    expect(planData.id).toBeTypeOf('number');
    expect(planData.title).toBeTypeOf('string');
    expect(planData.goal).toBeTypeOf('string');
    expect(planData.status).toBe('pending'); // Valid status value
    expect(planData.priority).toBe('medium'); // Valid priority value
    expect(Array.isArray(planData.issue)).toBe(true);
    expect(Array.isArray(planData.tasks)).toBe(true);
    expect(planData.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/); // ISO datetime
    expect(planData.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/); // ISO datetime

    // Verify tasks structure
    expect(planData.tasks[0]).toMatchObject({
      title: expect.any(String),
      description: expect.any(String),
      done: expect.any(Boolean),
    });

    // Verify file can be parsed back correctly
    const fileContent = await fs.readFile(filePath, 'utf-8');
    const yamlContent = fileContent.split('\n').slice(1).join('\n');
    const parsedYaml = yaml.parse(yamlContent);

    expect(parsedYaml).toEqual(planData);
  });

  test('should generate valid YAML structure for GitHub issues', async () => {
    const mockGitHubIssue: IssueWithComments = {
      issue: {
        id: '123',
        number: 123,
        title: 'GitHub schema validation test',
        body: 'Test schema validation for GitHub issues.',
        htmlUrl: 'https://github.com/owner/repo/issues/123',
        state: 'open',
        createdAt: '2024-01-15T10:30:00.000Z',
        updatedAt: '2024-01-16T14:22:00.000Z',
        user: { id: 'user-gh', name: 'GitHub Tester', login: 'ghtester' },
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

    await moduleMocker.mock('../../issue_utils.js', () => ({
      getInstructionsFromIssue: mock(() =>
        Promise.resolve({
          suggestedFileName: 'issue-123-github-schema-validation-test.md',
          issue: {
            title: 'GitHub schema validation test',
            html_url: 'https://github.com/owner/repo/issues/123',
            number: 123,
          },
          plan: 'Test schema validation for GitHub issues.',
          rmprOptions: {
            rmfilter: ['--include', '*.js'],
          },
        })
      ),
      createStubPlanFromIssue: mock((issueData, id) => ({
        id,
        title: issueData.issue.title,
        goal: `Validate: ${issueData.issue.title}`,
        details: issueData.plan,
        status: 'pending',
        priority: 'high',
        issue: [issueData.issue.html_url],
        tasks: [
          {
            title: 'GitHub validation task',
            description: 'Validate GitHub issue processing',
            done: false,
            files: ['src/validation.js'],
          },
        ],
        createdAt: new Date('2024-01-20T12:00:00.000Z').toISOString(),
        updatedAt: new Date('2024-01-20T12:00:00.000Z').toISOString(),
        rmfilter: issueData.rmprOptions?.rmfilter || [],
      })),
    }));

    await handleImportCommand('123');

    expect(actualWrittenFiles.size).toBe(1);
    const [filePath, planData] = actualWrittenFiles.entries().next().value;

    // Validate against the actual plan schema
    const validationResult = phaseSchema.safeParse(planData);

    if (!validationResult.success) {
      console.error('Schema validation errors:', validationResult.error.issues);
    }

    expect(validationResult.success).toBe(true);

    // Verify GitHub-specific structure
    expect(planData.issue[0]).toMatch(/^https:\/\/github\.com\/[^\/]+\/[^\/]+\/issues\/\d+$/);

    // Verify file structure is valid
    const fileContent = await fs.readFile(filePath, 'utf-8');
    const yamlContent = fileContent.split('\n').slice(1).join('\n');
    const parsedYaml = yaml.parse(yamlContent);

    expect(parsedYaml).toEqual(planData);
  });

  test('should handle edge case data types correctly in YAML', async () => {
    const mockEdgeCaseIssue: IssueWithComments = {
      issue: {
        id: 'issue-edge',
        number: 'EDGE-999',
        title: 'Edge case test with special characters: "quotes", \'apostrophes\', & symbols',
        body: 'This issue contains:\n- Multi-line content\n- Special characters: @#$%^&*()\n- Unicode: 你好世界 🚀\n- Code blocks:\n```javascript\nconst test = "value";\n```',
        htmlUrl: 'https://linear.app/company/issue/EDGE-999',
        state: 'Done',
        createdAt: '2024-01-15T10:30:00.000Z',
        updatedAt: '2024-01-16T14:22:00.000Z',
        user: { id: 'user-edge', name: 'Edge "Case" Tester' },
        pullRequest: false,
      },
      comments: [
        {
          id: 'comment-edge',
          body: 'Comment with special chars: <script>alert("xss")</script>\n\nAnd multiline:\n- Item 1\n- Item 2',
          createdAt: '2024-01-16T08:00:00.000Z',
          updatedAt: '2024-01-16T08:00:00.000Z',
          user: { id: 'user-special', name: 'Special & Characters' },
        },
      ],
    };

    const mockLinearClient: IssueTrackerClient = {
      fetchIssue: mock(() => Promise.resolve(mockEdgeCaseIssue)),
      fetchAllOpenIssues: mock(() => Promise.resolve([])),
      parseIssueIdentifier: mock(() => ({ identifier: 'EDGE-999' })),
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

    await moduleMocker.mock('../../issue_utils.js', () => ({
      getInstructionsFromIssue: mock(() =>
        Promise.resolve({
          suggestedFileName: 'edge-999-edge-case-test-with-special-characters.md',
          issue: {
            title: 'Edge case test with special characters: "quotes", \'apostrophes\', & symbols',
            html_url: 'https://linear.app/company/issue/EDGE-999',
            number: 'EDGE-999',
          },
          plan:
            mockEdgeCaseIssue.issue.body +
            '\n\n---\n\n**Comments:**\n\n> ' +
            mockEdgeCaseIssue.comments[0].body.replace(/\n/g, '\n> ') +
            '\n> — Special & Characters',
          rmprOptions: {
            rmfilter: ['--include', '*.ts', '--exclude', '**/*.spec.ts'],
          },
        })
      ),
      createStubPlanFromIssue: mock((issueData, id) => ({
        id,
        title: issueData.issue.title,
        goal: `Handle: ${issueData.issue.title}`,
        details: issueData.plan,
        status: 'done', // Map from Linear's "Done" status
        priority: 'low',
        issue: [issueData.issue.html_url],
        tasks: [
          {
            title: 'Task with "quotes"',
            description: 'Description with special chars: @#$%^&*()',
            done: true,
            files: ['src/special-chars.ts', 'test/edge-case.test.ts'],
          },
        ],
        createdAt: new Date('2024-01-20T12:00:00.000Z').toISOString(),
        updatedAt: new Date('2024-01-20T12:00:00.000Z').toISOString(),
        rmfilter: issueData.rmprOptions?.rmfilter || [],
      })),
    }));

    await handleImportCommand('EDGE-999');

    expect(actualWrittenFiles.size).toBe(1);
    const [filePath, planData] = actualWrittenFiles.entries().next().value;

    // Validate the plan passes schema validation despite special characters
    const validationResult = phaseSchema.safeParse(planData);
    expect(validationResult.success).toBe(true);

    // Verify special characters are preserved correctly
    expect(planData.title).toContain('"quotes"');
    expect(planData.title).toContain("'apostrophes'");
    expect(planData.title).toContain('& symbols');

    expect(planData.details).toContain('你好世界 🚀');
    expect(planData.details).toContain('<script>alert("xss")</script>');
    expect(planData.details).toContain('Special & Characters');

    // Verify tasks with special characters
    expect(planData.tasks[0].title).toBe('Task with "quotes"');
    expect(planData.tasks[0].description).toContain('@#$%^&*()');

    // Verify the file can be parsed correctly despite special characters
    const fileContent = await fs.readFile(filePath, 'utf-8');
    const yamlContent = fileContent.split('\n').slice(1).join('\n');

    // Should not throw on parsing
    expect(() => yaml.parse(yamlContent)).not.toThrow();

    const parsedYaml = yaml.parse(yamlContent);
    expect(parsedYaml.title).toBe(planData.title);
    expect(parsedYaml.details).toBe(planData.details);
    expect(parsedYaml.tasks[0].title).toBe(planData.tasks[0].title);
  });

  test('should maintain proper data types for all schema fields', async () => {
    const mockTypedIssue: IssueWithComments = {
      issue: {
        id: 'issue-types',
        number: 'TYPES-123',
        title: 'Data type validation test',
        body: 'Test proper data type handling.',
        htmlUrl: 'https://linear.app/company/issue/TYPES-123',
        state: 'In Progress',
        createdAt: '2024-01-15T10:30:00.000Z',
        updatedAt: '2024-01-16T14:22:00.000Z',
        user: { id: 'user-types', name: 'Type Tester' },
        pullRequest: false,
      },
      comments: [],
    };

    const mockLinearClient: IssueTrackerClient = {
      fetchIssue: mock(() => Promise.resolve(mockTypedIssue)),
      fetchAllOpenIssues: mock(() => Promise.resolve([])),
      parseIssueIdentifier: mock(() => ({ identifier: 'TYPES-123' })),
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

    await moduleMocker.mock('../../issue_utils.js', () => ({
      getInstructionsFromIssue: mock(() =>
        Promise.resolve({
          suggestedFileName: 'types-123-data-type-validation-test.md',
          issue: {
            title: 'Data type validation test',
            html_url: 'https://linear.app/company/issue/TYPES-123',
            number: 'TYPES-123',
          },
          plan: 'Test proper data type handling.',
          rmprOptions: {
            rmfilter: ['--include', '*.ts'],
          },
        })
      ),
      createStubPlanFromIssue: mock((issueData, id) => ({
        id: 42, // number type
        title: issueData.issue.title, // string type
        goal: `Test: ${issueData.issue.title}`, // string type
        details: issueData.plan, // string type
        status: 'in_progress', // enum type
        priority: 'urgent', // enum type
        epic: false, // boolean type
        dependencies: [1, 2, 3], // array of numbers
        issue: [issueData.issue.html_url], // array of strings (URLs)
        docs: ['doc1.md', 'doc2.md'], // array of strings
        assignedTo: 'Team Lead', // string type
        tasks: [
          // array of objects
          {
            title: 'Task 1', // string
            description: 'First task', // string
            done: false, // boolean
            files: ['file1.ts', 'file2.ts'], // array of strings
            docs: ['task-doc.md'], // array of strings
          },
          {
            title: 'Task 2',
            description: 'Second task',
            done: true,
          },
        ],
        createdAt: new Date('2024-01-20T12:00:00.000Z').toISOString(), // ISO datetime string
        updatedAt: new Date('2024-01-20T12:05:00.000Z').toISOString(), // ISO datetime string
        rmfilter: issueData.rmprOptions?.rmfilter || [], // array of strings
      })),
    }));

    await handleImportCommand('TYPES-123');

    expect(actualWrittenFiles.size).toBe(1);
    const [filePath, planData] = actualWrittenFiles.entries().next().value;

    // Validate all data types are correct
    expect(typeof planData.id).toBe('number');
    expect(typeof planData.title).toBe('string');
    expect(typeof planData.goal).toBe('string');
    expect(typeof planData.details).toBe('string');
    expect(typeof planData.status).toBe('string');
    expect(typeof planData.priority).toBe('string');
    expect(typeof planData.epic).toBe('boolean');
    expect(typeof planData.assignedTo).toBe('string');
    expect(typeof planData.createdAt).toBe('string');
    expect(typeof planData.updatedAt).toBe('string');

    // Validate arrays
    expect(Array.isArray(planData.dependencies)).toBe(true);
    expect(Array.isArray(planData.issue)).toBe(true);
    expect(Array.isArray(planData.docs)).toBe(true);
    expect(Array.isArray(planData.tasks)).toBe(true);
    expect(Array.isArray(planData.rmfilter)).toBe(true);

    // Validate array contents
    planData.dependencies.forEach((dep: any) => expect(typeof dep).toBe('number'));
    planData.issue.forEach((url: any) => expect(typeof url).toBe('string'));
    planData.docs.forEach((doc: any) => expect(typeof doc).toBe('string'));
    planData.rmfilter.forEach((filter: any) => expect(typeof filter).toBe('string'));

    // Validate task structure
    planData.tasks.forEach((task: any) => {
      expect(typeof task.title).toBe('string');
      expect(typeof task.description).toBe('string');
      expect(typeof task.done).toBe('boolean');
      if (task.files) {
        expect(Array.isArray(task.files)).toBe(true);
        task.files.forEach((file: any) => expect(typeof file).toBe('string'));
      }
      if (task.docs) {
        expect(Array.isArray(task.docs)).toBe(true);
        task.docs.forEach((doc: any) => expect(typeof doc).toBe('string'));
      }
    });

    // Validate against schema
    const validationResult = phaseSchema.safeParse(planData);
    expect(validationResult.success).toBe(true);

    // Verify YAML parsing preserves types
    const fileContent = await fs.readFile(filePath, 'utf-8');
    const yamlContent = fileContent.split('\n').slice(1).join('\n');
    const parsedYaml = yaml.parse(yamlContent);

    // Numbers should remain numbers, not become strings
    expect(typeof parsedYaml.id).toBe('number');
    expect(parsedYaml.id).toBe(42);

    // Booleans should remain booleans
    expect(typeof parsedYaml.epic).toBe('boolean');
    expect(parsedYaml.epic).toBe(false);

    expect(typeof parsedYaml.tasks[0].done).toBe('boolean');
    expect(parsedYaml.tasks[0].done).toBe(false);
    expect(parsedYaml.tasks[1].done).toBe(true);
  });
});
