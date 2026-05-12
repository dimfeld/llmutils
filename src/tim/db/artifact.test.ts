import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DATABASE_FILENAME, openDatabase } from './database.js';
import { getOrCreateProject } from './project.js';
import { upsertPlan } from './plan.js';
import {
  getArtifactByUuid,
  hardDeleteArtifact,
  insertArtifact,
  listArtifactsForPlan,
  listArtifactsForPurge,
  restoreArtifact,
  softDeleteArtifact,
} from './artifact.js';

describe('tim db/artifact', () => {
  let tempDir: string;
  let db: Database;
  let projectUuid: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-artifact-db-test-'));
    db = openDatabase(path.join(tempDir, DATABASE_FILENAME));
    const project = getOrCreateProject(db, 'repo-artifact');
    projectUuid = project.uuid;
    upsertPlan(db, project.id, {
      uuid: 'plan-artifact',
      planId: 1,
      title: 'Artifact plan',
    });
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('inserts and fetches an artifact', () => {
    const inserted = insertArtifact(db, {
      uuid: 'artifact-1',
      planUuid: 'plan-artifact',
      projectUuid,
      filename: 'screenshot.png',
      mimeType: 'image/png',
      size: 12,
      sha256: 'abc123',
      message: 'before fix',
      storagePath: '/tmp/artifact-1.png',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(inserted).toMatchObject({
      uuid: 'artifact-1',
      planUuid: 'plan-artifact',
      projectUuid,
      filename: 'screenshot.png',
      mimeType: 'image/png',
      size: 12,
      sha256: 'abc123',
      message: 'before fix',
      storagePath: '/tmp/artifact-1.png',
      deletedAt: null,
      revision: 1,
    });
    expect(getArtifactByUuid(db, 'artifact-1')).toEqual(inserted);
  });

  test('lists active artifacts by default and can include soft-deleted artifacts', () => {
    insertArtifact(db, {
      uuid: 'artifact-active',
      planUuid: 'plan-artifact',
      projectUuid,
      filename: 'active.log',
      mimeType: 'text/plain',
      size: 10,
      sha256: 'hash-active',
      storagePath: '/tmp/active.log',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    insertArtifact(db, {
      uuid: 'artifact-deleted',
      planUuid: 'plan-artifact',
      projectUuid,
      filename: 'deleted.log',
      mimeType: 'text/plain',
      size: 20,
      sha256: 'hash-deleted',
      storagePath: '/tmp/deleted.log',
      deletedAt: '2026-01-03T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
    });

    expect(listArtifactsForPlan(db, 'plan-artifact').map((artifact) => artifact.uuid)).toEqual([
      'artifact-active',
    ]);
    expect(
      listArtifactsForPlan(db, 'plan-artifact', { includeDeleted: true }).map(
        (artifact) => artifact.uuid
      )
    ).toEqual(['artifact-active', 'artifact-deleted']);
  });

  test('soft-deletes and restores artifacts', () => {
    insertArtifact(db, {
      uuid: 'artifact-toggle',
      planUuid: 'plan-artifact',
      projectUuid,
      filename: 'toggle.txt',
      mimeType: 'text/plain',
      size: 4,
      sha256: 'hash-toggle',
      storagePath: '/tmp/toggle.txt',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const deleted = softDeleteArtifact(db, 'artifact-toggle');
    expect(deleted.changed).toBe(true);
    expect(deleted.artifact?.deletedAt).toBeTruthy();
    expect(deleted.artifact?.revision).toBe(2);
    expect(listArtifactsForPlan(db, 'plan-artifact')).toEqual([]);

    const secondDelete = softDeleteArtifact(db, 'artifact-toggle');
    expect(secondDelete.changed).toBe(false);
    expect(secondDelete.artifact?.revision).toBe(2);

    const restored = restoreArtifact(db, 'artifact-toggle');
    expect(restored.changed).toBe(true);
    expect(restored.artifact?.deletedAt).toBeNull();
    expect(restored.artifact?.revision).toBe(3);

    const secondRestore = restoreArtifact(db, 'artifact-toggle');
    expect(secondRestore.changed).toBe(false);
    expect(secondRestore.artifact?.revision).toBe(3);
    expect(listArtifactsForPlan(db, 'plan-artifact').map((artifact) => artifact.uuid)).toEqual([
      'artifact-toggle',
    ]);
  });

  test('hard-deletes and returns the prior row', () => {
    insertArtifact(db, {
      uuid: 'artifact-hard-delete',
      planUuid: 'plan-artifact',
      projectUuid,
      filename: 'delete.txt',
      mimeType: 'text/plain',
      size: 6,
      sha256: 'hash-delete',
      storagePath: '/tmp/delete.txt',
    });

    const deleted = hardDeleteArtifact(db, 'artifact-hard-delete');
    expect(deleted?.uuid).toBe('artifact-hard-delete');
    expect(getArtifactByUuid(db, 'artifact-hard-delete')).toBeUndefined();
    expect(hardDeleteArtifact(db, 'artifact-hard-delete')).toBeUndefined();
  });

  test('returns undefined for non-existent UUID', () => {
    expect(getArtifactByUuid(db, 'does-not-exist')).toBeUndefined();
    expect(softDeleteArtifact(db, 'does-not-exist')).toEqual({
      changed: false,
      artifact: undefined,
    });
    expect(restoreArtifact(db, 'does-not-exist')).toEqual({
      changed: false,
      artifact: undefined,
    });
    expect(hardDeleteArtifact(db, 'does-not-exist')).toBeUndefined();
  });

  test('plan cascade-deletes artifacts when the owning plan is deleted', () => {
    insertArtifact(db, {
      uuid: 'artifact-cascade-1',
      planUuid: 'plan-artifact',
      projectUuid,
      filename: 'a.txt',
      mimeType: 'text/plain',
      size: 1,
      sha256: 'hash-a',
      storagePath: '/tmp/a.txt',
    });

    db.prepare("DELETE FROM plan WHERE uuid = 'plan-artifact'").run();

    expect(getArtifactByUuid(db, 'artifact-cascade-1')).toBeUndefined();
    expect(listArtifactsForPlan(db, 'plan-artifact', { includeDeleted: true })).toEqual([]);
  });

  test('artifact cascade-deletes artifact_transfer rows when the artifact is deleted', () => {
    insertArtifact(db, {
      uuid: 'artifact-transfer-cascade',
      planUuid: 'plan-artifact',
      projectUuid,
      filename: 'b.txt',
      mimeType: 'text/plain',
      size: 2,
      sha256: 'hash-b',
      storagePath: '/tmp/b.txt',
    });
    db.prepare(
      `INSERT INTO artifact_transfer (artifact_uuid, node_id, direction, status)
       VALUES ('artifact-transfer-cascade', 'node-1', 'upload', 'pending')`
    ).run();

    const beforeDelete = db
      .prepare<
        { count: number },
        string
      >('SELECT count(*) as count FROM artifact_transfer WHERE artifact_uuid = ?')
      .get('artifact-transfer-cascade');
    expect(beforeDelete?.count).toBe(1);

    hardDeleteArtifact(db, 'artifact-transfer-cascade');

    const afterDelete = db
      .prepare<
        { count: number },
        string
      >('SELECT count(*) as count FROM artifact_transfer WHERE artifact_uuid = ?')
      .get('artifact-transfer-cascade');
    expect(afterDelete?.count).toBe(0);
  });

  test('lists purge candidates by threshold, plan status, and includeActive flag', () => {
    upsertPlan(db, 1, {
      uuid: 'plan-in-progress-old',
      planId: 2,
      title: 'In progress old',
      status: 'in_progress',
      sourceUpdatedAt: '2026-01-01T00:00:00.000Z',
    });
    upsertPlan(db, 1, {
      uuid: 'plan-done-old',
      planId: 3,
      title: 'Done old',
      status: 'done',
      sourceUpdatedAt: '2026-01-01T00:00:00.000Z',
    });
    upsertPlan(db, 1, {
      uuid: 'plan-done-recent',
      planId: 4,
      title: 'Done recent',
      status: 'done',
      sourceUpdatedAt: '2026-01-10T00:00:00.000Z',
    });
    insertArtifact(db, {
      uuid: 'artifact-old-deleted',
      planUuid: 'plan-in-progress-old',
      projectUuid,
      filename: 'old-deleted.txt',
      mimeType: 'text/plain',
      size: 1,
      sha256: 'hash-old-deleted',
      storagePath: '/tmp/old-deleted.txt',
      deletedAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    insertArtifact(db, {
      uuid: 'artifact-new-deleted',
      planUuid: 'plan-artifact',
      projectUuid,
      filename: 'new-deleted.txt',
      mimeType: 'text/plain',
      size: 1,
      sha256: 'hash-new-deleted',
      storagePath: '/tmp/new-deleted.txt',
      deletedAt: '2026-01-10T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-10T00:00:00.000Z',
    });
    insertArtifact(db, {
      uuid: 'artifact-old-active-in-progress',
      planUuid: 'plan-in-progress-old',
      projectUuid,
      filename: 'old-active-in-progress.txt',
      mimeType: 'text/plain',
      size: 1,
      sha256: 'hash-old-active-in-progress',
      storagePath: '/tmp/old-active-in-progress.txt',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    insertArtifact(db, {
      uuid: 'artifact-old-active-done-old',
      planUuid: 'plan-done-old',
      projectUuid,
      filename: 'old-active-done-old.txt',
      mimeType: 'text/plain',
      size: 1,
      sha256: 'hash-old-active-done-old',
      storagePath: '/tmp/old-active-done-old.txt',
      createdAt: '2026-01-03T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
    });
    insertArtifact(db, {
      uuid: 'artifact-old-active-done-recent',
      planUuid: 'plan-done-recent',
      projectUuid,
      filename: 'old-active-done-recent.txt',
      mimeType: 'text/plain',
      size: 1,
      sha256: 'hash-old-active-done-recent',
      storagePath: '/tmp/old-active-done-recent.txt',
      createdAt: '2026-01-04T00:00:00.000Z',
      updatedAt: '2026-01-04T00:00:00.000Z',
    });

    const cutoff = '2026-01-05T00:00:00.000Z';
    expect(listArtifactsForPurge(db, { olderThanIso: cutoff }).map((row) => row.uuid)).toEqual([
      'artifact-old-deleted',
    ]);
    expect(
      listArtifactsForPurge(db, { olderThanIso: cutoff, includeActive: true }).map(
        (row) => row.uuid
      )
    ).toEqual(['artifact-old-deleted', 'artifact-old-active-done-old']);
  });

  test('purge eligibility follows projection plan, not canonical, when they diverge', () => {
    upsertPlan(db, 1, {
      uuid: 'plan-divergent',
      planId: 5,
      title: 'Divergent plan',
      status: 'done',
      sourceUpdatedAt: '2026-01-01T00:00:00.000Z',
    });
    insertArtifact(db, {
      uuid: 'artifact-divergent',
      planUuid: 'plan-divergent',
      projectUuid,
      filename: 'divergent.txt',
      mimeType: 'text/plain',
      size: 1,
      sha256: 'hash-divergent',
      storagePath: '/tmp/divergent.txt',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });

    const cutoff = '2026-01-05T00:00:00.000Z';

    // Both projection and canonical agree: done + old → purgeable.
    expect(
      listArtifactsForPurge(db, { olderThanIso: cutoff, includeActive: true }).map((r) => r.uuid)
    ).toContain('artifact-divergent');

    // Diverge: projection back to in_progress while canonical still says done.
    db.prepare("UPDATE plan SET status = 'in_progress' WHERE uuid = 'plan-divergent'").run();

    // Purge eligibility must follow the projection (user-visible) status.
    expect(
      listArtifactsForPurge(db, { olderThanIso: cutoff, includeActive: true }).map((r) => r.uuid)
    ).not.toContain('artifact-divergent');
  });
});
