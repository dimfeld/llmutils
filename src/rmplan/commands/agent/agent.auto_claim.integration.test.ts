import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';

import { ModuleMocker } from '../../../testing.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('rmplanAgent auto-claim integration', () => {
  const autoClaimPlanSpy = mock(async () => ({ result: { persisted: true } }));
  const readPlanFileSpy = mock(async () => ({
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

  let rmplanAgent: typeof import('./agent.js').rmplanAgent;
  let enableAutoClaim: () => void;
  let disableAutoClaim: () => void;

  let tempRoot: string;
  let planPath: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rmplan-agent-auto-claim-'));
    planPath = path.join(tempRoot, 'tasks', '7-agent.plan.md');
    await fs.mkdir(path.dirname(planPath), { recursive: true });
    await fs.writeFile(planPath, '# placeholder');

    autoClaimPlanSpy.mockClear();
    readPlanFileSpy.mockClear();

    await moduleMocker.mock('../../../logging.js', () => ({
      log: mock(() => {}),
      error: mock(() => {}),
      warn: mock(() => {}),
      openLogFile: mock(() => {}),
      closeLogFile: mock(async () => {}),
    }));

    await moduleMocker.mock('../../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: {
          tasks: path.join(tempRoot, 'tasks'),
        },
      }),
    }));

    await moduleMocker.mock('../../plans.js', () => ({
      resolvePlanFile: mock(async () => planPath),
      readPlanFile: readPlanFileSpy,
      writePlanFile: mock(async () => {}),
    }));

    await moduleMocker.mock('../../plans/find_next.js', () => ({
      findNextActionableItem: mock(() => null),
    }));

    await moduleMocker.mock('../../plans/mark_done.js', () => ({
      markStepDone: mock(async () => ({})),
      markTaskDone: mock(async () => ({})),
    }));

    await moduleMocker.mock('../../workspace/workspace_lock.js', () => ({
      WorkspaceLock: {
        acquireLock: mock(async () => ({ type: 'persistent' })),
        setupCleanupHandlers: mock(() => {}),
      },
    }));

    await moduleMocker.mock('../../executors/index.js', () => ({
      buildExecutorAndLog: mock(() => ({ execute: mock(async () => ({})) })),
      DEFAULT_EXECUTOR: 'mock-executor',
      defaultModelForExecutor: () => 'mock-model',
    }));

    await moduleMocker.mock('../../assignments/auto_claim.js', () => {
      let enabled = false;
      return {
        autoClaimPlan: mock(async (...args: unknown[]) => {
          if (!enabled) {
            throw new Error('autoClaimPlan invoked while disabled');
          }
          return autoClaimPlanSpy(...args);
        }),
        enableAutoClaim: () => {
          enabled = true;
        },
        disableAutoClaim: () => {
          enabled = false;
        },
        isAutoClaimEnabled: () => enabled,
      };
    });

    await moduleMocker.mock('../../plans/prepare_phase.js', () => ({
      preparePhase: mock(async () => {}),
    }));

    await moduleMocker.mock('../../plans/prepare_step.js', () => ({
      prepareNextStep: mock(async () => {}),
    }));

    await moduleMocker.mock('../../prompt_builder.js', () => ({
      buildExecutionPromptWithoutSteps: mock(async () => 'prompt'),
    }));

    await moduleMocker.mock('../../../common/git.js', () => ({
      getGitRoot: async () => tempRoot,
    }));

    await moduleMocker.mock('../find_next_dependency.js', () => ({
      findNextReadyDependency: mock(async () => ({ plan: null, message: '' })),
    }));

    ({ rmplanAgent } = await import('./agent.js'));
    ({ enableAutoClaim, disableAutoClaim } = await import('../../assignments/auto_claim.js'));
    disableAutoClaim();
  });

  afterEach(async () => {
    moduleMocker.clear();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  test('calls autoClaimPlan when enabled', async () => {
    enableAutoClaim();

    await rmplanAgent(planPath, { log: false, serialTasks: true, nonInteractive: true }, {});

    expect(readPlanFileSpy).toHaveBeenCalled();
    expect(autoClaimPlanSpy).toHaveBeenCalledTimes(1);
    const callArgs = autoClaimPlanSpy.mock.calls[0]?.[0];
    expect(callArgs?.uuid).toBe('bbbbbbbb-cccc-4ddd-8eee-ffffffffffff');
  });
});
