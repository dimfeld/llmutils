import { afterEach, beforeEach, describe, expect, vi, test } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { closeDatabaseForTesting } from '../db/database.js';
import { clearPlanSyncContext, syncPlanToDb } from '../db/plan_sync.js';
import { readPlanFile, writePlanFile } from '../plans.js';

let autoClaimEnabled = false;

vi.mock('../../logging.js', () => ({
  log: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../configLoader.js', () => ({
  loadEffectiveConfig: vi.fn(),
}));

vi.mock('../assignments/auto_claim.js', () => ({
  autoClaimPlan: vi.fn(),
  enableAutoClaim: vi.fn(() => {
    autoClaimEnabled = true;
  }),
  disableAutoClaim: vi.fn(() => {
    autoClaimEnabled = false;
  }),
  isAutoClaimEnabled: vi.fn(() => autoClaimEnabled),
  isAutoClaimDisabled: vi.fn(() => !autoClaimEnabled),
}));

vi.mock('../../common/process.js', () => ({
  commitAll: vi.fn(async () => 0),
}));

vi.mock('../../common/git.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getGitRoot: vi.fn(),
  };
});

vi.mock('../workspace/workspace_setup.js', () => ({
  setupWorkspace: vi.fn(),
}));

vi.mock('./prompts.js', () => ({
  buildPromptText: vi.fn(async () => 'Generated prompt text'),
  findMostRecentlyUpdatedPlan: vi.fn(async () => null),
  getPlanTimestamp: vi.fn(async () => 0),
  parseIsoTimestamp: vi.fn(() => undefined),
}));

vi.mock('../executors/index.js', () => ({
  buildExecutorAndLog: vi.fn(),
  DEFAULT_EXECUTOR: 'claude_code',
}));

vi.mock('../plan_materialize.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../plan_materialize.js')>();
  return {
    ...actual,
    syncMaterializedPlan: vi.fn(async () => {}),
  };
});

vi.mock('../workspace/workspace_roundtrip.js', () => ({
  prepareWorkspaceRoundTrip: vi.fn(async () => null),
  runPreExecutionWorkspaceSync: vi.fn(async () => {}),
  runPostExecutionWorkspaceSync: vi.fn(async () => {}),
  materializePlansForExecution: vi.fn(async () => undefined),
}));

vi.mock('../workspace/workspace_info.js', () => ({
  getWorkspaceInfoByPath: vi.fn(() => null),
  patchWorkspaceInfo: vi.fn(),
  touchWorkspaceInfo: vi.fn(),
}));

vi.mock('../../logging/tunnel_client.js', () => ({
  isTunnelActive: vi.fn(() => false),
}));

vi.mock('../headless.js', () => ({
  runWithHeadlessAdapterIfEnabled: vi.fn(async (options: any) => options.callback()),
}));

vi.mock('./plan_discovery.js', () => ({
  findNextReadyDependencyFromDb: vi.fn(),
  findLatestPlanFromDb: vi.fn(async () => null),
}));

vi.mock('../ensure_plan_in_db.js', () => ({
  resolvePlanFromDbOrSyncFile: vi.fn().mockImplementation((planPath: string) =>
    Promise.resolve({
      plan: { id: 42, uuid: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
      planPath,
    })
  ),
}));

vi.mock('../db/plan_sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/plan_sync.js')>();
  return {
    ...actual,
  };
});

import { handleGenerateCommand } from './generate.js';
import {
  autoClaimPlan,
  enableAutoClaim,
  disableAutoClaim,
  isAutoClaimEnabled,
} from '../assignments/auto_claim.js';
import { loadEffectiveConfig } from '../configLoader.js';
import { getGitRoot } from '../../common/git.js';
import { setupWorkspace } from '../workspace/workspace_setup.js';
import { buildExecutorAndLog } from '../executors/index.js';

// Set up the git root mock early so it's available during setup
vi.mocked(getGitRoot).mockResolvedValue('');

describe('handleGenerateCommand auto-claim integration', () => {
  let tempRoot: string;
  let tasksDir: string;
  let planPath: string;
  let originalEnv: Partial<Record<'XDG_CONFIG_HOME' | 'APPDATA', string | undefined>>;

  const autoClaimPlanSpy = vi.mocked(autoClaimPlan);

  // Mock executor - writes tasks to the plan file to simulate generation
  const mockExecutorExecute = vi.fn(async () => {
    const plan = await readPlanFile(planPath);
    plan.tasks = [{ title: 'Generated task', description: 'Auto-generated', done: false }];
    await writePlanFile(planPath, plan);
  });
  const mockExecutor = {
    execute: mockExecutorExecute,
    filePathPrefix: '',
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    autoClaimEnabled = false;
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
    await syncPlanToDb(await readPlanFile(planPath), {
      config: {
        paths: {
          tasks: tasksDir,
        },
        models: {},
      },
      cwdForIdentity: tempRoot,
    });

    autoClaimPlanSpy.mockResolvedValue({ result: { persisted: true } } as any);
    mockExecutorExecute.mockImplementation(async () => {
      const plan = await readPlanFile(planPath);
      plan.tasks = [{ title: 'Generated task', description: 'Auto-generated', done: false }];
      await writePlanFile(planPath, plan);
    });

    vi.mocked(loadEffectiveConfig).mockResolvedValue({
      paths: { tasks: tasksDir },
      models: {},
    } as any);
    vi.mocked(getGitRoot).mockResolvedValue(tempRoot);
    vi.mocked(setupWorkspace).mockImplementation(
      async (_options: any, baseDir: string, planFile: string) =>
        ({
          baseDir,
          planFile,
        }) as any
    );
    vi.mocked(buildExecutorAndLog).mockReturnValue(mockExecutor as any);
    vi.mocked(isAutoClaimEnabled).mockImplementation(() => autoClaimEnabled);

    // Restore enable/disable to update the module-level flag
    vi.mocked(enableAutoClaim).mockImplementation(() => {
      autoClaimEnabled = true;
    });
    vi.mocked(disableAutoClaim).mockImplementation(() => {
      autoClaimEnabled = false;
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
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
