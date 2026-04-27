import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'vitest';
import { runMigrations } from '../db/migrations.js';
import { getOrCreateProject } from '../db/project.js';
import { upsertPlan } from '../db/plan.js';
import { addPlanTagOperation } from './operations.js';
import { enqueueBatch, markOperationSending } from './queue.js';
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
});

function createDb(): Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function seedPlan(db: Database): void {
  const project = getOrCreateProject(db, 'github.com__example__repo', {
    uuid: PROJECT_UUID,
    highestPlanId: 10,
  });
  upsertPlan(db, project.id, {
    uuid: PLAN_UUID,
    planId: 1,
    title: 'Sync plan',
    status: 'pending',
    tasks: [{ uuid: TASK_UUID, title: 'Task one', description: 'Do it' }],
    forceOverwrite: true,
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
