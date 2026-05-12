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
    expect(deleted?.deletedAt).toBeTruthy();
    expect(deleted?.revision).toBe(2);
    expect(listArtifactsForPlan(db, 'plan-artifact')).toEqual([]);

    const secondDelete = softDeleteArtifact(db, 'artifact-toggle');
    expect(secondDelete?.revision).toBe(2);

    const restored = restoreArtifact(db, 'artifact-toggle');
    expect(restored?.deletedAt).toBeNull();
    expect(restored?.revision).toBe(3);
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

  test('lists purge candidates by threshold and includeActive flag', () => {
    insertArtifact(db, {
      uuid: 'artifact-old-deleted',
      planUuid: 'plan-artifact',
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
      uuid: 'artifact-old-active',
      planUuid: 'plan-artifact',
      projectUuid,
      filename: 'old-active.txt',
      mimeType: 'text/plain',
      size: 1,
      sha256: 'hash-old-active',
      storagePath: '/tmp/old-active.txt',
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });

    const cutoff = '2026-01-05T00:00:00.000Z';
    expect(listArtifactsForPurge(db, { olderThanIso: cutoff }).map((row) => row.uuid)).toEqual([
      'artifact-old-deleted',
    ]);
    expect(
      listArtifactsForPurge(db, { olderThanIso: cutoff, includeActive: true }).map(
        (row) => row.uuid
      )
    ).toEqual(['artifact-old-deleted', 'artifact-old-active']);
  });
});
