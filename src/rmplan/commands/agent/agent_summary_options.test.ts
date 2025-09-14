import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { rmplanAgent } from './agent.js';
import { ModuleMocker } from '../../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

// Common spies
const logSpy = mock(() => {});
const warnSpy = mock(() => {});
const errorSpy = mock(() => {});
const openLogFileSpy = mock(() => {});
const closeLogFileSpy = mock(async () => {});

// Executor mock
const executorExecuteSpy = mock(async () => {});
const buildExecutorAndLogSpy = mock(() => ({ execute: executorExecuteSpy, filePathPrefix: '' }));

// Batch mode mock
const executeBatchModeSpy = mock(async () => {});

// Summary mocks (configured per test when needed)
const recordStartSpy = mock(() => {});
const recordEndSpy = mock(() => {});
const trackFilesSpy = mock(async () => {});
const getSummarySpy = mock(() => ({
  planId: '1',
  planTitle: 'Test Plan',
  planFilePath: '',
  mode: 'batch',
  startedAt: new Date().toISOString(),
  endedAt: new Date().toISOString(),
  durationMs: 0,
  steps: [],
  changedFiles: [],
  errors: [],
  metadata: { totalSteps: 0, failedSteps: 0 },
}));

let tempDir: string;
let planFile: string;

async function writePlanWithTasks() {
  const plan = {
    id: 1,
    title: 'Test Plan',
    goal: 'g',
    details: 'd',
    status: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tasks: [
      { title: 'T1', description: 'D1', steps: [{ prompt: 'p1', done: false }] },
    ],
  };
  const schemaComment =
    '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json\n';
  await fs.writeFile(planFile, schemaComment + yaml.stringify(plan));
}

describe('rmplanAgent summary options', () => {
  beforeEach(async () => {
    // Reset spies
    logSpy.mockClear();
    warnSpy.mockClear();
    errorSpy.mockClear();
    openLogFileSpy.mockClear();
    closeLogFileSpy.mockClear();
    executorExecuteSpy.mockClear();
    buildExecutorAndLogSpy.mockClear();
    executeBatchModeSpy.mockClear();
    recordStartSpy.mockClear();
    recordEndSpy.mockClear();
    trackFilesSpy.mockClear();
    getSummarySpy.mockClear();

    // Temp dir + plan
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-summary-test-'));
    planFile = path.join(tempDir, 'plan.yml');

    // Mocks
    await moduleMocker.mock('../../../logging.js', () => ({
      log: logSpy,
      warn: warnSpy,
      error: errorSpy,
      openLogFile: openLogFileSpy,
      closeLogFile: closeLogFileSpy,
      boldMarkdownHeaders: (s: string) => s,
    }));

    await moduleMocker.mock('../../../common/git.js', () => ({
      getGitRoot: mock(async () => tempDir),
    }));

    await moduleMocker.mock('../../configLoader.js', () => ({
      loadEffectiveConfig: mock(async () => ({ models: { execution: 'm' } })),
    }));

    await moduleMocker.mock('../../executors/index.js', () => ({
      buildExecutorAndLog: buildExecutorAndLogSpy,
      DEFAULT_EXECUTOR: 'copy-only',
      defaultModelForExecutor: mock(() => 'm'),
    }));

    await moduleMocker.mock('../../plans.js', () => ({
      resolvePlanFile: mock(async (p: string) => p),
      readPlanFile: mock(async (p: string) => {
        const content = await fs.readFile(p, 'utf-8');
        return yaml.parse(content.replace(/^#.*\n/, ''));
      }),
      writePlanFile: mock(async (p: string, data: any) => {
        const schemaComment =
          '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/rmplan-plan-schema.json\n';
        await fs.writeFile(p, schemaComment + yaml.stringify(data));
      }),
    }));

    await moduleMocker.mock('../../prompt_builder.js', () => ({
      buildExecutionPromptWithoutSteps: mock(async () => 'batch-context'),
    }));

    await moduleMocker.mock('./batch_mode.js', () => ({
      executeBatchMode: executeBatchModeSpy,
    }));

    await moduleMocker.mock('../../summary/collector.js', () => ({
      SummaryCollector: mock(() => ({
        recordExecutionStart: recordStartSpy,
        recordExecutionEnd: recordEndSpy,
        trackFileChanges: trackFilesSpy,
        getExecutionSummary: getSummarySpy,
        addStepResult: mock(() => {}),
        setBatchIterations: mock(() => {}),
      })),
    }));

    await moduleMocker.mock('../../summary/display.js', () => ({
      displayExecutionSummary: mock(() => {}),
      formatExecutionSummaryToLines: mock((s: any) => [
        `Execution Summary: ${s.planTitle}`,
        `Steps: ${s.metadata?.totalSteps ?? 0}`,
      ]),
      writeOrDisplaySummary: mock(async (summary: any, filePath?: string) => {
        if (!filePath) return;
        const lines = [
          `${summary.planTitle}`,
          '------------------------------------------------------------',
          ...[
            `Execution Summary: ${summary.planTitle}`,
            `Steps: ${summary.metadata?.totalSteps ?? 0}`,
          ],
        ];
        await fs.writeFile(filePath, lines.join('\n'));
      }),
    }));

    await writePlanWithTasks();
  });

  afterEach(async () => {
    moduleMocker.clear();
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
    delete process.env.RMPLAN_SUMMARY_ENABLED;
  });

  test('does not initialize summary when --no-summary is set', async () => {
    const options = { log: false, nonInteractive: true, summary: false } as any;
    const globalCliOptions = {};

    await rmplanAgent(planFile, options, globalCliOptions);

    expect(recordStartSpy).not.toHaveBeenCalled();
    expect(recordEndSpy).not.toHaveBeenCalled();
    expect(trackFilesSpy).not.toHaveBeenCalled();
  });

  test('env RMPLAN_SUMMARY_ENABLED=false disables summary by default', async () => {
    process.env.RMPLAN_SUMMARY_ENABLED = 'false';

    const options = { log: false, nonInteractive: true } as any;
    const globalCliOptions = {};

    await rmplanAgent(planFile, options, globalCliOptions);

    expect(recordStartSpy).not.toHaveBeenCalled();
  });

  test('writes summary to file when --summary-file is provided', async () => {
    const outPath = path.join(tempDir, 'summary.txt');
    const options = { log: false, nonInteractive: true, summaryFile: outPath } as any;
    const globalCliOptions = {};

    await rmplanAgent(planFile, options, globalCliOptions);

    // Summary hooks called
    expect(recordStartSpy).toHaveBeenCalled();
    expect(recordEndSpy).toHaveBeenCalled();

    // File written with content containing plan title
    const content = await fs.readFile(outPath, 'utf-8');
    expect(content).toContain('Test Plan');
    expect(content).toContain('Execution Summary: Test Plan');
  });
});
