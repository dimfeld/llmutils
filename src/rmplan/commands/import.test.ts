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
    moduleMocker.clear();
  });

  test('should import a single issue when --issue flag is provided', async () => {
    await handleImportCommand(undefined, { issue: '123' });

    const { getInstructionsFromGithubIssue } = await import('../../common/github/issues.js');
    const { writePlanFile } = await import('../plans.js');

    expect(getInstructionsFromGithubIssue).toHaveBeenCalledWith('123');
    expect(writePlanFile).toHaveBeenCalled();
  });

  test('should import a single issue when issue argument is provided', async () => {
    await handleImportCommand('456');

    const { getInstructionsFromGithubIssue } = await import('../../common/github/issues.js');
    const { writePlanFile } = await import('../plans.js');

    expect(getInstructionsFromGithubIssue).toHaveBeenCalledWith('456');
    expect(writePlanFile).toHaveBeenCalled();
  });

  test('should throw error when no issue is specified', async () => {
    await expect(handleImportCommand()).rejects.toThrow(
      'An issue must be specified. Use either "rmplan import <issue>" or "rmplan import --issue <url|number>"'
    );
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
