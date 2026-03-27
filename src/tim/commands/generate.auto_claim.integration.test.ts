import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { ModuleMocker } from '../../testing.js';
import { closeDatabaseForTesting } from '../db/database.js';
import { clearPlanSyncContext, syncPlanToDb } from '../db/plan_sync.js';
import { clearPlanCache, writePlanFile } from '../plans.js';

const moduleMocker = new ModuleMocker(import.meta);

describe('handleGenerateCommand auto-claim integration', () => {
  let tempRoot: string;
  let tasksDir: string;
  let planPath: string;
  let originalEnv: Partial<Record<'XDG_CONFIG_HOME' | 'APPDATA', string | undefined>>;

  const autoClaimPlanSpy = mock(async () => ({ result: { persisted: true } }));

  // Mock executor - writes tasks to the plan file to simulate generation
  const mockExecutorExecute = mock(async () => {
    const { readPlanFile } = await import('../plans.js');
    const plan = await readPlanFile(planPath);
    plan.tasks = [{ title: 'Generated task', description: 'Auto-generated', done: false }];
    await writePlanFile(planPath, plan);
    clearPlanCache();
  });
  const mockExecutor = {
    execute: mockExecutorExecute,
    filePathPrefix: '',
  };

  let handleGenerateCommand: typeof import('./generate.js').handleGenerateCommand;
  let enableAutoClaim: () => void;
  let disableAutoClaim: () => void;

  beforeEach(async () => {
    closeDatabaseForTesting();
    clearPlanSyncContext();
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-generate-auto-claim-'));
    tasksDir = path.join(tempRoot, 'tasks');
    await fs.mkdir(tasksDir, { recursive: true });
    await Bun.$`git init`.cwd(tempRoot).quiet();

    originalEnv = {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      APPDATA: process.env.APPDATA,
    };
    process.env.XDG_CONFIG_HOME = path.join(tempRoot, 'config');
    delete process.env.APPDATA;

    planPath = path.join(tasksDir, '42-auto.plan.md');
    // Write a stub plan (empty tasks) that the generate command will process
    await writePlanFile(planPath, {
      id: 42,
      uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      status: 'pending',
      title: 'Auto-claim plan',
      goal: 'Demo',
      tasks: [],
    });
    await syncPlanToDb(await (await import('../plans.js')).readPlanFile(planPath), planPath, {
      config: {
        paths: {
          tasks: tasksDir,
        },
        models: {},
      },
      cwdForIdentity: tempRoot,
    });

    clearPlanCache();

    autoClaimPlanSpy.mockClear();
    mockExecutorExecute.mockClear();

    await moduleMocker.mock('../../logging.js', () => ({
      log: mock(() => {}),
      error: mock(() => {}),
      warn: mock(() => {}),
    }));

    await moduleMocker.mock('../configLoader.js', () => ({
      loadEffectiveConfig: async () => ({
        paths: {
          tasks: tasksDir,
        },
        models: {},
      }),
    }));

    await moduleMocker.mock('../assignments/auto_claim.js', () => {
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
        isAutoClaimDisabled: () => !enabled,
      };
    });

    await moduleMocker.mock('../../common/process.js', () => ({
      commitAll: mock(async () => 0),
    }));

    await moduleMocker.mock('../../common/git.js', () => ({
      getGitRoot: mock(async () => tempRoot),
    }));

    await moduleMocker.mock('../workspace/workspace_setup.js', () => ({
      setupWorkspace: mock(async (_options: any, baseDir: string, planFile: string) => ({
        baseDir,
        planFile,
      })),
    }));

    await moduleMocker.mock('./prompts.js', () => ({
      buildPromptText: mock(async () => 'Generated prompt text'),
      findMostRecentlyUpdatedPlan: mock(async () => null),
      getPlanTimestamp: mock(async () => 0),
      parseIsoTimestamp: mock(() => undefined),
    }));

    await moduleMocker.mock('../executors/index.js', () => ({
      buildExecutorAndLog: mock(() => mockExecutor),
      DEFAULT_EXECUTOR: 'claude_code',
    }));

    await moduleMocker.mock('../plan_materialize.js', () => ({
      syncMaterializedPlan: mock(async () => {}),
    }));

    ({ handleGenerateCommand } = await import('./generate.js'));
    ({ enableAutoClaim, disableAutoClaim } = await import('../assignments/auto_claim.js'));
    disableAutoClaim();
  });

  afterEach(async () => {
    moduleMocker.clear();
    closeDatabaseForTesting();
    clearPlanSyncContext();
    if (originalEnv.XDG_CONFIG_HOME === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = originalEnv.XDG_CONFIG_HOME;
    }
    if (originalEnv.APPDATA === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = originalEnv.APPDATA;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  test('invokes autoClaimPlan when enabled', async () => {
    enableAutoClaim();

    const options = {
      plan: planPath,
    };

    const command = {
      parent: {
        opts: () => ({}),
      },
    };

    await handleGenerateCommand(undefined, options, command);

    expect(autoClaimPlanSpy).toHaveBeenCalledTimes(1);
    const callArgs = autoClaimPlanSpy.mock.calls[0]?.[0];
    expect(callArgs?.uuid).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  });
});
