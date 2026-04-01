import { afterEach, beforeEach, describe, expect, vi, test } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

const autoClaimPlanSpy = vi.fn(async () => ({ result: { persisted: true } }));
const readPlanFileSpy = vi.fn(async () => ({
  id: 7,
  uuid: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
  title: 'Agent auto-claim plan',
  goal: 'Demo',
  details: '',
  status: 'pending',
  tasks: [
    {
      title: 'Task',
      description: undefined,
      steps: [],
    },
  ],
}));

let autoClaimEnabled = false;
let tempRoot = '';

vi.mock('../../../logging.js', () => ({
  log: vi.fn(() => {}),
  error: vi.fn(() => {}),
  warn: vi.fn(() => {}),
  openLogFile: vi.fn(() => {}),
  closeLogFile: vi.fn(async () => {}),
  debugLog: vi.fn(() => {}),
  sendStructured: vi.fn(() => {}),
  boldMarkdownHeaders: (s: string) => s,
}));

vi.mock('../../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(async () => ({
    paths: {
      tasks: path.join(tempRoot, 'tasks'),
    },
  })),
  loadGlobalConfigForNotifications: vi.fn(async () => ({})),
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
    resolvePlanFile: vi.fn(async () => ''),
    readPlanFile: readPlanFileSpy,
    writePlanFile: vi.fn(async () => {}),
    generatePlanFileContent: vi.fn(() => ''),
    resolvePlanFromDb: vi.fn(async () => ({
      plan: { id: 7, title: 'P', status: 'pending', tasks: [] },
      planPath: '',
    })),
    writePlanToDb: vi.fn(async () => {}),
    getBlockedPlans: vi.fn(() => []),
    getChildPlans: vi.fn(() => []),
    getDiscoveredPlans: vi.fn(() => []),
    getMaxNumericPlanId: vi.fn(async () => 0),
    parsePlanIdentifier: vi.fn(() => ({})),
    isPlanReady: vi.fn(() => true),
    collectDependenciesInOrder: vi.fn(async () => []),
    setPlanStatus: vi.fn(async () => {}),
    setPlanStatusById: vi.fn(async () => {}),
    generateSuggestedFilename: vi.fn(async () => 'plan.yml'),
    isTaskDone: vi.fn(() => false),
  };
});

vi.mock('../../plans/find_next.js', () => ({
  findNextActionableItem: vi.fn(() => null),
  getAllIncompleteTasks: vi.fn(() => []),
  findPendingTask: vi.fn(() => null),
}));

vi.mock('../../plans/mark_done.js', () => ({
  markStepDone: vi.fn(async () => ({})),
  markTaskDone: vi.fn(async () => ({})),
}));

vi.mock('../../workspace/workspace_lock.js', () => {
  class WorkspaceAlreadyLocked extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'WorkspaceAlreadyLocked';
    }
  }
  return {
    WorkspaceAlreadyLocked,
    WorkspaceLock: {
      acquireLock: vi.fn(async () => ({ type: 'persistent' })),
      setupCleanupHandlers: vi.fn(() => {}),
      releaseLock: vi.fn(async () => {}),
      getLockInfo: vi.fn(async () => null),
      isLockStale: vi.fn(async () => false),
    },
  };
});

vi.mock('../../executors/index.js', () => ({
  buildExecutorAndLog: vi.fn(() => ({ execute: vi.fn(async () => ({})), filePathPrefix: '' })),
  DEFAULT_EXECUTOR: 'mock-executor',
  defaultModelForExecutor: () => 'mock-model',
}));

vi.mock('../../assignments/auto_claim.js', () => ({
  autoClaimPlan: vi.fn(async (...args: unknown[]) => {
    if (!autoClaimEnabled) {
      throw new Error('autoClaimPlan invoked while disabled');
    }
    return autoClaimPlanSpy(...(args as any));
  }),
  enableAutoClaim: vi.fn(() => {
    autoClaimEnabled = true;
  }),
  disableAutoClaim: vi.fn(() => {
    autoClaimEnabled = false;
  }),
  isAutoClaimEnabled: vi.fn(() => autoClaimEnabled),
}));

vi.mock('../../plans/prepare_step.js', () => ({
  prepareNextStep: vi.fn(async () => {}),
}));

vi.mock('../../prompt_builder.js', () => ({
  buildExecutionPromptWithoutSteps: vi.fn(async () => 'prompt'),
}));

vi.mock('../../../common/git.js', () => ({
  getGitRoot: vi.fn(async () => tempRoot),
}));

vi.mock('../plan_discovery.js', () => ({
  findLatestPlanFromDb: vi.fn(async () => null),
  findNextPlanFromDb: vi.fn(async () => null),
  findNextReadyDependencyFromDb: vi.fn(async () => ({ plan: null, message: '' })),
  toHeadlessPlanSummary: vi.fn(() => undefined),
}));

describe('timAgent auto-claim integration', () => {
  let planPath: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-agent-auto-claim-'));
    planPath = path.join(tempRoot, 'tasks', '7-agent.plan.md');
    await fs.mkdir(path.dirname(planPath), { recursive: true });
    await fs.writeFile(planPath, '# placeholder');

    autoClaimPlanSpy.mockClear();
    readPlanFileSpy.mockClear();
    autoClaimEnabled = false;
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  test('calls autoClaimPlan when enabled', async () => {
    const { timAgent } = await import('./agent.js');
    const { enableAutoClaim } = await import('../../assignments/auto_claim.js');
    enableAutoClaim();

    await timAgent(planPath, { log: false, serialTasks: true, nonInteractive: true }, {});

    expect(readPlanFileSpy).toHaveBeenCalled();
    expect(autoClaimPlanSpy).toHaveBeenCalledTimes(1);
    const callArgs = autoClaimPlanSpy.mock.calls[0]?.[0];
    expect(callArgs?.uuid).toBe('bbbbbbbb-cccc-4ddd-8eee-ffffffffffff');
  });
});
