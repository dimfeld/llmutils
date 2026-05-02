import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'vitest';
import { runMigrations } from '../db/migrations.js';
import { getOrCreateProject, type Project } from '../db/project.js';
import {
  getPlanByUuid,
  getPlanDependenciesByUuid,
  getPlanTagsByUuid,
  getPlanTasksByUuid,
  upsertCanonicalPlanInTransaction,
  upsertProjectionPlanInTransaction,
} from '../db/plan.js';
import {
  getProjectSettingWithMetadata,
  writeCanonicalProjectSettingRow,
} from '../db/project_settings.js';
import {
  addPlanTagOperation,
  deletePlanOperation,
  promotePlanTaskOperation,
  setPlanParentOperation,
  setProjectSettingOperation,
} from './operations.js';
import {
  enqueueBatch,
  enqueueOperation,
  markOperationSending,
} from './queue.js';
import { mergeCanonicalRefresh } from './snapshots.js';
import { applyOperationResultTransitions } from './result_transitions.js';
import { createBatchEnvelope } from './types.js';

const PROJECT_UUID = '11111111-1111-4111-8111-111111111111';
const PLAN_UUID = '22222222-2222-4222-8222-222222222222';
const PARENT_PLAN_UUID = '44444444-4444-4444-8444-444444444444';
const TASK_UUID = '33333333-3333-4333-8333-333333333333';
const PARENT_TASK_UUID = '55555555-5555-4555-8555-555555555555';
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

  test('terminal plan result rebuilds projection from remaining active ops', async () => {
    const db = createDb();
    seedPlan(db);
    const rejected = enqueueOperation(
      db,
      await addPlanTagOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, tag: 'rejected-tag' },
        { originNodeId: NODE_A, localSequence: 0 }
      )
    ).operation;
    const retryable = enqueueOperation(
      db,
      await addPlanTagOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, tag: 'still-active' },
        { originNodeId: NODE_A, localSequence: 1 }
      )
    ).operation;
    markOperationSending(db, rejected.operationUuid);
    markOperationSending(db, retryable.operationUuid);

    expect(
      getPlanTagsByUuid(db, PLAN_UUID)
        .map((tag) => tag.tag)
        .sort()
    ).toEqual(['rejected-tag', 'still-active']);

    applyOperationResultTransitions(db, [
      { operationId: rejected.operationUuid, status: 'rejected', error: 'bad tag' },
      {
        operationId: retryable.operationUuid,
        status: 'failed_retryable',
        error: 'transport failed',
      },
    ]);

    expect(getPlanTagsByUuid(db, PLAN_UUID).map((tag) => tag.tag)).toEqual(['still-active']);
  });

  test('terminal plan.delete result rebuilds inbound owner projections', async () => {
    const db = createDb();
    seedPlan(db, PLAN_UUID, 1, TASK_UUID);
    seedPlan(db, PARENT_PLAN_UUID, 2, PARENT_TASK_UUID);
    db.prepare(
      'INSERT INTO plan_dependency_canonical (plan_uuid, depends_on_uuid) VALUES (?, ?)'
    ).run(PARENT_PLAN_UUID, PLAN_UUID);
    db.prepare('INSERT INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES (?, ?)').run(
      PARENT_PLAN_UUID,
      PLAN_UUID
    );

    const queued = enqueueOperation(
      db,
      await deletePlanOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID },
        { originNodeId: NODE_A, localSequence: 0 }
      )
    ).operation;
    markOperationSending(db, queued.operationUuid);

    expect(getPlanByUuid(db, PLAN_UUID)).toBeNull();
    expect(getPlanDependenciesByUuid(db, PARENT_PLAN_UUID)).toEqual([]);

    applyOperationResultTransitions(db, [
      { operationId: queued.operationUuid, status: 'rejected', error: 'cannot delete' },
    ]);

    expect(getPlanByUuid(db, PLAN_UUID)).not.toBeNull();
    expect(
      getPlanDependenciesByUuid(db, PARENT_PLAN_UUID).map((dep) => dep.depends_on_uuid)
    ).toEqual([PLAN_UUID]);
  });

  test('acked plan op drops its effect from projection until canonical snapshot arrives', async () => {
    // After ack, the op is terminal; projection is rebuilt without it. The data
    // reappears when the canonical snapshot merges. Briefly missing is acceptable.
    const db = createDb();
    seedPlan(db);
    const queued = enqueueOperation(
      db,
      await addPlanTagOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, tag: 'optimistic-tag' },
        { originNodeId: NODE_A, localSequence: 0 }
      )
    ).operation;
    markOperationSending(db, queued.operationUuid);

    expect(getPlanTagsByUuid(db, PLAN_UUID).map((t) => t.tag)).toContain('optimistic-tag');

    applyOperationResultTransitions(db, [
      { operationId: queued.operationUuid, status: 'applied', sequenceIds: [1], invalidations: [] },
    ]);

    // Tag optimistically disappeared (op is now terminal, projection rebuilt)
    expect(getPlanTagsByUuid(db, PLAN_UUID).map((t) => t.tag)).not.toContain('optimistic-tag');
    // Plan itself is still present (canonical still has it)
    expect(getPlanByUuid(db, PLAN_UUID)).not.toBeNull();

    // Canonical snapshot arrives with the tag confirmed
    mergeCanonicalRefresh(db, {
      type: 'plan',
      projectUuid: PROJECT_UUID,
      plan: {
        uuid: PLAN_UUID,
        planId: 1,
        title: 'Sync plan',
        goal: null,
        note: null,
        details: null,
        status: 'pending',
        priority: null,
        branch: null,
        simple: null,
        tdd: null,
        discoveredFrom: null,
        issue: null,
        pullRequest: null,
        assignedTo: null,
        baseBranch: null,
        temp: null,
        docs: null,
        changedFiles: null,
        planGeneratedAt: null,
        reviewIssues: null,
        parentUuid: null,
        epic: false,
        revision: 2,
        tasks: [],
        tags: ['optimistic-tag'],
        dependencyUuids: [],
      },
    });

    expect(getPlanTagsByUuid(db, PLAN_UUID).map((t) => t.tag)).toContain('optimistic-tag');
  });

  test('set_parent rejection rebuilds target, new parent, and previous parent projections', async () => {
    // set_parent affects three plans: target (whose parent changes), new parent
    // (gains a child dependency), and previous parent (loses a child dependency).
    // All three must be rebuilt when the op is rejected.
    const db = createDb();
    const NEW_PARENT_UUID = '55555555-5555-4555-8555-555555555555';
    const PREV_PARENT_UUID = '66666666-6666-4666-8666-666666666666';
    const NEW_PARENT_TASK = '77777777-7777-4777-8777-777777777777';
    const PREV_PARENT_TASK = '88888888-8888-4888-8888-888888888888';
    seedPlan(db, PLAN_UUID, 1, TASK_UUID);
    seedPlan(db, NEW_PARENT_UUID, 2, NEW_PARENT_TASK);
    seedPlan(db, PREV_PARENT_UUID, 3, PREV_PARENT_TASK);

    // Set up canonical state: PLAN_UUID has PREV_PARENT_UUID as its parent
    db.prepare('UPDATE plan_canonical SET parent_uuid = ? WHERE uuid = ?').run(
      PREV_PARENT_UUID,
      PLAN_UUID
    );
    db.prepare('UPDATE plan SET parent_uuid = ? WHERE uuid = ?').run(PREV_PARENT_UUID, PLAN_UUID);
    db.prepare(
      'INSERT INTO plan_dependency_canonical (plan_uuid, depends_on_uuid) VALUES (?, ?)'
    ).run(PREV_PARENT_UUID, PLAN_UUID);
    db.prepare('INSERT INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES (?, ?)').run(
      PREV_PARENT_UUID,
      PLAN_UUID
    );

    const queued = enqueueOperation(
      db,
      await setPlanParentOperation(
        PROJECT_UUID,
        {
          planUuid: PLAN_UUID,
          newParentUuid: NEW_PARENT_UUID,
          previousParentUuid: PREV_PARENT_UUID,
        },
        { originNodeId: NODE_A, localSequence: 0 }
      )
    ).operation;
    markOperationSending(db, queued.operationUuid);

    // After enqueue, projection reflects the set_parent: new parent has the dep, prev parent lost it
    expect(getPlanDependenciesByUuid(db, NEW_PARENT_UUID).map((d) => d.depends_on_uuid)).toContain(
      PLAN_UUID
    );
    expect(
      getPlanDependenciesByUuid(db, PREV_PARENT_UUID).map((d) => d.depends_on_uuid)
    ).not.toContain(PLAN_UUID);

    applyOperationResultTransitions(db, [
      { operationId: queued.operationUuid, status: 'rejected', error: 'parent conflict' },
    ]);

    // All three projections rebuilt from canonical: new parent loses the dep, prev parent regains it
    expect(
      getPlanDependenciesByUuid(db, NEW_PARENT_UUID).map((d) => d.depends_on_uuid)
    ).not.toContain(PLAN_UUID);
    expect(getPlanDependenciesByUuid(db, PREV_PARENT_UUID).map((d) => d.depends_on_uuid)).toContain(
      PLAN_UUID
    );
    // Target plan's parent_uuid reverts to canonical
    expect(getPlanByUuid(db, PLAN_UUID)).toMatchObject({ parent_uuid: PREV_PARENT_UUID });
  });

  test('promote_task rejection rebuilds source and destination plan projections', async () => {
    // promote_task creates a destination plan and removes a task from the source.
    // When rejected, both projections must be rebuilt: destination disappears,
    // source task is restored.
    const db = createDb();
    const NEW_PLAN_UUID = '55555555-5555-4555-8555-555555555555';
    seedPlan(db, PLAN_UUID, 1, TASK_UUID);

    const queued = enqueueOperation(
      db,
      await promotePlanTaskOperation(
        PROJECT_UUID,
        {
          sourcePlanUuid: PLAN_UUID,
          taskUuid: TASK_UUID,
          newPlanUuid: NEW_PLAN_UUID,
          title: 'Promoted task',
        },
        { originNodeId: NODE_A, localSequence: 0 }
      )
    ).operation;
    markOperationSending(db, queued.operationUuid);

    // Destination plan created optimistically
    expect(getPlanByUuid(db, NEW_PLAN_UUID)).not.toBeNull();
    // Task is marked done in source plan (promote_task marks the task done, not removes it)
    expect(getPlanTasksByUuid(db, PLAN_UUID).find((t) => t.uuid === TASK_UUID)?.done).toBe(1);

    applyOperationResultTransitions(db, [
      { operationId: queued.operationUuid, status: 'rejected', error: 'promote not allowed' },
    ]);

    // Destination plan removed (no active op creates it)
    expect(getPlanByUuid(db, NEW_PLAN_UUID)).toBeNull();
    // Source task reverted to not-done (projection rebuilt from canonical, where done=0)
    expect(getPlanTasksByUuid(db, PLAN_UUID).find((t) => t.uuid === TASK_UUID)?.done).toBe(0);
  });
});

function createDb(): Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function seedPlan(db: Database, planUuid = PLAN_UUID, planId = 1, taskUuid = TASK_UUID): void {
  const project = seedProject(db);
  const plan = {
    uuid: planUuid,
    planId,
    title: 'Sync plan',
    status: 'pending',
    revision: 1,
    tasks: [{ uuid: taskUuid, title: 'Task one', description: 'Do it' }],
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
