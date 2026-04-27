import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DATABASE_FILENAME, openDatabase } from './database.js';
import {
  getTimNode,
  upsertTimNode,
  insertSyncOperation,
  getSyncOperation,
  listSyncOperationsByStatus,
  insertSyncConflict,
  getSyncConflict,
  listSyncConflictsByStatus,
  upsertSyncTombstone,
  getSyncTombstone,
  insertSyncSequence,
  listSyncSequenceAfter,
  type TimNodeRole,
} from './sync_tables.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('sync_tables helpers', () => {
  let tempDir: string;
  let db: Database;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-sync-tables-test-'));
    db = openDatabase(path.join(tempDir, DATABASE_FILENAME));
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('upsertTimNode / getTimNode', () => {
    test('inserts a new node and retrieves it by nodeId', () => {
      const node = upsertTimNode(db, {
        nodeId: 'node-main-1',
        role: 'main',
        label: 'Primary server',
        tokenHash: 'abc123',
      });

      expect(node.node_id).toBe('node-main-1');
      expect(node.role).toBe('main');
      expect(node.label).toBe('Primary server');
      expect(node.token_hash).toBe('abc123');
      expect(node.created_at).toBeTruthy();
      expect(node.updated_at).toBeTruthy();

      const fetched = getTimNode(db, 'node-main-1');
      expect(fetched).toEqual(node);
    });

    test('updates an existing node on conflict', () => {
      upsertTimNode(db, { nodeId: 'node-x', role: 'persistent', label: 'old-label' });
      const updated = upsertTimNode(db, {
        nodeId: 'node-x',
        role: 'ephemeral',
        label: 'new-label',
        tokenHash: 'newtoken',
      });

      expect(updated.role).toBe('ephemeral');
      expect(updated.label).toBe('new-label');
      expect(updated.token_hash).toBe('newtoken');
    });

    test('allows null label and token_hash', () => {
      const node = upsertTimNode(db, { nodeId: 'node-minimal', role: 'persistent' });
      expect(node.label).toBeNull();
      expect(node.token_hash).toBeNull();
    });

    test('returns null for unknown nodeId', () => {
      expect(getTimNode(db, 'nonexistent')).toBeNull();
    });

    test('inserts all three roles without constraint violation', () => {
      for (const role of ['main', 'persistent', 'ephemeral'] as TimNodeRole[]) {
        const node = upsertTimNode(db, { nodeId: `node-${role}`, role });
        expect(node.role).toBe(role);
      }
    });
  });

  describe('insertSyncOperation / getSyncOperation / listSyncOperationsByStatus', () => {
    const PROJECT_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

    function makeOperation(
      overrides: {
        operationUuid?: string;
        localSequence?: number;
        originNodeId?: string;
        status?: string;
        projectUuid?: string;
      } = {}
    ) {
      return {
        operation_uuid: overrides.operationUuid ?? crypto.randomUUID(),
        project_uuid: overrides.projectUuid ?? PROJECT_UUID,
        origin_node_id: overrides.originNodeId ?? 'node-1',
        local_sequence: overrides.localSequence ?? 1,
        target_type: 'plan',
        target_key: 'plan:some-plan-uuid',
        operation_type: 'plan.add_tag',
        base_revision: null,
        base_hash: null,
        payload: JSON.stringify({ tag: 'backend' }),
        status: overrides.status ?? 'queued',
        last_error: null,
        acked_at: null,
        ack_metadata: null,
      };
    }

    test('inserts an operation and retrieves it by UUID', () => {
      const op = insertSyncOperation(db, makeOperation());

      expect(op.operation_uuid).toMatch(UUID_RE);
      expect(op.project_uuid).toBe(PROJECT_UUID);
      expect(op.origin_node_id).toBe('node-1');
      expect(op.local_sequence).toBe(1);
      expect(op.target_type).toBe('plan');
      expect(op.operation_type).toBe('plan.add_tag');
      expect(op.status).toBe('queued');
      expect(op.attempts).toBe(0);
      expect(op.created_at).toBeTruthy();
      expect(op.updated_at).toBeTruthy();

      const fetched = getSyncOperation(db, op.operation_uuid);
      expect(fetched).toEqual(op);
    });

    test('returns null for unknown operation UUID', () => {
      expect(getSyncOperation(db, crypto.randomUUID())).toBeNull();
    });

    test('listSyncOperationsByStatus filters by status', () => {
      const opA = insertSyncOperation(db, makeOperation({ localSequence: 1, status: 'queued' }));
      const opB = insertSyncOperation(db, makeOperation({ localSequence: 2, status: 'acked' }));
      const opC = insertSyncOperation(db, makeOperation({ localSequence: 3, status: 'queued' }));

      const queued = listSyncOperationsByStatus(db, 'queued');
      expect(queued.map((o) => o.operation_uuid)).toEqual([opA.operation_uuid, opC.operation_uuid]);

      const acked = listSyncOperationsByStatus(db, 'acked');
      expect(acked.map((o) => o.operation_uuid)).toEqual([opB.operation_uuid]);
    });

    test('listSyncOperationsByStatus can filter by project UUID', () => {
      const projectA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const projectB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      insertSyncOperation(db, makeOperation({ localSequence: 1, projectUuid: projectA }));
      insertSyncOperation(db, makeOperation({ localSequence: 2, projectUuid: projectB }));

      const forA = listSyncOperationsByStatus(db, 'queued', projectA);
      expect(forA).toHaveLength(1);
      expect(forA[0]!.project_uuid).toBe(projectA);

      const forB = listSyncOperationsByStatus(db, 'queued', projectB);
      expect(forB).toHaveLength(1);
      expect(forB[0]!.project_uuid).toBe(projectB);
    });

    test('listSyncOperationsByStatus orders by origin_node_id then local_sequence', () => {
      insertSyncOperation(
        db,
        makeOperation({
          localSequence: 2,
          originNodeId: 'node-a',
          operationUuid: crypto.randomUUID(),
        })
      );
      insertSyncOperation(
        db,
        makeOperation({
          localSequence: 1,
          originNodeId: 'node-b',
          operationUuid: crypto.randomUUID(),
        })
      );
      insertSyncOperation(
        db,
        makeOperation({
          localSequence: 1,
          originNodeId: 'node-a',
          operationUuid: crypto.randomUUID(),
        })
      );

      const ops = listSyncOperationsByStatus(db, 'queued');
      expect(ops[0]!.origin_node_id).toBe('node-a');
      expect(ops[0]!.local_sequence).toBe(1);
      expect(ops[1]!.origin_node_id).toBe('node-a');
      expect(ops[1]!.local_sequence).toBe(2);
      expect(ops[2]!.origin_node_id).toBe('node-b');
      expect(ops[2]!.local_sequence).toBe(1);
    });

    test('(origin_node_id, local_sequence) UNIQUE constraint rejects duplicate insert', () => {
      insertSyncOperation(
        db,
        makeOperation({
          localSequence: 5,
          originNodeId: 'node-dup',
          operationUuid: crypto.randomUUID(),
        })
      );
      expect(() =>
        insertSyncOperation(
          db,
          makeOperation({
            localSequence: 5,
            originNodeId: 'node-dup',
            operationUuid: crypto.randomUUID(),
          })
        )
      ).toThrow();
    });

    test('same local_sequence is allowed for different origin nodes', () => {
      expect(() => {
        insertSyncOperation(
          db,
          makeOperation({
            localSequence: 1,
            originNodeId: 'node-1',
            operationUuid: crypto.randomUUID(),
          })
        );
        insertSyncOperation(
          db,
          makeOperation({
            localSequence: 1,
            originNodeId: 'node-2',
            operationUuid: crypto.randomUUID(),
          })
        );
      }).not.toThrow();
    });

    test('stores and retrieves base_revision and base_hash', () => {
      const op = insertSyncOperation(db, {
        ...makeOperation(),
        base_revision: 7,
        base_hash: 'sha256:abc',
      });
      expect(op.base_revision).toBe(7);
      expect(op.base_hash).toBe('sha256:abc');
    });

    test('stores and retrieves acked_at and ack_metadata', () => {
      const op = insertSyncOperation(db, {
        ...makeOperation(),
        acked_at: '2026-04-26T00:00:00Z',
        ack_metadata: JSON.stringify({ result: 'ok' }),
      });
      expect(op.acked_at).toBe('2026-04-26T00:00:00Z');
      expect(op.ack_metadata).toBe(JSON.stringify({ result: 'ok' }));
    });
  });

  describe('insertSyncConflict / getSyncConflict / listSyncConflictsByStatus', () => {
    const PROJECT_UUID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

    function makeConflict(
      overrides: {
        conflictId?: string;
        status?: string;
        projectUuid?: string;
      } = {}
    ) {
      return {
        conflict_id: overrides.conflictId ?? crypto.randomUUID(),
        operation_uuid: crypto.randomUUID(),
        project_uuid: overrides.projectUuid ?? PROJECT_UUID,
        target_type: 'plan',
        target_key: 'plan:some-plan-uuid',
        field_path: 'title',
        base_value: 'old title',
        base_hash: null,
        incoming_value: 'new title',
        attempted_patch: null,
        current_value: 'other title',
        original_payload: JSON.stringify({ op: 'patch_text', value: 'new title' }),
        normalized_payload: JSON.stringify({ op: 'patch_text', value: 'new title' }),
        reason: 'non-mergeable text conflict',
        status: overrides.status,
        origin_node_id: 'node-persistent-1',
        resolved_at: null,
        resolution: null,
        resolved_by_node: null,
      };
    }

    test('inserts a conflict and retrieves it by ID', () => {
      const conflict = insertSyncConflict(db, makeConflict());

      expect(conflict.conflict_id).toMatch(UUID_RE);
      expect(conflict.status).toBe('open');
      expect(conflict.field_path).toBe('title');
      expect(conflict.base_value).toBe('old title');
      expect(conflict.incoming_value).toBe('new title');
      expect(conflict.current_value).toBe('other title');
      expect(conflict.reason).toBe('non-mergeable text conflict');
      expect(conflict.created_at).toBeTruthy();
      expect(conflict.resolved_at).toBeNull();

      const fetched = getSyncConflict(db, conflict.conflict_id);
      expect(fetched).toEqual(conflict);
    });

    test('defaults status to open when not provided', () => {
      const conflict = insertSyncConflict(db, makeConflict());
      expect(conflict.status).toBe('open');
    });

    test('allows explicit status override', () => {
      const conflict = insertSyncConflict(db, makeConflict({ status: 'resolved_applied' }));
      expect(conflict.status).toBe('resolved_applied');
    });

    test('listSyncConflictsByStatus filters by status', () => {
      insertSyncConflict(db, makeConflict({ conflictId: crypto.randomUUID(), status: 'open' }));
      insertSyncConflict(
        db,
        makeConflict({ conflictId: crypto.randomUUID(), status: 'resolved_applied' })
      );
      insertSyncConflict(db, makeConflict({ conflictId: crypto.randomUUID(), status: 'open' }));

      const open = listSyncConflictsByStatus(db);
      expect(open).toHaveLength(2);
      expect(open.every((c) => c.status === 'open')).toBe(true);

      const resolved = listSyncConflictsByStatus(db, 'resolved_applied');
      expect(resolved).toHaveLength(1);
    });

    test('listSyncConflictsByStatus filters by project UUID', () => {
      const projectA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const projectB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      insertSyncConflict(
        db,
        makeConflict({ conflictId: crypto.randomUUID(), projectUuid: projectA })
      );
      insertSyncConflict(
        db,
        makeConflict({ conflictId: crypto.randomUUID(), projectUuid: projectB })
      );

      expect(listSyncConflictsByStatus(db, 'open', projectA)).toHaveLength(1);
      expect(listSyncConflictsByStatus(db, 'open', projectB)).toHaveLength(1);
    });

    test('returns null for unknown conflict ID', () => {
      expect(getSyncConflict(db, crypto.randomUUID())).toBeNull();
    });

    test('stores all nullable context fields as null', () => {
      const conflict = insertSyncConflict(db, {
        ...makeConflict(),
        field_path: null,
        base_value: null,
        base_hash: null,
        incoming_value: null,
        attempted_patch: null,
        current_value: null,
      });
      expect(conflict.field_path).toBeNull();
      expect(conflict.base_value).toBeNull();
      expect(conflict.incoming_value).toBeNull();
      expect(conflict.current_value).toBeNull();
    });
  });

  describe('upsertSyncTombstone / getSyncTombstone', () => {
    const PROJECT_UUID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

    function makeTombstone(overrides: { entityKey?: string } = {}) {
      return {
        entity_type: 'plan',
        entity_key: overrides.entityKey ?? 'plan:some-plan-uuid',
        project_uuid: PROJECT_UUID,
        deletion_operation_uuid: crypto.randomUUID(),
        deleted_revision: 5,
        deleted_at: '2026-04-26T00:00:00Z',
        origin_node_id: 'node-main-1',
      };
    }

    test('inserts a tombstone and retrieves it', () => {
      upsertSyncTombstone(db, makeTombstone());

      const tombstone = getSyncTombstone(db, 'plan', 'plan:some-plan-uuid');
      expect(tombstone).not.toBeNull();
      expect(tombstone!.entity_type).toBe('plan');
      expect(tombstone!.entity_key).toBe('plan:some-plan-uuid');
      expect(tombstone!.project_uuid).toBe(PROJECT_UUID);
      expect(tombstone!.deleted_revision).toBe(5);
      expect(tombstone!.deleted_at).toBe('2026-04-26T00:00:00Z');
      expect(tombstone!.origin_node_id).toBe('node-main-1');
    });

    test('upserts correctly override an existing tombstone for the same entity', () => {
      const first = makeTombstone();
      upsertSyncTombstone(db, first);

      const newOpUuid = crypto.randomUUID();
      upsertSyncTombstone(db, {
        ...first,
        deletion_operation_uuid: newOpUuid,
        deleted_revision: 9,
        deleted_at: '2026-04-27T00:00:00Z',
      });

      const tombstone = getSyncTombstone(db, 'plan', 'plan:some-plan-uuid');
      expect(tombstone!.deletion_operation_uuid).toBe(newOpUuid);
      expect(tombstone!.deleted_revision).toBe(9);
      expect(tombstone!.deleted_at).toBe('2026-04-27T00:00:00Z');
    });

    test('different entity keys produce separate tombstones', () => {
      upsertSyncTombstone(db, makeTombstone({ entityKey: 'plan:plan-a' }));
      upsertSyncTombstone(db, makeTombstone({ entityKey: 'plan:plan-b' }));

      expect(getSyncTombstone(db, 'plan', 'plan:plan-a')).not.toBeNull();
      expect(getSyncTombstone(db, 'plan', 'plan:plan-b')).not.toBeNull();
    });

    test('returns null for unknown entity', () => {
      expect(getSyncTombstone(db, 'plan', 'nonexistent')).toBeNull();
    });

    test('stores null deleted_revision', () => {
      const tombstone = { ...makeTombstone(), deleted_revision: null };
      upsertSyncTombstone(db, tombstone);
      const fetched = getSyncTombstone(db, 'plan', 'plan:some-plan-uuid');
      expect(fetched!.deleted_revision).toBeNull();
    });
  });

  describe('insertSyncSequence / listSyncSequenceAfter', () => {
    const PROJECT_UUID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

    function makeSequenceEntry(
      overrides: {
        projectUuid?: string;
        targetKey?: string;
        revision?: number | null;
      } = {}
    ) {
      return {
        project_uuid: overrides.projectUuid ?? PROJECT_UUID,
        target_type: 'plan',
        target_key: overrides.targetKey ?? 'plan:some-plan-uuid',
        revision: overrides.revision !== undefined ? overrides.revision : 3,
        operation_uuid: crypto.randomUUID(),
        origin_node_id: 'node-main-1',
      };
    }

    test('inserts a sequence row and returns auto-incremented sequence number', () => {
      const row = insertSyncSequence(db, makeSequenceEntry());

      expect(row.sequence).toBeGreaterThan(0);
      expect(row.project_uuid).toBe(PROJECT_UUID);
      expect(row.target_type).toBe('plan');
      expect(row.target_key).toBe('plan:some-plan-uuid');
      expect(row.revision).toBe(3);
      expect(row.created_at).toBeTruthy();
    });

    test('sequence numbers are strictly increasing', () => {
      const row1 = insertSyncSequence(db, makeSequenceEntry({ targetKey: 'plan:a' }));
      const row2 = insertSyncSequence(db, makeSequenceEntry({ targetKey: 'plan:b' }));
      const row3 = insertSyncSequence(db, makeSequenceEntry({ targetKey: 'plan:c' }));

      expect(row2.sequence).toBeGreaterThan(row1.sequence);
      expect(row3.sequence).toBeGreaterThan(row2.sequence);
    });

    test('listSyncSequenceAfter returns entries with sequence > afterSequence', () => {
      const row1 = insertSyncSequence(db, makeSequenceEntry({ targetKey: 'plan:a' }));
      const row2 = insertSyncSequence(db, makeSequenceEntry({ targetKey: 'plan:b' }));
      const row3 = insertSyncSequence(db, makeSequenceEntry({ targetKey: 'plan:c' }));

      const after1 = listSyncSequenceAfter(db, PROJECT_UUID, row1.sequence);
      expect(after1).toHaveLength(2);
      expect(after1[0]!.sequence).toBe(row2.sequence);
      expect(after1[1]!.sequence).toBe(row3.sequence);

      const after2 = listSyncSequenceAfter(db, PROJECT_UUID, row2.sequence);
      expect(after2).toHaveLength(1);
      expect(after2[0]!.sequence).toBe(row3.sequence);

      const afterAll = listSyncSequenceAfter(db, PROJECT_UUID, row3.sequence);
      expect(afterAll).toHaveLength(0);
    });

    test('listSyncSequenceAfter filters by project UUID', () => {
      const projectA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const projectB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const rowA = insertSyncSequence(db, makeSequenceEntry({ projectUuid: projectA }));
      insertSyncSequence(db, makeSequenceEntry({ projectUuid: projectB }));

      const entriesA = listSyncSequenceAfter(db, projectA, 0);
      expect(entriesA).toHaveLength(1);
      expect(entriesA[0]!.project_uuid).toBe(projectA);

      const entriesB = listSyncSequenceAfter(db, projectB, rowA.sequence - 1);
      expect(entriesB.every((r) => r.project_uuid === projectB)).toBe(true);
    });

    test('stores null revision, operation_uuid, and origin_node_id', () => {
      const row = insertSyncSequence(db, {
        project_uuid: PROJECT_UUID,
        target_type: 'plan',
        target_key: 'plan:nullable-test',
        revision: null,
        operation_uuid: null,
        origin_node_id: null,
      });
      expect(row.revision).toBeNull();
      expect(row.operation_uuid).toBeNull();
      expect(row.origin_node_id).toBeNull();
    });

    test('listSyncSequenceAfter returns entries ordered by sequence', () => {
      const rows = [
        insertSyncSequence(db, makeSequenceEntry({ targetKey: 'plan:x' })),
        insertSyncSequence(db, makeSequenceEntry({ targetKey: 'plan:y' })),
        insertSyncSequence(db, makeSequenceEntry({ targetKey: 'plan:z' })),
      ];

      const entries = listSyncSequenceAfter(db, PROJECT_UUID, 0);
      expect(entries.map((r) => r.sequence)).toEqual(rows.map((r) => r.sequence));
    });
  });
});
