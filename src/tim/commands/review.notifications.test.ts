import { vi, describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runWithLogger } from '../../logging.js';
import { getLoggerAdapter, type LoggerAdapter } from '../../logging/adapter.js';
import { HeadlessAdapter } from '../../logging/headless_adapter.js';
import { stringifyPlanWithFrontmatter } from '../../testing.js';
import type { StructuredMessage } from '../../logging/structured_messages.js';
import * as notificationsModule from '../notifications.js';
import * as inputModule from '../../common/input.js';
import * as configLoaderModule from '../configLoader.js';
import * as gitModule from '../../common/git.js';
import * as tunnelClientModule from '../../logging/tunnel_client.js';
import * as contextGatheringModule from '../utils/context_gathering.js';
import * as reviewRunnerModule from '../review_runner.js';
import * as executorsModule from '../executors/index.js';
import * as reviewFormatterModule from '../formatters/review_formatter.js';
import * as incrementalReviewModule from '../incremental_review.js';
import * as reviewPersistenceModule from '../review_persistence.js';
import * as fileValidationModule from '../utils/file_validation.js';
import * as cleanupPlanCreatorModule from '../utils/cleanup_plan_creator.js';

vi.mock('../notifications.js', () => ({
  sendNotification: vi.fn(),
}));

vi.mock('../../common/input.js', () => ({
  promptSelect: vi.fn(),
  promptCheckbox: vi.fn(),
}));

vi.mock('../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(),
  loadGlobalConfigForNotifications: vi.fn(),
}));

vi.mock('../../common/git.js', () => ({
  getGitRoot: vi.fn(),
  getCurrentCommitHash: vi.fn(),
  getTrunkBranch: vi.fn(),
  getUsingJj: vi.fn(),
  getCurrentBranchName: vi.fn(),
}));

vi.mock('../../logging/tunnel_client.js', () => ({
  isTunnelActive: vi.fn(),
}));

vi.mock('../utils/context_gathering.js', () => ({
  gatherPlanContext: vi.fn(),
}));

vi.mock('../review_runner.js', () => ({
  runReview: vi.fn(),
  prepareReviewExecutors: vi.fn(),
}));

vi.mock('../executors/index.js', () => ({
  buildExecutorAndLog: vi.fn(),
  DEFAULT_EXECUTOR: 'claude-code',
}));

vi.mock('../formatters/review_formatter.js', () => ({
  createFormatter: vi.fn(),
  createReviewResult: vi.fn(),
}));

vi.mock('../incremental_review.js', () => ({
  storeLastReviewMetadata: vi.fn(),
  getLastReviewMetadata: vi.fn(),
  getIncrementalDiff: vi.fn(),
}));

vi.mock('../review_persistence.js', () => ({
  saveReviewResult: vi.fn(),
  createReviewsDirectory: vi.fn(),
  createGitNote: vi.fn(),
}));

vi.mock('../utils/file_validation.js', () => ({
  validateInstructionsFilePath: vi.fn(),
}));

vi.mock('../utils/cleanup_plan_creator.js', () => ({
  createCleanupPlan: vi.fn(),
}));

let tempDir: string;
let planFile: string;
let sendNotificationSpy: ReturnType<typeof vi.fn>;
let runReviewSpy: ReturnType<typeof vi.fn>;
let gatherPlanContextSpy: ReturnType<typeof vi.fn>;
let selectSpy: ReturnType<typeof vi.fn>;
let checkboxSpy: ReturnType<typeof vi.fn>;
let loadEffectiveConfigSpy: ReturnType<typeof vi.fn>;
let loadGlobalConfigForNotificationsSpy: ReturnType<typeof vi.fn>;
let buildExecutorAndLogSpy: ReturnType<typeof vi.fn>;
let createCleanupPlanSpy: ReturnType<typeof vi.fn>;

const noOpAdapter: LoggerAdapter = {
  log: () => {},
  error: () => {},
  warn: () => {},
  writeStdout: () => {},
  writeStderr: () => {},
  debugLog: () => {},
  sendStructured: (_message: StructuredMessage) => {},
};

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

function createStructuredCaptureAdapter(messages: StructuredMessage[]): LoggerAdapter {
  return {
    log: () => {},
    error: () => {},
    warn: () => {},
    writeStdout: () => {},
    writeStderr: () => {},
    debugLog: () => {},
    sendStructured: (message: StructuredMessage) => {
      messages.push(message);
    },
  };
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'tim-review-notify-'));
  planFile = join(tempDir, 'plan.yml');
  await writeFile(
    planFile,
    stringifyPlanWithFrontmatter({
      id: 123,
      title: 'Notify Plan',
      goal: 'Goal',
      details: 'Details',
      status: 'pending',
      tasks: [],
    })
  );

  sendNotificationSpy = vi.mocked(notificationsModule.sendNotification);
  runReviewSpy = vi.mocked(reviewRunnerModule.runReview);
  gatherPlanContextSpy = vi.mocked(contextGatheringModule.gatherPlanContext);
  selectSpy = vi.mocked(inputModule.promptSelect);
  checkboxSpy = vi.mocked(inputModule.promptCheckbox);
  loadEffectiveConfigSpy = vi.mocked(configLoaderModule.loadEffectiveConfig);
  loadGlobalConfigForNotificationsSpy = vi.mocked(
    configLoaderModule.loadGlobalConfigForNotifications
  );
  buildExecutorAndLogSpy = vi.mocked(executorsModule.buildExecutorAndLog);
  createCleanupPlanSpy = vi.mocked(cleanupPlanCreatorModule.createCleanupPlan);

  sendNotificationSpy.mockResolvedValue(true);
  runReviewSpy.mockResolvedValue({
    reviewResult: {
      summary: { totalIssues: 0 },
      issues: [],
      recommendations: [],
      actionItems: [],
    },
    rawOutput: '',
    usedExecutors: ['claude-code'],
    warnings: [],
  } as any);
  gatherPlanContextSpy.mockResolvedValue({
    resolvedPlanFile: planFile,
    planData: { ...basePlan },
    repoRoot: tempDir,
    gitRoot: tempDir,
    parentChain: [],
    completedChildren: [],
    diffResult: { ...baseDiff },
    noChangesDetected: false,
  } as any);
  selectSpy.mockResolvedValue('exit' as any);
  checkboxSpy.mockResolvedValue([] as any);
  loadEffectiveConfigSpy.mockResolvedValue({ notifications: { command: 'notify' } } as any);
  loadGlobalConfigForNotificationsSpy.mockResolvedValue({
    notifications: { command: 'notify' },
  } as any);
  buildExecutorAndLogSpy.mockReturnValue({
    execute: vi.fn(async () => ({ content: 'autofix done', success: true })),
  } as any);
  createCleanupPlanSpy.mockResolvedValue({
    planId: 456,
    filePath: join(tempDir, 'tasks', '456-cleanup-plan.md'),
  } as any);

  vi.mocked(gitModule.getGitRoot).mockResolvedValue(tempDir);
  vi.mocked(gitModule.getCurrentCommitHash).mockResolvedValue(undefined as any);
  vi.mocked(gitModule.getTrunkBranch).mockResolvedValue('main');
  vi.mocked(gitModule.getUsingJj).mockResolvedValue(false);

  vi.mocked(tunnelClientModule.isTunnelActive).mockReturnValue(false);

  vi.mocked(reviewRunnerModule.prepareReviewExecutors).mockResolvedValue([] as any);

  vi.mocked(reviewFormatterModule.createFormatter).mockReturnValue({
    format: () => 'formatted',
    getFileExtension: () => '.md',
  } as any);
  vi.mocked(reviewFormatterModule.createReviewResult).mockImplementation((input: any) => input);

  vi.mocked(incrementalReviewModule.storeLastReviewMetadata).mockResolvedValue(undefined);
  vi.mocked(incrementalReviewModule.getLastReviewMetadata).mockResolvedValue(undefined);
  vi.mocked(incrementalReviewModule.getIncrementalDiff).mockResolvedValue({
    hasChanges: true,
    changedFiles: [],
    baseBranch: 'main',
    diffContent: '',
  } as any);

  vi.mocked(reviewPersistenceModule.saveReviewResult).mockResolvedValue('' as any);
  vi.mocked(reviewPersistenceModule.createReviewsDirectory).mockResolvedValue('' as any);
  vi.mocked(reviewPersistenceModule.createGitNote).mockResolvedValue(false);

  vi.mocked(fileValidationModule.validateInstructionsFilePath).mockImplementation(
    (input: string) => input
  );
});

afterEach(async () => {
  vi.clearAllMocks();
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
    loadEffectiveConfigSpy.mockRejectedValueOnce(new Error('config boom'));

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
    runReviewSpy.mockRejectedValueOnce(new Error('boom'));

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
    gatherPlanContextSpy.mockRejectedValueOnce(new Error('context boom'));

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
    gatherPlanContextSpy.mockResolvedValueOnce({
      resolvedPlanFile: planFile,
      planData: { ...basePlan },
      repoRoot: tempDir,
      gitRoot: tempDir,
      parentChain: [],
      completedChildren: [],
      diffResult: { ...baseDiff },
      noChangesDetected: true,
    } as any);

    const { handleReviewCommand } = await import('./review.js');

    await handleReviewCommand(planFile, { noSave: true, noAutofix: true }, mockCommand);

    expect(sendNotificationSpy).not.toHaveBeenCalled();
  });

  test('skips notifications in dry-run mode', async () => {
    const { handleReviewCommand } = await import('./review.js');

    await handleReviewCommand(planFile, { noSave: true, dryRun: true }, mockCommand);

    expect(sendNotificationSpy).not.toHaveBeenCalled();
  });

  test('does not create a second headless adapter when one is already active', async () => {
    const headlessModule = await import('../headless.js');
    const createAdapterSpy = vi.spyOn(headlessModule, 'createHeadlessAdapterForCommand');
    const { handleReviewCommand } = await import('./review.js');
    const existingHeadlessAdapter = new HeadlessAdapter({ command: 'agent' }, noOpAdapter);

    try {
      await runWithLogger(existingHeadlessAdapter, () =>
        handleReviewCommand(planFile, { noSave: true, noAutofix: true }, mockCommand)
      );
      expect(createAdapterSpy).not.toHaveBeenCalled();
    } finally {
      await existingHeadlessAdapter.destroy();
      createAdapterSpy.mockRestore();
    }
  });

  test('creates and destroys a headless adapter in standalone mode', async () => {
    const destroySpy = vi.spyOn(HeadlessAdapter.prototype, 'destroy');
    gatherPlanContextSpy.mockImplementationOnce(async () => {
      expect(getLoggerAdapter()).toBeInstanceOf(HeadlessAdapter);
      return {
        resolvedPlanFile: planFile,
        planData: { ...basePlan },
        repoRoot: tempDir,
        gitRoot: tempDir,
        parentChain: [],
        completedChildren: [],
        diffResult: { ...baseDiff },
        noChangesDetected: false,
      };
    });

    const { handleReviewCommand } = await import('./review.js');

    try {
      await handleReviewCommand(planFile, { noSave: true, noAutofix: true }, mockCommand);
      expect(destroySpy).toHaveBeenCalledTimes(1);
    } finally {
      destroySpy.mockRestore();
    }
  });

  test('skips review_input notifications in non-interactive mode', async () => {
    process.env.TIM_INTERACTIVE = '0';
    const events: string[] = [];
    sendNotificationSpy.mockImplementation(async (_config: any, input: any) => {
      events.push(input.event);
      return true;
    });

    runReviewSpy.mockResolvedValueOnce({
      reviewResult: {
        summary: { totalIssues: 1 },
        issues: [
          {
            severity: 'major',
            category: 'bug',
            id: 'issue-1',
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
    } as any);

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

    runReviewSpy.mockResolvedValueOnce({
      reviewResult: {
        summary: { totalIssues: 1 },
        issues: [
          {
            severity: 'major',
            category: 'bug',
            id: 'issue-2',
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
    } as any);

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
      return 'exit' as any;
    });

    runReviewSpy.mockResolvedValueOnce({
      reviewResult: {
        summary: { totalIssues: 1 },
        issues: [
          {
            severity: 'major',
            category: 'bug',
            id: 'issue-3',
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
    } as any);

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
      return [] as any;
    });

    runReviewSpy.mockResolvedValueOnce({
      reviewResult: {
        summary: { totalIssues: 1 },
        issues: [
          {
            severity: 'major',
            category: 'bug',
            id: 'issue-4',
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
    } as any);

    const { handleReviewCommand } = await import('./review.js');

    await handleReviewCommand(planFile, { noSave: true, autofix: true }, mockCommand);

    expect(events).toContain('notify:review_input');
    expect(events.indexOf('notify:review_input')).toBeLessThan(events.indexOf('checkbox'));
  });

  test('emits structured review lifecycle messages for successful review', async () => {
    const { handleReviewCommand } = await import('./review.js');
    const structuredMessages: StructuredMessage[] = [];

    runReviewSpy.mockResolvedValueOnce({
      reviewResult: {
        summary: { totalIssues: 0 },
        issues: [],
        recommendations: ['Ship it'],
        actionItems: ['None'],
      },
      rawOutput: '',
      usedExecutors: ['claude-code'],
      warnings: [],
    } as any);

    await runWithLogger(createStructuredCaptureAdapter(structuredMessages), () =>
      handleReviewCommand(planFile, { noSave: true, noAutofix: true }, mockCommand)
    );

    expect(structuredMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'review_start', planId: 123 }),
        expect.objectContaining({
          type: 'review_result',
          verdict: 'ACCEPTABLE',
          fixInstructions: undefined,
          recommendations: ['Ship it'],
          actionItems: ['None'],
        }),
      ])
    );
    expect(
      structuredMessages.some((message) => (message as { type?: string }).type === 'review_verdict')
    ).toBe(false);
  });

  test('maps review issues to structured review_result fields with expected coercions', async () => {
    const { handleReviewCommand } = await import('./review.js');
    const structuredMessages: StructuredMessage[] = [];

    runReviewSpy.mockResolvedValueOnce({
      reviewResult: {
        summary: { totalIssues: 1 },
        issues: [
          {
            id: 'issue-1',
            severity: 'major',
            category: 'testing',
            content: 'Add coverage for issue mapping.',
            line: 42,
          },
        ],
        recommendations: [],
        actionItems: ['Fix the testing issue', 'Run tests'],
      },
      rawOutput: '',
      usedExecutors: ['claude-code'],
      warnings: [],
    } as any);

    await runWithLogger(createStructuredCaptureAdapter(structuredMessages), () =>
      handleReviewCommand(planFile, { noSave: true, noAutofix: true }, mockCommand)
    );

    const reviewResultMessage = structuredMessages.find(
      (message): message is Extract<StructuredMessage, { type: 'review_result' }> =>
        message.type === 'review_result'
    );

    expect(reviewResultMessage).toBeDefined();
    expect(reviewResultMessage?.verdict).toBe('NEEDS_FIXES');
    expect(reviewResultMessage?.fixInstructions).toBe('Fix the testing issue\nRun tests');
    expect(reviewResultMessage?.issues).toEqual([
      {
        severity: 'major',
        category: 'testing',
        content: 'Add coverage for issue mapping.',
        file: '',
        line: '42',
        suggestion: '',
      },
    ]);
    expect(
      structuredMessages.some((message) => (message as { type?: string }).type === 'review_verdict')
    ).toBe(false);
  });

  test('emits structured input_required before action prompt selection', async () => {
    const { handleReviewCommand } = await import('./review.js');
    const orderedEvents: string[] = [];
    const structuredMessages: StructuredMessage[] = [];
    const adapter: LoggerAdapter = {
      ...createStructuredCaptureAdapter(structuredMessages),
      sendStructured: (message: StructuredMessage) => {
        structuredMessages.push(message);
        if (message.type === 'input_required') {
          orderedEvents.push('input_required');
        }
      },
    };

    selectSpy.mockImplementationOnce(async () => {
      orderedEvents.push('select');
      return 'exit' as any;
    });
    runReviewSpy.mockResolvedValueOnce({
      reviewResult: {
        summary: { totalIssues: 1 },
        issues: [{ severity: 'major', category: 'bug', content: 'Fix me' }],
        recommendations: [],
        actionItems: [],
      },
      rawOutput: 'issues found',
      usedExecutors: ['claude-code'],
      warnings: [],
    } as any);

    await runWithLogger(adapter, () =>
      handleReviewCommand(planFile, { noSave: true }, mockCommand)
    );

    expect(orderedEvents).toContain('input_required');
    expect(orderedEvents).toContain('select');
    expect(orderedEvents.indexOf('input_required')).toBeLessThan(orderedEvents.indexOf('select'));
  });

  test('emits workflow_progress for autofix and cleanup flows', async () => {
    const { handleReviewCommand } = await import('./review.js');
    const structuredMessages: StructuredMessage[] = [];
    const issue = { severity: 'major', category: 'bug', content: 'Autofix this', file: 'a.ts' };

    checkboxSpy.mockImplementation(async () => [0] as any);
    runReviewSpy.mockImplementation(async () => ({
      reviewResult: {
        summary: { totalIssues: 1 },
        issues: [issue],
        recommendations: [],
        actionItems: [],
      },
      rawOutput: 'issues found',
      usedExecutors: ['claude-code'],
      warnings: [],
    }));

    await runWithLogger(createStructuredCaptureAdapter(structuredMessages), () =>
      handleReviewCommand(planFile, { noSave: true, autofix: true }, mockCommand)
    );
    expect(structuredMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'workflow_progress', phase: 'autofix' }),
      ])
    );

    structuredMessages.length = 0;
    await runWithLogger(createStructuredCaptureAdapter(structuredMessages), () =>
      handleReviewCommand(planFile, { noSave: true, createCleanupPlan: true }, mockCommand)
    );
    expect(structuredMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'workflow_progress', phase: 'cleanup' }),
      ])
    );
    expect(createCleanupPlanSpy).toHaveBeenCalled();
  });
});
