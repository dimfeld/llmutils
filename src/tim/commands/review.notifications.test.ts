import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ModuleMocker } from '../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

let tempDir: string;
let planFile: string;
let sendNotificationSpy: ReturnType<typeof mock>;
let runReviewSpy: ReturnType<typeof mock>;
let gatherPlanContextSpy: ReturnType<typeof mock>;
let selectSpy: ReturnType<typeof mock>;
let checkboxSpy: ReturnType<typeof mock>;
let loadEffectiveConfigSpy: ReturnType<typeof mock>;
let loadGlobalConfigForNotificationsSpy: ReturnType<typeof mock>;

const basePlan = {
  id: 123,
  title: 'Notify Plan',
  goal: 'Goal',
  details: 'Details',
  status: 'pending',
  tasks: [],
};

const baseDiff = {
  hasChanges: true,
  changedFiles: ['src/file.ts'],
  baseBranch: 'main',
  diffContent: 'diff',
};

const mockCommand = {
  parent: {
    opts: () => ({}),
  },
};

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'tim-review-notify-'));
  planFile = join(tempDir, 'plan.yml');
  await writeFile(planFile, 'id: 123\ntitle: Notify Plan\n');

  sendNotificationSpy = mock(async () => true);
  runReviewSpy = mock(async () => ({
    reviewResult: {
      summary: { totalIssues: 0 },
      issues: [],
      recommendations: [],
      actionItems: [],
    },
    rawOutput: '',
    usedExecutors: ['claude-code'],
    warnings: [],
  }));
  gatherPlanContextSpy = mock(async () => ({
    resolvedPlanFile: planFile,
    planData: { ...basePlan },
    parentChain: [],
    completedChildren: [],
    diffResult: { ...baseDiff },
    noChangesDetected: false,
  }));
  selectSpy = mock(async () => 'exit');
  checkboxSpy = mock(async () => []);
  loadEffectiveConfigSpy = mock(async () => ({ notifications: { command: 'notify' } }));
  loadGlobalConfigForNotificationsSpy = mock(async () => ({
    notifications: { command: 'notify' },
  }));

  await moduleMocker.mock('../notifications.js', () => ({
    sendNotification: sendNotificationSpy,
  }));

  await moduleMocker.mock('@inquirer/prompts', () => ({
    select: selectSpy,
    checkbox: checkboxSpy,
  }));

  await moduleMocker.mock('../configLoader.js', () => ({
    loadEffectiveConfig: loadEffectiveConfigSpy,
    loadGlobalConfigForNotifications: loadGlobalConfigForNotificationsSpy,
  }));

  await moduleMocker.mock('../../common/git.js', () => ({
    getGitRoot: mock(async () => tempDir),
    getCurrentCommitHash: mock(async () => undefined),
    getTrunkBranch: mock(async () => 'main'),
    getUsingJj: mock(async () => false),
  }));

  await moduleMocker.mock('../utils/context_gathering.js', () => ({
    gatherPlanContext: gatherPlanContextSpy,
  }));

  await moduleMocker.mock('../review_runner.js', () => ({
    runReview: runReviewSpy,
    prepareReviewExecutors: mock(async () => []),
  }));

  await moduleMocker.mock('../formatters/review_formatter.js', () => ({
    createFormatter: mock(() => ({
      format: () => 'formatted',
      getFileExtension: () => '.md',
    })),
    createReviewResult: (input: any) => input,
  }));

  await moduleMocker.mock('../incremental_review.js', () => ({
    storeLastReviewMetadata: mock(async () => {}),
    getLastReviewMetadata: mock(async () => undefined),
    getIncrementalDiff: mock(async () => ({
      hasChanges: true,
      changedFiles: [],
      baseBranch: 'main',
      diffContent: '',
    })),
  }));

  await moduleMocker.mock('../review_persistence.js', () => ({
    saveReviewResult: mock(async () => ''),
    createReviewsDirectory: mock(async () => ''),
    createGitNote: mock(async () => false),
  }));

  await moduleMocker.mock('../utils/file_validation.js', () => ({
    validateInstructionsFilePath: (input: string) => input,
  }));
});

afterEach(async () => {
  moduleMocker.clear();
  delete process.env.TIM_INTERACTIVE;
});

describe('review notifications', () => {
  test('emits review_done after successful review', async () => {
    const { handleReviewCommand } = await import('./review.js');

    await handleReviewCommand(planFile, { noSave: true, noAutofix: true }, mockCommand);

    expect(sendNotificationSpy).toHaveBeenCalledTimes(1);
    const [, input] = sendNotificationSpy.mock.calls[0];
    expect(input.event).toBe('review_done');
    expect(input.status).toBe('success');
    expect(input.message).toContain('completed');
  });

  test('emits review_done when config load fails', async () => {
    loadEffectiveConfigSpy.mockImplementationOnce(async () => {
      throw new Error('config boom');
    });

    const { handleReviewCommand } = await import('./review.js');

    await expect(
      handleReviewCommand(planFile, { noSave: true, noAutofix: true }, mockCommand)
    ).rejects.toThrow('config boom');

    expect(loadGlobalConfigForNotificationsSpy).toHaveBeenCalledTimes(1);
    expect(sendNotificationSpy).toHaveBeenCalledTimes(1);
    const [, input] = sendNotificationSpy.mock.calls[0];
    expect(input.event).toBe('review_done');
    expect(input.status).toBe('error');
    expect(input.message).toContain('config boom');
  });

  test('emits review_done when review fails', async () => {
    runReviewSpy.mockImplementationOnce(async () => {
      throw new Error('boom');
    });

    const { handleReviewCommand } = await import('./review.js');

    await expect(
      handleReviewCommand(planFile, { noSave: true, noAutofix: true }, mockCommand)
    ).rejects.toThrow('Review execution failed');

    expect(sendNotificationSpy).toHaveBeenCalledTimes(1);
    const [, input] = sendNotificationSpy.mock.calls[0];
    expect(input.event).toBe('review_done');
    expect(input.status).toBe('error');
    expect(input.message).toContain('failed');
    expect(input.message).toContain('boom');
    expect(input.errorMessage).toContain('boom');
  });

  test('emits review_done when plan context fails before review run', async () => {
    gatherPlanContextSpy.mockImplementationOnce(async () => {
      throw new Error('context boom');
    });

    const { handleReviewCommand } = await import('./review.js');

    await expect(
      handleReviewCommand(planFile, { noSave: true, noAutofix: true }, mockCommand)
    ).rejects.toThrow('context boom');

    expect(sendNotificationSpy).toHaveBeenCalledTimes(1);
    const [, input] = sendNotificationSpy.mock.calls[0];
    expect(input.event).toBe('review_done');
    expect(input.status).toBe('error');
    expect(input.message).toContain('failed');
    expect(input.message).toContain('context boom');
    expect(input.errorMessage).toContain('context boom');
  });

  test('skips notifications when no changes are detected (no-changes early return)', async () => {
    gatherPlanContextSpy.mockImplementationOnce(async () => ({
      resolvedPlanFile: planFile,
      planData: { ...basePlan },
      parentChain: [],
      completedChildren: [],
      diffResult: { ...baseDiff },
      noChangesDetected: true,
    }));

    const { handleReviewCommand } = await import('./review.js');

    await handleReviewCommand(planFile, { noSave: true, noAutofix: true }, mockCommand);

    expect(sendNotificationSpy).not.toHaveBeenCalled();
  });

  test('skips notifications in dry-run mode', async () => {
    const { handleReviewCommand } = await import('./review.js');

    await handleReviewCommand(planFile, { noSave: true, dryRun: true }, mockCommand);

    expect(sendNotificationSpy).not.toHaveBeenCalled();
  });

  test('skips review_input notifications in non-interactive mode', async () => {
    process.env.TIM_INTERACTIVE = '0';
    const events: string[] = [];
    sendNotificationSpy.mockImplementation(async (_config: any, input: any) => {
      events.push(input.event);
      return true;
    });

    runReviewSpy.mockImplementationOnce(async () => ({
      reviewResult: {
        summary: { totalIssues: 1 },
        issues: [
          {
            severity: 'major',
            content: 'Issue content',
            file: 'src/file.ts',
            line: 10,
          },
        ],
        recommendations: [],
        actionItems: [],
      },
      rawOutput: 'issues were found',
      usedExecutors: ['claude-code'],
      warnings: [],
    }));

    const { handleReviewCommand } = await import('./review.js');

    await handleReviewCommand(planFile, { noSave: true }, mockCommand);

    expect(events).toContain('review_done');
    expect(events).not.toContain('review_input');
    expect(selectSpy).not.toHaveBeenCalled();
    expect(checkboxSpy).not.toHaveBeenCalled();
  });

  test('skips review_input notifications in print mode', async () => {
    const events: string[] = [];
    sendNotificationSpy.mockImplementation(async (_config: any, input: any) => {
      events.push(input.event);
      return true;
    });

    runReviewSpy.mockImplementationOnce(async () => ({
      reviewResult: {
        summary: { totalIssues: 1 },
        issues: [
          {
            severity: 'major',
            content: 'Issue content',
            file: 'src/file.ts',
            line: 10,
          },
        ],
        recommendations: [],
        actionItems: [],
      },
      rawOutput: 'issues were found',
      usedExecutors: ['claude-code'],
      warnings: [],
    }));

    const { handleReviewCommand } = await import('./review.js');

    await handleReviewCommand(planFile, { noSave: true, print: true }, mockCommand);

    expect(events).toContain('review_done');
    expect(events).not.toContain('review_input');
    expect(selectSpy).not.toHaveBeenCalled();
    expect(checkboxSpy).not.toHaveBeenCalled();
  });

  test('emits review_input before action prompt', async () => {
    const events: string[] = [];
    sendNotificationSpy.mockImplementation(async (_config: any, input: any) => {
      events.push(`notify:${input.event}`);
      return true;
    });
    selectSpy.mockImplementation(async () => {
      events.push('select');
      return 'exit';
    });

    runReviewSpy.mockImplementationOnce(async () => ({
      reviewResult: {
        summary: { totalIssues: 1 },
        issues: [
          {
            severity: 'major',
            content: 'Issue content',
            file: 'src/file.ts',
            line: 10,
          },
        ],
        recommendations: [],
        actionItems: [],
      },
      rawOutput: 'issues were found',
      usedExecutors: ['claude-code'],
      warnings: [],
    }));

    const { handleReviewCommand } = await import('./review.js');

    await handleReviewCommand(planFile, { noSave: true }, mockCommand);

    expect(events).toContain('notify:review_input');
    expect(events.indexOf('notify:review_input')).toBeLessThan(events.indexOf('select'));
  });

  test('emits review_input before issue selection prompt', async () => {
    const events: string[] = [];
    sendNotificationSpy.mockImplementation(async (_config: any, input: any) => {
      events.push(`notify:${input.event}`);
      return true;
    });
    checkboxSpy.mockImplementation(async () => {
      events.push('checkbox');
      return [];
    });

    runReviewSpy.mockImplementationOnce(async () => ({
      reviewResult: {
        summary: { totalIssues: 1 },
        issues: [
          {
            severity: 'major',
            content: 'Issue content',
            file: 'src/file.ts',
            line: 10,
          },
        ],
        recommendations: [],
        actionItems: [],
      },
      rawOutput: 'issues were found',
      usedExecutors: ['claude-code'],
      warnings: [],
    }));

    const { handleReviewCommand } = await import('./review.js');

    await handleReviewCommand(planFile, { noSave: true, autofix: true }, mockCommand);

    expect(events).toContain('notify:review_input');
    expect(events.indexOf('notify:review_input')).toBeLessThan(events.indexOf('checkbox'));
  });
});
