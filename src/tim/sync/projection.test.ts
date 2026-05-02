import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'vitest';
import { runMigrations } from '../db/migrations.js';
import { getOrCreateProject, type Project } from '../db/project.js';
import {
  getProjectSettingWithMetadata,
  writeCanonicalProjectSettingRow,
} from '../db/project_settings.js';
import { setProjectSettingOperation, deleteProjectSettingOperation } from './operations.js';
import {
  enqueueOperation,
  markOperationAcked,
  markOperationConflict,
  markOperationFailedRetryable,
  markOperationRejected,
  markOperationSending,
} from './queue.js';
import { rebuildProjectSettingProjection } from './projection.js';

const PROJECT_UUID = '11111111-1111-4111-8111-111111111111';
const NODE_A = 'persistent-a';

let db: Database;
let project: Project;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  project = getOrCreateProject(db, 'github.com__example__repo', {
    uuid: PROJECT_UUID,
    highestPlanId: 10,
  });
});

describe('rebuildProjectSettingProjection', () => {
  test('copies canonical setting when there are no active operations', () => {
    writeCanonicalProjectSettingRow(db, project.id, 'color', 'blue', {
      revision: 4,
      updatedByNode: 'main',
    });

    rebuildProjectSettingProjection(db, project.id, 'color');

    expect(getProjectSettingWithMetadata(db, project.id, 'color')).toMatchObject({
      value: 'blue',
      updatedByNode: 'main',
    });
  });

  test('folds one active set operation over canonical', async () => {
    writeCanonicalProjectSettingRow(db, project.id, 'color', 'blue', {
      revision: 4,
      updatedByNode: 'main',
    });
    await enqueueSet('color', 'green');

    rebuildProjectSettingProjection(db, project.id, 'color');

    expect(getProjectSettingWithMetadata(db, project.id, 'color')).toMatchObject({
      value: 'green',
      updatedByNode: NODE_A,
    });
  });

  test('folds multiple operations in origin and local sequence order', async () => {
    writeCanonicalProjectSettingRow(db, project.id, 'color', 'blue', {
      revision: 4,
      updatedByNode: 'main',
    });
    await enqueueSet('color', 'green');
    await enqueueSet('color', 'orange');
    await enqueueDelete('color');
    await enqueueSet('color', 'purple');

    rebuildProjectSettingProjection(db, project.id, 'color');

    expect(getProjectSettingWithMetadata(db, project.id, 'color')?.value).toBe('purple');
  });

  test('projects a set operation against missing canonical state', async () => {
    await enqueueSet('featured', true);

    rebuildProjectSettingProjection(db, project.id, 'featured');

    expect(getProjectSettingWithMetadata(db, project.id, 'featured')?.value).toBe(true);
  });

  test('projects a set operation against absent canonical after local projection is cleared', async () => {
    await enqueueSet('abbreviation', 'TIM');
    db.prepare('DELETE FROM project_setting WHERE project_id = ? AND setting = ?').run(
      project.id,
      'abbreviation'
    );

    rebuildProjectSettingProjection(db, project.id, 'abbreviation');

    expect(getProjectSettingWithMetadata(db, project.id, 'abbreviation')?.value).toBe('TIM');
  });

  test('delete operation collapses projection when no later set remains', async () => {
    writeCanonicalProjectSettingRow(db, project.id, 'color', 'blue', {
      revision: 4,
      updatedByNode: 'main',
    });
    await enqueueDelete('color');

    rebuildProjectSettingProjection(db, project.id, 'color');

    expect(getProjectSettingWithMetadata(db, project.id, 'color')).toBeNull();
  });

  test('skips stale baseRevision on set operation', async () => {
    writeCanonicalProjectSettingRow(db, project.id, 'color', 'blue', {
      revision: 5,
      updatedByNode: 'main',
    });
    await enqueueSet('color', 'green', 4);

    rebuildProjectSettingProjection(db, project.id, 'color');

    expect(getProjectSettingWithMetadata(db, project.id, 'color')).toMatchObject({
      value: 'blue',
      updatedByNode: 'main',
    });
  });

  test('skips stale baseRevision on delete operation', async () => {
    writeCanonicalProjectSettingRow(db, project.id, 'color', 'blue', {
      revision: 5,
      updatedByNode: 'main',
    });
    await enqueueDelete('color', 4);

    rebuildProjectSettingProjection(db, project.id, 'color');

    expect(getProjectSettingWithMetadata(db, project.id, 'color')).toMatchObject({
      value: 'blue',
      updatedByNode: 'main',
    });
  });

  test('skips second operation when stale relative to running projected revision', async () => {
    writeCanonicalProjectSettingRow(db, project.id, 'color', 'blue', {
      revision: 5,
      updatedByNode: 'main',
    });
    await enqueueSet('color', 'green', 5);
    await enqueueSet('color', 'orange', 5);

    rebuildProjectSettingProjection(db, project.id, 'color');

    expect(getProjectSettingWithMetadata(db, project.id, 'color')?.value).toBe('green');
  });

  test('folds chained baseRevision operations', async () => {
    writeCanonicalProjectSettingRow(db, project.id, 'color', 'blue', {
      revision: 5,
      updatedByNode: 'main',
    });
    await enqueueSet('color', 'green', 5);
    await enqueueSet('color', 'orange', 6);

    rebuildProjectSettingProjection(db, project.id, 'color');

    expect(getProjectSettingWithMetadata(db, project.id, 'color')?.value).toBe('orange');
  });

  test('applies operation with undefined baseRevision regardless of canonical revision', async () => {
    writeCanonicalProjectSettingRow(db, project.id, 'color', 'blue', {
      revision: 5,
      updatedByNode: 'main',
    });
    await enqueueSet('color', 'green');

    rebuildProjectSettingProjection(db, project.id, 'color');

    expect(getProjectSettingWithMetadata(db, project.id, 'color')?.value).toBe('green');
  });

  test('ignores terminal operations when rebuilding', async () => {
    writeCanonicalProjectSettingRow(db, project.id, 'color', 'blue', {
      revision: 4,
      updatedByNode: 'main',
    });
    const acked = await enqueueSet('color', 'acked');
    markOperationSending(db, acked.operationUuid);
    markOperationAcked(db, acked.operationUuid, {});
    const conflicted = await enqueueSet('color', 'conflicted');
    markOperationSending(db, conflicted.operationUuid);
    markOperationConflict(db, conflicted.operationUuid, 'conflict-1', {});
    const rejected = await enqueueSet('color', 'rejected');
    markOperationSending(db, rejected.operationUuid);
    markOperationRejected(db, rejected.operationUuid, 'bad setting', {});

    rebuildProjectSettingProjection(db, project.id, 'color');

    expect(getProjectSettingWithMetadata(db, project.id, 'color')?.value).toBe('blue');
  });

  test('includes sending operations during restart-style rebuild', async () => {
    writeCanonicalProjectSettingRow(db, project.id, 'color', 'blue', {
      revision: 4,
      updatedByNode: 'main',
    });
    const op = await enqueueSet('color', 'green');
    markOperationSending(db, op.operationUuid);

    rebuildProjectSettingProjection(db, project.id, 'color');

    expect(getProjectSettingWithMetadata(db, project.id, 'color')?.value).toBe('green');
  });

  test('includes failed_retryable operations in rebuild (post-restart state)', async () => {
    writeCanonicalProjectSettingRow(db, project.id, 'color', 'blue', {
      revision: 4,
      updatedByNode: 'main',
    });
    const op = await enqueueSet('color', 'green');
    markOperationSending(db, op.operationUuid);
    markOperationFailedRetryable(db, op.operationUuid, 'network error');

    rebuildProjectSettingProjection(db, project.id, 'color');

    expect(getProjectSettingWithMetadata(db, project.id, 'color')?.value).toBe('green');
  });
});

async function enqueueSet(setting: string, value: unknown, baseRevision?: number) {
  return enqueueOperation(
    db,
    await setProjectSettingOperation(
      { projectUuid: PROJECT_UUID, setting, value, baseRevision },
      { originNodeId: NODE_A, localSequence: 999 }
    )
  ).operation;
}

async function enqueueDelete(setting: string, baseRevision?: number) {
  return enqueueOperation(
    db,
    await deleteProjectSettingOperation(
      { projectUuid: PROJECT_UUID, setting, baseRevision },
      { originNodeId: NODE_A, localSequence: 999 }
    )
  ).operation;
}
