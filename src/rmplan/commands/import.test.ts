import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { handleImportCommand } from './import.js';
import { ModuleMocker } from '../../testing.js';
import type { PlanSchema } from '../planSchema.js';

const moduleMocker = new ModuleMocker(import.meta);

// Mock data for testing
const mockIssueData = {
  suggestedFileName: 'issue-123-test-issue.md',
  issue: {
    title: 'Test Issue',
    html_url: 'https://github.com/owner/repo/issues/123',
    number: 123,
  },
  plan: 'This is a test issue description',
  rmprOptions: {
    rmfilter: ['--include', '*.ts'],
  },
};

const mockConfig = {
  paths: {
    tasks: 'tasks',
  },
};

const mockPlansResult = {
  plans: new Map(),
  maxNumericId: 5,
  duplicates: [],
};

describe('handleImportCommand', () => {
  beforeEach(async () => {
    // Mock all the dependencies
    await moduleMocker.mock('../../common/github/issues.js', () => ({
      getInstructionsFromGithubIssue: mock(() => Promise.resolve(mockIssueData)),
    }));

    await moduleMocker.mock('../plans.js', () => ({
      readAllPlans: mock(() => Promise.resolve(mockPlansResult)),
      writePlanFile: mock(() => Promise.resolve()),
      getMaxNumericPlanId: mock(() => Promise.resolve(5)),
      readPlanFile: mock(() => Promise.resolve({ issue: [] })),
      getImportedIssueUrls: mock(() => Promise.resolve(new Set())),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: mock(() => Promise.resolve(mockConfig)),
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
      checkbox: mock(() => Promise.resolve([100, 101])),
    }));

    await moduleMocker.mock('../../common/github/identifiers.js', () => ({
      parsePrOrIssueNumber: mock(() =>
        Promise.resolve({ owner: 'owner', repo: 'repo', number: 123 })
      ),
    }));

    await moduleMocker.mock('../../rmpr/comment_options.js', () => ({
      parseCommandOptionsFromComment: mock(() => ({ options: null })),
      combineRmprOptions: mock(() => ({ rmfilter: ['--include', '*.ts'] })),
    }));

    await moduleMocker.mock('../../common/formatting.js', () => ({
      singleLineWithPrefix: mock((prefix, text) => prefix + text),
      limitLines: mock((text) => text),
    }));
  });

  afterEach(async () => {
    return moduleMocker.clear();
  });

  test('should import a single issue when --issue flag is provided', async () => {
    // Mock fetchIssueAndComments for single issue import
    await moduleMocker.mock('../../common/github/issues.js', () => ({
      getInstructionsFromGithubIssue: mock(() => Promise.resolve(mockIssueData)),
      fetchIssueAndComments: mock(() =>
        Promise.resolve({
          issue: mockIssueData.issue,
          comments: [],
        })
      ),
    }));

    await handleImportCommand(undefined, { issue: '123' });

    const { getInstructionsFromGithubIssue } = await import('../../common/github/issues.js');
    const { writePlanFile } = await import('../plans.js');

    expect(getInstructionsFromGithubIssue).toHaveBeenCalledWith('123', false);
    expect(writePlanFile).toHaveBeenCalled();
  });

  test('should import a single issue when issue argument is provided', async () => {
    // Mock fetchIssueAndComments for single issue import
    await moduleMocker.mock('../../common/github/issues.js', () => ({
      getInstructionsFromGithubIssue: mock(() => Promise.resolve(mockIssueData)),
      fetchIssueAndComments: mock(() =>
        Promise.resolve({
          issue: mockIssueData.issue,
          comments: [],
        })
      ),
    }));

    // Mock parsePrOrIssueNumber to return proper issue data
    await moduleMocker.mock('../../common/github/identifiers.js', () => ({
      parsePrOrIssueNumber: mock(() =>
        Promise.resolve({ owner: 'owner', repo: 'repo', number: 456 })
      ),
    }));

    await handleImportCommand('456');

    const { getInstructionsFromGithubIssue } = await import('../../common/github/issues.js');
    const { writePlanFile } = await import('../plans.js');

    expect(getInstructionsFromGithubIssue).toHaveBeenCalledWith('456', false);
    expect(writePlanFile).toHaveBeenCalled();
  });

  test('should enter interactive mode when no issue is specified', async () => {
    // Mock fetchAllOpenIssues
    await moduleMocker.mock('../../common/github/issues.js', () => ({
      getInstructionsFromGithubIssue: mock(() => Promise.resolve(mockIssueData)),
      fetchAllOpenIssues: mock(() =>
        Promise.resolve([
          { html_url: 'https://github.com/owner/repo/issues/100', title: 'Issue 100', number: 100 },
          { html_url: 'https://github.com/owner/repo/issues/101', title: 'Issue 101', number: 101 },
        ])
      ),
    }));

    // Mock the checkbox to return no selections to avoid actual import
    await moduleMocker.mock('@inquirer/prompts', () => ({
      checkbox: mock(() => Promise.resolve([])),
    }));

    await handleImportCommand();

    const { fetchAllOpenIssues } = await import('../../common/github/issues.js');
    const { log } = await import('../../logging.js');
    const { checkbox } = await import('@inquirer/prompts');

    expect(fetchAllOpenIssues).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('Fetching all open issues...');
    expect(log).toHaveBeenCalledWith('Found 2 open issues.');
    expect(checkbox).toHaveBeenCalledWith({
      message: 'Select issues to import:',
      choices: [
        { name: '#100: Issue 100', value: 100 },
        { name: '#101: Issue 101', value: 101 },
      ],
    });
    expect(log).toHaveBeenCalledWith('No issues selected for import.');
  });

  test('should exclude already imported issues in interactive mode', async () => {
    // Mock data where one issue is already imported
    const mockPlansWithImported = {
      plans: new Map([[1, { filename: '/test/imported-plan.yml' }]]),
      maxNumericId: 5,
      duplicates: [],
    };

    const mockImportedPlan: PlanSchema = {
      id: 1,
      goal: 'Imported plan',
      details: 'Already imported',
      issue: ['https://github.com/owner/repo/issues/100'], // This one is already imported
      tasks: [],
    };

    await moduleMocker.mock('../../common/github/issues.js', () => ({
      getInstructionsFromGithubIssue: mock(() => Promise.resolve(mockIssueData)),
      fetchAllOpenIssues: mock(() =>
        Promise.resolve([
          { html_url: 'https://github.com/owner/repo/issues/100', title: 'Issue 100', number: 100 },
          { html_url: 'https://github.com/owner/repo/issues/101', title: 'Issue 101', number: 101 },
          { html_url: 'https://github.com/owner/repo/issues/102', title: 'Issue 102', number: 102 },
        ])
      ),
    }));

    await moduleMocker.mock('../plans.js', () => ({
      readAllPlans: mock(() => Promise.resolve(mockPlansWithImported)),
      writePlanFile: mock(() => Promise.resolve()),
      getMaxNumericPlanId: mock(() => Promise.resolve(5)),
      readPlanFile: mock(() => Promise.resolve(mockImportedPlan)),
      getImportedIssueUrls: mock(() =>
        Promise.resolve(new Set(['https://github.com/owner/repo/issues/100']))
      ),
    }));

    // Mock the checkbox to return no selections to avoid actual import
    await moduleMocker.mock('@inquirer/prompts', () => ({
      checkbox: mock(() => Promise.resolve([])),
    }));

    await handleImportCommand();

    const { fetchAllOpenIssues } = await import('../../common/github/issues.js');
    const { log } = await import('../../logging.js');
    const { checkbox } = await import('@inquirer/prompts');

    expect(fetchAllOpenIssues).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('Fetching all open issues...');
    expect(log).toHaveBeenCalledWith(
      'Found 3 open issues (1 already imported). Re-importing will update existing plans.'
    );

    // Verify that only non-imported issues are presented as choices
    expect(checkbox).toHaveBeenCalledWith({
      message: 'Select issues to import:',
      choices: [
        { name: '#101: Issue 101', value: 101 },
        { name: '#102: Issue 102', value: 102 },
      ],
    });
  });

  test('should import selected issues in interactive mode', async () => {
    // Mock fetchAllOpenIssues to return available issues
    await moduleMocker.mock('../../common/github/issues.js', () => ({
      getInstructionsFromGithubIssue: mock(() => Promise.resolve(mockIssueData)),
      fetchAllOpenIssues: mock(() =>
        Promise.resolve([
          { html_url: 'https://github.com/owner/repo/issues/100', title: 'Issue 100', number: 100 },
          { html_url: 'https://github.com/owner/repo/issues/101', title: 'Issue 101', number: 101 },
        ])
      ),
      fetchIssueAndComments: mock(() =>
        Promise.resolve({
          issue: mockIssueData.issue,
          comments: [],
        })
      ),
    }));

    // Mock parsePrOrIssueNumber to return proper issue data for both issues
    let callCount = 0;
    await moduleMocker.mock('../../common/github/identifiers.js', () => ({
      parsePrOrIssueNumber: mock(() => {
        const issueNumbers = ['100', '101'];
        const number = parseInt(issueNumbers[callCount++ % 2]);
        return Promise.resolve({ owner: 'owner', repo: 'repo', number });
      }),
    }));

    // Override the plans mock to include getImportedIssueUrls for this test
    await moduleMocker.mock('../plans.js', () => ({
      readAllPlans: mock(() => Promise.resolve(mockPlansResult)),
      writePlanFile: mock(() => Promise.resolve()),
      getMaxNumericPlanId: mock(() => Promise.resolve(5)),
      readPlanFile: mock(() => Promise.resolve({ issue: [] })),
      getImportedIssueUrls: mock(() => Promise.resolve(new Set())), // No imported issues
    }));

    // Mock the checkbox to return selected issues
    await moduleMocker.mock('@inquirer/prompts', () => ({
      checkbox: mock(() => Promise.resolve([100, 101])),
    }));

    await handleImportCommand();

    const { getInstructionsFromGithubIssue } = await import('../../common/github/issues.js');
    const { writePlanFile } = await import('../plans.js');
    const { log } = await import('../../logging.js');
    const { checkbox } = await import('@inquirer/prompts');

    // Verify checkbox was called with correct choices
    expect(checkbox).toHaveBeenCalledWith({
      message: 'Select issues to import:',
      choices: [
        { name: '#100: Issue 100', value: 100 },
        { name: '#101: Issue 101', value: 101 },
      ],
    });

    // Verify each selected issue was imported
    expect(getInstructionsFromGithubIssue).toHaveBeenCalledWith('100', false);
    expect(getInstructionsFromGithubIssue).toHaveBeenCalledWith('101', false);
    expect(writePlanFile).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith('Importing 2 selected issues...');
    expect(log).toHaveBeenCalledWith('Successfully imported 2 new issues.');
    expect(log).toHaveBeenCalledWith('Use "rmplan generate" to add tasks to these plans.');
  });

  test('should update existing plan when re-importing an issue', async () => {
    // Mock data where the issue is already imported
    const existingPlan: PlanSchema = {
      id: 3,
      title: 'Old Title',
      goal: 'Implement: Old Title',
      details: 'Old description',
      status: 'in_progress',
      issue: ['https://github.com/owner/repo/issues/123'],
      tasks: [{ id: 1, description: 'Existing task' }],
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };

    const mockPlansWithExisting = {
      plans: new Map([
        [3, { ...existingPlan, filename: '/test/git/root/tasks/issue-123-test-issue.yml' }],
      ]),
      maxNumericId: 5,
      duplicates: [],
    };

    // Mock the new dependencies
    await moduleMocker.mock('../../common/github/identifiers.js', () => ({
      parsePrOrIssueNumber: mock(() =>
        Promise.resolve({ owner: 'owner', repo: 'repo', number: 123 })
      ),
    }));

    await moduleMocker.mock('../../rmpr/comment_options.js', () => ({
      parseCommandOptionsFromComment: mock(() => ({
        options: { rmfilter: ['--include', '*.ts'] },
      })),
      combineRmprOptions: mock(() => ({ rmfilter: ['--include', '*.ts'] })),
    }));

    await moduleMocker.mock('../../common/formatting.js', () => ({
      singleLineWithPrefix: mock((prefix, text) => prefix + text),
      limitLines: mock((text) => text),
    }));

    await moduleMocker.mock('../plans.js', () => ({
      readAllPlans: mock(() => Promise.resolve(mockPlansWithExisting)),
      writePlanFile: mock(() => Promise.resolve()),
      getMaxNumericPlanId: mock(() => Promise.resolve(5)),
      readPlanFile: mock(() => Promise.resolve(existingPlan)),
      getImportedIssueUrls: mock(() =>
        Promise.resolve(new Set(['https://github.com/owner/repo/issues/123']))
      ),
    }));

    // Mock fetchIssueAndComments with a new comment
    await moduleMocker.mock('../../common/github/issues.js', () => ({
      getInstructionsFromGithubIssue: mock(() => Promise.resolve(mockIssueData)),
      fetchIssueAndComments: mock(() =>
        Promise.resolve({
          issue: mockIssueData.issue,
          comments: [
            { body: 'This is a new comment', user: { login: 'user1' } },
            { body: 'Old description', user: { login: 'user2' } }, // This one is already in details
          ],
        })
      ),
    }));

    // Mock checkbox to select the new comment
    await moduleMocker.mock('@inquirer/prompts', () => ({
      checkbox: mock(() => Promise.resolve([0])), // Select the first (new) comment
    }));

    await handleImportCommand('123');

    const { writePlanFile } = await import('../plans.js');
    const { log } = await import('../../logging.js');

    expect(log).toHaveBeenCalledWith(
      'Updating existing plan for issue: https://github.com/owner/repo/issues/123'
    );
    expect(writePlanFile).toHaveBeenCalled();

    const [filePath, planData] = (writePlanFile as any).mock.calls[0];

    expect(filePath).toBe('/test/git/root/tasks/issue-123-test-issue.yml');
    expect(planData).toMatchObject({
      id: 3, // Preserves existing ID
      title: 'Test Issue', // Updated from issue
      goal: 'Implement: Old Title', // Preserved
      details: 'Old description\n\nThis is a new comment', // Old details + new comment
      status: 'in_progress', // Preserved
      issue: ['https://github.com/owner/repo/issues/123'], // Preserved
      tasks: [{ id: 1, description: 'Existing task' }], // Preserved
      rmfilter: ['--include', '*.ts'], // Updated from issue
      createdAt: '2024-01-01T00:00:00Z', // Preserved
    });
    expect(planData.updatedAt).not.toBe('2024-01-01T00:00:00Z'); // Should be updated
    expect(log).toHaveBeenCalledWith('Added 1 new comment(s) to the plan.');
  });

  test('should create stub plan file with correct metadata', async () => {
    // Mock fetchIssueAndComments for single issue import
    await moduleMocker.mock('../../common/github/issues.js', () => ({
      getInstructionsFromGithubIssue: mock(() => Promise.resolve(mockIssueData)),
      fetchIssueAndComments: mock(() =>
        Promise.resolve({
          issue: mockIssueData.issue,
          comments: [],
        })
      ),
    }));

    await handleImportCommand('123');

    const { writePlanFile } = await import('../plans.js');

    expect(writePlanFile).toHaveBeenCalled();
    const [filePath, planData] = (writePlanFile as any).mock.calls[0];

    expect(filePath).toBe('/test/git/root/tasks/issue-123-test-issue.yml');
    expect(planData).toMatchObject({
      id: 6, // maxId + 1
      title: 'Test Issue',
      goal: 'Implement: Test Issue',
      details: 'This is a test issue description',
      status: 'pending',
      issue: ['https://github.com/owner/repo/issues/123'],
      tasks: [],
      rmfilter: ['--include', '*.ts'],
    });
    expect(planData.createdAt).toBeDefined();
    expect(planData.updatedAt).toBeDefined();
  });

  test('should update existing plan when importing duplicate issue', async () => {
    // Setup mock to return a plan with the same issue URL
    const mockExistingPlan: PlanSchema & { filename: string } = {
      id: 1,
      title: 'Test Issue', // Same as mockIssueData so no title change
      goal: 'Existing plan',
      details: 'Existing details',
      issue: ['https://github.com/owner/repo/issues/123'], // Same URL as mockIssueData
      tasks: [],
      filename: '/test/git/root/tasks/existing-plan.yml',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };

    const mockPlansWithDuplicate = {
      plans: new Map([[1, mockExistingPlan]]),
      maxNumericId: 5,
      duplicates: [],
    };

    // Mock the new dependencies
    await moduleMocker.mock('../../common/github/identifiers.js', () => ({
      parsePrOrIssueNumber: mock(() =>
        Promise.resolve({ owner: 'owner', repo: 'repo', number: 123 })
      ),
    }));

    await moduleMocker.mock('../../rmpr/comment_options.js', () => ({
      parseCommandOptionsFromComment: mock(() => ({
        options: { rmfilter: ['--include', '*.ts'] },
      })),
      combineRmprOptions: mock(() => ({ rmfilter: ['--include', '*.ts'] })),
    }));

    await moduleMocker.mock('../../common/formatting.js', () => ({
      singleLineWithPrefix: mock((prefix, text) => prefix + text),
      limitLines: mock((text) => text),
    }));

    await moduleMocker.mock('../plans.js', () => ({
      readAllPlans: mock(() => Promise.resolve(mockPlansWithDuplicate)),
      writePlanFile: mock(() => Promise.resolve()),
      getMaxNumericPlanId: mock(() => Promise.resolve(5)),
      readPlanFile: mock(() => Promise.resolve(mockExistingPlan)),
    }));

    // Mock fetchIssueAndComments with no new comments
    await moduleMocker.mock('../../common/github/issues.js', () => ({
      getInstructionsFromGithubIssue: mock(() => Promise.resolve(mockIssueData)),
      fetchIssueAndComments: mock(() =>
        Promise.resolve({
          issue: mockIssueData.issue,
          comments: [], // No comments
        })
      ),
    }));

    await handleImportCommand('123');

    const { writePlanFile } = await import('../plans.js');
    const { log } = await import('../../logging.js');

    expect(writePlanFile).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      'Updating existing plan for issue: https://github.com/owner/repo/issues/123'
    );
    expect(log).toHaveBeenCalledWith(
      'No updates needed for plan 1 - all content is already up to date.'
    );
  });
});
