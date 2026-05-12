import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { DATABASE_FILENAME, openDatabase } from './database.js';
import { getOrCreateProject } from './project.js';
import { upsertPlan } from './plan.js';
import { insertArtifact } from './artifact.js';
import {
  getArtifactTransfer,
  listArtifactsMissingDownloadTransfer,
  listPendingTransfers,
  markTransferFailed,
  markTransferInProgress,
  markTransferSucceeded,
  reenqueueDownloadTransfer,
  resetStrandedArtifactTransfers,
  upsertPendingTransfer,
} from './artifact_transfer.js';

describe('tim db/artifact_transfer', () => {
  let tempDir: string;
  let db: Database;
  let projectUuid: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-artifact-transfer-db-test-'));
    db = openDatabase(path.join(tempDir, DATABASE_FILENAME));
    const project = getOrCreateProject(db, 'repo-artifact-transfer');
    projectUuid = project.uuid;
    upsertPlan(db, project.id, {
      uuid: 'plan-artifact-transfer',
      planId: 1,
      title: 'Artifact transfer plan',
    });
    insertArtifact(db, {
      uuid: 'artifact-transfer-1',
      planUuid: 'plan-artifact-transfer',
      projectUuid,
      filename: 'transfer.txt',
      mimeType: 'text/plain',
      size: 4,
      sha256: 'hash-transfer',
      storagePath: path.join(tempDir, 'transfer.txt'),
    });
  });

  afterEach(async () => {
    db.close(false);
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  test('upserts pending rows without clobbering succeeded rows', () => {
    const pending = upsertPendingTransfer(db, 'artifact-transfer-1', 'main-node', 'upload');
    expect(pending).toMatchObject({
      artifact_uuid: 'artifact-transfer-1',
      node_id: 'main-node',
      direction: 'upload',
      status: 'pending',
      attempts: 0,
    });

    markTransferSucceeded(db, 'artifact-transfer-1', 'main-node', 'upload');
    upsertPendingTransfer(db, 'artifact-transfer-1', 'main-node', 'upload');

    expect(getArtifactTransfer(db, 'artifact-transfer-1', 'main-node', 'upload')).toMatchObject({
      status: 'succeeded',
      attempts: 0,
    });
  });

  test('tracks attempts, failures, and eventual success', () => {
    upsertPendingTransfer(db, 'artifact-transfer-1', 'main-node', 'download');
    const inProgress = markTransferInProgress(db, 'artifact-transfer-1', 'main-node', 'download');
    expect(inProgress?.status).toBe('in_progress');
    expect(inProgress?.attempts).toBe(1);
    expect(inProgress?.last_attempt_at).toBeTruthy();

    const failed = markTransferFailed(
      db,
      'artifact-transfer-1',
      'main-node',
      'download',
      new Error('network failed')
    );
    expect(failed?.status).toBe('failed');
    expect(failed?.last_error).toBe('network failed');

    const secondAttempt = markTransferInProgress(
      db,
      'artifact-transfer-1',
      'main-node',
      'download'
    );
    expect(secondAttempt?.attempts).toBe(2);

    const succeeded = markTransferSucceeded(db, 'artifact-transfer-1', 'main-node', 'download');
    expect(succeeded?.status).toBe('succeeded');
    expect(succeeded?.succeeded_at).toBeTruthy();
    expect(succeeded?.last_error).toBeNull();
  });

  test('lists pending and optionally failed transfers by direction', () => {
    upsertPendingTransfer(db, 'artifact-transfer-1', 'main-node', 'upload');
    markTransferFailed(
      db,
      'artifact-transfer-1',
      'main-node',
      'upload',
      new Error('first failure')
    );

    expect(listPendingTransfers(db, { direction: 'upload' })).toEqual([]);
    expect(listPendingTransfers(db, { direction: 'upload', includeFailed: true })).toHaveLength(1);
    expect(listPendingTransfers(db, { direction: 'download', includeFailed: true })).toEqual([]);
  });

  test('finds artifacts that do not yet have download tracking rows', () => {
    expect(listArtifactsMissingDownloadTransfer(db, 'main-node').map((row) => row.uuid)).toEqual([
      'artifact-transfer-1',
    ]);
    upsertPendingTransfer(db, 'artifact-transfer-1', 'main-node', 'download');
    expect(listArtifactsMissingDownloadTransfer(db, 'main-node')).toEqual([]);
  });

  test('finds succeeded download rows so callers can verify local files still exist', () => {
    markTransferInProgress(db, 'artifact-transfer-1', 'main-node', 'download');
    markTransferSucceeded(db, 'artifact-transfer-1', 'main-node', 'download');

    expect(listArtifactsMissingDownloadTransfer(db, 'main-node')).toEqual([
      expect.objectContaining({
        uuid: 'artifact-transfer-1',
        transfer_uuid: 'artifact-transfer-1',
      }),
    ]);
  });

  test('reenqueueDownloadTransfer resets succeeded rows without changing attempts', () => {
    markTransferInProgress(db, 'artifact-transfer-1', 'main-node', 'download');
    markTransferInProgress(db, 'artifact-transfer-1', 'main-node', 'download');
    markTransferSucceeded(db, 'artifact-transfer-1', 'main-node', 'download');

    const requeued = reenqueueDownloadTransfer(db, 'artifact-transfer-1', 'main-node');

    expect(requeued).toMatchObject({
      status: 'pending',
      attempts: 2,
      last_error: null,
    });
  });

  test('upsertPendingTransfer resets in_progress rows back to pending', () => {
    upsertPendingTransfer(db, 'artifact-transfer-1', 'main-node', 'upload');
    markTransferInProgress(db, 'artifact-transfer-1', 'main-node', 'upload');
    expect(getArtifactTransfer(db, 'artifact-transfer-1', 'main-node', 'upload')?.status).toBe(
      'in_progress'
    );

    upsertPendingTransfer(db, 'artifact-transfer-1', 'main-node', 'upload');
    expect(getArtifactTransfer(db, 'artifact-transfer-1', 'main-node', 'upload')?.status).toBe(
      'pending'
    );
  });

  test('resetStrandedArtifactTransfers resets in_progress rows and preserves attempts', () => {
    upsertPendingTransfer(db, 'artifact-transfer-1', 'main-node', 'upload');
    markTransferInProgress(db, 'artifact-transfer-1', 'main-node', 'upload');
    markTransferInProgress(db, 'artifact-transfer-1', 'main-node', 'upload');

    const changed = resetStrandedArtifactTransfers(db);

    expect(changed).toBe(1);
    expect(getArtifactTransfer(db, 'artifact-transfer-1', 'main-node', 'upload')).toMatchObject({
      status: 'pending',
      attempts: 2,
      last_error: 'orphaned in_progress reset',
    });
  });

  test('markTransferFailed truncates very long error messages', () => {
    upsertPendingTransfer(db, 'artifact-transfer-1', 'main-node', 'upload');
    markTransferInProgress(db, 'artifact-transfer-1', 'main-node', 'upload');
    const longMessage = 'x'.repeat(2000);
    const result = markTransferFailed(
      db,
      'artifact-transfer-1',
      'main-node',
      'upload',
      new Error(longMessage)
    );
    expect(result?.last_error).not.toBeNull();
    expect(result?.last_error!.length).toBeLessThanOrEqual(1024);
    expect(result?.last_error!.length).toBeGreaterThan(0);
  });

  test('markTransferSucceeded clears last_error from a previous failure', () => {
    upsertPendingTransfer(db, 'artifact-transfer-1', 'main-node', 'upload');
    markTransferInProgress(db, 'artifact-transfer-1', 'main-node', 'upload');
    markTransferFailed(
      db,
      'artifact-transfer-1',
      'main-node',
      'upload',
      new Error('temporary failure')
    );
    expect(getArtifactTransfer(db, 'artifact-transfer-1', 'main-node', 'upload')?.last_error).toBe(
      'temporary failure'
    );

    markTransferInProgress(db, 'artifact-transfer-1', 'main-node', 'upload');
    markTransferSucceeded(db, 'artifact-transfer-1', 'main-node', 'upload');
    expect(
      getArtifactTransfer(db, 'artifact-transfer-1', 'main-node', 'upload')?.last_error
    ).toBeNull();
  });

  test('cascade: deleting plan_artifact removes artifact_transfer rows', () => {
    upsertPendingTransfer(db, 'artifact-transfer-1', 'main-node', 'upload');
    upsertPendingTransfer(db, 'artifact-transfer-1', 'peer-node', 'download');
    expect(listPendingTransfers(db, { direction: 'upload' })).toHaveLength(1);
    expect(listPendingTransfers(db, { direction: 'download' })).toHaveLength(1);

    db.prepare('DELETE FROM plan_artifact WHERE uuid = ?').run('artifact-transfer-1');

    expect(listPendingTransfers(db, { direction: 'upload' })).toHaveLength(0);
    expect(listPendingTransfers(db, { direction: 'download' })).toHaveLength(0);
    expect(getArtifactTransfer(db, 'artifact-transfer-1', 'main-node', 'upload')).toBeUndefined();
  });

  test('mark helpers tolerate cascade-deleted transfer rows', () => {
    upsertPendingTransfer(db, 'artifact-transfer-1', 'main-node', 'upload');
    db.prepare('DELETE FROM plan_artifact WHERE uuid = ?').run('artifact-transfer-1');

    expect(() =>
      markTransferFailed(db, 'artifact-transfer-1', 'main-node', 'upload', new Error('failed'))
    ).not.toThrow();
    expect(() =>
      markTransferInProgress(db, 'artifact-transfer-1', 'main-node', 'upload')
    ).not.toThrow();
    expect(() =>
      markTransferSucceeded(db, 'artifact-transfer-1', 'main-node', 'upload')
    ).not.toThrow();
  });

  test('missing download discovery skips tombstoned artifact UUIDs', () => {
    db.prepare(
      `
        INSERT INTO sync_tombstone (
          entity_type,
          entity_key,
          project_uuid,
          plan_uuid,
          deletion_operation_uuid,
          deleted_at,
          origin_node_id
        ) VALUES ('plan_artifact', ?, ?, 'plan-artifact-transfer', ?, '2026-01-01T00:00:00.000Z', 'main-node')
      `
    ).run('artifact-transfer-1', projectUuid, 'delete-artifact-transfer-1');

    expect(listArtifactsMissingDownloadTransfer(db, 'main-node')).toEqual([]);
  });
});
