import { Database } from 'bun:sqlite';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { clearConfigCache } from '../configLoader.js';
import { runMigrations } from '../db/migrations.js';
import { getOrCreateProject, type Project } from '../db/project.js';
import { getPlanByUuid, getPlanTagsByUuid, getPlanTasksByUuid, upsertPlan } from '../db/plan.js';
import { getProjectSettingWithMetadata, setProjectSetting } from '../db/project_settings.js';
import { insertSyncConflict, insertSyncOperation, getSyncConflict } from '../db/sync_tables.js';
import {
  handleSyncConflictsCommand,
  handleSyncResolveCommand,
  handleSyncStatusCommand,
} from '../commands/sync.js';
import { applyOperation } from './apply.js';
import {
  addPlanListItemOperation,
  addPlanTagOperation,
  addPlanTaskOperation,
  deletePlanOperation,
  deleteProjectSettingOperation,
  markPlanTaskDoneOperation,
  patchPlanTextOperation,
  setProjectSettingOperation,
} from './operations.js';
import type { SyncOperationEnvelope } from './types.js';
import type { TimConfig } from '../configSchema.js';

vi.mock('../../logging.js', () => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debugLog: vi.fn(),
  writeStdout: vi.fn(),
  writeStderr: vi.fn(),
  sendStructured: vi.fn(),
}));

import { log as mockLogFn } from '../../logging.js';

const mockLog = vi.mocked(mockLogFn);

const PROJECT_UUID = '11111111-1111-4111-8111-111111111111';
const PLAN_UUID = '22222222-2222-4222-8222-222222222222';
const TASK_UUID = '33333333-3333-4333-8333-333333333333';
const MAIN_NODE = 'main-node';
const PERSISTENT_NODE = 'persistent-node';

let db: Database;
let project: Project;

const command = { parent: { opts: () => ({}) } } as any;

function config(role: 'main' | 'persistent'): TimConfig {
  return {
    sync:
      role === 'main'
        ? { role, nodeId: MAIN_NODE, allowedNodes: [] }
        : {
            role,
            nodeId: PERSISTENT_NODE,
            mainUrl: 'http://127.0.0.1:8124',
            nodeToken: 'token',
          },
  } as TimConfig;
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  project = getOrCreateProject(db, 'github.com__example__repo', {
    uuid: PROJECT_UUID,
    highestPlanId: 10,
  });
  mockLog.mockClear();
});

function seedPlan(details = 'alpha\nbeta\ngamma\n'): void {
  upsertPlan(db, project.id, {
    uuid: PLAN_UUID,
    planId: 1,
    title: 'Plan',
    details,
    status: 'pending',
    tasks: [{ uuid: TASK_UUID, title: 'Task one', description: 'Task description' }],
    forceOverwrite: true,
  });
}

async function createTextConflict(): Promise<string> {
  seedPlan('main changed\n');
  const op = await patchPlanTextOperation(
    PROJECT_UUID,
    {
      planUuid: PLAN_UUID,
      field: 'details',
      base: 'base\n',
      new: 'incoming\n',
      baseRevision: 1,
    },
    { originNodeId: PERSISTENT_NODE, localSequence: 1 }
  );
  const result = applyOperation(db, op);
  expect(result.status).toBe('conflict');
  expect(result.conflictId).toBeTruthy();
  return result.conflictId!;
}

async function createSettingConflict(localSequence = 1): Promise<string> {
  setProjectSetting(db, project.id, 'color', 'blue', { updatedByNode: MAIN_NODE });
  const op = await setProjectSettingOperation(
    {
      projectUuid: PROJECT_UUID,
      setting: 'color',
      value: 'red',
      baseRevision: 0,
    },
    { originNodeId: PERSISTENT_NODE, localSequence }
  );
  const result = applyOperation(db, op);
  expect(result.status).toBe('conflict');
  expect(result.conflictId).toBeTruthy();
  return result.conflictId!;
}

async function createTombstonedTargetConflict(): Promise<string> {
  seedPlan();
  const deleteOp = await deletePlanOperation(
    PROJECT_UUID,
    { planUuid: PLAN_UUID },
    { originNodeId: PERSISTENT_NODE, localSequence: 1 }
  );
  expect(applyOperation(db, deleteOp).status).toBe('applied');
  expect(getPlanByUuid(db, PLAN_UUID)).toBeNull();

  const tagOp = await addPlanTagOperation(
    PROJECT_UUID,
    { planUuid: PLAN_UUID, tag: 'offline-tag' },
    { originNodeId: PERSISTENT_NODE, localSequence: 2 }
  );
  const result = applyOperation(db, tagOp);
  expect(result.status).toBe('conflict');
  expect(result.conflictId).toBeTruthy();
  expect(getSyncConflict(db, result.conflictId!)?.reason).toBe('tombstoned_target');
  return result.conflictId!;
}

function syncSequenceCount(): number {
  return (db.prepare('SELECT COUNT(*) AS count FROM sync_sequence').get() as { count: number })
    .count;
}

async function pathFromTemp(prefix: string): Promise<string> {
  const dir = path.join(os.tmpdir(), `${prefix}-${crypto.randomUUID()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function insertOpenConflictForOperation(
  operationPromise: Promise<SyncOperationEnvelope>,
  conflictId: string
): Promise<string> {
  const op = await operationPromise;
  insertSyncConflict(db, {
    conflict_id: conflictId,
    operation_uuid: op.operationUuid,
    project_uuid: PROJECT_UUID,
    target_type: op.targetType,
    target_key: op.targetKey,
    field_path: null,
    base_value: null,
    base_hash: null,
    incoming_value: null,
    attempted_patch: null,
    current_value: null,
    original_payload: JSON.stringify(op.op),
    normalized_payload: JSON.stringify(op.op),
    reason: 'test',
    origin_node_id: PERSISTENT_NODE,
    resolved_at: null,
    resolution: null,
    resolved_by_node: null,
  });
  return conflictId;
}

describe('tim sync CLI node commands', () => {
  test('respects --config option through nested subcommands', async () => {
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
    const previousLoadGlobalConfig = process.env.TIM_LOAD_GLOBAL_CONFIG;
    clearConfigCache();
    const configDir = await pathFromTemp('tim-sync-config');
    process.env.XDG_CONFIG_HOME = configDir;
    delete process.env.TIM_LOAD_GLOBAL_CONFIG;
    const configPath = path.join(configDir, 'tim', 'config.yml');
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      [
        'sync:',
        '  role: persistent',
        '  nodeId: config-file-node',
        '  mainUrl: http://127.0.0.1:8124',
        '  nodeToken: config-file-token',
        '',
      ].join('\n')
    );
    const root = new Command();
    root.exitOverride();
    root.name('tim');
    root.option('--config <path>');
    const sync = root.command('sync');
    sync.command('status').action(async (options, nestedCommand) => {
      await handleSyncStatusCommand(options, nestedCommand, { db });
    });

    try {
      await root.parseAsync(['node', 'tim', '--config', configPath, 'sync', 'status']);
    } finally {
      if (previousXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
      }
      if (previousLoadGlobalConfig === undefined) {
        delete process.env.TIM_LOAD_GLOBAL_CONFIG;
      } else {
        process.env.TIM_LOAD_GLOBAL_CONFIG = previousLoadGlobalConfig;
      }
      clearConfigCache();
    }

    expect(mockLog.mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining([
        'Node ID: config-file-node',
        'Role: persistent',
        'Configured endpoint: http://127.0.0.1:8124',
      ])
    );
  });

  test('sync status reports configured persistent queue state', async () => {
    await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'queued' },
      { originNodeId: PERSISTENT_NODE, localSequence: 1 }
    ).then((op) => {
      insertSyncOperation(db, {
        operation_uuid: op.operationUuid,
        project_uuid: PROJECT_UUID,
        origin_node_id: PERSISTENT_NODE,
        local_sequence: 1,
        target_type: op.targetType,
        target_key: op.targetKey,
        operation_type: op.op.type,
        base_revision: null,
        base_hash: null,
        payload: JSON.stringify(op.op),
        status: 'queued',
        last_error: null,
        acked_at: null,
        ack_metadata: null,
      });
    });
    for (const [index, status] of [
      'sending',
      'failed_retryable',
      'conflict',
      'rejected',
    ].entries()) {
      const op = await addPlanTagOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, tag: status },
        { originNodeId: PERSISTENT_NODE, localSequence: index + 2 }
      );
      insertSyncOperation(db, {
        operation_uuid: op.operationUuid,
        project_uuid: PROJECT_UUID,
        origin_node_id: PERSISTENT_NODE,
        local_sequence: index + 2,
        target_type: op.targetType,
        target_key: op.targetKey,
        operation_type: op.op.type,
        base_revision: null,
        base_hash: null,
        payload: JSON.stringify(op.op),
        status,
        last_error: null,
        acked_at: null,
        ack_metadata: null,
      });
    }
    db.prepare(
      "INSERT INTO tim_node_cursor (node_id, last_known_sequence_id, updated_at) VALUES (?, 42, '2026-01-01T00:00:00.000Z')"
    ).run(PERSISTENT_NODE);

    await handleSyncStatusCommand({}, command, { db, config: config('persistent') });

    expect(mockLog.mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining([
        `Node ID: ${PERSISTENT_NODE}`,
        'Role: persistent',
        'Configured state: online',
        'Configured endpoint: http://127.0.0.1:8124',
        expect.stringMatching(
          /^Health: Degraded \(1 failed_retryable operation, 1 rejected operation\), oldest pending \d+s$/
        ),
        'Pending operations: queued=1, sending=1, failed_retryable=1',
        'Rejected operations: 1',
        'Conflict-acked operations: 1',
        'Last known main-node sequence: 42',
      ])
    );
  });

  test('sync conflicts lists open conflicts on main and rejects on persistent', async () => {
    const conflictId = await createTextConflict();

    await handleSyncConflictsCommand({}, command, { db, config: config('main') });
    expect(mockLog.mock.calls.some((call) => String(call[0]).includes(conflictId))).toBe(true);

    await expect(
      handleSyncConflictsCommand({}, command, { db, config: config('persistent') })
    ).rejects.toThrow('only valid on the main sync node');
  });

  test('sync resolve --apply-current discards without changing state or revision', async () => {
    const conflictId = await createTextConflict();
    const before = getPlanByUuid(db, PLAN_UUID)!;
    const beforeSequenceCount = syncSequenceCount();

    await handleSyncResolveCommand(conflictId, { applyCurrent: true }, command, {
      db,
      config: config('main'),
    });

    const after = getPlanByUuid(db, PLAN_UUID)!;
    expect(after.details).toBe(before.details);
    expect(after.revision).toBe(before.revision);
    expect(syncSequenceCount()).toBe(beforeSequenceCount);
    expect(getSyncConflict(db, conflictId)?.status).toBe('resolved_discarded');
  });

  test('sync resolve --apply-incoming applies text conflicts and appends sequence', async () => {
    const conflictId = await createTextConflict();
    const beforeRevision = getPlanByUuid(db, PLAN_UUID)!.revision;
    const beforeSequenceCount = syncSequenceCount();

    await handleSyncResolveCommand(conflictId, { applyIncoming: true }, command, {
      db,
      config: config('main'),
    });

    const after = getPlanByUuid(db, PLAN_UUID)!;
    expect(after.details).toBe('incoming\n');
    expect(after.revision).toBe(beforeRevision + 1);
    expect(syncSequenceCount()).toBe(beforeSequenceCount + 1);
    expect(
      (
        db
          .prepare('SELECT origin_node_id FROM sync_sequence ORDER BY sequence DESC LIMIT 1')
          .get() as { origin_node_id: string }
      ).origin_node_id
    ).toBe(`resolver:${MAIN_NODE}`);
    expect(getSyncConflict(db, conflictId)?.status).toBe('resolved_applied');
  });

  test('sync resolve --apply-incoming applies project setting conflicts', async () => {
    const conflictId = await createSettingConflict();
    const beforeRevision = getProjectSettingWithMetadata(db, project.id, 'color')!.revision;

    await handleSyncResolveCommand(conflictId, { applyIncoming: true }, command, {
      db,
      config: config('main'),
    });

    const setting = getProjectSettingWithMetadata(db, project.id, 'color')!;
    expect(setting.value).toBe('red');
    expect(setting.revision).toBe(beforeRevision + 1);
    expect(syncSequenceCount()).toBe(1);
    expect(getSyncConflict(db, conflictId)?.status).toBe('resolved_applied');
  });

  test('sync resolve --apply-incoming applies project_setting.delete conflict by deleting the setting', async () => {
    // Create a stale-delete conflict: main node has revision 1, persistent sends delete with baseRevision 0
    setProjectSetting(db, project.id, 'theme', 'dark', { updatedByNode: MAIN_NODE });
    const op = await deleteProjectSettingOperation(
      { projectUuid: PROJECT_UUID, setting: 'theme', baseRevision: 0 },
      { originNodeId: PERSISTENT_NODE, localSequence: 1 }
    );
    const result = applyOperation(db, op);
    expect(result.status).toBe('conflict');
    const conflictId = result.conflictId!;

    await handleSyncResolveCommand(conflictId, { applyIncoming: true }, command, {
      db,
      config: config('main'),
    });

    expect(getProjectSettingWithMetadata(db, project.id, 'theme')).toBeNull();
    expect(getSyncConflict(db, conflictId)?.status).toBe('resolved_applied');
  });

  test('sync resolve --manual rejects malformed JSON', async () => {
    const conflictId = await createTextConflict();
    await expect(
      handleSyncResolveCommand(conflictId, { manual: 'not valid json' }, command, {
        db,
        config: config('main'),
      })
    ).rejects.toThrow('--manual must be valid JSON:');
  });

  test('sync resolve --apply-incoming applies plan.add_tag conflicts', async () => {
    seedPlan();
    const conflictId = await insertOpenConflictForOperation(
      addPlanTagOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, tag: 'resolved-tag' },
        { originNodeId: PERSISTENT_NODE, localSequence: 10 }
      ),
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
    );
    const beforeRevision = getPlanByUuid(db, PLAN_UUID)!.revision;

    await handleSyncResolveCommand(conflictId, { applyIncoming: true }, command, {
      db,
      config: config('main'),
    });

    expect(getPlanTagsByUuid(db, PLAN_UUID).map((tag) => tag.tag)).toContain('resolved-tag');
    expect(getPlanByUuid(db, PLAN_UUID)!.revision).toBe(beforeRevision + 1);
    expect(syncSequenceCount()).toBe(1);
    expect(getSyncConflict(db, conflictId)?.status).toBe('resolved_applied');
  });

  test('sync resolve --apply-incoming applies plan.add_task conflicts', async () => {
    seedPlan();
    const taskUuid = '44444444-4444-4444-8444-444444444444';
    const conflictId = await insertOpenConflictForOperation(
      addPlanTaskOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, taskUuid, title: 'Recovered task', description: 'Recovered' },
        { originNodeId: PERSISTENT_NODE, localSequence: 11 }
      ),
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
    );

    await handleSyncResolveCommand(conflictId, { applyIncoming: true }, command, {
      db,
      config: config('main'),
    });

    expect(getPlanTasksByUuid(db, PLAN_UUID).map((task) => task.uuid)).toContain(taskUuid);
    expect(syncSequenceCount()).toBe(2);
    expect(getSyncConflict(db, conflictId)?.status).toBe('resolved_applied');
  });

  test('sync resolve --apply-incoming applies plan.mark_task_done conflicts', async () => {
    seedPlan();
    const conflictId = await insertOpenConflictForOperation(
      markPlanTaskDoneOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, taskUuid: TASK_UUID, done: true },
        { originNodeId: PERSISTENT_NODE, localSequence: 12 }
      ),
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'
    );

    await handleSyncResolveCommand(conflictId, { applyIncoming: true }, command, {
      db,
      config: config('main'),
    });

    expect(getPlanTasksByUuid(db, PLAN_UUID).find((task) => task.uuid === TASK_UUID)?.done).toBe(1);
    expect(syncSequenceCount()).toBe(2);
    expect(getSyncConflict(db, conflictId)?.status).toBe('resolved_applied');
  });

  test('sync resolve --apply-incoming applies plan.add_list_item conflicts', async () => {
    seedPlan();
    const conflictId = await insertOpenConflictForOperation(
      addPlanListItemOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, list: 'docs', value: 'docs/recovered.md' },
        { originNodeId: PERSISTENT_NODE, localSequence: 13 }
      ),
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4'
    );

    await handleSyncResolveCommand(conflictId, { applyIncoming: true }, command, {
      db,
      config: config('main'),
    });

    expect(JSON.parse(getPlanByUuid(db, PLAN_UUID)!.docs!)).toEqual(['docs/recovered.md']);
    expect(syncSequenceCount()).toBe(1);
    expect(getSyncConflict(db, conflictId)?.status).toBe('resolved_applied');
  });

  test('sync resolve treats tombstoned-target conflicts as discard-only', async () => {
    const conflictId = await createTombstonedTargetConflict();
    const expectedMessage =
      'Tombstoned-target conflicts can only be resolved with --apply-current (discard); the target plan or task no longer exists. To recover the deleted entity, recreate it first via the appropriate command.';

    await expect(
      handleSyncResolveCommand(conflictId, { applyIncoming: true }, command, {
        db,
        config: config('main'),
      })
    ).rejects.toThrow(expectedMessage);
    await expect(
      handleSyncResolveCommand(conflictId, { manual: '"offline-tag"' }, command, {
        db,
        config: config('main'),
      })
    ).rejects.toThrow(expectedMessage);
    expect(getSyncConflict(db, conflictId)?.status).toBe('open');

    await handleSyncResolveCommand(conflictId, { applyCurrent: true }, command, {
      db,
      config: config('main'),
    });

    const conflict = getSyncConflict(db, conflictId);
    expect(conflict?.status).toBe('resolved_discarded');
    expect(JSON.parse(conflict!.resolution!)).toMatchObject({ mode: 'apply-current' });
  });

  test('sync resolve --manual rejects project_setting.delete conflicts', async () => {
    setProjectSetting(db, project.id, 'theme', 'dark', { updatedByNode: MAIN_NODE });
    const op = await deleteProjectSettingOperation(
      { projectUuid: PROJECT_UUID, setting: 'theme', baseRevision: 0 },
      { originNodeId: PERSISTENT_NODE, localSequence: 1 }
    );
    const result = applyOperation(db, op);
    const conflictId = result.conflictId!;

    await expect(
      handleSyncResolveCommand(conflictId, { manual: '"light"' }, command, {
        db,
        config: config('main'),
      })
    ).rejects.toThrow(
      'manual value is not compatible with delete operations; use --apply-incoming or --apply-current'
    );
  });

  test('sync resolve --manual applies manual text and setting values', async () => {
    const textConflictId = await createTextConflict();
    await handleSyncResolveCommand(textConflictId, { manual: '"manual text\\n"' }, command, {
      db,
      config: config('main'),
    });
    expect(getPlanByUuid(db, PLAN_UUID)!.details).toBe('manual text\n');

    const settingConflictId = await createSettingConflict(2);
    await handleSyncResolveCommand(settingConflictId, { manual: '{"name":"manual"}' }, command, {
      db,
      config: config('main'),
    });
    expect(getProjectSettingWithMetadata(db, project.id, 'color')!.value).toEqual({
      name: 'manual',
    });
  });

  test('sync resolve rejects persistent nodes, unknown ids, resolved conflicts, and manual incompatible ops', async () => {
    const conflictId = await createTextConflict();
    await expect(
      handleSyncResolveCommand(conflictId, { applyIncoming: true }, command, {
        db,
        config: config('persistent'),
      })
    ).rejects.toThrow('only valid on the main sync node');

    await expect(
      handleSyncResolveCommand('missing', { applyIncoming: true }, command, {
        db,
        config: config('main'),
      })
    ).rejects.toThrow('Unknown sync conflict');

    await handleSyncResolveCommand(conflictId, { applyCurrent: true }, command, {
      db,
      config: config('main'),
    });
    await expect(
      handleSyncResolveCommand(conflictId, { applyIncoming: true }, command, {
        db,
        config: config('main'),
      })
    ).rejects.toThrow('already resolved');

    seedPlan();
    await insertOpenConflictForOperation(
      addPlanTagOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, tag: 'tag' },
        { originNodeId: PERSISTENT_NODE, localSequence: 5 }
      ),
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    );
    await expect(
      handleSyncResolveCommand(
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        { manual: '"tag"' },
        command,
        { db, config: config('main') }
      )
    ).rejects.toThrow(
      '--manual is not compatible with plan.add_tag; use --apply-incoming or --apply-current'
    );
  });
});
