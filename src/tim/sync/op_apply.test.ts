import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DATABASE_FILENAME, openDatabase } from '../db/database.js';
import {
  getPlanByUuid,
  getPlanDependenciesByUuid,
  getPlanTagsByUuid,
  getPlanTasksByUuid,
  upsertPlan,
  upsertPlanDependencies,
} from '../db/plan.js';
import { getProjectSetting, setProjectSetting } from '../db/project_settings.js';
import { getOrCreateProject } from '../db/project.js';
import { applyRemoteOps, type SyncOpRecord } from './op_apply.js';
import { formatHlc, type Hlc } from './hlc.js';

function opRows(db: Database): SyncOpRecord[] {
  return db
    .prepare(
      'SELECT * FROM sync_op_log ORDER BY hlc_physical_ms, hlc_logical, node_id, local_counter'
    )
    .all() as SyncOpRecord[];
}

function makeOp(
  nodeId: string,
  hlc: Hlc,
  localCounter: number,
  entityType: string,
  entityId: string,
  opType: string,
  payload: unknown
): SyncOpRecord {
  return {
    op_id: `${formatHlc(hlc)}/${nodeId}/${localCounter}`,
    node_id: nodeId,
    hlc_physical_ms: hlc.physicalMs,
    hlc_logical: hlc.logical,
    local_counter: localCounter,
    entity_type: entityType,
    entity_id: entityId,
    op_type: opType,
    payload: JSON.stringify(payload),
    base: null,
  };
}

describe('sync op application', () => {
  let tempDir: string;
  let db: Database;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-sync-op-apply-test-'));
    db = openDatabase(path.join(tempDir, DATABASE_FILENAME));
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('is idempotent by op_id', () => {
    const op = makeOp(
      'remote-a',
      { physicalMs: 1000, logical: 0 },
      1,
      'plan',
      'plan-idem',
      'create',
      {
        projectIdentity: 'github.com__owner__repo',
        planIdHint: 1,
        fields: { title: 'Once', status: 'pending' },
      }
    );

    expect(applyRemoteOps(db, [op])).toMatchObject({ applied: 1, errors: [] });
    expect(applyRemoteOps(db, [op])).toMatchObject({
      applied: 0,
      errors: [],
      skipped: [{ opId: op.op_id, reason: 'already applied' }],
    });
    expect(getPlanByUuid(db, 'plan-idem')?.title).toBe('Once');
    expect(
      db.prepare('SELECT count(*) AS count FROM sync_op_log WHERE op_id = ?').get(op.op_id)
    ).toEqual({ count: 1 });
  });

  test('uses HLC and node id tie-breaker for LWW plan fields', () => {
    const create = makeOp(
      'remote-a',
      { physicalMs: 1000, logical: 0 },
      1,
      'plan',
      'plan-lww',
      'create',
      {
        projectIdentity: 'github.com__owner__repo',
        planIdHint: 2,
        fields: { title: 'Base', status: 'pending' },
      }
    );
    const updateA = makeOp(
      'node-a',
      { physicalMs: 2000, logical: 0 },
      1,
      'plan',
      'plan-lww',
      'update_fields',
      {
        projectIdentity: 'github.com__owner__repo',
        planIdHint: 2,
        fields: { title: 'A title' },
      }
    );
    const updateB = makeOp(
      'node-b',
      { physicalMs: 2000, logical: 0 },
      1,
      'plan',
      'plan-lww',
      'update_fields',
      {
        projectIdentity: 'github.com__owner__repo',
        planIdHint: 2,
        fields: { title: 'B title' },
      }
    );

    const result = applyRemoteOps(db, [updateB, create, updateA]);

    expect(result.errors).toEqual([]);
    expect(getPlanByUuid(db, 'plan-lww')?.title).toBe('B title');
  });

  test('task tombstone prevents stale field updates from resurrecting content', () => {
    const projectId = getOrCreateProject(db, 'github.com__owner__repo').id;
    upsertPlan(db, projectId, {
      uuid: 'plan-tombstone-apply',
      planId: 3,
      tasks: [{ uuid: 'task-gone', title: 'Original', description: 'Desc', done: false }],
    });

    const deleteOp = makeOp(
      'remote-a',
      { physicalMs: 3000, logical: 0 },
      1,
      'plan_task',
      'task-gone',
      'delete',
      { planUuid: 'plan-tombstone-apply' }
    );
    const staleUpdate = makeOp(
      'remote-b',
      { physicalMs: 2000, logical: 0 },
      1,
      'plan_task',
      'task-gone',
      'update_fields',
      {
        planUuid: 'plan-tombstone-apply',
        fields: { title: 'Stale update' },
      }
    );

    expect(applyRemoteOps(db, [deleteOp]).errors).toEqual([]);
    expect(applyRemoteOps(db, [staleUpdate]).errors).toEqual([]);

    expect(getPlanTasksByUuid(db, 'plan-tombstone-apply')).toEqual([]);
    const row = db
      .prepare('SELECT title, deleted_hlc FROM plan_task WHERE uuid = ?')
      .get('task-gone') as { title: string; deleted_hlc: string | null };
    expect(row.title).toBe('Original');
    expect(row.deleted_hlc).toBe(formatHlc({ physicalMs: 3000, logical: 0 }));
  });

  test('remove-wins edge clocks control dependency and tag presence', () => {
    const projectId = getOrCreateProject(db, 'github.com__owner__repo').id;
    upsertPlan(db, projectId, { uuid: 'plan-edge', planId: 4 });
    upsertPlan(db, projectId, { uuid: 'dep-edge', planId: 5 });

    const addDep = makeOp(
      'remote-a',
      { physicalMs: 1000, logical: 0 },
      1,
      'plan_dependency',
      'plan-edge->dep-edge',
      'add_edge',
      { planUuid: 'plan-edge', dependsOnUuid: 'dep-edge' }
    );
    const removeDep = makeOp(
      'remote-a',
      { physicalMs: 2000, logical: 0 },
      2,
      'plan_dependency',
      'plan-edge->dep-edge',
      'remove_edge',
      { planUuid: 'plan-edge', dependsOnUuid: 'dep-edge' }
    );
    expect(applyRemoteOps(db, [addDep, removeDep]).errors).toEqual([]);
    expect(getPlanDependenciesByUuid(db, 'plan-edge')).toEqual([]);

    const staleRemoveTag = makeOp(
      'remote-a',
      { physicalMs: 1000, logical: 0 },
      3,
      'plan_tag',
      'plan-edge#backend',
      'remove_edge',
      { planUuid: 'plan-edge', tag: 'backend' }
    );
    const addTag = makeOp(
      'remote-a',
      { physicalMs: 2000, logical: 0 },
      4,
      'plan_tag',
      'plan-edge#backend',
      'add_edge',
      { planUuid: 'plan-edge', tag: 'backend' }
    );
    expect(applyRemoteOps(db, [addTag, staleRemoveTag]).errors).toEqual([]);
    expect(getPlanTagsByUuid(db, 'plan-edge')).toEqual([
      { plan_uuid: 'plan-edge', tag: 'backend' },
    ]);
  });

  test('round-trips real emitted plan, task, and dependency ops between databases', async () => {
    const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-sync-op-apply-peer-'));
    const source = openDatabase(path.join(otherDir, DATABASE_FILENAME));
    try {
      const projectId = getOrCreateProject(source, 'github.com__owner__repo').id;
      upsertPlan(source, projectId, { uuid: 'dep-roundtrip', planId: 1, title: 'Dependency' });
      upsertPlan(source, projectId, {
        uuid: 'plan-roundtrip',
        planId: 2,
        title: 'Round trip',
        tasks: [
          {
            uuid: 'task-roundtrip',
            title: 'Ship apply',
            description: 'Use real emitted ops',
            done: false,
          },
        ],
      });
      upsertPlanDependencies(source, 'plan-roundtrip', ['dep-roundtrip']);

      const result = applyRemoteOps(db, opRows(source));

      expect(result.errors).toEqual([]);
      expect(getPlanByUuid(db, 'plan-roundtrip')?.title).toBe('Round trip');
      expect(getPlanTasksByUuid(db, 'plan-roundtrip')).toMatchObject([
        {
          uuid: 'task-roundtrip',
          title: 'Ship apply',
          description: 'Use real emitted ops',
          done: 0,
        },
      ]);
      expect(getPlanDependenciesByUuid(db, 'plan-roundtrip')).toEqual([
        { plan_uuid: 'plan-roundtrip', depends_on_uuid: 'dep-roundtrip' },
      ]);
    } finally {
      source.close(false);
      await fs.rm(otherDir, { recursive: true, force: true });
    }
  });

  test('round-trips project setting LWW updates', async () => {
    const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-sync-op-apply-setting-peer-'));
    const source = openDatabase(path.join(otherDir, DATABASE_FILENAME));
    try {
      const sourceProjectId = getOrCreateProject(source, 'github.com__owner__repo').id;
      setProjectSetting(source, sourceProjectId, 'featured', true);
      setProjectSetting(source, sourceProjectId, 'featured', false);

      const result = applyRemoteOps(db, opRows(source));
      const targetProjectId = getOrCreateProject(db, 'github.com__owner__repo').id;

      expect(result.errors).toEqual([]);
      expect(getProjectSetting(db, targetProjectId, 'featured')).toBe(false);
    } finally {
      source.close(false);
      await fs.rm(otherDir, { recursive: true, force: true });
    }
  });

  test('project setting stale delete does not beat a newer value field clock', () => {
    const update = makeOp(
      'remote-b',
      { physicalMs: 3000, logical: 0 },
      1,
      'project_setting',
      'github.com__owner__repo:featured',
      'update_fields',
      {
        projectIdentity: 'github.com__owner__repo',
        setting: 'featured',
        value: true,
      }
    );
    const staleDelete = makeOp(
      'remote-a',
      { physicalMs: 2000, logical: 0 },
      1,
      'project_setting',
      'github.com__owner__repo:featured',
      'delete',
      {
        projectIdentity: 'github.com__owner__repo',
        setting: 'featured',
      }
    );

    const result = applyRemoteOps(db, [update]);
    const deleteResult = applyRemoteOps(db, [staleDelete]);
    const projectId = getOrCreateProject(db, 'github.com__owner__repo').id;

    expect(result.errors).toEqual([]);
    expect(deleteResult.errors).toEqual([]);
    expect(getProjectSetting(db, projectId, 'featured')).toBe(true);
  });

  test('returns unknown op types in skipped without throwing', () => {
    const op = makeOp(
      'remote-a',
      { physicalMs: 1000, logical: 0 },
      1,
      'plan',
      'plan-unknown',
      'future_magic',
      {}
    );

    const result = applyRemoteOps(db, [op]);

    expect(result.applied).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.skipped).toEqual([
      { opId: op.op_id, reason: 'unsupported op plan:future_magic' },
    ]);
  });

  test('observes remote HLCs into the local clock', () => {
    const futurePhysical = Date.now() + 60_000;
    const op = makeOp(
      'remote-a',
      { physicalMs: futurePhysical, logical: 7 },
      1,
      'project_setting',
      'github.com__owner__repo:abbreviation',
      'update_fields',
      {
        projectIdentity: 'github.com__owner__repo',
        setting: 'abbreviation',
        value: 'GH',
      }
    );

    expect(applyRemoteOps(db, [op]).errors).toEqual([]);

    const clock = db.prepare('SELECT physical_ms, logical FROM sync_clock WHERE id = 1').get() as {
      physical_ms: number;
      logical: number;
    };
    expect(clock.physical_ms).toBe(futurePhysical);
    expect(clock.logical).toBe(8);
  });
});
