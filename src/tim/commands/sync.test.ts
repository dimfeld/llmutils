import { afterEach, beforeEach, describe, expect, vi, test } from 'vitest';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { clearAllTimCaches } from '../../testing.js';
import { closeDatabaseForTesting, getDatabase, getDefaultDatabasePath } from '../db/database.js';
import {
  getArtifactTransfer,
  markTransferSucceeded,
  upsertPendingTransfer,
} from '../db/artifact_transfer.js';
import { runMigrations } from '../db/migrations.js';
import { getPlansByProject } from '../db/plan.js';
import { upsertCanonicalPlanInTransaction, upsertProjectionPlanInTransaction } from '../db/plan.js';
import { clearPlanSyncContext } from '../db/plan_sync.js';
import { getOrCreateProject, getProject } from '../db/project.js';
import { getRepositoryIdentity } from '../assignments/workspace_identifier.js';
import { materializePlan } from '../plan_materialize.js';
import { readPlanFile, writePlanFile, writePlanToDb } from '../plans.js';
import { applyOperation } from '../sync/apply.js';
import { buildArtifactAttachOperation } from '../sync/operations.js';

vi.mock('../../logging.js', () => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debugLog: vi.fn(),
  writeStdout: vi.fn(),
  writeStderr: vi.fn(),
  sendStructured: vi.fn(),
}));

const runnerMocks = vi.hoisted(() => ({
  runSyncCatchUpOnce: vi.fn(),
  drainArtifactTransfersOnce: vi.fn(),
}));

vi.mock('../sync/runner.js', async () => {
  const actual = await vi.importActual<typeof import('../sync/runner.js')>('../sync/runner.js');
  return {
    ...actual,
    runSyncCatchUpOnce: runnerMocks.runSyncCatchUpOnce,
    drainArtifactTransfersOnce: runnerMocks.drainArtifactTransfersOnce,
  };
});

import { handleSyncCatchUpCommand, handleSyncCommand } from './sync.js';
import { log as mockLogFn, warn as mockWarnFn } from '../../logging.js';

const mockLog = vi.mocked(mockLogFn);
const mockWarn = vi.mocked(mockWarnFn);

const PROJECT_UUID = '11111111-1111-4111-8111-111111111111';
const PLAN_UUID = '22222222-2222-4222-8222-222222222222';
const TASK_UUID = '33333333-3333-4333-8333-333333333333';
const ARTIFACT_UUID = '44444444-4444-4444-8444-444444444444';
const NODE_ID = 'persistent-a';
const MAIN_URL = 'http://main.test';

async function initializeGitRepository(repoDir: string): Promise<void> {
  await Bun.$`git init`.cwd(repoDir).quiet();
  await Bun.$`git remote add origin https://example.com/acme/sync-tests.git`.cwd(repoDir).quiet();
}

describe('tim sync command', () => {
  let tempDir: string;
  let repoDir: string;
  let originalCwd: string;

  const makeCommand = () => ({
    parent: {
      opts: () => ({}),
    },
  });

  beforeEach(async () => {
    clearAllTimCaches();
    closeDatabaseForTesting();
    const dbPath = getDefaultDatabasePath();
    await fs.rm(dbPath, { force: true });
    await fs.rm(`${dbPath}-wal`, { force: true });
    await fs.rm(`${dbPath}-shm`, { force: true });
    clearPlanSyncContext();

    originalCwd = process.cwd();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-sync-command-test-'));
    repoDir = path.join(tempDir, 'repo');
    await fs.mkdir(repoDir, { recursive: true });
    await initializeGitRepository(repoDir);
    process.chdir(repoDir);

    vi.clearAllMocks();
    runnerMocks.runSyncCatchUpOnce.mockReset();
    runnerMocks.drainArtifactTransfersOnce.mockReset();
    runnerMocks.runSyncCatchUpOnce.mockResolvedValue(undefined);
    runnerMocks.drainArtifactTransfersOnce.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    clearAllTimCaches();
    closeDatabaseForTesting();
    clearPlanSyncContext();
    vi.clearAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('sync catch-up drains pending artifact downloads before returning', async () => {
    const db = createInMemorySyncDb();
    seedSyncPlan(db);
    const transferNodeId = `sync-server:${MAIN_URL}`;
    runnerMocks.runSyncCatchUpOnce.mockImplementation(async ({ db: runnerDb }) => {
      await attachArtifactMetadata(runnerDb);
      upsertPendingTransfer(runnerDb, ARTIFACT_UUID, transferNodeId, 'download');
    });
    runnerMocks.drainArtifactTransfersOnce.mockImplementation(async ({ db: runnerDb }) => {
      markTransferSucceeded(runnerDb, ARTIFACT_UUID, transferNodeId, 'download');
    });

    await handleSyncCatchUpCommand({} as Record<string, never>, makeCommand() as any, {
      db,
      config: {
        sync: {
          role: 'persistent',
          nodeId: NODE_ID,
          mainUrl: MAIN_URL,
          nodeToken: 'token',
        },
      },
    });

    expect(runnerMocks.runSyncCatchUpOnce).toHaveBeenCalledTimes(1);
    expect(runnerMocks.drainArtifactTransfersOnce).toHaveBeenCalledTimes(1);
    expect(getArtifactTransfer(db, ARTIFACT_UUID, transferNodeId, 'download')).toMatchObject({
      status: 'succeeded',
    });
    expect(mockLog).toHaveBeenCalledWith('Sync catch-up completed.');
  });

  test('syncs all materialized plans back into SQLite', async () => {
    await writePlanToDb(
      {
        id: 1,
        uuid: '11111111-1111-4111-8111-111111111111',
        title: 'Alpha',
        goal: 'Sync alpha',
        details: 'Before edit',
        tasks: [],
      },
      { cwdForIdentity: repoDir }
    );

    const materializedPath = await materializePlan(1, repoDir);
    const materializedPlan = await readPlanFile(materializedPath);
    await writePlanFile(
      materializedPath,
      {
        ...materializedPlan,
        title: 'Alpha Edited',
        details: 'After edit',
        updatedAt: '2026-03-27T01:00:00.000Z',
      },
      { skipDb: true }
    );

    await handleSyncCommand(undefined, {}, makeCommand() as any);

    const repository = await getRepositoryIdentity({ cwd: repoDir });
    const db = getDatabase();
    const project = getProject(db, repository.repositoryId);
    expect(project).not.toBeNull();
    const plans = getPlansByProject(db, project!.id);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.title).toBe('Alpha Edited');
    expect(plans[0]?.details).toBe('After edit');
    expect(mockLog).toHaveBeenCalledWith('Synced 1 materialized plan.');
  });

  test('reports zero synced plans when the materialized directory does not exist', async () => {
    await handleSyncCommand(undefined, {}, makeCommand() as any);

    expect(mockLog).toHaveBeenCalledWith('Synced 0 materialized plans.');
  });

  test('ignores non-plan files when syncing all materialized plans', async () => {
    await writePlanToDb(
      {
        id: 1,
        uuid: '11111111-1111-4111-8111-111111111111',
        title: 'One',
        goal: 'First plan',
        details: 'Before one',
        tasks: [],
      },
      { cwdForIdentity: repoDir }
    );
    await writePlanToDb(
      {
        id: 2,
        uuid: '22222222-2222-4222-8222-222222222222',
        title: 'Two',
        goal: 'Second plan',
        details: 'Before two',
        tasks: [],
      },
      { cwdForIdentity: repoDir }
    );

    const firstPath = await materializePlan(1, repoDir);
    const secondPath = await materializePlan(2, repoDir);

    const firstPlan = await readPlanFile(firstPath);
    await writePlanFile(
      firstPath,
      {
        ...firstPlan,
        details: 'After one',
        updatedAt: '2026-03-27T03:00:00.000Z',
      },
      { skipDb: true }
    );

    const secondPlan = await readPlanFile(secondPath);
    await writePlanFile(
      secondPath,
      {
        ...secondPlan,
        details: 'After two',
        updatedAt: '2026-03-27T03:05:00.000Z',
      },
      { skipDb: true }
    );

    const materializedDir = path.join(repoDir, '.tim', 'plans');
    await fs.writeFile(path.join(materializedDir, 'notes.txt'), 'ignore me', 'utf8');
    await fs.writeFile(path.join(materializedDir, 'draft.plan.md'), 'ignore me too', 'utf8');
    await fs.writeFile(path.join(materializedDir, '999.reference.md'), 'still ignore me', 'utf8');

    await handleSyncCommand(undefined, {}, makeCommand() as any);

    const repository = await getRepositoryIdentity({ cwd: repoDir });
    const db = getDatabase();
    const project = getProject(db, repository.repositoryId);
    expect(project).not.toBeNull();
    const plans = getPlansByProject(db, project!.id);
    expect(plans.find((plan) => plan.plan_id === 1)?.details).toBe('After one');
    expect(plans.find((plan) => plan.plan_id === 2)?.details).toBe('After two');
    expect(mockLog).toHaveBeenCalledWith('Synced 2 materialized plans.');
  });

  test('syncs only the requested materialized plan when a plan ID is provided', async () => {
    await writePlanToDb(
      {
        id: 1,
        uuid: '11111111-1111-4111-8111-111111111111',
        title: 'One',
        goal: 'First plan',
        details: 'Unchanged',
        tasks: [],
      },
      { cwdForIdentity: repoDir }
    );
    await writePlanToDb(
      {
        id: 2,
        uuid: '22222222-2222-4222-8222-222222222222',
        title: 'Two',
        goal: 'Second plan',
        details: 'Before edit',
        tasks: [],
      },
      { cwdForIdentity: repoDir }
    );

    await materializePlan(1, repoDir);
    const materializedPath = await materializePlan(2, repoDir);
    const materializedPlan = await readPlanFile(materializedPath);
    await writePlanFile(
      materializedPath,
      {
        ...materializedPlan,
        details: 'After edit',
        updatedAt: '2026-03-27T02:00:00.000Z',
      },
      { skipDb: true }
    );

    await handleSyncCommand(2, {}, makeCommand() as any);

    const repository = await getRepositoryIdentity({ cwd: repoDir });
    const db = getDatabase();
    const project = getProject(db, repository.repositoryId);
    expect(project).not.toBeNull();
    const plans = getPlansByProject(db, project!.id);
    expect(plans.find((plan) => plan.plan_id === 1)?.details).toBe('Unchanged');
    expect(plans.find((plan) => plan.plan_id === 2)?.details).toBe('After edit');
    expect(mockLog).toHaveBeenCalledWith('Synced materialized plan 2.');
  });

  test('syncs a single stale materialized plan when --force is used', async () => {
    await writePlanToDb(
      {
        id: 1,
        uuid: '11111111-1111-4111-8111-111111111111',
        title: 'One',
        goal: 'First plan',
        details: 'Before edit',
        tasks: [],
      },
      { cwdForIdentity: repoDir }
    );
    const materializedPath = await materializePlan(1, repoDir);
    const materializedPlan = await readPlanFile(materializedPath);
    await writePlanFile(
      materializedPath,
      {
        ...materializedPlan,
        details: 'After edit',
        updatedAt: undefined,
      },
      { skipDb: true, skipUpdatedAt: true }
    );

    await handleSyncCommand(1, { force: true }, makeCommand() as any);

    const repository = await getRepositoryIdentity({ cwd: repoDir });
    const db = getDatabase();
    const project = getProject(db, repository.repositoryId);
    expect(project).not.toBeNull();
    const plans = getPlansByProject(db, project!.id);
    expect(plans.find((plan) => plan.plan_id === 1)?.details).toBe('After edit');
    expect(mockWarn).not.toHaveBeenCalled();
  });

  test('bulk sync logs each plan with verbose and continues after per-file failures', async () => {
    await writePlanToDb(
      {
        id: 1,
        uuid: '11111111-1111-4111-8111-111111111111',
        title: 'One',
        goal: 'First plan',
        details: 'Before one',
        tasks: [],
      },
      { cwdForIdentity: repoDir }
    );
    await writePlanToDb(
      {
        id: 2,
        uuid: '22222222-2222-4222-8222-222222222222',
        title: 'Two',
        goal: 'Second plan',
        details: 'Before two',
        tasks: [],
      },
      { cwdForIdentity: repoDir }
    );

    const firstPath = await materializePlan(1, repoDir);
    const secondPath = await materializePlan(2, repoDir);

    const firstPlan = await readPlanFile(firstPath);
    await writePlanFile(
      firstPath,
      {
        ...firstPlan,
        details: 'After one',
      },
      { skipDb: true, skipUpdatedAt: true }
    );
    await fs.writeFile(
      secondPath,
      `---
id: 2
uuid: invalid-uuid
title: Broken materialized plan
goal: Broken materialized plan
updatedAt: 2026-03-27T04:05:00.000Z
tasks: []
---
`,
      'utf8'
    );

    await expect(
      handleSyncCommand(undefined, { verbose: true, force: true }, makeCommand() as any)
    ).rejects.toThrow('Failed to sync 1 materialized plan');

    const repository = await getRepositoryIdentity({ cwd: repoDir });
    const db = getDatabase();
    const project = getProject(db, repository.repositoryId);
    expect(project).not.toBeNull();
    const plans = getPlansByProject(db, project!.id);
    expect(plans.find((plan) => plan.plan_id === 1)?.details).toBe('After one');
    expect(plans.find((plan) => plan.plan_id === 2)?.details).toBe('Before two');
    expect(
      mockLog.mock.calls.some(
        ([message]) =>
          String(message).startsWith('Syncing ') &&
          String(message).endsWith('/.tim/plans/1.plan.md')
      )
    ).toBe(true);
    expect(
      mockLog.mock.calls.some(
        ([message]) =>
          String(message).startsWith('Syncing ') &&
          String(message).endsWith('/.tim/plans/2.plan.md')
      )
    ).toBe(true);
    expect(
      mockWarn.mock.calls.some(([message]) => String(message).includes('Failed to sync'))
    ).toBe(true);
    expect(mockLog).toHaveBeenCalledWith('Synced 1 materialized plan (1 error).');
  });
});

function createInMemorySyncDb(): Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function seedSyncPlan(db: Database): void {
  const project = getOrCreateProject(db, 'github.com__example__repo', {
    uuid: PROJECT_UUID,
    highestPlanId: 10,
  });
  const plan = {
    uuid: PLAN_UUID,
    planId: 1,
    title: 'Artifact catch-up plan',
    status: 'pending',
    revision: 1,
    tasks: [{ uuid: TASK_UUID, title: 'Task one', description: 'Do it' }],
    forceOverwrite: true,
  };
  upsertCanonicalPlanInTransaction(db, project.id, {
    ...plan,
    tasks: plan.tasks.map((task) => ({ ...task, revision: 1 })),
  });
  upsertProjectionPlanInTransaction(db, project.id, plan);
}

async function attachArtifactMetadata(db: Database): Promise<void> {
  applyOperation(
    db,
    await buildArtifactAttachOperation(
      {
        projectUuid: PROJECT_UUID,
        planUuid: PLAN_UUID,
        artifactUuid: ARTIFACT_UUID,
        filename: 'catch-up.txt',
        mimeType: 'text/plain',
        size: 12,
        sha256: 'catch-up-hash',
      },
      { originNodeId: 'remote-node', localSequence: 1 }
    )
  );
}
