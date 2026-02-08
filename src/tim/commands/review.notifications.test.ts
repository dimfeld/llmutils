import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runWithLogger } from '../../logging.js';
import { getLoggerAdapter, type LoggerAdapter } from '../../logging/adapter.js';
import { HeadlessAdapter } from '../../logging/headless_adapter.js';
import { ModuleMocker } from '../../testing.js';
import type { StructuredMessage } from '../../logging/structured_messages.js';

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
let buildExecutorAndLogSpy: ReturnType<typeof mock>;
let createCleanupPlanSpy: ReturnType<typeof mock>;

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
  buildExecutorAndLogSpy = mock(() => ({
    execute: mock(async () => ({ content: 'autofix done', success: true })),
  }));
  createCleanupPlanSpy = mock(async () => ({
    planId: 456,
    filePath: join(tempDir, 'tasks', '456-cleanup-plan.md'),
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

  await moduleMocker.mock('../../logging/tunnel_client.js', () => ({
    isTunnelActive: () => false,
  }));

  await moduleMocker.mock('../utils/context_gathering.js', () => ({
    gatherPlanContext: gatherPlanContextSpy,
  }));

  await moduleMocker.mock('../review_runner.js', () => ({
    runReview: runReviewSpy,
    prepareReviewExecutors: mock(async () => []),
  }));

  await moduleMocker.mock('../executors/index.js', () => ({
    buildExecutorAndLog: buildExecutorAndLogSpy,
    DEFAULT_EXECUTOR: 'claude-code',
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

  await moduleMocker.mock('../utils/cleanup_plan_creator.js', () => ({
    createCleanupPlan: createCleanupPlanSpy,
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

  test('does not create a second headless adapter when one is already active', async () => {
    const headlessModule = await import('../headless.js');
    const createAdapterSpy = spyOn(headlessModule, 'createHeadlessAdapterForCommand');
    const { handleReviewCommand } = await import('./review.js');
    const existingHeadlessAdapter = new HeadlessAdapter(
      'not-a-websocket-url',
      { command: 'agent' },
      noOpAdapter,
      { reconnectIntervalMs: Number.MAX_SAFE_INTEGER }
    );

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
    const destroySpy = spyOn(HeadlessAdapter.prototype, 'destroy');
    gatherPlanContextSpy.mockImplementationOnce(async () => {
      expect(getLoggerAdapter()).toBeInstanceOf(HeadlessAdapter);
      return {
        resolvedPlanFile: planFile,
        planData: { ...basePlan },
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

  test('emits structured review lifecycle messages for successful review', async () => {
    const { handleReviewCommand } = await import('./review.js');
    const structuredMessages: StructuredMessage[] = [];

    runReviewSpy.mockImplementationOnce(async () => ({
      reviewResult: {
        summary: { totalIssues: 0 },
        issues: [],
        recommendations: ['Ship it'],
        actionItems: ['None'],
      },
      rawOutput: '',
      usedExecutors: ['claude-code'],
      warnings: [],
    }));

    await runWithLogger(createStructuredCaptureAdapter(structuredMessages), () =>
      handleReviewCommand(planFile, { noSave: true, noAutofix: true }, mockCommand)
    );

    expect(structuredMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'review_start', planId: 123 }),
        expect.objectContaining({
          type: 'review_result',
          recommendations: ['Ship it'],
          actionItems: ['None'],
        }),
        expect.objectContaining({ type: 'review_verdict', verdict: 'ACCEPTABLE' }),
      ])
    );
  });

  test('maps review issues to structured review_result fields with expected coercions', async () => {
    const { handleReviewCommand } = await import('./review.js');
    const structuredMessages: StructuredMessage[] = [];

    runReviewSpy.mockImplementationOnce(async () => ({
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
        actionItems: [],
      },
      rawOutput: '',
      usedExecutors: ['claude-code'],
      warnings: [],
    }));

    await runWithLogger(createStructuredCaptureAdapter(structuredMessages), () =>
      handleReviewCommand(planFile, { noSave: true, noAutofix: true }, mockCommand)
    );

    const reviewResultMessage = structuredMessages.find(
      (message): message is Extract<StructuredMessage, { type: 'review_result' }> =>
        message.type === 'review_result'
    );

    expect(reviewResultMessage).toBeDefined();
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
      return 'exit';
    });
    runReviewSpy.mockImplementationOnce(async () => ({
      reviewResult: {
        summary: { totalIssues: 1 },
        issues: [{ severity: 'major', category: 'bug', content: 'Fix me' }],
        recommendations: [],
        actionItems: [],
      },
      rawOutput: 'issues found',
      usedExecutors: ['claude-code'],
      warnings: [],
    }));

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

    checkboxSpy.mockImplementation(async () => [issue]);
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
