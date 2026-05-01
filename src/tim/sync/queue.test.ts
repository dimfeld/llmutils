import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { getAssignment, importAssignment } from '../db/assignment.js';
import { runMigrations } from '../db/migrations.js';
import { getOrCreateProject, type Project } from '../db/project.js';
import {
  getPlanByUuid,
  getPlanDependenciesByUuid,
  getPlanTagsByUuid,
  getPlanTasksByUuid,
  upsertPlan,
} from '../db/plan.js';
import { getProjectSettingWithMetadata } from '../db/project_settings.js';
import { applyOperation } from './apply.js';
import {
  addPlanDependencyOperation,
  addPlanListItemOperation,
  addPlanTagOperation,
  addPlanTaskOperation,
  createPlanOperation,
  deletePlanOperation,
  deleteProjectSettingOperation,
  markPlanTaskDoneOperation,
  patchPlanTextOperation,
  promotePlanTaskOperation,
  removePlanDependencyOperation,
  removePlanTagOperation,
  setPlanParentOperation,
  setPlanScalarOperation,
  setProjectSettingOperation,
  updatePlanTaskTextOperation,
} from './operations.js';
import {
  enqueueBatch,
  enqueueOperation,
  getPendingRollbackKeys,
  getSyncConflictSummary,
  getSyncQueueSummary,
  listPendingOperations,
  markOperationAcked,
  markOperationConflict,
  markOperationFailedRetryable,
  markOperationRejected,
  markOperationSending,
  mergeCanonicalRefresh,
  pruneAcknowledgedOperations,
  resetSendingOperations,
  subscribeToQueueChanges,
  type CanonicalPlanSnapshot,
  type QueueableOperation,
} from './queue.js';
import { createSyncConflict } from './conflicts.js';
import { createBatchEnvelope } from './types.js';

const PROJECT_UUID = '11111111-1111-4111-8111-111111111111';
const OTHER_PROJECT_UUID = '99999999-9999-4999-8999-999999999111';
const PLAN_UUID = '22222222-2222-4222-8222-222222222222';
const OTHER_PLAN_UUID = '33333333-3333-4333-8333-333333333333';
const TASK_UUID = '44444444-4444-4444-8444-444444444444';
const TASK_UUID_2 = '55555555-5555-4555-8555-555555555555';
const TASK_UUID_3 = '88888888-8888-4888-8888-888888888888';
const TASK_UUID_4 = '99999999-9999-4999-8999-999999999999';
const OLD_PARENT_TASK_UUID = '66666666-6666-4666-8666-666666666666';
const NEW_PARENT_TASK_UUID = '77777777-7777-4777-8777-777777777777';
const NODE_A = 'persistent-a';
const NODE_B = 'persistent-b';

let db: Database;
let project: Project;

beforeEach(() => {
  db = createDb();
  project = getOrCreateProject(db, 'github.com__example__repo', {
    uuid: PROJECT_UUID,
    highestPlanId: 10,
  });
});

function createDb(): Database {
  const nextDb = new Database(':memory:');
  runMigrations(nextDb);
  return nextDb;
}

function seedPlan(targetDb = db, uuid = PLAN_UUID, planId = 1, taskUuid = TASK_UUID): void {
  const targetProject =
    getOrCreateProject(targetDb, 'github.com__example__repo', {
      uuid: PROJECT_UUID,
      highestPlanId: 10,
    }) ?? project;
  upsertPlan(targetDb, targetProject.id, {
    uuid,
    planId,
    title: `Plan ${planId}`,
    details: 'alpha\nbeta\ngamma\n',
    status: 'pending',
    tasks: [{ uuid: taskUuid, title: 'Task one', description: 'old description' }],
    forceOverwrite: true,
  });
}

function seedAssignment(planUuid = PLAN_UUID): void {
  importAssignment(
    db,
    project.id,
    planUuid,
    1,
    null,
    'agent',
    'in_progress',
    '2026-01-01T00:00:00.000Z',
    '2026-01-01T00:00:00.000Z'
  );
}

function enqueue(op: QueueableOperation) {
  return enqueueOperation(db, op).operation;
}

async function tagOp(tag: string, node = NODE_A) {
  return addPlanTagOperation(
    PROJECT_UUID,
    { planUuid: PLAN_UUID, tag },
    { originNodeId: node, localSequence: 999 }
  );
}

async function tagOpForPlan(projectUuid: string, planUuid: string, tag: string, node = NODE_A) {
  return addPlanTagOperation(
    projectUuid,
    { planUuid, tag },
    { originNodeId: node, localSequence: 999 }
  );
}

async function settingOp(projectUuid: string, setting: string, node = NODE_A) {
  return setProjectSettingOperation(
    { projectUuid, setting, value: true },
    { originNodeId: node, localSequence: 999 }
  );
}

function opRows() {
  return db
    .prepare(
      'SELECT operation_uuid, origin_node_id, local_sequence, status FROM sync_operation ORDER BY origin_node_id, local_sequence'
    )
    .all() as Array<{
    operation_uuid: string;
    origin_node_id: string;
    local_sequence: number;
    status: string;
  }>;
}

function operationRow(operationUuid: string) {
  return db.prepare('SELECT * FROM sync_operation WHERE operation_uuid = ?').get(operationUuid) as {
    operation_uuid: string;
    status: string;
    attempts: number;
    last_error: string | null;
    ack_metadata: string | null;
  };
}

function taskOrder(planUuid = PLAN_UUID) {
  return getPlanTasksByUuid(db, planUuid).map((task) => [task.uuid, task.task_index]);
}

function planSnapshotFromDb(targetDb: Database, planUuid = PLAN_UUID): CanonicalPlanSnapshot {
  const plan = getPlanByUuid(targetDb, planUuid);
  if (!plan) {
    throw new Error(`Missing plan ${planUuid}`);
  }
  return {
    type: 'plan',
    projectUuid: PROJECT_UUID,
    plan: {
      uuid: plan.uuid,
      planId: plan.plan_id,
      title: plan.title,
      goal: plan.goal,
      note: plan.note,
      details: plan.details,
      status: plan.status,
      priority: plan.priority,
      branch: plan.branch,
      simple: nullableBoolean(plan.simple),
      tdd: nullableBoolean(plan.tdd),
      discoveredFrom: plan.discovered_from,
      parentUuid: plan.parent_uuid,
      epic: Boolean(plan.epic),
      revision: plan.revision,
      issue: parseStringArray(plan.issue),
      pullRequest: parseStringArray(plan.pull_request),
      assignedTo: plan.assigned_to,
      baseBranch: plan.base_branch,
      temp: nullableBoolean(plan.temp),
      docs: parseStringArray(plan.docs),
      changedFiles: parseStringArray(plan.changed_files),
      planGeneratedAt: plan.plan_generated_at,
      reviewIssues: parseUnknownArray(plan.review_issues),
      tasks: getPlanTasksByUuid(targetDb, planUuid).map((task) => ({
        uuid: task.uuid ?? crypto.randomUUID(),
        title: task.title,
        description: task.description,
        done: Boolean(task.done),
        revision: task.revision,
      })),
      dependencyUuids: getPlanDependenciesByUuid(targetDb, planUuid).map(
        (dependency) => dependency.depends_on_uuid
      ),
      tags: getPlanTagsByUuid(targetDb, planUuid).map((tag) => tag.tag),
    },
  };
}

function canonicalPlanSnapshot(
  plan: Partial<CanonicalPlanSnapshot['plan']> &
    Pick<CanonicalPlanSnapshot['plan'], 'uuid' | 'planId'>
): CanonicalPlanSnapshot {
  return {
    type: 'plan',
    projectUuid: PROJECT_UUID,
    plan: {
      title: null,
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
      revision: 1,
      tasks: [],
      dependencyUuids: [],
      tags: [],
      ...plan,
    },
  };
}

function nullableBoolean(value: number | null): boolean | null {
  return value === null ? null : Boolean(value);
}

function parseStringArray(value: string | null): string[] | null {
  if (!value) {
    return null;
  }
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error(`Expected string array JSON, received ${value}`);
  }
  return parsed;
}

function parseUnknownArray(value: string | null): unknown[] | null {
  if (!value) {
    return null;
  }
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected array JSON, received ${value}`);
  }
  return parsed;
}

describe('persistent-node sync queue', () => {
  test('enqueueBatch rolls back queued rows and optimistic state when an optimistic operation fails', async () => {
    seedPlan();
    const tag = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'queued' },
      { originNodeId: NODE_A, localSequence: 0 }
    );
    const invalidTask = await addPlanTaskOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, title: 'duplicate operation uuid' },
      { operationUuid: tag.operationUuid, originNodeId: NODE_A, localSequence: 1 }
    );

    expect(() =>
      enqueueBatch(
        db,
        createBatchEnvelope({
          batchId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          originNodeId: NODE_A,
          operations: [tag, invalidTask],
        })
      )
    ).toThrow();
    expect(listPendingOperations(db, { originNodeId: NODE_A })).toEqual([]);
    expect(getPlanTagsByUuid(db, PLAN_UUID)).toEqual([]);
  });

  test('sequence allocation is contiguous per origin and starts at 0', async () => {
    seedPlan();

    const first = enqueue(await tagOp('one'));
    const second = enqueue(await tagOp('two'));
    const third = enqueue(await tagOp('other-node', NODE_B));

    expect(first.localSequence).toBe(0);
    expect(second.localSequence).toBe(1);
    expect(third.localSequence).toBe(0);
    expect(opRows().map((row) => [row.origin_node_id, row.local_sequence])).toEqual([
      [NODE_A, 0],
      [NODE_A, 1],
      [NODE_B, 0],
    ]);
  });

  test('back-to-back enqueue transactions do not skip or duplicate sequences', async () => {
    seedPlan();

    for (let index = 0; index < 5; index += 1) {
      enqueue(await tagOp(`tag-${index}`));
    }

    expect(opRows().map((row) => row.local_sequence)).toEqual([0, 1, 2, 3, 4]);
  });

  test('sequence allocation survives pruning acknowledged rows', async () => {
    seedPlan();
    const first = enqueue(await tagOp('before-prune'));
    markOperationSending(db, first.operationUuid);
    markOperationAcked(db, first.operationUuid, {});
    db.prepare('UPDATE sync_operation SET acked_at = ? WHERE operation_uuid = ?').run(
      '2026-01-01T00:00:00.000Z',
      first.operationUuid
    );

    expect(
      pruneAcknowledgedOperations(db, { olderThan: new Date('2026-01-02T00:00:00.000Z') })
    ).toBe(1);

    const second = enqueue(await tagOp('after-prune'));
    expect(second.localSequence).toBe(1);
  });

  test('post-prune operations keep converging with the main node FIFO floor', async () => {
    seedPlan();
    const mainDb = createDb();
    getOrCreateProject(mainDb, 'github.com__example__repo', {
      uuid: PROJECT_UUID,
      highestPlanId: 10,
    });
    seedPlan(mainDb);

    const first = enqueue(await tagOp('before-prune'));
    markOperationSending(db, first.operationUuid);
    const firstResult = applyOperation(mainDb, first);
    expect(firstResult.status).toBe('applied');
    markOperationAcked(db, first.operationUuid, firstResult);
    db.prepare('UPDATE sync_operation SET acked_at = ? WHERE operation_uuid = ?').run(
      '2026-01-01T00:00:00.000Z',
      first.operationUuid
    );
    pruneAcknowledgedOperations(db, { olderThan: new Date('2026-01-02T00:00:00.000Z') });

    const second = enqueue(await tagOp('after-prune'));
    markOperationSending(db, second.operationUuid);
    const secondResult = applyOperation(mainDb, second);

    expect(second.localSequence).toBe(1);
    expect(secondResult.status).toBe('applied');
    expect(
      getPlanTagsByUuid(mainDb, PLAN_UUID)
        .map((tag) => tag.tag)
        .sort()
    ).toEqual(['after-prune', 'before-prune']);
  });

  test('optimistic apply mutates local plan and project setting state', async () => {
    seedPlan();
    seedPlan(db, OTHER_PLAN_UUID, 2, '66666666-6666-4666-8666-666666666666');

    enqueue(await tagOp('sync'));
    enqueue(
      await addPlanDependencyOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, dependsOnPlanUuid: OTHER_PLAN_UUID },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );
    enqueue(
      await markPlanTaskDoneOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, taskUuid: TASK_UUID, done: true },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );
    enqueue(
      await addPlanTaskOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, taskUuid: TASK_UUID_2, title: 'Task two', description: 'new' },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );
    enqueue(
      await patchPlanTextOperation(
        PROJECT_UUID,
        {
          planUuid: PLAN_UUID,
          field: 'details',
          base: 'alpha\nbeta\ngamma\n',
          new: 'alpha\nbeta updated\ngamma\n',
        },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );
    enqueue(
      await setProjectSettingOperation(
        { projectUuid: PROJECT_UUID, setting: 'color', value: 'blue' },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );

    expect(getPlanTagsByUuid(db, PLAN_UUID).map((tag) => tag.tag)).toEqual(['sync']);
    expect(getPlanDependenciesByUuid(db, PLAN_UUID).map((dep) => dep.depends_on_uuid)).toEqual([
      OTHER_PLAN_UUID,
    ]);
    expect(getPlanTasksByUuid(db, PLAN_UUID).map((task) => [task.uuid, task.done])).toEqual([
      [TASK_UUID, 1],
      [TASK_UUID_2, 0],
    ]);
    expect(getPlanByUuid(db, PLAN_UUID)?.details).toBe('alpha\nbeta updated\ngamma\n');
    expect(getProjectSettingWithMetadata(db, project.id, 'color')?.value).toBe('blue');
  });

  test('optimistic plan.create allocates after project highest_plan_id when plan rows lag', async () => {
    db.prepare('UPDATE project SET highest_plan_id = 7 WHERE id = ?').run(project.id);
    const planUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const op = await createPlanOperation(
      {
        projectUuid: PROJECT_UUID,
        planUuid,
        title: 'Offline plan',
      },
      { originNodeId: NODE_A, localSequence: 999 }
    );

    enqueue(op);

    expect(getPlanByUuid(db, planUuid)?.plan_id).toBe(8);
  });

  test('optimistic add_task inserts at the beginning without task_index collisions', async () => {
    seedPlan();
    db.prepare(
      'INSERT INTO plan_task (uuid, plan_uuid, task_index, title, description, done, revision) VALUES (?, ?, ?, ?, ?, 0, 1)'
    ).run(TASK_UUID_3, PLAN_UUID, 1, 'Second task', '');

    enqueue(
      await addPlanTaskOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, taskUuid: TASK_UUID_2, taskIndex: 0, title: 'Inserted first' },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );

    expect(taskOrder()).toEqual([
      [TASK_UUID_2, 0],
      [TASK_UUID, 1],
      [TASK_UUID_3, 2],
    ]);
  });

  test('optimistic add_task inserts in the middle without task_index collisions', async () => {
    seedPlan();
    db.prepare(
      'INSERT INTO plan_task (uuid, plan_uuid, task_index, title, description, done, revision) VALUES (?, ?, ?, ?, ?, 0, 1)'
    ).run(TASK_UUID_2, PLAN_UUID, 1, 'Second task', '');
    db.prepare(
      'INSERT INTO plan_task (uuid, plan_uuid, task_index, title, description, done, revision) VALUES (?, ?, ?, ?, ?, 0, 1)'
    ).run(TASK_UUID_3, PLAN_UUID, 2, 'Third task', '');

    enqueue(
      await addPlanTaskOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, taskUuid: TASK_UUID_4, taskIndex: 1, title: 'Inserted middle' },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );

    expect(taskOrder()).toEqual([
      [TASK_UUID, 0],
      [TASK_UUID_4, 1],
      [TASK_UUID_2, 2],
      [TASK_UUID_3, 3],
    ]);
  });

  test('optimistic apply skips missing local targets while keeping the operation queued', async () => {
    const op = enqueue(await tagOp('later'));

    expect(getPlanTagsByUuid(db, PLAN_UUID)).toEqual([]);
    expect(op.localSequence).toBe(0);
    expect(listPendingOperations(db).map((row) => row.operation_uuid)).toEqual([op.operationUuid]);
  });

  test('status transitions reject illegal moves', async () => {
    seedPlan();
    const op = enqueue(await tagOp('sync'));

    expect(() => markOperationAcked(db, op.operationUuid, {})).toThrow(
      /Illegal sync_operation transition queued -> acked/
    );

    markOperationSending(db, op.operationUuid);
    markOperationAcked(db, op.operationUuid, { sequenceIds: [1] });

    expect(() => markOperationSending(db, op.operationUuid)).toThrow(
      /Illegal sync_operation transition acked -> sending/
    );
  });

  test('terminal result transitions absorb rows reset to failed_retryable during recovery', async () => {
    seedPlan();
    const acked = enqueue(await tagOp('acked-after-reset'));
    const conflicted = enqueue(await tagOp('conflict-after-reset'));
    const rejected = enqueue(await tagOp('rejected-after-reset'));

    for (const operation of [acked, conflicted, rejected]) {
      markOperationSending(db, operation.operationUuid);
    }
    const reset = resetSendingOperations(db);
    expect(reset.map((row) => row.status)).toEqual([
      'failed_retryable',
      'failed_retryable',
      'failed_retryable',
    ]);

    markOperationAcked(db, acked.operationUuid, { sequenceIds: [1], invalidations: ['plan:x'] });
    markOperationConflict(db, conflicted.operationUuid, 'conflict-1', {
      sequenceIds: [],
      invalidations: [],
    });
    markOperationRejected(db, rejected.operationUuid, 'bad operation', {
      sequenceIds: [],
      invalidations: [],
    });

    const ackedRow = operationRow(acked.operationUuid);
    expect(ackedRow.status).toBe('acked');
    expect(ackedRow.attempts).toBe(0);
    expect(JSON.parse(ackedRow.ack_metadata ?? '{}')).toEqual({
      sequenceIds: [1],
      invalidations: ['plan:x'],
    });
    expect(operationRow(conflicted.operationUuid).status).toBe('conflict');
    expect(JSON.parse(operationRow(conflicted.operationUuid).ack_metadata ?? '{}')).toEqual({
      sequenceIds: [],
      invalidations: [],
      conflictId: 'conflict-1',
    });
    const rejectedRow = operationRow(rejected.operationUuid);
    expect(rejectedRow.status).toBe('rejected');
    expect(rejectedRow.last_error).toBe('bad operation');
    expect(JSON.parse(rejectedRow.ack_metadata ?? '{}')).toEqual({
      sequenceIds: [],
      invalidations: [],
      error: 'bad operation',
    });
  });

  test('markOperationAcked still tolerates already terminal rows without overwriting metadata', async () => {
    seedPlan();
    const op = enqueue(await tagOp('already-terminal'));
    markOperationSending(db, op.operationUuid);
    markOperationAcked(db, op.operationUuid, { sequenceIds: [1] });

    expect(() => markOperationAcked(db, op.operationUuid, { sequenceIds: [2] })).not.toThrow();
    expect(operationRow(op.operationUuid).status).toBe('acked');
    expect(JSON.parse(operationRow(op.operationUuid).ack_metadata ?? '{}')).toEqual({
      sequenceIds: [1],
    });
  });

  test('listPendingOperations returns queued and failed_retryable in origin sequence order', async () => {
    seedPlan();
    const b = enqueue(await tagOp('b', NODE_B));
    const a0 = enqueue(await tagOp('a0', NODE_A));
    const a1 = enqueue(await tagOp('a1', NODE_A));
    const a2 = enqueue(await tagOp('a2', NODE_A));

    markOperationSending(db, a1.operationUuid);
    markOperationFailedRetryable(db, a1.operationUuid, new Error('network down'));
    markOperationSending(db, a2.operationUuid);

    expect(listPendingOperations(db).map((row) => row.operation_uuid)).toEqual([
      a0.operationUuid,
      a1.operationUuid,
      b.operationUuid,
    ]);
    expect(
      listPendingOperations(db, { originNodeId: NODE_B }).map((row) => row.operation_uuid)
    ).toEqual([b.operationUuid]);
  });

  test('queue change subscribers fire after enqueue and retryable transitions', async () => {
    seedPlan();
    const listener = vi.fn();
    const unsubscribe = subscribeToQueueChanges(listener);

    const op = enqueue(await tagOp('notify'));
    expect(listener).toHaveBeenCalledTimes(1);

    markOperationSending(db, op.operationUuid);
    expect(listener).toHaveBeenCalledTimes(1);

    markOperationFailedRetryable(db, op.operationUuid, new Error('network down'));
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    enqueue(await tagOp('after-unsubscribe'));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  test('resetSendingOperations makes crash-stranded sending rows retryable', async () => {
    seedPlan();
    const op = enqueue(await tagOp('stranded'));
    markOperationSending(db, op.operationUuid);
    db.prepare('UPDATE sync_operation SET attempts = 3 WHERE operation_uuid = ?').run(
      op.operationUuid
    );

    const reset = resetSendingOperations(db);

    expect(reset).toMatchObject([
      {
        operation_uuid: op.operationUuid,
        status: 'failed_retryable',
        attempts: 3,
        local_sequence: 0,
      },
    ]);
    expect(listPendingOperations(db).map((row) => row.operation_uuid)).toEqual([op.operationUuid]);
  });

  test('resetSendingOperations notifies subscribers when rows become flushable', async () => {
    seedPlan();
    const listener = vi.fn();
    const unsubscribe = subscribeToQueueChanges(listener);
    const op = enqueue(await tagOp('stranded-notify'));
    listener.mockClear();
    markOperationSending(db, op.operationUuid);

    resetSendingOperations(db);
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  test('pruneAcknowledgedOperations removes only old acked records', async () => {
    seedPlan();
    const oldAck = enqueue(await tagOp('old-ack'));
    const recentAck = enqueue(await tagOp('recent-ack'));
    const conflict = enqueue(await tagOp('conflict'));
    const rejected = enqueue(await tagOp('rejected'));
    const failed = enqueue(await tagOp('failed'));

    for (const op of [oldAck, recentAck, conflict, rejected, failed]) {
      markOperationSending(db, op.operationUuid);
    }
    markOperationAcked(db, oldAck.operationUuid, {});
    markOperationAcked(db, recentAck.operationUuid, {});
    markOperationConflict(db, conflict.operationUuid, 'conflict-1', {});
    markOperationRejected(db, rejected.operationUuid, 'bad op', {});
    markOperationFailedRetryable(db, failed.operationUuid, 'network');

    db.prepare('UPDATE sync_operation SET acked_at = ? WHERE operation_uuid = ?').run(
      '2026-01-01T00:00:00.000Z',
      oldAck.operationUuid
    );
    db.prepare('UPDATE sync_operation SET acked_at = ? WHERE operation_uuid = ?').run(
      '2026-01-03T12:00:00.000Z',
      recentAck.operationUuid
    );
    db.prepare('UPDATE sync_operation SET acked_at = ? WHERE status IN (?, ?)').run(
      '2026-01-01T00:00:00.000Z',
      'conflict',
      'rejected'
    );

    expect(
      pruneAcknowledgedOperations(db, { olderThan: new Date('2026-01-02T00:00:00.000Z') })
    ).toBe(1);

    expect(
      db
        .prepare('SELECT status FROM sync_operation ORDER BY local_sequence')
        .all()
        .map((row) => (row as { status: string }).status)
    ).toEqual(['acked', 'conflict', 'rejected', 'failed_retryable']);
  });

  test('mergeCanonicalRefresh writes canonical state and layers still-pending ops', async () => {
    seedPlan();
    const ackedTag = enqueue(await tagOp('canonical'));
    const pendingText = enqueue(
      await patchPlanTextOperation(
        PROJECT_UUID,
        {
          planUuid: PLAN_UUID,
          field: 'details',
          base: 'main canonical\n',
          new: 'main canonical\nlocal pending\n',
        },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );
    markOperationSending(db, ackedTag.operationUuid);
    markOperationAcked(db, ackedTag.operationUuid, { sequenceIds: [1] });

    mergeCanonicalRefresh(
      db,
      canonicalPlanSnapshot({
        uuid: PLAN_UUID,
        planId: 1,
        title: 'Canonical title',
        details: 'main canonical\n',
        status: 'in_progress',
        revision: 12,
        tasks: [
          { uuid: TASK_UUID, title: 'Task one', description: 'server', done: false, revision: 7 },
        ],
        tags: ['canonical'],
        dependencyUuids: [],
      })
    );

    expect(pendingText.localSequence).toBe(1);
    expect(getPlanByUuid(db, PLAN_UUID)).toMatchObject({
      title: 'Canonical title',
      status: 'in_progress',
      details: 'main canonical\nlocal pending\n',
    });
    expect(getPlanTagsByUuid(db, PLAN_UUID).map((tag) => tag.tag)).toEqual(['canonical']);
    expect(getPlanTasksByUuid(db, PLAN_UUID)[0]).toMatchObject({
      title: 'Task one',
      description: 'server',
      revision: 7,
    });
  });

  test('mergeCanonicalRefresh preserves local base tracking fields', () => {
    seedPlan();
    db.prepare('UPDATE plan SET base_commit = ?, base_change_id = ? WHERE uuid = ?').run(
      'local-base-commit',
      'local-base-change',
      PLAN_UUID
    );

    mergeCanonicalRefresh(
      db,
      canonicalPlanSnapshot({
        uuid: PLAN_UUID,
        planId: 1,
        title: 'Canonical title',
        revision: 12,
      })
    );

    expect(getPlanByUuid(db, PLAN_UUID)).toMatchObject({
      title: 'Canonical title',
      base_commit: 'local-base-commit',
      base_change_id: 'local-base-change',
    });
  });

  test('mergeCanonicalRefresh preserves pending plan.create parent dependency edge', async () => {
    seedPlan(db, OTHER_PLAN_UUID, 2, OLD_PARENT_TASK_UUID);
    const op = enqueue(
      await createPlanOperation(
        {
          projectUuid: PROJECT_UUID,
          planUuid: PLAN_UUID,
          numericPlanId: 3,
          title: 'Optimistic child',
          parentUuid: OTHER_PLAN_UUID,
        },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );

    mergeCanonicalRefresh(
      db,
      canonicalPlanSnapshot({
        uuid: OTHER_PLAN_UUID,
        planId: 2,
        title: 'Canonical parent',
        status: 'pending',
        revision: 12,
        tasks: [],
        tags: [],
        dependencyUuids: [],
      })
    );

    expect(op.localSequence).toBe(0);
    expect(
      getPlanDependenciesByUuid(db, OTHER_PLAN_UUID).map((dep) => dep.depends_on_uuid)
    ).toEqual([PLAN_UUID]);
  });

  test('mergeCanonicalRefresh preserves pending set_parent removal from old parent', async () => {
    seedPlan();
    seedPlan(db, OTHER_PLAN_UUID, 2, OLD_PARENT_TASK_UUID);
    seedPlan(db, '88888888-8888-4888-8888-888888888888', 3, NEW_PARENT_TASK_UUID);
    db.prepare('UPDATE plan SET parent_uuid = ? WHERE uuid = ?').run(OTHER_PLAN_UUID, PLAN_UUID);
    db.prepare('INSERT INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES (?, ?)').run(
      OTHER_PLAN_UUID,
      PLAN_UUID
    );

    const setParent = enqueue(
      await setPlanParentOperation(
        PROJECT_UUID,
        {
          planUuid: PLAN_UUID,
          newParentUuid: '88888888-8888-4888-8888-888888888888',
        },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );

    mergeCanonicalRefresh(
      db,
      canonicalPlanSnapshot({
        uuid: OTHER_PLAN_UUID,
        planId: 2,
        title: 'Canonical old parent',
        status: 'pending',
        revision: 12,
        tasks: [],
        tags: [],
        dependencyUuids: [PLAN_UUID],
      })
    );

    expect(setParent.op.type).toBe('plan.set_parent');
    if (setParent.op.type === 'plan.set_parent') {
      expect(setParent.op.previousParentUuid).toBe(OTHER_PLAN_UUID);
    }
    expect(getPlanDependenciesByUuid(db, OTHER_PLAN_UUID)).toEqual([]);
    expect(
      getPlanDependenciesByUuid(db, '88888888-8888-4888-8888-888888888888').map(
        (dep) => dep.depends_on_uuid
      )
    ).toEqual([PLAN_UUID]);
  });

  test('mergeCanonicalRefresh reapplies pending set_parent over a third canonical parent', async () => {
    const oldParentUuid = OTHER_PLAN_UUID;
    const newParentUuid = '88888888-8888-4888-8888-888888888001';
    const otherParentUuid = '88888888-8888-4888-8888-888888888002';
    seedPlan();
    seedPlan(db, oldParentUuid, 2, OLD_PARENT_TASK_UUID);
    seedPlan(db, newParentUuid, 3, NEW_PARENT_TASK_UUID);
    seedPlan(db, otherParentUuid, 4, TASK_UUID_3);
    db.prepare('UPDATE plan SET parent_uuid = ? WHERE uuid = ?').run(oldParentUuid, PLAN_UUID);
    db.prepare('INSERT INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES (?, ?)').run(
      oldParentUuid,
      PLAN_UUID
    );

    enqueue(
      await setPlanParentOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, newParentUuid },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );

    mergeCanonicalRefresh(
      db,
      canonicalPlanSnapshot({
        uuid: otherParentUuid,
        planId: 4,
        title: 'Canonical other parent',
        status: 'pending',
        revision: 12,
        tasks: [],
        tags: [],
        dependencyUuids: [PLAN_UUID],
      })
    );

    expect(getPlanDependenciesByUuid(db, oldParentUuid)).toEqual([]);
    expect(getPlanDependenciesByUuid(db, otherParentUuid)).toEqual([]);
    expect(getPlanDependenciesByUuid(db, newParentUuid).map((dep) => dep.depends_on_uuid)).toEqual([
      PLAN_UUID,
    ]);
  });

  test('mergeCanonicalRefresh reapplies pending plan.delete to dependent snapshots', async () => {
    const dependentUuid = PLAN_UUID;
    const deletedUuid = OTHER_PLAN_UUID;
    seedPlan(db, dependentUuid, 1, TASK_UUID);
    seedPlan(db, deletedUuid, 2, TASK_UUID_2);
    db.prepare('INSERT INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES (?, ?)').run(
      dependentUuid,
      deletedUuid
    );

    enqueue(
      await deletePlanOperation(
        PROJECT_UUID,
        { planUuid: deletedUuid },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );

    expect(getPlanByUuid(db, deletedUuid)).toBeNull();
    expect(getPlanDependenciesByUuid(db, dependentUuid)).toEqual([]);

    mergeCanonicalRefresh(
      db,
      canonicalPlanSnapshot({
        uuid: dependentUuid,
        planId: 1,
        title: 'Canonical dependent',
        status: 'pending',
        revision: 12,
        tasks: [],
        tags: [],
        dependencyUuids: [deletedUuid],
      })
    );

    expect(getPlanDependenciesByUuid(db, dependentUuid)).toEqual([]);
  });

  test('mergeCanonicalRefresh removes local assignment for plan_deleted snapshots', () => {
    seedPlan();
    seedAssignment();

    mergeCanonicalRefresh(db, {
      type: 'plan_deleted',
      projectUuid: PROJECT_UUID,
      planUuid: PLAN_UUID,
      deletedAt: '2026-01-02T00:00:00.000Z',
    });

    expect(getPlanByUuid(db, PLAN_UUID)).toBeNull();
    expect(getAssignment(db, project.id, PLAN_UUID)).toBeNull();
  });

  test('mergeCanonicalRefresh rejects pending plan operations through indexed payload plan UUID', async () => {
    seedPlan();
    const pending = enqueue(await tagOp('local-tag'));
    const indexed = db
      .prepare('SELECT payload_plan_uuid FROM sync_operation WHERE operation_uuid = ?')
      .get(pending.operationUuid) as { payload_plan_uuid: string | null };
    expect(indexed.payload_plan_uuid).toBe(PLAN_UUID);

    mergeCanonicalRefresh(db, {
      type: 'plan_deleted',
      projectUuid: PROJECT_UUID,
      planUuid: PLAN_UUID,
      deletedAt: '2026-01-02T00:00:00.000Z',
    });

    expect(operationRow(pending.operationUuid).status).toBe('rejected');
  });

  test('enqueueOperation populates payload_task_uuid for task-scoped operations', async () => {
    seedPlan();
    const op = enqueue(
      await markPlanTaskDoneOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, taskUuid: TASK_UUID, done: true },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );

    const row = db
      .prepare(
        'SELECT payload_plan_uuid, payload_task_uuid FROM sync_operation WHERE operation_uuid = ?'
      )
      .get(op.operationUuid) as {
      payload_plan_uuid: string | null;
      payload_task_uuid: string | null;
    };
    expect(row.payload_plan_uuid).toBe(PLAN_UUID);
    expect(row.payload_task_uuid).toBe(TASK_UUID);
  });

  test('enqueueOperation populates null payload indexes for project_setting operations', async () => {
    const op = enqueue(
      await setProjectSettingOperation(
        { projectUuid: PROJECT_UUID, setting: 'color', value: 'blue' },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );

    const row = db
      .prepare(
        'SELECT payload_plan_uuid, payload_task_uuid FROM sync_operation WHERE operation_uuid = ?'
      )
      .get(op.operationUuid) as {
      payload_plan_uuid: string | null;
      payload_task_uuid: string | null;
    };
    expect(row.payload_plan_uuid).toBeNull();
    expect(row.payload_task_uuid).toBeNull();
  });

  test('mergeCanonicalRefresh never_existed for plan rejects queued ops and deletes local plan', async () => {
    seedPlan();
    const op = enqueue(await tagOp('optimistic-tag'));

    // Confirm payload_plan_uuid is indexed
    const indexed = db
      .prepare('SELECT payload_plan_uuid FROM sync_operation WHERE operation_uuid = ?')
      .get(op.operationUuid) as { payload_plan_uuid: string | null };
    expect(indexed.payload_plan_uuid).toBe(PLAN_UUID);

    mergeCanonicalRefresh(db, {
      type: 'never_existed',
      entityKey: `plan:${PLAN_UUID}`,
      targetType: 'plan',
      planUuid: PLAN_UUID,
    });

    // Plan is removed locally (never existed on main)
    expect(getPlanByUuid(db, PLAN_UUID)).toBeNull();
    // The queued op is rejected via indexed payload_plan_uuid lookup
    expect(operationRow(op.operationUuid).status).toBe('rejected');
  });

  test('mergeCanonicalRefresh never_existed for task rejects queued ops and deletes local task', async () => {
    seedPlan();
    const op = enqueue(
      await markPlanTaskDoneOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, taskUuid: TASK_UUID, done: true },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );

    // Confirm payload_task_uuid is indexed
    const indexed = db
      .prepare('SELECT payload_task_uuid FROM sync_operation WHERE operation_uuid = ?')
      .get(op.operationUuid) as { payload_task_uuid: string | null };
    expect(indexed.payload_task_uuid).toBe(TASK_UUID);

    mergeCanonicalRefresh(db, {
      type: 'never_existed',
      entityKey: `task:${TASK_UUID}`,
      targetType: 'task',
      taskUuid: TASK_UUID,
    });

    // Task is removed locally (never existed on main)
    expect(getPlanTasksByUuid(db, PLAN_UUID)).toHaveLength(0);
    // The queued op is rejected via indexed payload_task_uuid lookup
    expect(operationRow(op.operationUuid).status).toBe('rejected');
  });

  test('mergeCanonicalRefresh never_existed for optimistic add_task returns owning plan follow-up key', async () => {
    seedPlan();
    const addedTaskUuid = TASK_UUID_2;
    const op = enqueue(
      await addPlanTaskOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, taskUuid: addedTaskUuid, title: 'Optimistic task' },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );
    expect(getPlanTasksByUuid(db, PLAN_UUID).map((task) => task.uuid)).toContain(addedTaskUuid);

    const followUpKeys = mergeCanonicalRefresh(db, {
      type: 'never_existed',
      entityKey: `task:${addedTaskUuid}`,
      targetType: 'task',
      taskUuid: addedTaskUuid,
    });

    expect(operationRow(op.operationUuid).status).toBe('rejected');
    expect(getPlanTasksByUuid(db, PLAN_UUID).map((task) => task.uuid)).not.toContain(
      addedTaskUuid
    );
    expect(followUpKeys).toEqual([`plan:${PLAN_UUID}`]);
  });

  test('mergeCanonicalRefresh never_existed rejects pending plan.promote_task ops via target_key/payload_plan_uuid', async () => {
    seedPlan();
    const newPlanUuid = '99999999-9999-4999-8999-999999999999';
    const promoteOp = await promotePlanTaskOperation(
      PROJECT_UUID,
      {
        sourcePlanUuid: PLAN_UUID,
        taskUuid: TASK_UUID,
        newPlanUuid,
        title: 'Promoted task',
      },
      { originNodeId: NODE_A, localSequence: 777 }
    );
    enqueue(promoteOp);

    // payload_plan_uuid falls back to newPlanUuid; sourcePlanUuid lives in
    // payload_secondary_plan_uuid.
    const indexed = db
      .prepare(
        'SELECT payload_plan_uuid, payload_secondary_plan_uuid, target_key FROM sync_operation WHERE operation_uuid = ?'
      )
      .get(promoteOp.operationUuid) as {
      payload_plan_uuid: string | null;
      payload_secondary_plan_uuid: string | null;
      target_key: string;
    };
    expect(indexed.payload_plan_uuid).toBe(newPlanUuid);
    expect(indexed.payload_secondary_plan_uuid).toBe(PLAN_UUID);
    expect(indexed.target_key).toBe(`plan:${newPlanUuid}`);

    mergeCanonicalRefresh(db, {
      type: 'never_existed',
      entityKey: `plan:${newPlanUuid}`,
      targetType: 'plan',
      planUuid: newPlanUuid,
    });

    // The queued promote op is rejected because the new plan never existed on main
    expect(operationRow(promoteOp.operationUuid).status).toBe('rejected');
  });

  test('mergeCanonicalRefresh plan_deleted for source plan rejects pending plan.promote_task ops via payload_secondary_plan_uuid', async () => {
    seedPlan();
    const newPlanUuid = '88888888-8888-4888-8888-888888888888';
    const promoteOp = await promotePlanTaskOperation(
      PROJECT_UUID,
      {
        sourcePlanUuid: PLAN_UUID,
        taskUuid: TASK_UUID,
        newPlanUuid,
        title: 'Promoted task',
      },
      { originNodeId: NODE_A, localSequence: 778 }
    );
    enqueue(promoteOp);

    mergeCanonicalRefresh(db, {
      type: 'plan_deleted',
      projectUuid: PROJECT_UUID,
      planUuid: PLAN_UUID,
      deletedAt: new Date().toISOString(),
    });

    // The queued promote op is rejected because its sourcePlanUuid was deleted
    expect(operationRow(promoteOp.operationUuid).status).toBe('rejected');
  });

  test('mergeCanonicalRefresh plan_deleted for source plan returns affected keys for rejected promote_task ops', async () => {
    seedPlan();
    const newPlanUuid = '88888888-8888-4888-8888-888888888889';
    const promoteOp = await promotePlanTaskOperation(
      PROJECT_UUID,
      {
        sourcePlanUuid: PLAN_UUID,
        taskUuid: TASK_UUID,
        newPlanUuid,
        title: 'Promoted task',
      },
      { originNodeId: NODE_A, localSequence: 778 }
    );
    enqueue(promoteOp);
    expect(getPlanByUuid(db, newPlanUuid)).not.toBeNull();

    const followUpKeys = mergeCanonicalRefresh(db, {
      type: 'plan_deleted',
      projectUuid: PROJECT_UUID,
      planUuid: PLAN_UUID,
      deletedAt: new Date().toISOString(),
    });

    expect(operationRow(promoteOp.operationUuid).status).toBe('rejected');
    expect(followUpKeys).toEqual(
      expect.arrayContaining([`plan:${newPlanUuid}`, `task:${TASK_UUID}`])
    );
    expect(followUpKeys).not.toContain(`plan:${PLAN_UUID}`);
    expect(getPlanByUuid(db, newPlanUuid)).not.toBeNull();
  });

  test('mergeCanonicalRefresh records pending_rollback for follow-up keys when rejecting promote_task', async () => {
    seedPlan();
    const newPlanUuid = '88888888-8888-4888-8888-888888888880';
    const promoteOp = await promotePlanTaskOperation(
      PROJECT_UUID,
      {
        sourcePlanUuid: PLAN_UUID,
        taskUuid: TASK_UUID,
        newPlanUuid,
        title: 'Promoted task',
      },
      { originNodeId: NODE_A, localSequence: 778 }
    );
    enqueue(promoteOp);

    const followUpKeys = mergeCanonicalRefresh(db, {
      type: 'plan_deleted',
      projectUuid: PROJECT_UUID,
      planUuid: PLAN_UUID,
      deletedAt: new Date().toISOString(),
    });

    expect(operationRow(promoteOp.operationUuid).status).toBe('rejected');
    expect(followUpKeys).toEqual(
      expect.arrayContaining([`plan:${newPlanUuid}`, `task:${TASK_UUID}`])
    );
    expect(getPendingRollbackKeys(db)).toEqual(
      expect.arrayContaining([`plan:${newPlanUuid}`, `task:${TASK_UUID}`])
    );
  });

  test('mergeCanonicalRefresh never_existed for source plan rejects pending plan.promote_task ops via payload_secondary_plan_uuid', async () => {
    seedPlan();
    const newPlanUuid = '77777777-7777-4777-8777-777777777777';
    const promoteOp = await promotePlanTaskOperation(
      PROJECT_UUID,
      {
        sourcePlanUuid: PLAN_UUID,
        taskUuid: TASK_UUID,
        newPlanUuid,
        title: 'Promoted task',
      },
      { originNodeId: NODE_A, localSequence: 779 }
    );
    enqueue(promoteOp);

    mergeCanonicalRefresh(db, {
      type: 'never_existed',
      entityKey: `plan:${PLAN_UUID}`,
      targetType: 'plan',
      planUuid: PLAN_UUID,
    });

    expect(operationRow(promoteOp.operationUuid).status).toBe('rejected');
  });

  test('mergeCanonicalRefresh never_existed for plan returns affected keys for rejected promote_task ops', async () => {
    seedPlan();
    const newPlanUuid = '77777777-7777-4777-8777-777777777778';
    const promoteOp = await promotePlanTaskOperation(
      PROJECT_UUID,
      {
        sourcePlanUuid: PLAN_UUID,
        taskUuid: TASK_UUID,
        newPlanUuid,
        title: 'Promoted task',
      },
      { originNodeId: NODE_A, localSequence: 779 }
    );
    enqueue(promoteOp);
    expect(getPlanByUuid(db, newPlanUuid)).not.toBeNull();

    const followUpKeys = mergeCanonicalRefresh(db, {
      type: 'never_existed',
      entityKey: `plan:${newPlanUuid}`,
      targetType: 'plan',
      planUuid: newPlanUuid,
    });

    expect(operationRow(promoteOp.operationUuid).status).toBe('rejected');
    expect(followUpKeys).toEqual(
      expect.arrayContaining([`plan:${PLAN_UUID}`, `task:${TASK_UUID}`])
    );
    expect(followUpKeys).not.toContain(`plan:${newPlanUuid}`);
    expect(getPlanByUuid(db, newPlanUuid)).toBeNull();
  });

  test('mergeCanonicalRefresh second-pass never_existed removes optimistic promoted plan', async () => {
    seedPlan();
    const newPlanUuid = '77777777-7777-4777-8777-777777777779';
    const promoteOp = await promotePlanTaskOperation(
      PROJECT_UUID,
      {
        sourcePlanUuid: PLAN_UUID,
        taskUuid: TASK_UUID,
        newPlanUuid,
        title: 'Promoted task',
      },
      { originNodeId: NODE_A, localSequence: 780 }
    );
    enqueue(promoteOp);
    expect(getPlanByUuid(db, newPlanUuid)).not.toBeNull();

    const followUpKeys = mergeCanonicalRefresh(db, {
      type: 'plan_deleted',
      projectUuid: PROJECT_UUID,
      planUuid: PLAN_UUID,
      deletedAt: new Date().toISOString(),
    });
    expect(followUpKeys).toContain(`plan:${newPlanUuid}`);
    expect(getPlanByUuid(db, newPlanUuid)).not.toBeNull();

    mergeCanonicalRefresh(db, {
      type: 'never_existed',
      entityKey: `plan:${newPlanUuid}`,
      targetType: 'plan',
      planUuid: newPlanUuid,
    });

    expect(operationRow(promoteOp.operationUuid).status).toBe('rejected');
    expect(getPlanByUuid(db, newPlanUuid)).toBeNull();
  });

  test('mergeCanonicalRefresh clears pending_rollback when the followed-up entity snapshot is merged', async () => {
    seedPlan();
    const newPlanUuid = '77777777-7777-4777-8777-777777777770';
    const promoteOp = await promotePlanTaskOperation(
      PROJECT_UUID,
      {
        sourcePlanUuid: PLAN_UUID,
        taskUuid: TASK_UUID,
        newPlanUuid,
        title: 'Promoted task',
      },
      { originNodeId: NODE_A, localSequence: 781 }
    );
    enqueue(promoteOp);

    mergeCanonicalRefresh(db, {
      type: 'plan_deleted',
      projectUuid: PROJECT_UUID,
      planUuid: PLAN_UUID,
      deletedAt: new Date().toISOString(),
    });
    expect(getPendingRollbackKeys(db)).toContain(`plan:${newPlanUuid}`);

    mergeCanonicalRefresh(db, {
      type: 'never_existed',
      entityKey: `plan:${newPlanUuid}`,
      targetType: 'plan',
      planUuid: newPlanUuid,
    });

    expect(operationRow(promoteOp.operationUuid).status).toBe('rejected');
    expect(getPlanByUuid(db, newPlanUuid)).toBeNull();
    expect(getPendingRollbackKeys(db)).not.toContain(`plan:${newPlanUuid}`);
  });

  test('mergeCanonicalRefresh removes local assignments for cleanup-status plan snapshots', () => {
    const cases = [
      { planUuid: PLAN_UUID, taskUuid: TASK_UUID, planId: 1, status: 'done' },
      { planUuid: OTHER_PLAN_UUID, taskUuid: TASK_UUID_2, planId: 2, status: 'needs_review' },
      {
        planUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        taskUuid: TASK_UUID_3,
        planId: 3,
        status: 'cancelled',
      },
    ] as const;

    for (const testCase of cases) {
      seedPlan(db, testCase.planUuid, testCase.planId, testCase.taskUuid);
      seedAssignment(testCase.planUuid);

      mergeCanonicalRefresh(
        db,
        canonicalPlanSnapshot({
          uuid: testCase.planUuid,
          planId: testCase.planId,
          status: testCase.status,
        })
      );

      expect(getAssignment(db, project.id, testCase.planUuid)).toBeNull();
    }
  });

  test('mergeCanonicalRefresh preserves local assignments for non-cleanup plan snapshots', () => {
    seedPlan();
    seedAssignment();

    mergeCanonicalRefresh(
      db,
      canonicalPlanSnapshot({
        uuid: PLAN_UUID,
        planId: 1,
        status: 'in_progress',
      })
    );

    expect(getAssignment(db, project.id, PLAN_UUID)).not.toBeNull();
  });

  test('mergeCanonicalRefresh rejects partial plan snapshots before overwriting local state', () => {
    seedPlan();
    seedPlan(db, OTHER_PLAN_UUID, 2, TASK_UUID_2);
    db.prepare('INSERT INTO plan_dependency (plan_uuid, depends_on_uuid) VALUES (?, ?)').run(
      PLAN_UUID,
      OTHER_PLAN_UUID
    );
    db.prepare('INSERT INTO plan_tag (plan_uuid, tag) VALUES (?, ?)').run(PLAN_UUID, 'local-tag');

    expect(() =>
      mergeCanonicalRefresh(db, {
        type: 'plan',
        projectUuid: PROJECT_UUID,
        plan: {
          uuid: PLAN_UUID,
          planId: 1,
          title: 'Partial canonical',
          status: 'pending',
          revision: 2,
        },
      } as unknown as CanonicalPlanSnapshot)
    ).toThrow();

    expect(getPlanTasksByUuid(db, PLAN_UUID).map((task) => task.uuid)).toEqual([TASK_UUID]);
    expect(getPlanTagsByUuid(db, PLAN_UUID).map((tag) => tag.tag)).toEqual(['local-tag']);
    expect(getPlanDependenciesByUuid(db, PLAN_UUID).map((dep) => dep.depends_on_uuid)).toEqual([
      OTHER_PLAN_UUID,
    ]);
  });

  test('pending set_parent reset can remove an explicit add_dependency edge until later refresh', async () => {
    const parentUuid = PLAN_UUID;
    const explicitDependentUuid = OTHER_PLAN_UUID;
    const childUuid = '88888888-8888-4888-8888-888888888010';
    seedPlan(db, parentUuid, 1, TASK_UUID);
    seedPlan(db, explicitDependentUuid, 2, TASK_UUID_2);
    seedPlan(db, childUuid, 3, TASK_UUID_3);

    enqueue(
      await addPlanDependencyOperation(
        PROJECT_UUID,
        { planUuid: explicitDependentUuid, dependsOnPlanUuid: childUuid },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );
    const setParent = enqueue(
      await setPlanParentOperation(
        PROJECT_UUID,
        { planUuid: childUuid, newParentUuid: parentUuid },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );

    mergeCanonicalRefresh(
      db,
      canonicalPlanSnapshot({
        uuid: explicitDependentUuid,
        planId: 2,
        title: 'Canonical explicit dependent',
        status: 'pending',
        revision: 12,
        tasks: [],
        tags: [],
        dependencyUuids: [childUuid],
      })
    );

    expect(getPlanDependenciesByUuid(db, explicitDependentUuid)).toEqual([]);

    markOperationSending(db, setParent.operationUuid);
    markOperationAcked(db, setParent.operationUuid, { sequenceIds: [10] });
    mergeCanonicalRefresh(
      db,
      canonicalPlanSnapshot({
        uuid: explicitDependentUuid,
        planId: 2,
        title: 'Canonical explicit dependent',
        status: 'pending',
        revision: 13,
        tasks: [],
        tags: [],
        dependencyUuids: [childUuid],
      })
    );

    expect(
      getPlanDependenciesByUuid(db, explicitDependentUuid).map((dep) => dep.depends_on_uuid)
    ).toEqual([childUuid]);
  });

  test('mergeCanonicalRefresh handles project settings and preserves pending setting edits', async () => {
    enqueue(
      await setProjectSettingOperation(
        { projectUuid: PROJECT_UUID, setting: 'color', value: 'green' },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );

    mergeCanonicalRefresh(db, {
      type: 'project_setting',
      projectUuid: PROJECT_UUID,
      setting: 'color',
      value: 'blue',
      revision: 3,
      updatedByNode: 'main',
    });

    expect(getProjectSettingWithMetadata(db, project.id, 'color')).toMatchObject({
      value: 'green',
      updatedByNode: NODE_A,
    });
  });

  test('mergeCanonicalRefresh rejects project setting snapshot missing value or revision', () => {
    expect(() =>
      mergeCanonicalRefresh(db, {
        type: 'project_setting',
        projectUuid: PROJECT_UUID,
        setting: 'color',
        revision: 1,
      } as never)
    ).toThrow();

    expect(() =>
      mergeCanonicalRefresh(db, {
        type: 'project_setting',
        projectUuid: PROJECT_UUID,
        setting: 'color',
        value: 'blue',
      } as never)
    ).toThrow();

    expect(getProjectSettingWithMetadata(db, project.id, 'color')).toBeNull();
  });

  test('open conflict on an entity does not block enqueueing a later operation', async () => {
    seedPlan();
    const conflicted = enqueue(await tagOp('first'));
    markOperationSending(db, conflicted.operationUuid);
    markOperationConflict(db, conflicted.operationUuid, 'conflict-1', {});

    const later = enqueue(await tagOp('later'));

    expect(later.localSequence).toBe(1);
    expect(getPlanTagsByUuid(db, PLAN_UUID).map((tag) => tag.tag)).toEqual(['first', 'later']);
    expect(listPendingOperations(db).map((row) => row.operation_uuid)).toEqual([
      later.operationUuid,
    ]);
  });

  test('plan.remove_tag optimistic apply removes an existing tag', async () => {
    seedPlan();
    enqueue(await tagOp('keep'));
    enqueue(await tagOp('remove'));
    enqueue(
      await removePlanTagOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, tag: 'remove' },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );

    expect(getPlanTagsByUuid(db, PLAN_UUID).map((t) => t.tag)).toEqual(['keep']);
  });

  test('plan.remove_dependency optimistic apply removes an existing dependency', async () => {
    seedPlan(db, OTHER_PLAN_UUID, 2, '66666666-6666-4666-8666-666666666666');
    seedPlan();
    enqueue(
      await addPlanDependencyOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, dependsOnPlanUuid: OTHER_PLAN_UUID },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );
    expect(getPlanDependenciesByUuid(db, PLAN_UUID).map((d) => d.depends_on_uuid)).toEqual([
      OTHER_PLAN_UUID,
    ]);

    enqueue(
      await removePlanDependencyOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, dependsOnPlanUuid: OTHER_PLAN_UUID },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );
    expect(getPlanDependenciesByUuid(db, PLAN_UUID)).toEqual([]);
  });

  test('plan.set_scalar optimistic apply updates status and priority', async () => {
    seedPlan();
    enqueue(
      await setPlanScalarOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, field: 'status', value: 'in_progress' },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );
    enqueue(
      await setPlanScalarOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, field: 'priority', value: 'high' },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );

    const plan = getPlanByUuid(db, PLAN_UUID);
    expect(plan?.status).toBe('in_progress');
    expect(plan?.priority).toBe('high');
  });

  test('plan.set_scalar optimistic cleanup status removes local assignment', async () => {
    seedPlan();
    seedAssignment();

    enqueue(
      await setPlanScalarOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, field: 'status', value: 'done' },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );

    expect(getPlanByUuid(db, PLAN_UUID)?.status).toBe('done');
    expect(getAssignment(db, project.id, PLAN_UUID)).toBeNull();
  });

  test('plan.set_scalar optimistic non-cleanup status preserves local assignment', async () => {
    seedPlan();
    seedAssignment();

    enqueue(
      await setPlanScalarOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, field: 'status', value: 'in_progress' },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );

    expect(getPlanByUuid(db, PLAN_UUID)?.status).toBe('in_progress');
    expect(getAssignment(db, project.id, PLAN_UUID)).not.toBeNull();
  });

  test('plan.update_task_text optimistic apply patches task fields', async () => {
    seedPlan();
    enqueue(
      await updatePlanTaskTextOperation(
        PROJECT_UUID,
        {
          planUuid: PLAN_UUID,
          taskUuid: TASK_UUID,
          field: 'title',
          base: 'Task one',
          new: 'Task one updated',
        },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );
    enqueue(
      await updatePlanTaskTextOperation(
        PROJECT_UUID,
        {
          planUuid: PLAN_UUID,
          taskUuid: TASK_UUID,
          field: 'description',
          base: 'old description',
          new: 'new description',
        },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );

    const tasks = getPlanTasksByUuid(db, PLAN_UUID);
    expect(tasks[0].title).toBe('Task one updated');
    expect(tasks[0].description).toBe('new description');
  });

  test('optimistic text merge failure leaves local plan text unchanged', async () => {
    seedPlan();
    db.prepare('UPDATE plan SET details = ? WHERE uuid = ?').run(
      'alpha\nlocal divergent edit\ngamma\n',
      PLAN_UUID
    );

    enqueue(
      await patchPlanTextOperation(
        PROJECT_UUID,
        {
          planUuid: PLAN_UUID,
          field: 'details',
          base: 'alpha\nbeta\ngamma\n',
          new: 'alpha\nincoming edit\ngamma\n',
        },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );

    expect(getPlanByUuid(db, PLAN_UUID)?.details).toBe('alpha\nlocal divergent edit\ngamma\n');
  });

  test('optimistic task text merge failure leaves local task text unchanged', async () => {
    seedPlan();
    db.prepare('UPDATE plan_task SET description = ? WHERE uuid = ?').run(
      'local divergent description',
      TASK_UUID
    );

    enqueue(
      await updatePlanTaskTextOperation(
        PROJECT_UUID,
        {
          planUuid: PLAN_UUID,
          taskUuid: TASK_UUID,
          field: 'description',
          base: 'old description',
          new: 'incoming description',
        },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );

    expect(getPlanTasksByUuid(db, PLAN_UUID)[0].description).toBe('local divergent description');
  });

  test('optimistic plan.create with parent creates parent dependency edge', async () => {
    seedPlan(db, OTHER_PLAN_UUID, 2, OLD_PARENT_TASK_UUID);

    enqueue(
      await createPlanOperation(
        {
          projectUuid: PROJECT_UUID,
          planUuid: PLAN_UUID,
          numericPlanId: 3,
          title: 'Optimistic child',
          parentUuid: OTHER_PLAN_UUID,
        },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );

    expect(
      getPlanDependenciesByUuid(db, OTHER_PLAN_UUID).map((dep) => dep.depends_on_uuid)
    ).toEqual([PLAN_UUID]);
  });

  test('malformed list JSON is treated as empty during optimistic apply', async () => {
    seedPlan();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    db.prepare('UPDATE plan SET docs = ? WHERE uuid = ?').run('{not json', PLAN_UUID);

    try {
      enqueue(
        await addPlanListItemOperation(
          PROJECT_UUID,
          { planUuid: PLAN_UUID, list: 'docs', value: 'docs/notes.md' },
          { originNodeId: NODE_A, localSequence: 999 }
        )
      );
    } finally {
      warn.mockRestore();
    }

    expect(JSON.parse(String(getPlanByUuid(db, PLAN_UUID)?.docs))).toEqual(['docs/notes.md']);
  });

  test('project_setting.delete optimistic apply removes the setting', async () => {
    enqueue(
      await setProjectSettingOperation(
        { projectUuid: PROJECT_UUID, setting: 'color', value: 'red' },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );
    expect(getProjectSettingWithMetadata(db, project.id, 'color')).not.toBeNull();

    enqueue(
      await deleteProjectSettingOperation(
        { projectUuid: PROJECT_UUID, setting: 'color' },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );
    expect(getProjectSettingWithMetadata(db, project.id, 'color')).toBeNull();
  });

  test('full retry lifecycle: queued -> sending -> failed_retryable -> sending -> acked', async () => {
    seedPlan();
    const op = enqueue(await tagOp('retry-test'));
    expect(opRows()[0].status).toBe('queued');

    markOperationSending(db, op.operationUuid);
    expect(opRows()[0].status).toBe('sending');

    markOperationFailedRetryable(db, op.operationUuid, new Error('network timeout'));
    const afterFail = opRows()[0];
    expect(afterFail.status).toBe('failed_retryable');
    expect(listPendingOperations(db).length).toBe(1);

    markOperationSending(db, op.operationUuid);
    markOperationAcked(db, op.operationUuid, { sequenceIds: [42] });
    expect(opRows()[0].status).toBe('acked');
    expect(listPendingOperations(db)).toEqual([]);
  });

  test('listPendingOperations filters by projectUuid', async () => {
    const PROJECT_UUID_2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const project2 = getOrCreateProject(db, 'github.com__other__repo', {
      uuid: PROJECT_UUID_2,
      highestPlanId: 0,
    });
    const PLAN_UUID_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    upsertPlan(db, project2.id, {
      uuid: PLAN_UUID_2,
      planId: 1,
      title: 'Other plan',
      status: 'pending',
      tasks: [],
      forceOverwrite: true,
    });

    seedPlan();
    const opProject1 = enqueue(await tagOp('project1'));
    const opProject2 = enqueue(
      await addPlanTagOperation(
        PROJECT_UUID_2,
        { planUuid: PLAN_UUID_2, tag: 'project2' },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );

    const allPending = listPendingOperations(db);
    expect(allPending.map((r) => r.operation_uuid)).toContain(opProject1.operationUuid);
    expect(allPending.map((r) => r.operation_uuid)).toContain(opProject2.operationUuid);

    const project1Only = listPendingOperations(db, { projectUuid: PROJECT_UUID });
    expect(project1Only.map((r) => r.operation_uuid)).toEqual([opProject1.operationUuid]);

    const project2Only = listPendingOperations(db, { projectUuid: PROJECT_UUID_2 });
    expect(project2Only.map((r) => r.operation_uuid)).toEqual([opProject2.operationUuid]);
  });

  test('mergeCanonicalRefresh does not re-apply sending-status operations', async () => {
    seedPlan();
    const op = enqueue(await tagOp('in-flight'));
    markOperationSending(db, op.operationUuid);

    mergeCanonicalRefresh(
      db,
      canonicalPlanSnapshot({
        uuid: PLAN_UUID,
        planId: 1,
        title: 'Canonical',
        status: 'in_progress',
        revision: 5,
        tasks: [],
        tags: [],
        dependencyUuids: [],
      })
    );

    expect(getPlanTagsByUuid(db, PLAN_UUID).map((t) => t.tag)).toEqual([]);
    expect(getPlanByUuid(db, PLAN_UUID)?.status).toBe('in_progress');
  });

  test('non-record ack metadata is not wrapped in ackMetadata property', async () => {
    seedPlan();
    const conflict = enqueue(await tagOp('conflict-metadata'));
    const rejected = enqueue(await tagOp('rejected-metadata'));
    markOperationSending(db, conflict.operationUuid);
    markOperationSending(db, rejected.operationUuid);

    markOperationConflict(db, conflict.operationUuid, 'conflict-1', 'plain string');
    markOperationRejected(db, rejected.operationUuid, 'bad op', 'plain string');

    const metadata = db
      .prepare('SELECT operation_uuid, ack_metadata FROM sync_operation ORDER BY local_sequence')
      .all() as Array<{ operation_uuid: string; ack_metadata: string }>;

    expect(JSON.parse(metadata[0].ack_metadata)).toEqual({ conflictId: 'conflict-1' });
    expect(JSON.parse(metadata[1].ack_metadata)).toEqual({ error: 'bad op' });
  });

  test('persistent and main databases converge after ack and canonical refresh', async () => {
    seedPlan();
    const mainDb = createDb();
    getOrCreateProject(mainDb, 'github.com__example__repo', {
      uuid: PROJECT_UUID,
      highestPlanId: 10,
    });
    seedPlan(mainDb);

    const op = enqueue(await tagOp('synced'));
    markOperationSending(db, op.operationUuid);

    const result = applyOperation(mainDb, op);
    expect(result.status).toBe('applied');
    markOperationAcked(db, op.operationUuid, {
      sequenceIds: result.sequenceIds,
      invalidations: result.invalidations,
    });

    mergeCanonicalRefresh(db, planSnapshotFromDb(mainDb));

    expect(getPlanTagsByUuid(mainDb, PLAN_UUID).map((tag) => tag.tag)).toEqual(['synced']);
    expect(getPlanTagsByUuid(db, PLAN_UUID).map((tag) => tag.tag)).toEqual(['synced']);
    expect(listPendingOperations(db)).toEqual([]);
  });
});

describe('sync queue summary helpers', () => {
  test('returns zeros for an empty queue', () => {
    seedPlan();
    expect(getSyncQueueSummary(db)).toEqual({
      pending: 0,
      sending: 0,
      failedRetryable: 0,
      conflict: 0,
      rejected: 0,
      oldestPendingAt: null,
    });
    expect(getSyncConflictSummary(db)).toEqual({ open: 0 });
  });

  test('counts pending, sending, failed_retryable, and rejected operations', async () => {
    seedPlan();

    const queued1 = enqueue(await tagOp('queued-1'));
    const queued2 = enqueue(await tagOp('queued-2'));
    const sendingOp = enqueue(await tagOp('sending'));
    markOperationSending(db, sendingOp.operationUuid);
    const retryOp = enqueue(await tagOp('retry'));
    markOperationSending(db, retryOp.operationUuid);
    markOperationFailedRetryable(db, retryOp.operationUuid, new Error('boom'));
    const rejectedOp = enqueue(await tagOp('rejected'));
    markOperationSending(db, rejectedOp.operationUuid);
    markOperationRejected(db, rejectedOp.operationUuid, 'rejected', null);
    const conflictOp = enqueue(await tagOp('operation-conflict'));
    markOperationSending(db, conflictOp.operationUuid);
    markOperationConflict(db, conflictOp.operationUuid, 'conflict-1');
    const ackedOp = enqueue(await tagOp('acked'));
    markOperationSending(db, ackedOp.operationUuid);
    markOperationAcked(db, ackedOp.operationUuid, { sequenceIds: [1], invalidations: [] });

    db.prepare('UPDATE sync_operation SET created_at = ? WHERE operation_uuid = ?').run(
      '2026-01-02T00:00:00.000Z',
      queued1.operationUuid
    );
    db.prepare('UPDATE sync_operation SET created_at = ? WHERE operation_uuid = ?').run(
      '2026-01-01T00:00:00.000Z',
      queued2.operationUuid
    );
    db.prepare('UPDATE sync_operation SET created_at = ? WHERE operation_uuid = ?').run(
      '2025-12-31T00:00:00.000Z',
      rejectedOp.operationUuid
    );
    db.prepare('UPDATE sync_operation SET created_at = ? WHERE operation_uuid = ?').run(
      '2025-12-30T00:00:00.000Z',
      conflictOp.operationUuid
    );
    db.prepare('UPDATE sync_operation SET created_at = ? WHERE operation_uuid = ?').run(
      '2025-12-29T00:00:00.000Z',
      ackedOp.operationUuid
    );

    const summary = getSyncQueueSummary(db, { originNodeId: NODE_A });
    expect(summary.pending).toBe(2);
    expect(summary.sending).toBe(1);
    expect(summary.failedRetryable).toBe(1);
    expect(summary.conflict).toBe(1);
    expect(summary.rejected).toBe(1);
    expect(summary.oldestPendingAt).toBe('2026-01-01T00:00:00.000Z');
  });

  test('filters by originNodeId, projectUuid, targetKey, and targetKeyPrefix', async () => {
    seedPlan();
    seedPlan(db, OTHER_PLAN_UUID, 2, TASK_UUID_2);

    const otherProject = getOrCreateProject(db, 'github.com__other__repo', {
      uuid: OTHER_PROJECT_UUID,
      highestPlanId: 0,
    });
    upsertPlan(db, otherProject.id, {
      uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      planId: 1,
      title: 'Other project plan',
      status: 'pending',
      tasks: [],
      forceOverwrite: true,
    });

    enqueue(await tagOp('plan-a-tag'));
    enqueue(await tagOpForPlan(PROJECT_UUID, OTHER_PLAN_UUID, 'plan-b-tag'));
    enqueue(await settingOp(PROJECT_UUID, 'featured'));
    enqueue(await tagOp('node-b-tag', NODE_B));
    enqueue(
      await tagOpForPlan(
        OTHER_PROJECT_UUID,
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        'other-project-tag'
      )
    );

    const summaryA = getSyncQueueSummary(db, { originNodeId: NODE_A });
    expect(summaryA.pending).toBe(4);

    const summaryB = getSyncQueueSummary(db, { originNodeId: NODE_B });
    expect(summaryB.pending).toBe(1);

    const summaryByProject = getSyncQueueSummary(db, {
      originNodeId: NODE_A,
      projectUuid: PROJECT_UUID,
    });
    expect(summaryByProject.pending).toBe(3);

    const summaryByPlan = getSyncQueueSummary(db, {
      originNodeId: NODE_A,
      targetKey: `plan:${PLAN_UUID}`,
    });
    expect(summaryByPlan.pending).toBe(1);

    const summaryByPrefix = getSyncQueueSummary(db, {
      originNodeId: NODE_A,
      targetKeyPrefix: 'plan:',
    });
    expect(summaryByPrefix.pending).toBe(3);

    const summaryBySettingPrefix = getSyncQueueSummary(db, {
      originNodeId: NODE_A,
      projectUuid: PROJECT_UUID,
      targetKeyPrefix: `project_setting:${PROJECT_UUID}:`,
    });
    expect(summaryBySettingPrefix.pending).toBe(1);
  });

  test('filters open conflicts and ignores resolved ones', async () => {
    seedPlan();
    getOrCreateProject(db, 'github.com__other__repo', {
      uuid: OTHER_PROJECT_UUID,
      highestPlanId: 0,
    });
    const planOp = enqueue(await tagOp('conflict-tag'));
    const settingOperation = enqueue(await settingOp(PROJECT_UUID, 'featured'));
    const otherProjectSettingOperation = enqueue(await settingOp(OTHER_PROJECT_UUID, 'featured'));
    const conflictId = createSyncConflict(db, {
      envelope: planOp,
      originalPayload: JSON.stringify(planOp.op),
      normalizedPayload: JSON.stringify(planOp.op),
      reason: 'test',
    });
    const settingConflictId = createSyncConflict(db, {
      envelope: settingOperation,
      originalPayload: JSON.stringify(settingOperation.op),
      normalizedPayload: JSON.stringify(settingOperation.op),
      reason: 'test',
    });
    createSyncConflict(db, {
      envelope: otherProjectSettingOperation,
      originalPayload: JSON.stringify(otherProjectSettingOperation.op),
      normalizedPayload: JSON.stringify(otherProjectSettingOperation.op),
      reason: 'test',
    });

    expect(getSyncConflictSummary(db).open).toBe(3);
    expect(getSyncConflictSummary(db, { projectUuid: PROJECT_UUID }).open).toBe(2);
    expect(getSyncConflictSummary(db, { targetKey: `plan:${PLAN_UUID}` }).open).toBe(1);
    expect(getSyncConflictSummary(db, { targetKeyPrefix: 'project_setting:' }).open).toBe(2);
    expect(
      getSyncConflictSummary(db, {
        projectUuid: PROJECT_UUID,
        targetKeyPrefix: `project_setting:${PROJECT_UUID}:`,
      }).open
    ).toBe(1);

    // Mark resolved
    db.prepare(
      `UPDATE sync_conflict SET status = 'resolved_applied', resolved_at = '2026-01-01T00:00:00Z' WHERE conflict_id = ?`
    ).run(conflictId);
    db.prepare(
      `UPDATE sync_conflict SET status = 'resolved_discarded', resolved_at = '2026-01-01T00:00:00Z' WHERE conflict_id = ?`
    ).run(settingConflictId);
    expect(getSyncConflictSummary(db).open).toBe(1);
  });

  test('planUuid filter aggregates task-scoped operations under their owning plan', async () => {
    seedPlan();
    seedPlan(db, OTHER_PLAN_UUID, 2, TASK_UUID_2);

    enqueue(await tagOp('plan-tag'));
    enqueue(
      await addPlanTaskOperation(
        PROJECT_UUID,
        {
          planUuid: PLAN_UUID,
          taskUuid: TASK_UUID_3,
          title: 'New task',
          description: 'desc',
        },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );
    enqueue(
      await markPlanTaskDoneOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, taskUuid: TASK_UUID, done: true },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );
    enqueue(
      await addPlanTaskOperation(
        PROJECT_UUID,
        {
          planUuid: OTHER_PLAN_UUID,
          taskUuid: TASK_UUID_4,
          title: 'Other plan task',
          description: 'desc',
        },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );

    const planSummary = getSyncQueueSummary(db, {
      originNodeId: NODE_A,
      planUuid: PLAN_UUID,
    });
    expect(planSummary.pending).toBe(3);

    const otherSummary = getSyncQueueSummary(db, {
      originNodeId: NODE_A,
      planUuid: OTHER_PLAN_UUID,
    });
    expect(otherSummary.pending).toBe(1);
  });

  test('planUuid filter aggregates task-scoped conflicts under their owning plan', async () => {
    seedPlan();
    seedPlan(db, OTHER_PLAN_UUID, 2, TASK_UUID_2);

    const taskOp = enqueue(
      await markPlanTaskDoneOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, taskUuid: TASK_UUID, done: true },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );
    const otherTaskOp = enqueue(
      await markPlanTaskDoneOperation(
        PROJECT_UUID,
        { planUuid: OTHER_PLAN_UUID, taskUuid: TASK_UUID_2, done: true },
        { originNodeId: NODE_A, localSequence: 999 }
      )
    );
    createSyncConflict(db, {
      envelope: taskOp,
      originalPayload: JSON.stringify(taskOp.op),
      normalizedPayload: JSON.stringify(taskOp.op),
      reason: 'test',
    });
    createSyncConflict(db, {
      envelope: otherTaskOp,
      originalPayload: JSON.stringify(otherTaskOp.op),
      normalizedPayload: JSON.stringify(otherTaskOp.op),
      reason: 'test',
    });

    expect(getSyncConflictSummary(db, { planUuid: PLAN_UUID }).open).toBe(1);
    expect(getSyncConflictSummary(db, { planUuid: OTHER_PLAN_UUID }).open).toBe(1);
  });

  test('targetKeyPrefix LIKE escapes underscores so unrelated keys do not collide', async () => {
    // Seed a project with a plan whose UUID, when used as a targetKey prefix,
    // contains an underscore that would otherwise act as a single-char wildcard.
    seedPlan();

    enqueue(await settingOp(PROJECT_UUID, 'featured'));

    // Build an envelope whose target_key contains a literal `X` where the LIKE
    // wildcard would match. The unescaped prefix `project_setting:` would match
    // a key like `projectXsetting:foo:bar` because `_` is a single-char wildcard.
    db.prepare(
      `INSERT INTO sync_operation (
         operation_uuid, project_uuid, origin_node_id, local_sequence,
         target_type, target_key, operation_type, base_revision, base_hash,
         payload, status, attempts, last_error, created_at, updated_at,
         acked_at, ack_metadata
       ) VALUES (?, ?, ?, ?, 'project_setting', ?, 'project_setting.set', NULL, NULL,
                 ?, 'queued', 0, NULL, ?, ?, NULL, NULL)`
    ).run(
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      PROJECT_UUID,
      NODE_A,
      9000,
      `projectXsetting:${PROJECT_UUID}:imposter`,
      JSON.stringify({}),
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z'
    );

    const escaped = getSyncQueueSummary(db, {
      originNodeId: NODE_A,
      targetKeyPrefix: 'project_setting:',
    });
    // Should match only the legitimate project_setting:* row, not the imposter.
    expect(escaped.pending).toBe(1);
  });
});
