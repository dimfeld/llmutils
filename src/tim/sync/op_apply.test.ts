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
  deletePlan,
  upsertPlan,
  upsertPlanDependencies,
} from '../db/plan.js';
import { createReviewIssue, listReviewIssuesForPlan } from '../db/plan_review_issue.js';
import { getProjectSetting, setProjectSetting } from '../db/project_settings.js';
import { getOrCreateProject } from '../db/project.js';
import { applyRemoteOps, type SyncOpRecord } from './op_apply.js';
import { edgeClockIsPresent, getEdgeClock } from './edge_clock.js';
import { formatHlc, type Hlc } from './hlc.js';
import { HLC_MIN_PHYSICAL_MS } from './op_validation.js';

const fixtureIds = new Map<string, string>();
const fixtureNodeIds = new Map<string, string>([
  ['node-a', '00000000-0000-4000-8000-00000000000a'],
  ['node-b', '00000000-0000-4000-8000-00000000000b'],
  ['remote-a', '10000000-0000-4000-8000-00000000000a'],
  ['remote-b', '10000000-0000-4000-8000-00000000000b'],
  ['remote-c', '10000000-0000-4000-8000-00000000000c'],
  ['remote-d', '10000000-0000-4000-8000-00000000000d'],
  ['remote-e', '10000000-0000-4000-8000-00000000000e'],
  ['remote-f', '10000000-0000-4000-8000-00000000000f'],
  ['remote-hlc', '10000000-0000-4000-8000-0000000000aa'],
  ['remote-src', '10000000-0000-4000-8000-0000000000bb'],
  ['remote-stale', '10000000-0000-4000-8000-0000000000cc'],
]);

function id(label: string): string {
  let existing = fixtureIds.get(label);
  if (!existing) {
    existing = `20000000-0000-4000-8000-${(fixtureIds.size + 1).toString().padStart(12, '0')}`;
    fixtureIds.set(label, existing);
  }
  return existing;
}

function fixtureNodeId(label: string): string {
  return fixtureNodeIds.get(label) ?? label;
}

function testHlc(physicalOffsetMs: number, logical = 0): Hlc {
  return { physicalMs: HLC_MIN_PHYSICAL_MS + physicalOffsetMs, logical };
}

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
  const actualNodeId = fixtureNodeId(nodeId);
  const actualHlc =
    hlc.physicalMs < HLC_MIN_PHYSICAL_MS ? testHlc(hlc.physicalMs, hlc.logical) : hlc;
  return {
    op_id: `${formatHlc(actualHlc)}/${actualNodeId}/${localCounter}`,
    node_id: actualNodeId,
    hlc_physical_ms: actualHlc.physicalMs,
    hlc_logical: actualHlc.logical,
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
      id('plan-idem'),
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
    expect(getPlanByUuid(db, id('plan-idem'))?.title).toBe('Once');
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
      id('plan-lww'),
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
      id('plan-lww'),
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
      id('plan-lww'),
      'update_fields',
      {
        projectIdentity: 'github.com__owner__repo',
        planIdHint: 2,
        fields: { title: 'B title' },
      }
    );

    const result = applyRemoteOps(db, [updateB, create, updateA]);

    expect(result.errors).toEqual([]);
    expect(getPlanByUuid(db, id('plan-lww'))?.title).toBe('B title');
  });

  test('task tombstone prevents stale field updates from resurrecting content', () => {
    const projectId = getOrCreateProject(db, 'github.com__owner__repo').id;
    upsertPlan(db, projectId, {
      uuid: id('plan-tombstone-apply'),
      planId: 3,
      tasks: [{ uuid: id('task-gone'), title: 'Original', description: 'Desc', done: false }],
    });

    const deleteOp = makeOp(
      'remote-a',
      { physicalMs: 3000, logical: 0 },
      1,
      'plan_task',
      id('task-gone'),
      'delete',
      { planUuid: id('plan-tombstone-apply') }
    );
    const staleUpdate = makeOp(
      'remote-b',
      { physicalMs: 2000, logical: 0 },
      1,
      'plan_task',
      id('task-gone'),
      'update_fields',
      {
        planUuid: id('plan-tombstone-apply'),
        fields: { title: 'Stale update' },
      }
    );

    expect(applyRemoteOps(db, [deleteOp]).errors).toEqual([]);
    expect(applyRemoteOps(db, [staleUpdate]).errors).toEqual([]);

    expect(getPlanTasksByUuid(db, id('plan-tombstone-apply'))).toEqual([]);
    const row = db
      .prepare('SELECT title, deleted_hlc FROM plan_task WHERE uuid = ?')
      .get(id('task-gone')) as { title: string; deleted_hlc: string | null };
    expect(row.title).toBe('Original');
    expect(row.deleted_hlc).toBe(formatHlc(testHlc(3000)));
  });

  test('plan delete tombstones children so stale child ops are no-ops on both peers', async () => {
    const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-sync-op-apply-delete-peer-'));
    const source = openDatabase(path.join(otherDir, DATABASE_FILENAME));
    try {
      const projectId = getOrCreateProject(source, 'github.com__owner__repo').id;
      upsertPlan(source, projectId, {
        uuid: id('plan-delete-wall'),
        planId: 50,
        tasks: [
          {
            uuid: id('task-delete-wall'),
            title: 'Original',
            description: 'Before delete',
            done: false,
          },
        ],
        tags: ['sync'],
      });
      const staleTaskUpdate = makeOp(
        'remote-stale',
        { physicalMs: 1000, logical: 0 },
        1,
        'plan_task',
        id('task-delete-wall'),
        'update_fields',
        {
          planUuid: id('plan-delete-wall'),
          fields: { title: 'Stale title' },
        }
      );

      expect(deletePlan(source, id('plan-delete-wall'))).toBe(true);
      expect(applyRemoteOps(source, [staleTaskUpdate]).errors).toEqual([]);
      expect(getPlanByUuid(source, id('plan-delete-wall'))).toBeNull();
      expect(
        source
          .prepare(
            'SELECT count(*) AS count FROM sync_tombstone WHERE entity_type = ? AND entity_id = ?'
          )
          .get('plan_task', id('task-delete-wall'))
      ).toEqual({ count: 1 });

      const result = applyRemoteOps(db, opRows(source));
      expect(result.errors).toEqual([]);
      expect(getPlanByUuid(db, id('plan-delete-wall'))).toBeNull();
      expect(
        db
          .prepare(
            'SELECT count(*) AS count FROM sync_tombstone WHERE entity_type = ? AND entity_id = ?'
          )
          .get('plan_task', id('task-delete-wall'))
      ).toEqual({ count: 1 });

      const staleResult = applyRemoteOps(db, [staleTaskUpdate]);
      expect(staleResult.errors).toEqual([]);
      expect(getPlanTasksByUuid(db, id('plan-delete-wall'))).toEqual([]);
    } finally {
      source.close(false);
      await fs.rm(otherDir, { recursive: true, force: true });
    }
  });

  test('deleted plan is not resurrected by a higher-HLC create op', () => {
    const projectId = getOrCreateProject(db, 'github.com__owner__repo').id;
    upsertPlan(db, projectId, { uuid: id('plan-no-resurrect'), planId: 51, title: 'Gone' });

    const deleteOp = makeOp(
      'remote-a',
      { physicalMs: 2000, logical: 0 },
      1,
      'plan',
      id('plan-no-resurrect'),
      'delete',
      {}
    );
    const higherCreate = makeOp(
      'remote-b',
      { physicalMs: 3000, logical: 0 },
      1,
      'plan',
      id('plan-no-resurrect'),
      'create',
      {
        projectIdentity: 'github.com__owner__repo',
        planIdHint: 51,
        fields: { title: 'Back again', status: 'pending' },
      }
    );

    expect(applyRemoteOps(db, [deleteOp]).errors).toEqual([]);
    expect(applyRemoteOps(db, [higherCreate]).errors).toEqual([]);
    expect(getPlanByUuid(db, id('plan-no-resurrect'))).toBeNull();
  });

  test('remove-wins edge clocks control dependency and tag presence', () => {
    const projectId = getOrCreateProject(db, 'github.com__owner__repo').id;
    upsertPlan(db, projectId, { uuid: id('plan-edge'), planId: 4 });
    upsertPlan(db, projectId, { uuid: id('dep-edge'), planId: 5 });

    const addDep = makeOp(
      'remote-a',
      { physicalMs: 1000, logical: 0 },
      1,
      'plan_dependency',
      `${id('plan-edge')}->${id('dep-edge')}`,
      'add_edge',
      { planUuid: id('plan-edge'), dependsOnUuid: id('dep-edge') }
    );
    const removeDep = makeOp(
      'remote-a',
      { physicalMs: 2000, logical: 0 },
      2,
      'plan_dependency',
      `${id('plan-edge')}->${id('dep-edge')}`,
      'remove_edge',
      { planUuid: id('plan-edge'), dependsOnUuid: id('dep-edge') }
    );
    expect(applyRemoteOps(db, [addDep, removeDep]).errors).toEqual([]);
    expect(getPlanDependenciesByUuid(db, id('plan-edge'))).toEqual([]);
    expect(
      edgeClockIsPresent(
        getEdgeClock(db, 'plan_dependency', `${id('plan-edge')}->${id('dep-edge')}`)
      )
    ).toBe(false);

    const staleDepAdd = makeOp(
      'remote-b',
      { physicalMs: 900, logical: 0 },
      1,
      'plan_dependency',
      `${id('plan-edge')}->${id('dep-edge')}`,
      'add_edge',
      { planUuid: id('plan-edge'), dependsOnUuid: id('dep-edge') }
    );
    const staleDepResult = applyRemoteOps(db, [staleDepAdd]);
    expect(staleDepResult.errors).toEqual([]);
    expect(staleDepResult.skipped).toEqual([
      expect.objectContaining({ opId: staleDepAdd.op_id, kind: 'permanent' }),
    ]);
    expect(getPlanDependenciesByUuid(db, id('plan-edge'))).toEqual([]);

    const staleRemoveTag = makeOp(
      'remote-a',
      { physicalMs: 1000, logical: 0 },
      3,
      'plan_tag',
      `${id('plan-edge')}#backend`,
      'remove_edge',
      { planUuid: id('plan-edge'), tag: 'backend' }
    );
    const addTag = makeOp(
      'remote-a',
      { physicalMs: 2000, logical: 0 },
      4,
      'plan_tag',
      `${id('plan-edge')}#backend`,
      'add_edge',
      { planUuid: id('plan-edge'), tag: 'backend' }
    );
    expect(applyRemoteOps(db, [addTag, staleRemoveTag]).errors).toEqual([]);
    expect(getPlanTagsByUuid(db, id('plan-edge'))).toEqual([
      { plan_uuid: id('plan-edge'), tag: 'backend' },
    ]);
    expect(edgeClockIsPresent(getEdgeClock(db, 'plan_tag', `${id('plan-edge')}#backend`))).toBe(
      true
    );

    const removeTag = makeOp(
      'remote-a',
      { physicalMs: 3000, logical: 0 },
      5,
      'plan_tag',
      `${id('plan-edge')}#backend`,
      'remove_edge',
      { planUuid: id('plan-edge'), tag: 'backend' }
    );
    const staleTagAdd = makeOp(
      'remote-b',
      { physicalMs: 1500, logical: 0 },
      2,
      'plan_tag',
      `${id('plan-edge')}#backend`,
      'add_edge',
      { planUuid: id('plan-edge'), tag: 'backend' }
    );
    expect(applyRemoteOps(db, [removeTag]).errors).toEqual([]);
    const staleTagResult = applyRemoteOps(db, [staleTagAdd]);
    expect(staleTagResult.errors).toEqual([]);
    expect(staleTagResult.skipped).toEqual([
      expect.objectContaining({ opId: staleTagAdd.op_id, kind: 'permanent' }),
    ]);
    expect(getPlanTagsByUuid(db, id('plan-edge'))).toEqual([]);
    expect(edgeClockIsPresent(getEdgeClock(db, 'plan_tag', `${id('plan-edge')}#backend`))).toBe(
      false
    );
  });

  test('round-trips real emitted plan, task, and dependency ops between databases', async () => {
    const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-sync-op-apply-peer-'));
    const source = openDatabase(path.join(otherDir, DATABASE_FILENAME));
    try {
      const projectId = getOrCreateProject(source, 'github.com__owner__repo').id;
      upsertPlan(source, projectId, { uuid: id('dep-roundtrip'), planId: 1, title: 'Dependency' });
      upsertPlan(source, projectId, {
        uuid: id('plan-roundtrip'),
        planId: 2,
        title: 'Round trip',
        tasks: [
          {
            uuid: id('task-roundtrip'),
            title: 'Ship apply',
            description: 'Use real emitted ops',
            done: false,
          },
        ],
      });
      upsertPlanDependencies(source, id('plan-roundtrip'), [id('dep-roundtrip')]);

      const result = applyRemoteOps(db, opRows(source));

      expect(result.errors).toEqual([]);
      expect(getPlanByUuid(db, id('plan-roundtrip'))?.title).toBe('Round trip');
      expect(getPlanTasksByUuid(db, id('plan-roundtrip'))).toMatchObject([
        {
          uuid: id('task-roundtrip'),
          title: 'Ship apply',
          description: 'Use real emitted ops',
          done: 0,
        },
      ]);
      expect(getPlanDependenciesByUuid(db, id('plan-roundtrip'))).toEqual([
        { plan_uuid: id('plan-roundtrip'), depends_on_uuid: id('dep-roundtrip') },
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
      id('plan-unknown'),
      'future_magic',
      {}
    );

    const result = applyRemoteOps(db, [op]);

    expect(result.applied).toBe(0);
    expect(result.errors).toEqual([]);
    expect(result.skipped).toEqual([
      { opId: op.op_id, reason: 'unsupported op plan:future_magic', kind: 'permanent' },
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

  test('set_order op changes order_key and derived task_index but not title or description', () => {
    const projectId = getOrCreateProject(db, 'github.com__owner__repo').id;
    upsertPlan(db, projectId, {
      uuid: id('plan-setorder'),
      planId: 10,
      tasks: [{ uuid: id('task-ord'), title: 'Keep title', description: 'Keep desc', done: false }],
    });

    const setOrderOp = makeOp(
      'remote-a',
      { physicalMs: Date.now() + 10_000, logical: 0 },
      1,
      'plan_task',
      id('task-ord'),
      'set_order',
      { planUuid: id('plan-setorder'), orderKey: '0000000099', taskIndex: 99 }
    );

    expect(applyRemoteOps(db, [setOrderOp]).errors).toEqual([]);

    const row = db
      .prepare('SELECT title, description, order_key, task_index FROM plan_task WHERE uuid = ?')
      .get(id('task-ord')) as {
      title: string;
      description: string;
      order_key: string;
      task_index: number;
    };
    expect(row.order_key).toBe('0000000099');
    expect(row.task_index).toBe(0);
    expect(row.title).toBe('Keep title');
    expect(row.description).toBe('Keep desc');
  });

  test('set_order swap applies without violating task_index uniqueness', () => {
    const projectId = getOrCreateProject(db, 'github.com__owner__repo').id;
    upsertPlan(db, projectId, {
      uuid: id('plan-swap-order'),
      planId: 11,
      tasks: [
        { uuid: id('task-first'), title: 'First', description: 'A', done: false },
        { uuid: id('task-second'), title: 'Second', description: 'B', done: false },
      ],
    });

    const moveFirstAfter = makeOp(
      'remote-a',
      { physicalMs: Date.now() + 1_000_000, logical: 0 },
      1,
      'plan_task',
      id('task-first'),
      'set_order',
      { planUuid: id('plan-swap-order'), orderKey: '0000000001', taskIndex: 1 }
    );
    const moveSecondBefore = makeOp(
      'remote-a',
      { physicalMs: Date.now() + 1_000_001, logical: 0 },
      2,
      'plan_task',
      id('task-second'),
      'set_order',
      { planUuid: id('plan-swap-order'), orderKey: '0000000000', taskIndex: 0 }
    );

    const result = applyRemoteOps(db, [moveFirstAfter, moveSecondBefore]);
    expect(result.errors).toEqual([]);
    expect(
      db
        .prepare(
          'SELECT uuid, task_index, order_key FROM plan_task WHERE plan_uuid = ? ORDER BY task_index'
        )
        .all(id('plan-swap-order'))
    ).toEqual([
      { uuid: id('task-second'), task_index: 0, order_key: '0000000000' },
      { uuid: id('task-first'), task_index: 1, order_key: '0000000001' },
    ]);
  });

  test('planIdHint collision assigns a fresh numeric id', () => {
    const projectId = getOrCreateProject(db, 'github.com__owner__repo').id;
    upsertPlan(db, projectId, { uuid: id('plan-existing'), planId: 5 });

    const createOp = makeOp(
      'remote-a',
      { physicalMs: 1000, logical: 0 },
      1,
      'plan',
      id('plan-new-uuid'),
      'create',
      {
        projectIdentity: 'github.com__owner__repo',
        planIdHint: 5,
        fields: { title: 'New plan with colliding hint' },
      }
    );

    expect(applyRemoteOps(db, [createOp]).errors).toEqual([]);

    const newPlan = getPlanByUuid(db, id('plan-new-uuid'));
    expect(newPlan).not.toBeNull();
    // Must not reuse plan_id=5 (already taken by plan-existing)
    expect(newPlan?.plan_id).not.toBe(5);
    expect(newPlan?.plan_id).toBeGreaterThan(0);
    // Original plan must be untouched
    expect(getPlanByUuid(db, id('plan-existing'))?.plan_id).toBe(5);
  });

  test('same UUID created on two nodes merges by field clocks and exists once', () => {
    // Earlier HLC (800) from node-b, later HLC (1000) from node-a
    const createEarly = makeOp(
      'node-b',
      { physicalMs: 800, logical: 0 },
      1,
      'plan',
      id('plan-dual'),
      'create',
      {
        projectIdentity: 'github.com__owner__repo',
        planIdHint: 20,
        fields: { title: 'Early title', status: 'pending' },
      }
    );
    const createLate = makeOp(
      'node-a',
      { physicalMs: 1000, logical: 0 },
      1,
      'plan',
      id('plan-dual'),
      'create',
      {
        projectIdentity: 'github.com__owner__repo',
        planIdHint: 20,
        fields: { title: 'Late title', status: 'in_progress' },
      }
    );

    expect(applyRemoteOps(db, [createLate, createEarly]).errors).toEqual([]);

    // Plan must exist exactly once
    const count = (
      db.prepare('SELECT count(*) AS c FROM plan WHERE uuid = ?').get(id('plan-dual')) as {
        c: number;
      }
    ).c;
    expect(count).toBe(1);

    // Higher-HLC (1000) wins for both fields
    const plan = getPlanByUuid(db, id('plan-dual'));
    expect(plan?.title).toBe('Late title');
    expect(plan?.status).toBe('in_progress');
  });

  test('plan_review_issue round-trip: create, update, and delete ops applied correctly', async () => {
    const otherDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-sync-op-apply-ri-peer-'));
    const source = openDatabase(path.join(otherDir, DATABASE_FILENAME));
    try {
      const sourceProjectId = getOrCreateProject(source, 'github.com__owner__repo').id;
      upsertPlan(source, sourceProjectId, { uuid: id('plan-ri-rt'), planId: 30 });

      const issue = createReviewIssue(source, {
        planUuid: id('plan-ri-rt'),
        content: 'Found a bug',
        severity: 'major',
        category: 'bug',
      });

      // Apply source ops (create) to target
      const sourceOps = source
        .prepare('SELECT * FROM sync_op_log ORDER BY hlc_physical_ms, hlc_logical, local_counter')
        .all() as SyncOpRecord[];

      const result = applyRemoteOps(db, sourceOps);
      expect(result.errors).toEqual([]);

      const targetProjectId = getOrCreateProject(db, 'github.com__owner__repo').id;
      const issues = listReviewIssuesForPlan(db, id('plan-ri-rt'));
      expect(issues).toHaveLength(1);
      expect(issues[0]!.uuid).toBe(issue.uuid);
      expect(issues[0]!.content).toBe('Found a bug');
      expect(issues[0]!.severity).toBe('major');

      // Now delete the issue on source and sync again
      source
        .prepare('UPDATE plan_review_issue SET deleted_hlc = ?, updated_hlc = ? WHERE uuid = ?')
        .run('9999999999.00000001', '9999999999.00000001', issue.uuid);
      // Emit a delete op manually
      const deleteOp = makeOp(
        'remote-src',
        { physicalMs: 9999999999, logical: 1 },
        99,
        'plan_review_issue',
        issue.uuid,
        'delete',
        { planUuid: id('plan-ri-rt') }
      );

      const deleteResult = applyRemoteOps(db, [deleteOp]);
      expect(deleteResult.errors).toEqual([]);
      expect(listReviewIssuesForPlan(db, id('plan-ri-rt'))).toHaveLength(0);

      void targetProjectId;
    } finally {
      source.close(false);
      await fs.rm(otherDir, { recursive: true, force: true });
    }
  });

  test('plan delete op removes the plan row', () => {
    const projectId = getOrCreateProject(db, 'github.com__owner__repo').id;
    upsertPlan(db, projectId, { uuid: id('plan-to-delete'), planId: 40 });
    expect(getPlanByUuid(db, id('plan-to-delete'))).not.toBeNull();

    const deleteOp = makeOp(
      'remote-a',
      { physicalMs: 5000, logical: 0 },
      1,
      'plan',
      id('plan-to-delete'),
      'delete',
      {}
    );

    expect(applyRemoteOps(db, [deleteOp]).errors).toEqual([]);
    expect(getPlanByUuid(db, id('plan-to-delete'))).toBeNull();
  });

  test('plan delete + stale child op does not resurrect deleted task', () => {
    const projectId = getOrCreateProject(db, 'github.com__owner__repo').id;
    upsertPlan(db, projectId, {
      uuid: id('plan-cascade-res'),
      planId: 50,
      tasks: [
        { uuid: id('task-cascade-res'), title: 'Original', description: 'Desc', done: false },
      ],
    });

    // Capture a stale update op at T0 before the plan is deleted
    const staleUpdate = makeOp(
      'remote-b',
      { physicalMs: 1000, logical: 0 },
      1,
      'plan_task',
      id('task-cascade-res'),
      'update_fields',
      {
        planUuid: id('plan-cascade-res'),
        fields: { title: 'Stale resurrection attempt' },
      }
    );

    // Delete the plan locally at T1 (higher HLC) via deletePlan — tombstones children
    deletePlan(db, id('plan-cascade-res'));

    // Plan and task should be gone
    expect(getPlanByUuid(db, id('plan-cascade-res'))).toBeNull();
    expect(getPlanTasksByUuid(db, id('plan-cascade-res'))).toEqual([]);

    // Apply the stale T0 task update — must be skipped due to tombstone wall
    const result = applyRemoteOps(db, [staleUpdate]);
    expect(result.errors).toEqual([]);

    // Task must remain absent
    const taskRow = db
      .prepare('SELECT title, deleted_hlc FROM plan_task WHERE uuid = ?')
      .get(id('task-cascade-res')) as { title: string; deleted_hlc: string | null } | null;
    // Task row may exist with deleted_hlc set (tombstoned) but must not have updated title
    if (taskRow) {
      expect(taskRow.deleted_hlc).not.toBeNull();
      expect(taskRow.title).toBe('Original');
    }
  });

  test('plan tombstone is absolute: higher-HLC create does not resurrect deleted plan', () => {
    const projectId = getOrCreateProject(db, 'github.com__owner__repo').id;
    upsertPlan(db, projectId, { uuid: id('plan-no-resurrect'), planId: 51 });

    // Delete the plan via a remote op at T1
    const deleteOp = makeOp(
      'remote-a',
      { physicalMs: 5000, logical: 0 },
      1,
      'plan',
      id('plan-no-resurrect'),
      'delete',
      {}
    );
    expect(applyRemoteOps(db, [deleteOp]).errors).toEqual([]);
    expect(getPlanByUuid(db, id('plan-no-resurrect'))).toBeNull();

    // Receive a create op at T2 > T1 from another node
    const lateCreate = makeOp(
      'remote-b',
      { physicalMs: 9000, logical: 0 },
      1,
      'plan',
      id('plan-no-resurrect'),
      'create',
      {
        projectIdentity: 'github.com__owner__repo',
        planIdHint: 51,
        fields: { title: 'Resurrected — should not appear' },
      }
    );
    const result = applyRemoteOps(db, [lateCreate]);
    expect(result.errors).toEqual([]);

    // Plan must NOT be resurrected
    const count = (
      db.prepare('SELECT count(*) AS c FROM plan WHERE uuid = ?').get(id('plan-no-resurrect')) as {
        c: number;
      }
    ).c;
    expect(count).toBe(0);
  });

  test('reorder swap applies without UNIQUE violation and re-derives task_index', () => {
    const projectId = getOrCreateProject(db, 'github.com__owner__repo').id;
    upsertPlan(db, projectId, {
      uuid: id('plan-swap'),
      planId: 60,
      tasks: [
        { uuid: id('task-swap-a'), title: 'Task A', description: '', done: false },
        { uuid: id('task-swap-b'), title: 'Task B', description: '', done: false },
      ],
    });

    // Confirm initial state: A before B
    const before = db
      .prepare(
        'SELECT uuid, order_key, task_index FROM plan_task WHERE plan_uuid = ? ORDER BY task_index'
      )
      .all(id('plan-swap')) as Array<{ uuid: string; order_key: string; task_index: number }>;
    expect(before[0]!.uuid).toBe(id('task-swap-a'));
    expect(before[1]!.uuid).toBe(id('task-swap-b'));
    const aOrderKey = before[0]!.order_key;
    const bOrderKey = before[1]!.order_key;

    // Apply two set_order ops to swap order_keys
    const swapA = makeOp(
      'remote-a',
      { physicalMs: Date.now() + 10_000, logical: 0 },
      1,
      'plan_task',
      id('task-swap-a'),
      'set_order',
      { planUuid: id('plan-swap'), orderKey: bOrderKey }
    );
    const swapB = makeOp(
      'remote-a',
      { physicalMs: Date.now() + 10_000, logical: 1 },
      2,
      'plan_task',
      id('task-swap-b'),
      'set_order',
      { planUuid: id('plan-swap'), orderKey: aOrderKey }
    );

    const result = applyRemoteOps(db, [swapA, swapB]);
    expect(result.errors).toEqual([]);
    expect(result.applied).toBe(2);

    const rowA = db
      .prepare('SELECT order_key, task_index FROM plan_task WHERE uuid = ?')
      .get(id('task-swap-a')) as { order_key: string; task_index: number };
    const rowB = db
      .prepare('SELECT order_key, task_index FROM plan_task WHERE uuid = ?')
      .get(id('task-swap-b')) as { order_key: string; task_index: number };

    // order_keys should be swapped
    expect(rowA.order_key).toBe(bOrderKey);
    expect(rowB.order_key).toBe(aOrderKey);

    // task_index is re-derived from new order_key order: B now has lower order_key, so index 0
    expect(rowB.task_index).toBe(0);
    expect(rowA.task_index).toBe(1);
  });

  test('malformed plan_task op is deduped: only one op_log row even on re-apply', () => {
    const malformedOp = makeOp(
      'remote-a',
      { physicalMs: 2000, logical: 0 },
      1,
      'plan_task',
      id('task-malformed'),
      'update_fields',
      {
        // plan_uuid intentionally omitted
        fields: { title: 'should not land' },
      }
    );

    const first = applyRemoteOps(db, [malformedOp]);
    expect(first.errors).toEqual([]);
    expect(first.skipped).toHaveLength(1);
    expect(first.skipped[0]!.reason).toContain('plan_uuid');

    const second = applyRemoteOps(db, [malformedOp]);
    expect(second.errors).toEqual([]);
    // Second apply is deduped as 'already applied'
    expect(second.skipped).toHaveLength(1);
    expect(second.skipped[0]!.reason).toBe('already applied');

    const count = (
      db
        .prepare('SELECT count(*) AS c FROM sync_op_log WHERE op_id = ?')
        .get(malformedOp.op_id) as { c: number }
    ).c;
    expect(count).toBe(1);
  });

  test('invalid JSON payload is permanently skipped and deduped', () => {
    const badJsonOp = {
      ...makeOp(
        'remote-a',
        { physicalMs: 2500, logical: 0 },
        1,
        'plan_task',
        id('task-bad-json'),
        'update_fields',
        { fields: { title: 'ignored' } }
      ),
      payload: '{not json',
    };

    const first = applyRemoteOps(db, [badJsonOp]);
    expect(first.errors).toEqual([]);
    expect(first.skipped).toHaveLength(1);
    expect(first.skipped[0]).toMatchObject({
      opId: badJsonOp.op_id,
      kind: 'permanent',
    });

    expect(
      db.prepare('SELECT count(*) AS count FROM sync_op_log WHERE op_id = ?').get(badJsonOp.op_id)
    ).toEqual({ count: 1 });

    const second = applyRemoteOps(db, [badJsonOp]);
    expect(second.errors).toEqual([]);
    expect(second.skipped).toEqual([{ opId: badJsonOp.op_id, reason: 'already applied' }]);
  });

  test('plan update_fields with missing projectIdentity goes to skipped not errors', () => {
    const badOp = makeOp(
      'remote-a',
      { physicalMs: 3000, logical: 0 },
      1,
      'plan',
      id('plan-no-identity'),
      'update_fields',
      {
        // projectIdentity intentionally omitted
        planIdHint: 99,
        fields: { title: 'should be skipped' },
      }
    );

    const result = applyRemoteOps(db, [badOp]);
    expect(result.errors).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toContain('projectIdentity');

    // op_log row must still be persisted for dedup
    const count = (
      db.prepare('SELECT count(*) AS c FROM sync_op_log WHERE op_id = ?').get(badOp.op_id) as {
        c: number;
      }
    ).c;
    expect(count).toBe(1);
  });

  test('remote plan delete op cascades tombstones to all child entity types', () => {
    const projectId = getOrCreateProject(db, 'github.com__owner__repo').id;
    upsertPlan(db, projectId, { uuid: id('plan-dep-src'), planId: 70 });
    upsertPlan(db, projectId, {
      uuid: id('plan-cascade-all'),
      planId: 71,
      tasks: [{ uuid: id('task-cascade-all'), title: 'T', description: '', done: false }],
      dependencyUuids: [id('plan-dep-src')],
      tags: ['mytag'],
    });

    // Add a review issue and capture its UUID BEFORE the delete op
    const issue = createReviewIssue(db, {
      planUuid: id('plan-cascade-all'),
      content: 'Issue to cascade',
      severity: 'minor',
      category: 'quality',
    });
    const issueUuid = issue.uuid;

    // Apply a remote delete plan op
    const deleteOp = makeOp(
      'remote-a',
      { physicalMs: Date.now() + 50_000, logical: 0 },
      1,
      'plan',
      id('plan-cascade-all'),
      'delete',
      {}
    );
    const result = applyRemoteOps(db, [deleteOp]);
    expect(result.errors).toEqual([]);

    function hasSyncTombstone(entityType: string, entityId: string): boolean {
      const row = db
        .prepare('SELECT 1 AS present FROM sync_tombstone WHERE entity_type = ? AND entity_id = ?')
        .get(entityType, entityId) as { present: number } | null;
      return row !== null;
    }

    // Plan itself must be tombstoned
    expect(hasSyncTombstone('plan', id('plan-cascade-all'))).toBe(true);

    // Task must be tombstoned
    expect(hasSyncTombstone('plan_task', id('task-cascade-all'))).toBe(true);

    // Review issue must be tombstoned
    expect(hasSyncTombstone('plan_review_issue', issueUuid)).toBe(true);

    expect(
      edgeClockIsPresent(
        getEdgeClock(db, 'plan_dependency', `${id('plan-cascade-all')}->${id('plan-dep-src')}`)
      )
    ).toBe(false);
    expect(
      edgeClockIsPresent(getEdgeClock(db, 'plan_tag', `${id('plan-cascade-all')}#mytag`))
    ).toBe(false);
  });

  test('stale add_edge for tombstoned plan is skipped, op_log row persists for dedup', () => {
    const projectId = getOrCreateProject(db, 'github.com__owner__repo').id;
    upsertPlan(db, projectId, { uuid: id('plan-edge-deleted'), planId: 90 });
    deletePlan(db, id('plan-edge-deleted'));
    expect(getPlanByUuid(db, id('plan-edge-deleted'))).toBeNull();

    const staleDepAdd = makeOp(
      'remote-c',
      { physicalMs: Date.now() + 50_000, logical: 0 },
      1,
      'plan_dependency',
      `${id('plan-edge-deleted')}->${id('some-dep')}`,
      'add_edge',
      { planUuid: id('plan-edge-deleted'), dependsOnUuid: id('some-dep') }
    );
    const staleTagAdd = makeOp(
      'remote-c',
      { physicalMs: Date.now() + 50_001, logical: 0 },
      2,
      'plan_tag',
      `${id('plan-edge-deleted')}#feature`,
      'add_edge',
      { planUuid: id('plan-edge-deleted'), tag: 'feature' }
    );

    const result = applyRemoteOps(db, [staleDepAdd, staleTagAdd]);
    expect(result.errors).toEqual([]);
    expect(result.skipped.map((s) => s.opId).sort()).toEqual(
      [staleDepAdd.op_id, staleTagAdd.op_id].sort()
    );

    // Both op_log rows must persist for dedup
    expect(
      db.prepare('SELECT count(*) AS count FROM sync_op_log WHERE op_id = ?').get(staleDepAdd.op_id)
    ).toEqual({ count: 1 });
    expect(
      db.prepare('SELECT count(*) AS count FROM sync_op_log WHERE op_id = ?').get(staleTagAdd.op_id)
    ).toEqual({ count: 1 });

    // Re-apply: dedup hit (already applied), no errors
    const reResult = applyRemoteOps(db, [staleDepAdd, staleTagAdd]);
    expect(reResult.errors).toEqual([]);
    expect(reResult.applied).toBe(0);
  });

  test('add_edge for non-existent (non-tombstoned) parent plan is deferred without FK throw', () => {
    const projectId = getOrCreateProject(db, 'github.com__owner__repo').id;
    upsertPlan(db, projectId, { uuid: id('plan-existing-edge'), planId: 95 });

    // Reference a parent plan UUID that has no row and no tombstone
    const badDep = makeOp(
      'remote-e',
      { physicalMs: Date.now() + 70_000, logical: 0 },
      1,
      'plan_dependency',
      `${id('plan-missing')}->${id('plan-existing-edge')}`,
      'add_edge',
      { planUuid: id('plan-missing'), dependsOnUuid: id('plan-existing-edge') }
    );
    const badTag = makeOp(
      'remote-e',
      { physicalMs: Date.now() + 70_001, logical: 0 },
      2,
      'plan_tag',
      `${id('plan-missing')}#x`,
      'add_edge',
      { planUuid: id('plan-missing'), tag: 'x' }
    );

    const result = applyRemoteOps(db, [badDep, badTag]);
    expect(result.errors).toEqual([]);
    expect(result.skipped).toHaveLength(2);
    expect(result.skipped.every((skip) => skip.kind === 'deferred')).toBe(true);
    expect(
      db.prepare('SELECT count(*) AS count FROM sync_op_log WHERE op_id = ?').get(badDep.op_id)
    ).toEqual({ count: 0 });
    expect(
      db.prepare('SELECT count(*) AS count FROM sync_op_log WHERE op_id = ?').get(badTag.op_id)
    ).toEqual({ count: 0 });
  });

  test('set_order arriving before task create is skipped and does not poison field clock', () => {
    const projectId = getOrCreateProject(db, 'github.com__owner__repo').id;
    upsertPlan(db, projectId, { uuid: id('plan-order-race'), planId: 96 });

    const setOrderEarly = makeOp(
      'remote-f',
      { physicalMs: Date.now() + 80_000, logical: 0 },
      1,
      'plan_task',
      id('task-order-race'),
      'set_order',
      { planUuid: id('plan-order-race'), orderKey: '0000000099', taskIndex: 99 }
    );

    const result = applyRemoteOps(db, [setOrderEarly]);
    expect(result.errors).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.kind).toBe('deferred');

    // No field clock written for order_key — later create can apply its own order_key
    const clock = db
      .prepare(
        'SELECT * FROM sync_field_clock WHERE entity_type = ? AND entity_id = ? AND field_name = ?'
      )
      .get('plan_task', id('task-order-race'), 'order_key');
    expect(clock).toBeNull();

    // Deferred skips roll back the op_log row so the original op can be retried.
    expect(
      db
        .prepare('SELECT count(*) AS count FROM sync_op_log WHERE op_id = ?')
        .get(setOrderEarly.op_id)
    ).toEqual({ count: 0 });
  });

  test('deferred high-HLC set_order advances local clock so later local task order wins on retry', () => {
    const projectId = getOrCreateProject(db, 'github.com__owner__repo').id;
    upsertPlan(db, projectId, { uuid: id('plan-deferred-hlc-order'), planId: 97 });

    const remotePhysical = Date.now() + 120_000;
    const deferredSetOrder = makeOp(
      'remote-hlc',
      { physicalMs: remotePhysical, logical: 0 },
      1,
      'plan_task',
      id('task-deferred-hlc'),
      'set_order',
      { planUuid: id('plan-deferred-hlc-order'), orderKey: '0000000099', taskIndex: 99 }
    );

    const deferResult = applyRemoteOps(db, [deferredSetOrder]);
    expect(deferResult.errors).toEqual([]);
    expect(deferResult.skipped).toEqual([
      {
        opId: deferredSetOrder.op_id,
        reason: `plan_task set_order arrived before task ${id('task-deferred-hlc')} create`,
        kind: 'deferred',
      },
    ]);

    const observedClock = db
      .prepare('SELECT physical_ms, logical FROM sync_clock WHERE id = 1')
      .get() as { physical_ms: number; logical: number };
    expect(observedClock).toEqual({ physical_ms: remotePhysical, logical: 1 });

    upsertPlan(db, projectId, {
      uuid: id('plan-deferred-hlc-order'),
      planId: 97,
      tasks: [
        {
          uuid: id('task-deferred-hlc'),
          orderKey: '0000000000',
          title: 'Local task',
          description: 'Created after deferred remote op',
          done: false,
        },
      ],
    });

    const localOrderClock = db
      .prepare(
        'SELECT hlc_physical_ms, hlc_logical FROM sync_field_clock WHERE entity_type = ? AND entity_id = ? AND field_name = ?'
      )
      .get('plan_task', id('task-deferred-hlc'), 'order_key') as {
      hlc_physical_ms: number;
      hlc_logical: number;
    };
    expect(localOrderClock.hlc_physical_ms).toBe(remotePhysical);
    expect(localOrderClock.hlc_logical).toBeGreaterThan(0);

    const retryResult = applyRemoteOps(db, [deferredSetOrder]);
    expect(retryResult.errors).toEqual([]);
    expect(retryResult.skipped).toEqual([]);
    expect(retryResult.applied).toBe(1);

    const task = db
      .prepare('SELECT order_key, task_index FROM plan_task WHERE uuid = ?')
      .get(id('task-deferred-hlc')) as { order_key: string; task_index: number };
    expect(task).toEqual({ order_key: '0000000000', task_index: 0 });
  });

  test('add_edge with missing payload fields routes to skipped without throwing', () => {
    const projectId = getOrCreateProject(db, 'github.com__owner__repo').id;
    upsertPlan(db, projectId, { uuid: id('plan-bad-edge'), planId: 91 });

    const badDep = makeOp(
      'remote-d',
      { physicalMs: Date.now() + 60_000, logical: 0 },
      1,
      'plan_dependency',
      `${id('plan-bad-edge')}->${id('missing-dep')}`,
      'add_edge',
      { planUuid: id('plan-bad-edge') } // missing dependsOnUuid
    );
    const badTag = makeOp(
      'remote-d',
      { physicalMs: Date.now() + 60_001, logical: 0 },
      2,
      'plan_tag',
      `${id('plan-bad-edge')}#missing`,
      'add_edge',
      { planUuid: id('plan-bad-edge') } // missing tag
    );

    const result = applyRemoteOps(db, [badDep, badTag]);
    expect(result.errors).toEqual([]);
    expect(result.skipped).toHaveLength(2);
    expect(
      db.prepare('SELECT count(*) AS count FROM sync_op_log WHERE op_id = ?').get(badDep.op_id)
    ).toEqual({ count: 1 });
    expect(
      db.prepare('SELECT count(*) AS count FROM sync_op_log WHERE op_id = ?').get(badTag.op_id)
    ).toEqual({ count: 1 });
  });
});
