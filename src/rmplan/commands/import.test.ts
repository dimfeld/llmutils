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
  });

  afterEach(async () => {
    return moduleMocker.clear();
  });

  test('should import a single issue when --issue flag is provided', async () => {
    await handleImportCommand(undefined, { issue: '123' });

    const { getInstructionsFromGithubIssue } = await import('../../common/github/issues.js');
    const { writePlanFile } = await import('../plans.js');

    expect(getInstructionsFromGithubIssue).toHaveBeenCalledWith('123', false);
    expect(writePlanFile).toHaveBeenCalled();
  });

  test('should import a single issue when issue argument is provided', async () => {
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

    await handleImportCommand();

    const { fetchAllOpenIssues } = await import('../../common/github/issues.js');
    const { log } = await import('../../logging.js');

    expect(fetchAllOpenIssues).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('Fetching all open issues...');
    expect(log).toHaveBeenCalledWith('Found 2 issues available for import (0 already imported).');
  });

  test('should filter out already imported issues in interactive mode', async () => {
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
    }));

    await handleImportCommand();

    const { fetchAllOpenIssues } = await import('../../common/github/issues.js');
    const { log } = await import('../../logging.js');

    expect(fetchAllOpenIssues).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('Fetching all open issues...');
    expect(log).toHaveBeenCalledWith('Found 2 issues available for import (1 already imported).');
  });

  test('should create stub plan file with correct metadata', async () => {
    await handleImportCommand('123');

    const { writePlanFile } = await import('../plans.js');

    expect(writePlanFile).toHaveBeenCalled();
    const [filePath, planData] = (writePlanFile as any).mock.calls[0];

    expect(filePath).toContain('issue-123-test-issue.yml');
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

  test('should avoid creating duplicate plans for existing issues', async () => {
    // Setup mock to return a plan with the same issue URL
    const mockPlansWithDuplicate = {
      plans: new Map([[1, { filename: '/test/existing-plan.yml' }]]),
      maxNumericId: 5,
      duplicates: [],
    };

    const mockExistingPlan: PlanSchema = {
      id: 1,
      goal: 'Existing plan',
      details: 'Existing details',
      issue: ['https://github.com/owner/repo/issues/123'], // Same URL as mockIssueData
      tasks: [],
    };

    await moduleMocker.mock('../plans.js', () => ({
      readAllPlans: mock(() => Promise.resolve(mockPlansWithDuplicate)),
      writePlanFile: mock(() => Promise.resolve()),
      getMaxNumericPlanId: mock(() => Promise.resolve(5)),
      readPlanFile: mock(() => Promise.resolve(mockExistingPlan)),
    }));

    await handleImportCommand('123');

    const { writePlanFile } = await import('../plans.js');
    const { warn } = await import('../../logging.js');

    expect(writePlanFile).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Issue https://github.com/owner/repo/issues/123 has already been imported'
      )
    );
  });
});
