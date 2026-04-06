import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';

let tempDir: string;
let yielded = false;
const markStepDoneSpy = vi.fn(async () => ({ planComplete: false, message: 'ok' }));

vi.mock('../../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(async () => ({ models: {}, postApplyCommands: [] })),
  loadGlobalConfigForNotifications: vi.fn(async () => ({})),
}));

vi.mock('../../summary/collector.js', () => ({
  SummaryCollector: class {
    recordExecutionStart = vi.fn(() => {});
    recordExecutionEnd = vi.fn(() => {});
    addStepResult = vi.fn(() => {});
    addError = vi.fn(() => {});
    trackFileChanges = vi.fn(async () => {});
    getExecutionSummary = vi.fn(() => ({ steps: [], changedFiles: [], errors: [] }));
    setBatchIterations = vi.fn(() => {});
  },
}));

vi.mock('../../summary/display.js', () => ({
  writeOrDisplaySummary: vi.fn(async () => {}),
  formatExecutionSummaryToLines: vi.fn(() => []),
  displayExecutionSummary: vi.fn(() => {}),
}));

vi.mock('../../../common/git.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../common/git.js')>()),
  getGitRoot: vi.fn(async () => tempDir),
}));

vi.mock('../../plans/find_next.js', () => ({
  findNextActionableItem: vi.fn(() => {
    if (yielded) return null;
    yielded = true;
    return {
      type: 'step',
      taskIndex: 0,
      stepIndex: 0,
      task: { title: 'T1', description: '', steps: [{ prompt: 'do it', done: false }] },
    };
  }),
  getAllIncompleteTasks: vi.fn(() => []),
  findPendingTask: vi.fn(() => null),
}));

vi.mock('../../plans/prepare_step.js', () => ({
  prepareNextStep: vi.fn(async () => ({
    prompt: 'CTX',
    promptFilePath: undefined,
    rmfilterArgs: undefined,
    taskIndex: 0,
    stepIndex: 0,
    numStepsSelected: 1,
  })),
}));

vi.mock('../../plans/mark_done.js', () => ({
  markStepDone: markStepDoneSpy,
  markTaskDone: vi.fn(async () => ({ planComplete: false })),
}));

vi.mock('../../executors/index.js', () => ({
  buildExecutorAndLog: vi.fn(() => ({
    filePathPrefix: '',
    prepareStepOptions: () => ({}),
    execute: async () => ({
      content: 'FAILED: Something is impossible\nProblems:\n- details',
      success: false,
      failureDetails: {
        requirements: '',
        problems: 'details',
        sourceAgent: 'implementer',
      },
    }),
  })),
  DEFAULT_EXECUTOR: 'codex_cli',
  defaultModelForExecutor: vi.fn(() => undefined),
}));

vi.mock('../../../logging.js', () => ({
  boldMarkdownHeaders: (s: string) => s,
  openLogFile: vi.fn(() => {}),
  closeLogFile: vi.fn(() => {}),
  log: vi.fn(() => {}),
  error: vi.fn(() => {}),
  warn: vi.fn(() => {}),
  debugLog: vi.fn(() => {}),
  sendStructured: vi.fn(() => {}),
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
    readPlanFile: vi.fn(async (filePath: string) => {
      const { readFile } = await import('node:fs/promises');
      const content = await readFile(filePath, 'utf-8');
      const yaml = await import('yaml');
      const stripped = content.replace(/^---\n/, '').replace(/\n---\n[\s\S]*$/, '');
      return yaml.default.parse(stripped);
    }),
    writePlanFile: vi.fn(async () => {}),
    generatePlanFileContent: vi.fn(() => ''),
    resolvePlanFromDb: vi.fn(async () => ({
      plan: { id: 1, title: 'P', status: 'pending', tasks: [] },
      planPath: '',
    })),
    writePlanToDb: vi.fn(async () => {}),
    setPlanStatus: vi.fn(async () => {}),
    setPlanStatusById: vi.fn(async () => {}),
    isTaskDone: vi.fn(() => false),
    getBlockedPlans: vi.fn(() => []),
    getChildPlans: vi.fn(() => []),
    getDiscoveredPlans: vi.fn(() => []),
    getMaxNumericPlanId: vi.fn(async () => 0),
    parsePlanIdentifier: vi.fn(() => ({})),
    isPlanReady: vi.fn(() => true),
    collectDependenciesInOrder: vi.fn(async () => []),
    generateSuggestedFilename: vi.fn(async () => 'plan.yml'),
  };
});

vi.mock('../../workspace/workspace_roundtrip.js', () => ({
  prepareWorkspaceRoundTrip: vi.fn(async () => null),
  runPostExecutionWorkspaceSync: vi.fn(async () => {}),
  runPreExecutionWorkspaceSync: vi.fn(async () => {}),
  materializePlansForExecution: vi.fn(async () => undefined),
}));

describe('timAgent - serial mode failure handling', () => {
  beforeEach(async () => {
    yielded = false;
    markStepDoneSpy.mockClear();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-failure-serial-'));
    await fs.mkdir(path.join(tempDir, 'tasks'), { recursive: true });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('executor failure stops loop, prints details, and does not mark step done', async () => {
    const planFile = path.join(tempDir, 'tasks', 'p.yml');
    const content = `---\nid: 1\ntitle: P\ngoal: G\ndetails: D\ntasks:\n  - title: T1\n    description: Desc\n    steps:\n      - prompt: do it\n---\n`;
    await fs.writeFile(planFile, content);

    const { timAgent } = await import('./agent.js');
    await expect(
      timAgent(planFile, { summary: true, log: false, serialTasks: true }, {})
    ).rejects.toThrow('Agent stopped due to error.');

    // Ensure we did not mark the step as done
    expect(markStepDoneSpy).not.toHaveBeenCalled();
  });
});
