import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'vitest';
import { runMigrations } from '../db/migrations.js';
import { getOrCreateProject, type Project } from '../db/project.js';
import {
  upsertCanonicalPlanInTransaction,
  upsertProjectionPlanInTransaction,
} from '../db/plan.js';
import {
  getProjectSettingWithMetadata,
  writeCanonicalProjectSettingRow,
} from '../db/project_settings.js';
import { addPlanTagOperation, setProjectSettingOperation } from './operations.js';
import {
  enqueueBatch,
  enqueueOperation,
  markOperationSending,
  mergeCanonicalRefresh,
} from './queue.js';
import { applyOperationResultTransitions } from './result_transitions.js';
import { createBatchEnvelope } from './types.js';

const PROJECT_UUID = '11111111-1111-4111-8111-111111111111';
const PLAN_UUID = '22222222-2222-4222-8222-222222222222';
const TASK_UUID = '33333333-3333-4333-8333-333333333333';
const NODE_A = 'persistent-a';

describe('applyOperationResultTransitions', () => {
  test('applies result transitions for batches with mixed rejected and retryable ops', async () => {
    const db = createDb();
    seedPlan(db);
    const batch = enqueueBatch(
      db,
      createBatchEnvelope({
        originNodeId: NODE_A,
        operations: [
          await addPlanTagOperation(
            PROJECT_UUID,
            { planUuid: PLAN_UUID, tag: 'cause' },
            { originNodeId: NODE_A, localSequence: 0 }
          ),
          await addPlanTagOperation(
            PROJECT_UUID,
            { planUuid: PLAN_UUID, tag: 'sibling' },
            { originNodeId: NODE_A, localSequence: 1 }
          ),
        ],
      })
    );
    for (const row of batch.rows) {
      markOperationSending(db, row.operation_uuid);
    }

    applyOperationResultTransitions(db, [
      {
        operationId: batch.rows[0].operation_uuid,
        status: 'rejected',
        error: 'invalid operation',
      },
      {
        operationId: batch.rows[1].operation_uuid,
        status: 'failed_retryable',
        error: 'batch rolled back',
      },
    ]);

    expect(operationRows(db)).toEqual([
      {
        operation_uuid: batch.rows[0].operation_uuid,
        status: 'rejected',
        batch_id: batch.batch.batchId,
      },
      {
        operation_uuid: batch.rows[1].operation_uuid,
        status: 'failed_retryable',
        batch_id: batch.batch.batchId,
      },
    ]);
  });

  test('preserves whole retryable batches for deferred results', async () => {
    const db = createDb();
    seedPlan(db);
    const batch = enqueueBatch(
      db,
      createBatchEnvelope({
        originNodeId: NODE_A,
        operations: [
          await addPlanTagOperation(
            PROJECT_UUID,
            { planUuid: PLAN_UUID, tag: 'deferred-a' },
            { originNodeId: NODE_A, localSequence: 0 }
          ),
          await addPlanTagOperation(
            PROJECT_UUID,
            { planUuid: PLAN_UUID, tag: 'deferred-b' },
            { originNodeId: NODE_A, localSequence: 1 }
          ),
        ],
      })
    );
    for (const row of batch.rows) {
      markOperationSending(db, row.operation_uuid);
    }

    applyOperationResultTransitions(
      db,
      batch.rows.map((row) => ({
        operationId: row.operation_uuid,
        status: 'deferred',
        error: 'fifo gap',
      }))
    );

    expect(operationRows(db)).toEqual(
      batch.rows.map((row) => ({
        operation_uuid: row.operation_uuid,
        status: 'failed_retryable',
        batch_id: batch.batch.batchId,
      }))
    );
  });

  test('acked project setting drops pending projection until canonical snapshot arrives', async () => {
    const db = createDb();
    const project = seedProject(db);
    const queued = enqueueOperation(
      db,
      await setProjectSettingOperation(
        { projectUuid: PROJECT_UUID, setting: 'color', value: 'green' },
        { originNodeId: NODE_A, localSequence: 0 }
      )
    ).operation;
    markOperationSending(db, queued.operationUuid);

    applyOperationResultTransitions(db, [
      { operationId: queued.operationUuid, status: 'applied', sequenceIds: [1] },
    ]);

    expect(getProjectSettingWithMetadata(db, project.id, 'color')).toBeNull();

    mergeCanonicalRefresh(db, {
      type: 'project_setting',
      projectUuid: PROJECT_UUID,
      setting: 'color',
      value: 'green',
      revision: 1,
      updatedByNode: 'main',
    });

    expect(getProjectSettingWithMetadata(db, project.id, 'color')).toMatchObject({
      value: 'green',
      updatedByNode: 'main',
    });
  });

  test('rejected project setting collapses projection back to canonical', async () => {
    const db = createDb();
    const project = seedProject(db);
    writeCanonicalProjectSettingRow(db, project.id, 'color', 'blue', {
      revision: 4,
      updatedByNode: 'main',
    });
    const queued = enqueueOperation(
      db,
      await setProjectSettingOperation(
        { projectUuid: PROJECT_UUID, setting: 'color', value: 'green' },
        { originNodeId: NODE_A, localSequence: 0 }
      )
    ).operation;
    markOperationSending(db, queued.operationUuid);

    applyOperationResultTransitions(db, [
      { operationId: queued.operationUuid, status: 'rejected', error: 'bad setting' },
    ]);

    expect(getProjectSettingWithMetadata(db, project.id, 'color')).toMatchObject({
      value: 'blue',
      updatedByNode: 'main',
    });
  });

  test('conflicted project setting collapses projection back to canonical', async () => {
    const db = createDb();
    const project = seedProject(db);
    writeCanonicalProjectSettingRow(db, project.id, 'color', 'blue', {
      revision: 4,
      updatedByNode: 'main',
    });
    const queued = enqueueOperation(
      db,
      await setProjectSettingOperation(
        { projectUuid: PROJECT_UUID, setting: 'color', value: 'green' },
        { originNodeId: NODE_A, localSequence: 0 }
      )
    ).operation;
    markOperationSending(db, queued.operationUuid);

    applyOperationResultTransitions(db, [
      { operationId: queued.operationUuid, status: 'conflict', conflictId: 'conflict-1' },
    ]);

    expect(getProjectSettingWithMetadata(db, project.id, 'color')).toMatchObject({
      value: 'blue',
      updatedByNode: 'main',
    });
  });
});

function createDb(): Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function seedPlan(db: Database): void {
  const project = seedProject(db);
  const plan = {
    uuid: PLAN_UUID,
    planId: 1,
    title: 'Sync plan',
    status: 'pending',
    revision: 1,
    tasks: [{ uuid: TASK_UUID, title: 'Task one', description: 'Do it' }],
    forceOverwrite: true,
  };
  upsertCanonicalPlanInTransaction(db, project.id, {
    ...plan,
    tasks: plan.tasks.map((task) => ({ ...task, revision: 1 })),
  });
  upsertProjectionPlanInTransaction(db, project.id, plan);
}

function seedProject(db: Database): Project {
  return getOrCreateProject(db, 'github.com__example__repo', {
    uuid: PROJECT_UUID,
    highestPlanId: 10,
  });
}

function operationRows(db: Database) {
  return db
    .prepare(
      `SELECT operation_uuid, status, batch_id
       FROM sync_operation
       ORDER BY local_sequence`
    )
    .all() as Array<{
    operation_uuid: string;
    status: string;
    batch_id: string | null;
  }>;
}
