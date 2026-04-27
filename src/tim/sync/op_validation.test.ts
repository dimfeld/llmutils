import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';

import { getOrCreateProject } from '../db/project.js';
import { appendPlanTask, upsertPlan } from '../db/plan.js';
import { openDatabase } from '../db/database.js';
import { bootstrapSyncMetadata } from './bootstrap.js';
import { formatHlc, formatOpId, type Hlc } from './hlc.js';
import { getLocalNodeId } from './node_identity.js';
import { applyRemoteOps, type SyncOpRecord } from './op_apply.js';
import {
  HLC_MAX_FUTURE_SKEW_MS,
  HLC_MIN_PHYSICAL_MS,
  validateOpEnvelope,
} from './op_validation.js';

function makeOp(overrides: Partial<SyncOpRecord> = {}): SyncOpRecord {
  const nodeId = overrides.node_id ?? randomUUID();
  const hlc: Hlc = {
    physicalMs: overrides.hlc_physical_ms ?? Date.now(),
    logical: overrides.hlc_logical ?? 0,
  };
  const localCounter = overrides.local_counter ?? 1;
  const entityId = overrides.entity_id ?? randomUUID();
  return {
    op_id: overrides.op_id ?? formatOpId(hlc, nodeId, localCounter),
    node_id: nodeId,
    hlc_physical_ms: hlc.physicalMs,
    hlc_logical: hlc.logical,
    local_counter: localCounter,
    entity_type: overrides.entity_type ?? 'plan',
    entity_id: entityId,
    op_type: overrides.op_type ?? 'create',
    payload:
      overrides.payload ??
      JSON.stringify({
        projectIdentity: 'github.com__owner__repo',
        planIdHint: 1,
        fields: { title: 'Remote title' },
      }),
    base: overrides.base ?? null,
    seq: overrides.seq,
    created_at: overrides.created_at,
  };
}

describe('sync op envelope validation', () => {
  let db: Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  afterEach(() => {
    db.close(false);
  });

  function expectPermanentSkip(op: SyncOpRecord, reason: RegExp | string): void {
    const result = applyRemoteOps(db, [op]);
    expect(result.errors).toEqual([]);
    expect(result.applied).toBe(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ opId: op.op_id, kind: 'permanent' });
    expect(result.skipped[0]?.reason).toEqual(expect.stringMatching(reason));
    expect(
      db.prepare('SELECT count(*) AS count FROM sync_op_log WHERE op_id = ?').get(op.op_id)
    ).toEqual({ count: 1 });
    expect(db.prepare('SELECT uuid FROM plan WHERE uuid = ?').get(op.entity_id)).toBeNull();
  }

  test('rejects op_id shapes and component mismatches as permanent skips', () => {
    expectPermanentSkip(makeOp({ op_id: 'not-canonical' }), /op_id/);

    const nodeId = randomUUID();
    const otherNodeId = randomUUID();
    const hlc = { physicalMs: Date.now(), logical: 0 };
    expectPermanentSkip(
      makeOp({
        node_id: nodeId,
        op_id: formatOpId(hlc, otherNodeId, 1),
        hlc_physical_ms: hlc.physicalMs,
        hlc_logical: hlc.logical,
      }),
      /node_id does not match/
    );

    expectPermanentSkip(
      makeOp({
        node_id: nodeId,
        op_id: formatOpId({ physicalMs: hlc.physicalMs + 1, logical: 0 }, nodeId, 1),
        hlc_physical_ms: hlc.physicalMs,
        hlc_logical: hlc.logical,
      }),
      /HLC does not match/
    );

    expectPermanentSkip(
      makeOp({
        node_id: nodeId,
        op_id: formatOpId(hlc, nodeId, 2),
        hlc_physical_ms: hlc.physicalMs,
        hlc_logical: hlc.logical,
        local_counter: 1,
      }),
      /local_counter does not match/
    );
  });

  test('rejects invalid node, HLC, local counter, entity type, entity id, and payload identity', () => {
    const hlc = { physicalMs: Date.now(), logical: 0 };
    expectPermanentSkip(
      makeOp({
        node_id: 'not-a-uuid',
        op_id: formatOpId(hlc, 'not-a-uuid', 1),
        hlc_physical_ms: hlc.physicalMs,
        hlc_logical: hlc.logical,
      }),
      /node_id is not a valid sync node id/
    );

    const counterNodeId = randomUUID();
    expectPermanentSkip(
      makeOp({
        node_id: counterNodeId,
        local_counter: -1,
        op_id: `${formatHlc(hlc)}/${counterNodeId}/-1`,
        hlc_physical_ms: hlc.physicalMs,
        hlc_logical: hlc.logical,
      }),
      /local_counter/
    );

    expectPermanentSkip(makeOp({ entity_type: 'future_entity' }), /unsupported entity_type/);
    expectPermanentSkip(makeOp({ entity_id: 'bad id with spaces' }), /entity_id/);
    expectPermanentSkip(
      makeOp({
        entity_type: 'plan_dependency',
        entity_id: `${randomUUID()}->${randomUUID()}`,
        op_type: 'add_edge',
        payload: JSON.stringify({ planUuid: randomUUID(), dependsOnUuid: randomUUID() }),
      }),
      /payload identity contradicts/
    );
  });

  test('rejects HLC values outside canonical width and sanity bounds', () => {
    const nodeId = randomUUID();
    expectPermanentSkip(
      makeOp({
        node_id: nodeId,
        op_id: `123.00000000/${nodeId}/1`,
        hlc_physical_ms: 123,
        hlc_logical: 0,
      }),
      /malformed HLC/
    );

    const oldHlc = { physicalMs: HLC_MIN_PHYSICAL_MS - 1, logical: 0 };
    expectPermanentSkip(
      makeOp({
        node_id: nodeId,
        op_id: formatOpId(oldHlc, nodeId, 2),
        hlc_physical_ms: oldHlc.physicalMs,
        hlc_logical: oldHlc.logical,
        local_counter: 2,
      }),
      /before lower bound/
    );

    const futureHlc = { physicalMs: Date.now() + HLC_MAX_FUTURE_SKEW_MS + 60_000, logical: 0 };
    expectPermanentSkip(
      makeOp({
        node_id: nodeId,
        op_id: formatOpId(futureHlc, nodeId, 3),
        hlc_physical_ms: futureHlc.physicalMs,
        hlc_logical: futureHlc.logical,
        local_counter: 3,
      }),
      /future skew/
    );
  });

  test('bootstrap synthetic operations pass validation', () => {
    const projectId = getOrCreateProject(db, 'github.com__owner__repo').id;
    const parentUuid = randomUUID();
    const childUuid = randomUUID();
    const dependencyUuid = randomUUID();
    upsertPlan(db, projectId, {
      uuid: childUuid,
      planId: 1,
      title: 'Child',
      parentUuid,
    });
    upsertPlan(db, projectId, {
      uuid: parentUuid,
      planId: 2,
      title: 'Parent',
    });
    upsertPlan(db, projectId, {
      uuid: dependencyUuid,
      planId: 3,
      title: 'Dependency',
    });
    appendPlanTask(db, childUuid, { uuid: randomUUID(), title: 'Task', description: 'Desc' });
    db.prepare('INSERT INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES (?, ?)').run(
      childUuid,
      dependencyUuid
    );
    db.prepare('INSERT INTO plan_tag (plan_uuid, tag) VALUES (?, ?)').run(childUuid, 'sync-tag');

    db.prepare('DELETE FROM sync_op_log').run();
    const stats = bootstrapSyncMetadata(db, { force: true });
    expect(stats.syntheticOpsInserted).toBeGreaterThan(0);

    const ops = db.prepare('SELECT * FROM sync_op_log ORDER BY seq').all() as SyncOpRecord[];
    expect(ops.length).toBeGreaterThan(0);
    for (const op of ops) {
      expect(validateOpEnvelope(op)).toEqual({ ok: true });
    }
    expect(ops.some((op) => op.entity_type === 'plan_dependency')).toBe(true);
    expect(ops.some((op) => op.entity_type === 'plan_tag')).toBe(true);
    expect(getLocalNodeId(db)).toBeTruthy();
  });
});
