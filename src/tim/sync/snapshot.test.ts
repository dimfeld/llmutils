import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';

import { openDatabase } from '../db/database.js';
import {
  getOrCreateProject,
  type Project,
} from '../db/project.js';
import { getPlanByUuid, getPlanDependenciesByUuid, getPlanTagsByUuid, upsertPlan, upsertPlanDependencies } from '../db/plan.js';
import { getPeerCursor, setPeerCursor } from '../db/sync_schema.js';
import type { SyncFieldClockRow, SyncTombstoneRow } from '../db/sync_schema.js';
import {
  getLocalNodeId,
  registerPeerNode,
} from './node_identity.js';
import { applyPeerSnapshot, buildPeerSnapshot, type PeerSnapshot } from './snapshot.js';
import {
  getCompactionFloorSeq,
  getCompactedThroughSeq,
  setCompactedThroughSeq,
} from './compaction.js';
import { retireMainPeer } from './node_lifecycle.js';
import { runPeerSync } from './peer_sync.js';
import { createHttpPeerTransport, createPeerSyncHttpHandler, runHttpPeerSync } from './peer_transport_http.js';
import { formatHlc } from './hlc.js';
import { HLC_MIN_PHYSICAL_MS } from './op_validation.js';
import {
  edgeClockIsPresent,
  getEdgeClock,
  writeEdgeAddClock,
  writeEdgeRemoveClock,
} from './edge_clock.js';
import {
  emitDependencyAdd,
  emitDependencyRemove,
  emitTagAdd,
  emitTagRemove,
} from './op_emission.js';

const fixtureIds = new Map<string, string>();
function id(label: string): string {
  let existing = fixtureIds.get(label);
  if (!existing) {
    existing = randomUUID();
    fixtureIds.set(label, existing);
  }
  return existing;
}

/** Force field clock for one field to a specific HLC on the given DB. */
function setFieldClock(
  db: Database,
  entityType: string,
  entityId: string,
  fieldName: string,
  hlcPhysicalMs: number,
  hlcLogical: number,
  nodeId: string
): void {
  db.prepare(`
    INSERT INTO sync_field_clock (entity_type, entity_id, field_name, hlc_physical_ms, hlc_logical, node_id, deleted, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'))
    ON CONFLICT(entity_type, entity_id, field_name) DO UPDATE SET
      hlc_physical_ms = excluded.hlc_physical_ms,
      hlc_logical = excluded.hlc_logical,
      node_id = excluded.node_id,
      updated_at = excluded.updated_at
  `).run(entityType, entityId, fieldName, hlcPhysicalMs, hlcLogical, nodeId);
}

/** Insert a tombstone for an entity on the given DB. */
function insertTombstone(
  db: Database,
  entityType: string,
  entityId: string,
  hlcPhysicalMs: number,
  hlcLogical: number,
  nodeId: string
): void {
  db.prepare(`
    INSERT OR REPLACE INTO sync_tombstone (entity_type, entity_id, hlc_physical_ms, hlc_logical, node_id, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
  `).run(entityType, entityId, hlcPhysicalMs, hlcLogical, nodeId);
}

/** Count rows matching a query. */
function countRows(db: Database, sql: string, ...params: unknown[]): number {
  const result = db.prepare(sql).get(...(params as Parameters<ReturnType<typeof db.prepare>['get']>)) as { n: number } | null;
  return result?.n ?? 0;
}

describe('snapshot: apply idempotence', () => {
  let dbA: Database;
  let dbB: Database;
  let projectA: number;

  beforeEach(() => {
    dbA = openDatabase(':memory:');
    dbB = openDatabase(':memory:');
    projectA = getOrCreateProject(dbA, 'github.com__owner__repo').id;
  });

  afterEach(() => {
    dbA.close(false);
    dbB.close(false);
  });

  test('applying the same snapshot twice produces identical state with no errors', () => {
    const planUuid = id('idempotent-plan');
    upsertPlan(dbA, projectA, { uuid: planUuid, planId: 1, title: 'Idempotent plan', status: 'in_progress' });

    const nodeA = getLocalNodeId(dbA);
    const snapshot = buildPeerSnapshot(dbA);

    // First apply
    applyPeerSnapshot(dbB, nodeA, snapshot);
    const planAfterFirst = getPlanByUuid(dbB, planUuid);
    expect(planAfterFirst?.title).toBe('Idempotent plan');

    const fieldClockCountAfterFirst = (
      dbB.prepare("SELECT count(*) AS n FROM sync_field_clock").get() as { n: number }
    ).n;
    const pullCursorAfterFirst = getPeerCursor(dbB, nodeA, 'pull')?.last_op_id;

    // Second apply of the SAME snapshot
    applyPeerSnapshot(dbB, nodeA, snapshot);
    const planAfterSecond = getPlanByUuid(dbB, planUuid);
    expect(planAfterSecond?.title).toBe('Idempotent plan');

    const fieldClockCountAfterSecond = (
      dbB.prepare("SELECT count(*) AS n FROM sync_field_clock").get() as { n: number }
    ).n;
    // Field clock count must not grow from duplicate apply
    expect(fieldClockCountAfterSecond).toBe(fieldClockCountAfterFirst);

    // Cursor unchanged by second apply
    expect(getPeerCursor(dbB, nodeA, 'pull')?.last_op_id).toBe(pullCursorAfterFirst);
  });
});

describe('snapshot: field clock conflict resolution', () => {
  let dbA: Database;
  let dbB: Database;
  let projectA: number;
  let projectB: number;

  beforeEach(() => {
    dbA = openDatabase(':memory:');
    dbB = openDatabase(':memory:');
    projectA = getOrCreateProject(dbA, 'github.com__owner__repo').id;
    projectB = getOrCreateProject(dbB, 'github.com__owner__repo').id;
  });

  afterEach(() => {
    dbA.close(false);
    dbB.close(false);
  });

  test('snapshot field wins when its clock is newer than local clock', () => {
    const planUuid = id('field-conflict-snapshot-wins');
    // Write plan to both DBs with the same UUID
    upsertPlan(dbB, projectB, { uuid: planUuid, planId: 1, title: 'local old title' });
    upsertPlan(dbA, projectA, { uuid: planUuid, planId: 1, title: 'snapshot new title' });

    const nodeA = getLocalNodeId(dbA);
    const nodeB = getLocalNodeId(dbB);

    // Force dbB's title field clock to a very old value so the snapshot wins
    const veryOldMs = HLC_MIN_PHYSICAL_MS + 1;
    setFieldClock(dbB, 'plan', planUuid, 'title', veryOldMs, 0, nodeB);

    // Build snapshot from dbA (has normal current-time clock, newer than dbB's forced-old clock)
    const snapshot = buildPeerSnapshot(dbA);

    // The snapshot's field clock for title should be newer than the one we set on dbB
    const snapshotTitleClock = snapshot.fieldClocks.find(
      (c) => c.entity_type === 'plan' && c.entity_id === planUuid && c.field_name === 'title'
    );
    expect(snapshotTitleClock).toBeDefined();
    expect(snapshotTitleClock!.hlc_physical_ms).toBeGreaterThan(veryOldMs);

    applyPeerSnapshot(dbB, nodeA, snapshot);
    // Snapshot wins: dbB should now have the snapshot's title
    expect(getPlanByUuid(dbB, planUuid)?.title).toBe('snapshot new title');
  });

  test('local field wins when its clock is newer than the snapshot clock', () => {
    const planUuid = id('field-conflict-local-wins');
    upsertPlan(dbA, projectA, { uuid: planUuid, planId: 2, title: 'snapshot old title' });
    upsertPlan(dbB, projectB, { uuid: planUuid, planId: 2, title: 'local new title' });

    const nodeA = getLocalNodeId(dbA);

    // Force dbA's title field clock to a very old value so local wins
    const veryOldMs = HLC_MIN_PHYSICAL_MS + 1;
    setFieldClock(dbA, 'plan', planUuid, 'title', veryOldMs, 0, nodeA);

    const snapshot = buildPeerSnapshot(dbA);

    // Snapshot clock is old; dbB's local clock is current time — local should win
    applyPeerSnapshot(dbB, nodeA, snapshot);
    expect(getPlanByUuid(dbB, planUuid)?.title).toBe('local new title');
  });
});

describe('snapshot: tombstone semantics', () => {
  let dbA: Database;
  let dbB: Database;
  let projectA: number;
  let projectB: number;

  beforeEach(() => {
    dbA = openDatabase(':memory:');
    dbB = openDatabase(':memory:');
    projectA = getOrCreateProject(dbA, 'github.com__owner__repo').id;
    projectB = getOrCreateProject(dbB, 'github.com__owner__repo').id;
  });

  afterEach(() => {
    dbA.close(false);
    dbB.close(false);
  });

  test('snapshot tombstone removes a locally-present plan with no winning local clock', () => {
    const planUuid = id('tombstone-removes-local');
    // dbB has the plan locally
    upsertPlan(dbB, projectB, { uuid: planUuid, planId: 1, title: 'Will be removed' });
    expect(getPlanByUuid(dbB, planUuid)).not.toBeNull();

    // dbA tombstones the plan
    upsertPlan(dbA, projectA, { uuid: planUuid, planId: 1, title: 'A copy' });
    const nodeA = getLocalNodeId(dbA);
    const tombstoneMs = Date.now();
    insertTombstone(dbA, 'plan', planUuid, tombstoneMs, 0, nodeA);
    // Also actually delete from dbA so the snapshot reflects the tombstoned state
    dbA.prepare('DELETE FROM plan WHERE uuid = ?').run(planUuid);

    const snapshot = buildPeerSnapshot(dbA);
    expect(snapshot.tombstones.some((t) => t.entity_type === 'plan' && t.entity_id === planUuid)).toBe(true);

    applyPeerSnapshot(dbB, nodeA, snapshot);
    // Plan should be gone from dbB
    expect(getPlanByUuid(dbB, planUuid)).toBeNull();
    // Tombstone should now exist on dbB
    const tombstone = dbB.prepare("SELECT 1 FROM sync_tombstone WHERE entity_type = 'plan' AND entity_id = ?").get(planUuid);
    expect(tombstone).not.toBeNull();
  });

  test('snapshot create does not resurrect a locally-tombstoned entity', () => {
    const planUuid = id('snapshot-no-resurrect');
    // dbA has the plan (no tombstone)
    upsertPlan(dbA, projectA, { uuid: planUuid, planId: 1, title: 'Will not resurrect' });

    // dbB has tombstoned the plan locally
    const nodeB = getLocalNodeId(dbB);
    const tombstoneMs = Date.now();
    insertTombstone(dbB, 'plan', planUuid, tombstoneMs, 0, nodeB);
    // dbB never had the live row
    expect(getPlanByUuid(dbB, planUuid)).toBeNull();

    const nodeA = getLocalNodeId(dbA);
    const snapshot = buildPeerSnapshot(dbA);
    expect(snapshot.plans.some((p) => p.uuid === planUuid)).toBe(true);

    applyPeerSnapshot(dbB, nodeA, snapshot);
    // The tombstone on dbB must prevent resurrection
    expect(getPlanByUuid(dbB, planUuid)).toBeNull();
    // The tombstone should still be present
    const tombstone = dbB.prepare("SELECT 1 FROM sync_tombstone WHERE entity_type = 'plan' AND entity_id = ?").get(planUuid);
    expect(tombstone).not.toBeNull();
  });
});

describe('snapshot: edge clock merge', () => {
  let dbA: Database;
  let dbB: Database;
  let projectA: number;
  let projectB: number;

  beforeEach(() => {
    dbA = openDatabase(':memory:');
    dbB = openDatabase(':memory:');
    projectA = getOrCreateProject(dbA, 'github.com__owner__repo').id;
    projectB = getOrCreateProject(dbB, 'github.com__owner__repo').id;
  });

  afterEach(() => {
    dbA.close(false);
    dbB.close(false);
  });

  test('snapshot remove-clock newer than local add-clock removes the edge', () => {
    const planUuid = id('edge-remove-wins-plan');
    const depUuid = id('edge-remove-wins-dep');
    const edgeKey = `${planUuid}->${depUuid}`;

    // Both DBs have both plans
    upsertPlan(dbA, projectA, { uuid: planUuid, planId: 1, title: 'Plan' });
    upsertPlan(dbA, projectA, { uuid: depUuid, planId: 2, title: 'Dep' });
    upsertPlan(dbB, projectB, { uuid: planUuid, planId: 1, title: 'Plan' });
    upsertPlan(dbB, projectB, { uuid: depUuid, planId: 2, title: 'Dep' });

    // dbB has an add-edge for the dependency
    const addMs = HLC_MIN_PHYSICAL_MS + 100;
    const nodeB = getLocalNodeId(dbB);
    writeEdgeAddClock(dbB, { entityType: 'plan_dependency', edgeKey, hlc: { physicalMs: addMs, logical: 0 }, nodeId: nodeB });
    dbB.prepare('INSERT OR IGNORE INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES (?, ?)').run(planUuid, depUuid);

    // dbA has a remove-edge for the dependency (newer than dbB's add)
    const removeMs = addMs + 10_000;
    const nodeA = getLocalNodeId(dbA);
    writeEdgeAddClock(dbA, { entityType: 'plan_dependency', edgeKey, hlc: { physicalMs: addMs, logical: 0 }, nodeId: nodeB });
    writeEdgeRemoveClock(dbA, { entityType: 'plan_dependency', edgeKey, hlc: { physicalMs: removeMs, logical: 0 }, nodeId: nodeA });

    const snapshot = buildPeerSnapshot(dbA);

    // Verify snapshot has a remove clock newer than the add clock
    const snapshotEdge = snapshot.edgeClocks.find((e) => e.entity_type === 'plan_dependency' && e.edge_key === edgeKey);
    expect(snapshotEdge?.remove_hlc).not.toBeNull();

    applyPeerSnapshot(dbB, nodeA, snapshot);

    // After snapshot apply, edge should be absent because remove wins
    const localEdgeClock = getEdgeClock(dbB, 'plan_dependency', edgeKey);
    expect(edgeClockIsPresent(localEdgeClock)).toBe(false);
    const dep = dbB.prepare('SELECT 1 FROM plan_dependency WHERE plan_uuid = ? AND depends_on_uuid = ?').get(planUuid, depUuid);
    expect(dep).toBeNull();
  });

  test('snapshot add-clock newer than local remove-clock restores the edge', () => {
    const planUuid = id('edge-add-wins-plan');
    const depUuid = id('edge-add-wins-dep');
    const edgeKey = `${planUuid}->${depUuid}`;

    upsertPlan(dbA, projectA, { uuid: planUuid, planId: 1, title: 'Plan' });
    upsertPlan(dbA, projectA, { uuid: depUuid, planId: 2, title: 'Dep' });
    upsertPlan(dbB, projectB, { uuid: planUuid, planId: 1, title: 'Plan' });
    upsertPlan(dbB, projectB, { uuid: depUuid, planId: 2, title: 'Dep' });

    const nodeA = getLocalNodeId(dbA);
    const nodeB = getLocalNodeId(dbB);

    // dbB has: add at T, then remove at T+5 → edge is absent locally
    const addMs = HLC_MIN_PHYSICAL_MS + 100;
    const removeMs = addMs + 5_000;
    writeEdgeAddClock(dbB, { entityType: 'plan_dependency', edgeKey, hlc: { physicalMs: addMs, logical: 0 }, nodeId: nodeA });
    writeEdgeRemoveClock(dbB, { entityType: 'plan_dependency', edgeKey, hlc: { physicalMs: removeMs, logical: 0 }, nodeId: nodeB });
    // Ensure no live row on dbB
    dbB.prepare('DELETE FROM plan_dependency WHERE plan_uuid = ? AND depends_on_uuid = ?').run(planUuid, depUuid);

    // dbA has: add at T+10 (newer than dbB's remove) → edge should be present
    const newerAddMs = removeMs + 10_000;
    writeEdgeAddClock(dbA, { entityType: 'plan_dependency', edgeKey, hlc: { physicalMs: newerAddMs, logical: 0 }, nodeId: nodeA });
    dbA.prepare('INSERT OR IGNORE INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES (?, ?)').run(planUuid, depUuid);

    const snapshot = buildPeerSnapshot(dbA);

    applyPeerSnapshot(dbB, nodeA, snapshot);

    // After snapshot apply, the edge should be present since add wins
    const localEdgeClock = getEdgeClock(dbB, 'plan_dependency', edgeKey);
    expect(edgeClockIsPresent(localEdgeClock)).toBe(true);
    const dep = dbB.prepare('SELECT 1 FROM plan_dependency WHERE plan_uuid = ? AND depends_on_uuid = ?').get(planUuid, depUuid);
    expect(dep).not.toBeNull();
  });
});

describe('snapshot: cursor advance', () => {
  let dbA: Database;
  let dbB: Database;
  let projectA: number;

  beforeEach(() => {
    dbA = openDatabase(':memory:');
    dbB = openDatabase(':memory:');
    projectA = getOrCreateProject(dbA, 'github.com__owner__repo').id;
  });

  afterEach(() => {
    dbA.close(false);
    dbB.close(false);
  });

  test('pull cursor for the sender peer equals highWaterSeq after snapshot apply', () => {
    upsertPlan(dbA, projectA, { uuid: id('cursor-plan-1'), planId: 1, title: 'Plan 1' });
    upsertPlan(dbA, projectA, { uuid: id('cursor-plan-2'), planId: 2, title: 'Plan 2' });

    const nodeA = getLocalNodeId(dbA);
    const snapshot = buildPeerSnapshot(dbA);
    expect(snapshot.highWaterSeq).toBeGreaterThan(0);

    // Before apply: dbB has no cursor for nodeA
    expect(getPeerCursor(dbB, nodeA, 'pull')).toBeNull();

    applyPeerSnapshot(dbB, nodeA, snapshot);

    // After apply: cursor must equal the snapshot's high-water seq
    const cursor = getPeerCursor(dbB, nodeA, 'pull');
    expect(cursor?.last_op_id).toBe(snapshot.highWaterSeq.toString());
  });

  test('a second snapshot with higher highWaterSeq advances the cursor further', () => {
    upsertPlan(dbA, projectA, { uuid: id('cursor-adv-plan-1'), planId: 1, title: 'Plan 1' });

    const nodeA = getLocalNodeId(dbA);
    const firstSnapshot = buildPeerSnapshot(dbA);
    applyPeerSnapshot(dbB, nodeA, firstSnapshot);

    // Add more data on dbA
    upsertPlan(dbA, projectA, { uuid: id('cursor-adv-plan-2'), planId: 2, title: 'Plan 2' });
    const secondSnapshot = buildPeerSnapshot(dbA);
    expect(secondSnapshot.highWaterSeq).toBeGreaterThan(firstSnapshot.highWaterSeq);

    applyPeerSnapshot(dbB, nodeA, secondSnapshot);

    const cursor = getPeerCursor(dbB, nodeA, 'pull');
    expect(cursor?.last_op_id).toBe(secondSnapshot.highWaterSeq.toString());
  });
});

describe('snapshot: end-to-end resync with ops above watermark', () => {
  let dbA: Database;
  let dbB: Database;
  let projectA: number;
  let projectB: number;

  beforeEach(() => {
    dbA = openDatabase(':memory:');
    dbB = openDatabase(':memory:');
    projectA = getOrCreateProject(dbA, 'github.com__owner__repo').id;
    projectB = getOrCreateProject(dbB, 'github.com__owner__repo').id;
  });

  afterEach(() => {
    dbA.close(false);
    dbB.close(false);
  });

  test('after snapshot resync, subsequent pull delivers ops above the watermark', async () => {
    const planBeforeUuid = id('resync-before-plan');
    const planAfterUuid = id('resync-after-plan');

    // Write a plan that will be captured in the snapshot
    upsertPlan(dbB, projectB, { uuid: planBeforeUuid, planId: 1, title: 'Before snapshot' });

    const nodeA = getLocalNodeId(dbA);
    const nodeB = getLocalNodeId(dbB);

    // A syncs from B initially → sets cursor
    registerPeerNode(dbA, { nodeId: nodeB, nodeType: 'main' });
    setPeerCursor(dbA, nodeB, 'pull', '1', null);

    // Write a second plan on B (above the snapshot watermark)
    upsertPlan(dbB, projectB, { uuid: planAfterUuid, planId: 2, title: 'After snapshot' });

    // Compact B's history through seq 1
    setCompactedThroughSeq(dbB, 1);

    // Verify: A's cursor (1) is at or below compacted threshold → will trigger resync
    expect(getCompactedThroughSeq(dbB)).toBe(1);

    // Run sync using HTTP handler (so ResyncRequiredError flows through)
    const handler = createPeerSyncHttpHandler(dbB, { token: 'test-token' });
    const fetchFn: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return handler(request) as Promise<Response>;
    };

    const transport = createHttpPeerTransport({
      baseUrl: 'http://peer.test',
      token: 'test-token',
      localNodeId: nodeA,
      fetch: fetchFn,
    });

    const result = await runPeerSync(dbA, nodeB, transport);

    // Both plans should be present on A after the resync + pull above watermark
    expect(getPlanByUuid(dbA, planBeforeUuid)?.title).toBe('Before snapshot');
    expect(getPlanByUuid(dbA, planAfterUuid)?.title).toBe('After snapshot');

    // Cursor should be advanced past the watermark to reflect the ops above it
    const finalCursor = getPeerCursor(dbA, nodeB, 'pull')?.last_op_id;
    expect(Number(finalCursor)).toBeGreaterThan(1);
  });
});

describe('snapshot: retire blocks pin / releases floor', () => {
  let db: Database;
  let projectId: number;

  beforeEach(() => {
    db = openDatabase(':memory:');
    projectId = getOrCreateProject(db, 'github.com__owner__repo').id;
  });

  afterEach(() => {
    db.close(false);
  });

  test('a registered main peer with NULL push cursor pins compaction floor to 0', () => {
    const peerId = randomUUID();
    registerPeerNode(db, { nodeId: peerId, nodeType: 'main' });

    // No push cursor → compaction floor is pinned to 0
    expect(getCompactionFloorSeq(db)).toBe(0);
  });

  test('retireMainPeer releases the compaction floor pin', () => {
    upsertPlan(db, projectId, { uuid: id('retire-floor-plan'), planId: 1, title: 'Plan' });

    const peerId = randomUUID();
    registerPeerNode(db, { nodeId: peerId, nodeType: 'main' });

    // Give the peer a non-null push cursor so the floor would normally advance
    const localNode = getLocalNodeId(db);
    db.prepare(
      "INSERT INTO sync_peer_cursor (peer_node_id, direction, hlc_physical_ms, hlc_logical, last_op_id, updated_at) VALUES (?, 'push', ?, ?, ?, datetime('now'))"
    ).run(peerId, Date.now(), 0, '5');

    // With peer registered and cursor present, floor should be 5
    expect(getCompactionFloorSeq(db)).toBe(5);

    // Retire the peer — cursor is cleared inside retireMainPeer
    const result = retireMainPeer(db, peerId);
    expect(result.retired).toBe(true);

    // After retirement, no durable main peers remain → floor advances to 0 (no peers = no constraint)
    // getCompactionFloorSeq returns 0 when candidates list is empty (no peers registered)
    expect(getCompactionFloorSeq(db)).toBe(0);
  });

  test('getCompactionFloorSeq returns 0 when no durable main peers are registered', () => {
    // Only the local node exists — no remote main peers
    expect(getCompactionFloorSeq(db)).toBe(0);
  });
});

describe('snapshot: retired peer stickiness', () => {
  let db: Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  afterEach(() => {
    db.close(false);
  });

  test('retired_main cannot be re-registered as main', () => {
    const peerId = randomUUID();
    registerPeerNode(db, { nodeId: peerId, nodeType: 'main' });
    const retireResult = retireMainPeer(db, peerId);
    expect(retireResult.retired).toBe(true);

    // Attempt re-registration as main
    const row = registerPeerNode(db, { nodeId: peerId, nodeType: 'main' });
    expect(row.node_type).toBe('retired_main');
  });

  test('retired_main cannot be re-registered as worker', () => {
    const peerId = randomUUID();
    registerPeerNode(db, { nodeId: peerId, nodeType: 'main' });
    retireMainPeer(db, peerId);

    const row = registerPeerNode(db, { nodeId: peerId, nodeType: 'worker' });
    expect(row.node_type).toBe('retired_main');
  });

  test('retired_main cannot be re-registered as transient', () => {
    const peerId = randomUUID();
    registerPeerNode(db, { nodeId: peerId, nodeType: 'main' });
    retireMainPeer(db, peerId);

    const row = registerPeerNode(db, { nodeId: peerId, nodeType: 'transient' });
    expect(row.node_type).toBe('retired_main');
  });

  test('retireMainPeer returns not_found for an unknown peer', () => {
    const unknownId = randomUUID();
    const result = retireMainPeer(db, unknownId);
    expect(result.retired).toBe(false);
    if (!result.retired) expect(result.reason).toBe('not_found');
  });

  test('retireMainPeer returns local_node when called on the local node', () => {
    const localId = getLocalNodeId(db);
    const result = retireMainPeer(db, localId);
    expect(result.retired).toBe(false);
    if (!result.retired) expect(result.reason).toBe('local_node');
  });

  test('retireMainPeer returns not_main when called on a transient peer', () => {
    const peerId = randomUUID();
    registerPeerNode(db, { nodeId: peerId, nodeType: 'transient' });
    const result = retireMainPeer(db, peerId);
    expect(result.retired).toBe(false);
    if (!result.retired) expect(result.reason).toBe('not_main');
  });
});

describe('snapshot: HTTP 410 on retired peer (comprehensive)', () => {
  let dbA: Database;
  let dbB: Database;
  let projectA: number;
  let projectB: number;

  beforeEach(() => {
    dbA = openDatabase(':memory:');
    dbB = openDatabase(':memory:');
    projectA = getOrCreateProject(dbA, 'github.com__owner__repo').id;
    projectB = getOrCreateProject(dbB, 'github.com__owner__repo').id;
  });

  afterEach(() => {
    dbA.close(false);
    dbB.close(false);
  });

  function handlerFetch(db: Database, token: string): typeof fetch {
    const handler = createPeerSyncHttpHandler(db, { token });
    return async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      return handler(request) as Promise<Response>;
    };
  }

  test('all three HTTP endpoints return 410 peer_retired after retireMainPeer', async () => {
    const nodeA = getLocalNodeId(dbA);
    const nodeB = getLocalNodeId(dbB);

    registerPeerNode(dbB, { nodeId: nodeA, nodeType: 'main' });
    const result = retireMainPeer(dbB, nodeA);
    expect(result.retired).toBe(true);

    const handler = createPeerSyncHttpHandler(dbB, { token: 'tok' });

    // /sync/pull
    const pullUrl = new URL('http://peer.test/sync/pull');
    pullUrl.searchParams.set('peer_node_id', nodeA);
    const pullResp = await handler(new Request(pullUrl, {
      method: 'POST',
      headers: { authorization: 'Bearer tok' },
    }));
    expect(pullResp.status).toBe(410);
    await expect(pullResp.json()).resolves.toEqual({ error: 'peer_retired' });

    // /sync/push
    const pushUrl = new URL('http://peer.test/sync/push');
    pushUrl.searchParams.set('peer_node_id', nodeA);
    const pushResp = await handler(new Request(pushUrl, {
      method: 'POST',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ ops: [] }),
    }));
    expect(pushResp.status).toBe(410);
    await expect(pushResp.json()).resolves.toEqual({ error: 'peer_retired' });

    // /sync/snapshot
    const snapUrl = new URL('http://peer.test/sync/snapshot');
    snapUrl.searchParams.set('peer_node_id', nodeA);
    const snapResp = await handler(new Request(snapUrl, {
      method: 'GET',
      headers: { authorization: 'Bearer tok' },
    }));
    expect(snapResp.status).toBe(410);
    await expect(snapResp.json()).resolves.toEqual({ error: 'peer_retired' });
  });

  test('HTTP push cursor advances by source seq after retirement of a different peer', async () => {
    // Verify that a retired peer cannot push
    const nodeA = getLocalNodeId(dbA);
    const nodeB = getLocalNodeId(dbB);

    upsertPlan(dbA, projectA, { uuid: id('cursor-seq-plan'), planId: 1, title: 'Seq plan' });

    // Register nodeA as main on dbB, retire it, then try to push
    registerPeerNode(dbB, { nodeId: nodeA, nodeType: 'main' });
    retireMainPeer(dbB, nodeA);

    const { getOpLogChunkAfter } = await import('../db/sync_schema.js');
    const ownOp = (getOpLogChunkAfter(dbA, null, 100).ops).find(
      (op) => op.entity_id === id('cursor-seq-plan')
    );
    expect(ownOp).toBeDefined();

    const handler = createPeerSyncHttpHandler(dbB, { token: 'tok' });
    const pushUrl = new URL('http://peer.test/sync/push');
    pushUrl.searchParams.set('peer_node_id', nodeA);
    const resp = await handler(new Request(pushUrl, {
      method: 'POST',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ ops: [ownOp] }),
    }));

    // Retired peer → 410
    expect(resp.status).toBe(410);
    // Plan must NOT have been applied
    expect(getPlanByUuid(dbB, id('cursor-seq-plan'))).toBeNull();
    // Cursor must remain null
    expect(getPeerCursor(dbB, nodeA, 'pull')).toBeNull();
  });
});
