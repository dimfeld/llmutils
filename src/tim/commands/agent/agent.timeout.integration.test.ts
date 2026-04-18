import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import yaml from 'yaml';

let tempDir = '';
const logSink = vi.fn(() => {});

// Declare with vi.hoisted so they're available inside vi.mock() factory functions
const { executorExecuteSpy } = vi.hoisted(() => ({
  executorExecuteSpy: vi.fn(async () => {
    throw new Error('permission prompt timeout');
  }),
}));

vi.mock('../../../logging.js', () => ({
  log: logSink,
  error: logSink,
  warn: logSink,
  boldMarkdownHeaders: (s: string) => s,
  openLogFile: vi.fn(() => {}),
  closeLogFile: vi.fn(async () => {}),
  debugLog: vi.fn(() => {}),
  sendStructured: vi.fn(() => {}),
  writeStdout: vi.fn(() => {}),
  writeStderr: vi.fn(() => {}),
  runWithLogger: vi.fn(async (_adapter: any, fn: () => any) => fn()),
}));

vi.mock('../../../common/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../common/git.js')>();
  return {
    ...actual,
    getGitRoot: vi.fn(async () => tempDir),
  };
});

vi.mock('../../../logging/tunnel_client.js', () => ({
  isTunnelActive: vi.fn(() => false),
}));

vi.mock('../../headless.js', () => ({
  runWithHeadlessAdapterIfEnabled: vi.fn(async (options: any) => options.callback()),
  isTunnelActive: vi.fn(() => false),
  toHeadlessPlanSummary: vi.fn((plan: any) => plan),
  createHeadlessAdapterForCommand: vi.fn(async () => null),
  updateHeadlessSessionInfo: vi.fn(() => {}),
  buildHeadlessSessionInfo: vi.fn(async () => null),
  resetHeadlessWarningStateForTests: vi.fn(() => {}),
  resolveHeadlessUrl: vi.fn(() => 'ws://localhost:8123/tim-agent'),
  DEFAULT_HEADLESS_URL: 'ws://localhost:8123/tim-agent',
}));

vi.mock('../../executors/index.js', () => ({
  buildExecutorAndLog: vi.fn(() => ({
    execute: executorExecuteSpy,
    filePathPrefix: '',
  })),
  DEFAULT_EXECUTOR: 'copy-only',
  defaultModelForExecutor: vi.fn(() => 'test-model'),
}));

vi.mock('../../workspace/workspace_roundtrip.js', () => ({
  prepareWorkspaceRoundTrip: vi.fn(async () => null),
  runPostExecutionWorkspaceSync: vi.fn(async () => {}),
  runPreExecutionWorkspaceSync: vi.fn(async () => {}),
  materializePlansForExecution: vi.fn(async () => undefined),
}));

vi.mock('../../workspace/workspace_setup.js', () => ({
  setupWorkspace: vi.fn(async (_options: any, baseDir: string, currentPlanFile: string) => ({
    baseDir,
    planFile: currentPlanFile,
    branchCreatedDuringSetup: false,
  })),
}));

vi.mock('../../plans.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../plans.js')>();
  return {
    ...actual,
    resolvePlanByNumericId: vi.fn(async (planId: number) => ({
      plan: { id: planId, title: 'Timeout Plan', status: 'in_progress', tasks: [] },
      planPath: path.join(tempDir, 'tasks', `${planId}.yml`),
    })),
  };
});

describe('tim agent integration (timeout simulation)', () => {
  let tasksDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-agent-timeout-'));
    tasksDir = path.join(tempDir, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });

    // Initialize a real git repo for file-change tracking
    await Bun.$`git init -b main`.cwd(tempDir).quiet();
    await Bun.$`git config user.email test@example.com`.cwd(tempDir).quiet();
    await Bun.$`git config user.name "Test User"`.cwd(tempDir).quiet();

    // Seed a tracked file for file-change tracking
    await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
    await fs.writeFile(path.join(tempDir, 'src', 'foo.txt'), 'initial\n');
    await Bun.$`git add .`.cwd(tempDir).quiet();
    await Bun.$`git commit -m "Initial commit"`.cwd(tempDir).quiet();

    // Create config file
    configPath = path.join(tempDir, '.rmfilter', 'tim.yml');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      yaml.stringify({
        paths: { tasks: 'tasks' },
      }),
      'utf8'
    );

    logSink.mockReset();
    executorExecuteSpy.mockReset();
    executorExecuteSpy.mockImplementation(async () => {
      throw new Error('permission prompt timeout');
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  test('captures failed step and error message when executor times out', async () => {
    const plan = {
      id: 707,
      title: 'Timeout Plan',
      goal: 'Simulate executor timeout',
      details: 'Verify summary captures timeout error',
      status: 'in_progress',
      tasks: [
        {
          title: 'Timeout Task',
          description: 'Will time out',
          done: false,
          steps: [{ prompt: 'Simulate timeout', done: false }],
        },
      ],
    };
    const planPath = path.join(tasksDir, '707.yml');
    const { details, ...planWithoutDetails } = plan;
    let planContent = `---\n${yaml.stringify(planWithoutDetails)}---\n`;
    if (details) {
      planContent += `\n${details}\n`;
    }
    await fs.writeFile(planPath, planContent, 'utf8');

    const { timAgent } = await import('./agent.js');

    const summaryOut = path.join(tempDir, 'out', 'timeout-summary.txt');
    await expect(
      timAgent(
        707,
        { serialTasks: true, summaryFile: summaryOut, model: 'auto', log: false },
        { config: configPath }
      )
    ).rejects.toBeInstanceOf(Error);

    const content = await fs.readFile(summaryOut, 'utf8');
    expect(content).toContain('Execution Summary: Timeout Plan');
    // Failed step recorded
    expect(content).toMatch(/Failed Steps[\s\S]*1/);
    // Error message included in steps/errors
    expect(content).toContain('permission prompt timeout');
  });
});
