import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';
import { timAgent } from './agent.js';

// Common spies — declared with vi.hoisted() so they are available inside vi.mock() factories
const {
  logSpy,
  warnSpy,
  errorSpy,
  openLogFileSpy,
  closeLogFileSpy,
  executorExecuteSpy,
  buildExecutorAndLogSpy,
  executeBatchModeSpy,
  recordStartSpy,
  recordEndSpy,
  trackFilesSpy,
  getSummarySpy,
} = vi.hoisted(() => {
  const executorExecuteSpy = vi.fn(async () => {});
  return {
    logSpy: vi.fn(() => {}),
    warnSpy: vi.fn(() => {}),
    errorSpy: vi.fn(() => {}),
    openLogFileSpy: vi.fn(() => {}),
    closeLogFileSpy: vi.fn(async () => {}),
    executorExecuteSpy,
    buildExecutorAndLogSpy: vi.fn(() => ({ execute: executorExecuteSpy, filePathPrefix: '' })),
    executeBatchModeSpy: vi.fn(async () => {}),
    recordStartSpy: vi.fn(() => {}),
    recordEndSpy: vi.fn(() => {}),
    trackFilesSpy: vi.fn(async () => {}),
    getSummarySpy: vi.fn(() => ({
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
    })),
  };
});

let tempDir = '';

vi.mock('../../../logging.js', () => ({
  log: logSpy,
  warn: warnSpy,
  error: errorSpy,
  openLogFile: openLogFileSpy,
  closeLogFile: closeLogFileSpy,
  boldMarkdownHeaders: (s: string) => s,
  debugLog: vi.fn(() => {}),
  sendStructured: vi.fn(() => {}),
}));

vi.mock('../../../common/git.js', () => ({
  getGitRoot: vi.fn(async () => tempDir),
}));

vi.mock('../../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(async () => ({ models: { execution: 'm' } })),
  loadGlobalConfigForNotifications: vi.fn(async () => ({})),
}));

vi.mock('../../executors/index.js', () => ({
  buildExecutorAndLog: buildExecutorAndLogSpy,
  DEFAULT_EXECUTOR: 'copy-only',
  defaultModelForExecutor: vi.fn(() => 'm'),
}));

vi.mock('../../plans.js', () => {
  class PlanNotFoundError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'PlanNotFoundError';
    }
  }
  class NoFrontmatterError extends Error {
    constructor(filePath: string) {
      super(`File lacks frontmatter: ${filePath}`);
      this.name = 'NoFrontmatterError';
    }
  }
  return {
    PlanNotFoundError,
    NoFrontmatterError,
    resolvePlanFile: vi.fn(async (p: string) => p),
    readPlanFile: vi.fn(async (p: string) => {
      const content = await fs.readFile(p, 'utf-8');
      return yaml.parse(content.replace(/^#.*\n/, ''));
    }),
    writePlanFile: vi.fn(async (p: string, data: any) => {
      const schemaComment =
        '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json\n';
      await fs.writeFile(p, schemaComment + yaml.stringify(data));
    }),
    generatePlanFileContent: vi.fn(() => ''),
    resolvePlanFromDb: vi.fn(async () => ({
      plan: { id: 1, title: 'Test Plan', status: 'pending', tasks: [] },
      planPath: '',
    })),
    writePlanToDb: vi.fn(async () => {}),
    setPlanStatus: vi.fn(async () => {}),
    setPlanStatusById: vi.fn(async () => {}),
    isTaskDone: vi.fn(() => false),
  };
});

vi.mock('../../prompt_builder.js', () => ({
  buildExecutionPromptWithoutSteps: vi.fn(async () => 'batch-context'),
}));

vi.mock('./batch_mode.js', () => ({
  executeBatchMode: executeBatchModeSpy,
}));

vi.mock('../../summary/collector.js', () => {
  class SummaryCollector {
    constructor(_opts: any) {}
    recordExecutionStart(...args: any[]) {
      return recordStartSpy(...args);
    }
    recordExecutionEnd(...args: any[]) {
      return recordEndSpy(...args);
    }
    trackFileChanges(...args: any[]) {
      return trackFilesSpy(...args);
    }
    getExecutionSummary(...args: any[]) {
      return getSummarySpy(...args);
    }
    addStepResult() {}
    setBatchIterations() {}
  }
  return { SummaryCollector };
});

vi.mock('../../summary/display.js', () => ({
  displayExecutionSummary: vi.fn(() => {}),
  formatExecutionSummaryToLines: vi.fn((s: any) => [
    `Execution Summary: ${s.planTitle}`,
    `Steps: ${s.metadata?.totalSteps ?? 0}`,
  ]),
  writeOrDisplaySummary: vi.fn(async (summary: any, filePath?: string) => {
    if (!filePath) return;
    const lines = [
      `${summary.planTitle}`,
      '------------------------------------------------------------',
      ...[`Execution Summary: ${summary.planTitle}`, `Steps: ${summary.metadata?.totalSteps ?? 0}`],
    ];
    await fs.writeFile(filePath, lines.join('\n'));
  }),
}));

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
    tasks: [{ title: 'T1', description: 'D1', steps: [{ prompt: 'p1', done: false }] }],
  };
  const schemaComment =
    '# yaml-language-server: $schema=https://raw.githubusercontent.com/dimfeld/llmutils/main/schema/tim-plan-schema.json\n';
  await fs.writeFile(planFile, schemaComment + yaml.stringify(plan));
}

describe('timAgent summary options', () => {
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

    await writePlanWithTasks();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
    delete process.env.TIM_SUMMARY_ENABLED;
  });

  test('does not initialize summary when --no-summary is set', async () => {
    const options = { log: false, nonInteractive: true, summary: false } as any;
    const globalCliOptions = {};

    await timAgent(planFile, options, globalCliOptions);

    expect(recordStartSpy).not.toHaveBeenCalled();
    expect(recordEndSpy).not.toHaveBeenCalled();
    expect(trackFilesSpy).not.toHaveBeenCalled();
  });

  test('env TIM_SUMMARY_ENABLED=false disables summary by default', async () => {
    process.env.TIM_SUMMARY_ENABLED = 'false';

    const options = { log: false, nonInteractive: true } as any;
    const globalCliOptions = {};

    await timAgent(planFile, options, globalCliOptions);

    expect(recordStartSpy).not.toHaveBeenCalled();
  });

  test('writes summary to file when --summary-file is provided', async () => {
    const outPath = path.join(tempDir, 'summary.txt');
    const options = { log: false, nonInteractive: true, summaryFile: outPath } as any;
    const globalCliOptions = {};

    await timAgent(planFile, options, globalCliOptions);

    // Summary hooks called
    expect(recordStartSpy).toHaveBeenCalled();
    expect(recordEndSpy).toHaveBeenCalled();

    // File written with content containing plan title
    const content = await fs.readFile(outPath, 'utf-8');
    expect(content).toContain('Test Plan');
    expect(content).toContain('Execution Summary: Test Plan');
  });
});
