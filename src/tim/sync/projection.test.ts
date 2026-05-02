import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'vitest';
import type { TimConfig } from '../configSchema.js';
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
  removePlanListItemOperation,
  removePlanTagOperation,
  removePlanTaskOperation,
  setPlanParentOperation,
  setPlanScalarOperation,
  setProjectSettingOperation,
  updatePlanTaskTextOperation,
} from './operations.js';
import { assertValidPayload } from './types.js';
import { writeProjectSettingSet } from './write_router.js';
import {
  enqueueOperation,
  markOperationAcked,
  markOperationConflict,
  markOperationFailedRetryable,
  markOperationRejected,
  markOperationSending,
} from './queue.js';
import { rebuildPlanProjection, rebuildProjectSettingProjection } from './projection.js';

const PROJECT_UUID = '11111111-1111-4111-8111-111111111111';
const NODE_A = 'persistent-a';
const PLAN_UUID = '22222222-2222-4222-8222-222222222222';
const TASK_UUID = '33333333-3333-4333-8333-333333333333';

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

describe('rebuildPlanProjection', () => {
  test('copies canonical plan when there are no active operations', () => {
    writeCanonicalPlan({
      revision: 4,
      title: 'Canonical',
      tasks: [{ uuid: TASK_UUID, title: 'Task', description: '', done: false, revision: 2 }],
    });

    rebuildPlanProjection(db, PLAN_UUID);

    expect(getPlanByUuid(db, PLAN_UUID)).toMatchObject({
      title: 'Canonical',
      revision: 4,
    });
    expect(getPlanTasksByUuid(db, PLAN_UUID)).toHaveLength(1);
    expect(getPlanTasksByUuid(db, PLAN_UUID)[0]).toMatchObject({
      uuid: TASK_UUID,
      revision: 2,
    });
  });

  test('rebuilding a dependency target preserves inbound projection edges owned by other plans', () => {
    const dependencyPlanUuid = '77777777-7777-4777-8777-777777777777';
    upsertCanonicalPlanInTransaction(db, project.id, {
      uuid: PLAN_UUID,
      planId: 12,
      title: 'Dependent',
      status: 'pending',
      revision: 1,
      dependencyUuids: [dependencyPlanUuid],
      tasks: [],
      tags: [],
    });
    upsertCanonicalPlanInTransaction(db, project.id, {
      uuid: dependencyPlanUuid,
      planId: 13,
      title: 'Dependency',
      status: 'pending',
      revision: 1,
      dependencyUuids: [],
      tasks: [],
      tags: [],
    });

    rebuildPlanProjection(db, PLAN_UUID);
    expect(getPlanDependenciesByUuid(db, PLAN_UUID)).toEqual([
      { plan_uuid: PLAN_UUID, depends_on_uuid: dependencyPlanUuid },
    ]);

    rebuildPlanProjection(db, dependencyPlanUuid);

    expect(getPlanDependenciesByUuid(db, PLAN_UUID)).toEqual([
      { plan_uuid: PLAN_UUID, depends_on_uuid: dependencyPlanUuid },
    ]);
  });

  test('folds one set_scalar operation over canonical and advances projected revision', async () => {
    writeCanonicalPlan({ revision: 4, title: 'Canonical', status: 'pending' });
    await enqueuePlanSetScalar('status', 'in_progress', 4);

    rebuildPlanProjection(db, PLAN_UUID);

    expect(getPlanByUuid(db, PLAN_UUID)).toMatchObject({
      status: 'in_progress',
      revision: 5,
    });
  });

  test('folds multiple active operations in sequence', async () => {
    writeCanonicalPlan({ revision: 1, title: 'Canonical' });
    await enqueuePlanSetScalar('status', 'in_progress', 1, 1);
    await enqueuePlanAddTask('Added task', 2);
    await enqueuePlanAddTag('sync', 3);

    rebuildPlanProjection(db, PLAN_UUID);

    expect(getPlanByUuid(db, PLAN_UUID)).toMatchObject({
      status: 'in_progress',
      revision: 4,
    });
    expect(getPlanTasksByUuid(db, PLAN_UUID).map((task) => task.title)).toEqual(['Added task']);
    expect(db.prepare('SELECT tag FROM plan_tag WHERE plan_uuid = ?').all(PLAN_UUID)).toEqual([
      { tag: 'sync' },
    ]);
  });

  test('folds add_tag operation over canonical and advances projected revision', async () => {
    writeCanonicalPlan({ revision: 3, title: 'Canonical', tags: [] });
    await enqueuePlanAddTag('sync', 1);

    rebuildPlanProjection(db, PLAN_UUID);

    expect(getPlanByUuid(db, PLAN_UUID)).toMatchObject({ revision: 4 });
    expect(getPlanTagsByUuid(db, PLAN_UUID)).toEqual([{ plan_uuid: PLAN_UUID, tag: 'sync' }]);
  });

  test('creates projection from ghost canonical plus plan.create operation', async () => {
    await enqueueOperation(
      db,
      await createPlanOperation(
        {
          projectUuid: PROJECT_UUID,
          planUuid: PLAN_UUID,
          numericPlanId: 42,
          title: 'Local create',
          tasks: [{ taskUuid: TASK_UUID, title: 'First', description: '', done: false }],
        },
        { originNodeId: NODE_A, localSequence: 1 }
      )
    );

    rebuildPlanProjection(db, PLAN_UUID);

    expect(getPlanByUuid(db, PLAN_UUID)).toMatchObject({
      title: 'Local create',
      revision: 1,
      plan_id: 42,
    });
    expect(getPlanTasksByUuid(db, PLAN_UUID)[0]).toMatchObject({
      uuid: TASK_UUID,
      revision: 1,
    });
  });

  test('plan.create projection uses the numericPlanId persisted on enqueue', async () => {
    await enqueueOperation(
      db,
      await createPlanOperation(
        {
          projectUuid: PROJECT_UUID,
          planUuid: PLAN_UUID,
          title: 'Local create',
        },
        { originNodeId: NODE_A, localSequence: 1 }
      )
    );

    rebuildPlanProjection(db, PLAN_UUID);
    const firstPlanId = getPlanByUuid(db, PLAN_UUID)?.plan_id;
    rebuildPlanProjection(db, PLAN_UUID);

    expect(getPlanByUuid(db, PLAN_UUID)?.plan_id).toBe(firstPlanId);
    expect(firstPlanId).toBe(11);
    const row = db
      .prepare("SELECT payload FROM sync_operation WHERE operation_type = 'plan.create'")
      .get() as { payload: string };
    expect(JSON.parse(row.payload)).toMatchObject({ numericPlanId: firstPlanId });
  });

  test('projection skips add_dependency that would create a cycle without changing op status', async () => {
    const dependencyPlanUuid = '77777777-7777-4777-8777-777777777777';
    writeCanonicalPlan({
      revision: 1,
      title: 'Target',
      dependencyUuids: [dependencyPlanUuid],
    });
    upsertCanonicalPlanInTransaction(db, project.id, {
      uuid: dependencyPlanUuid,
      planId: 13,
      title: 'Dependency',
      status: 'pending',
      revision: 1,
      tasks: [],
      dependencyUuids: [],
      tags: [],
    });
    const operation = await addPlanDependencyOperation(
      PROJECT_UUID,
      { planUuid: dependencyPlanUuid, dependsOnPlanUuid: PLAN_UUID },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    enqueueOperation(db, operation);

    rebuildPlanProjection(db, dependencyPlanUuid);

    expect(getPlanDependenciesByUuid(db, dependencyPlanUuid)).toEqual([]);
    expect(operationStatus(operation.operationUuid)).toBe('queued');
  });

  test('projection skips set_parent that would create a dependency cycle', async () => {
    const parentUuid = '77777777-7777-4777-8777-777777777777';
    writeCanonicalPlan({
      revision: 1,
      title: 'Child',
      dependencyUuids: [parentUuid],
    });
    upsertCanonicalPlanInTransaction(db, project.id, {
      uuid: parentUuid,
      planId: 13,
      title: 'Parent',
      status: 'pending',
      revision: 1,
      tasks: [],
      dependencyUuids: [],
      tags: [],
    });
    const operation = await setPlanParentOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, newParentUuid: parentUuid, baseRevision: 1 },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    enqueueOperation(db, operation);

    rebuildPlanProjection(db, PLAN_UUID);

    expect(getPlanByUuid(db, PLAN_UUID)?.parent_uuid).toBeNull();
    expect(operationStatus(operation.operationUuid)).toBe('queued');
  });

  test('projection skips add_task with a duplicate canonical task UUID', async () => {
    const otherPlanUuid = '77777777-7777-4777-8777-777777777777';
    writeCanonicalPlan({ revision: 1, title: 'Target' });
    upsertCanonicalPlanInTransaction(db, project.id, {
      uuid: otherPlanUuid,
      planId: 13,
      title: 'Other',
      status: 'pending',
      revision: 1,
      tasks: [{ uuid: TASK_UUID, title: 'Existing', description: '', revision: 1 }],
      dependencyUuids: [],
      tags: [],
    });
    const operation = await addPlanTaskOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, taskUuid: TASK_UUID, title: 'Duplicate' },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    enqueueOperation(db, operation);

    rebuildPlanProjection(db, PLAN_UUID);

    expect(getPlanTasksByUuid(db, PLAN_UUID)).toEqual([]);
    expect(operationStatus(operation.operationUuid)).toBe('queued');
  });

  test('projection skips plan.create with a duplicate canonical task UUID', async () => {
    const otherPlanUuid = '77777777-7777-4777-8777-777777777777';
    upsertCanonicalPlanInTransaction(db, project.id, {
      uuid: otherPlanUuid,
      planId: 13,
      title: 'Other',
      status: 'pending',
      revision: 1,
      tasks: [{ uuid: TASK_UUID, title: 'Existing', description: '', revision: 1 }],
      dependencyUuids: [],
      tags: [],
    });
    const operation = await createPlanOperation(
      {
        projectUuid: PROJECT_UUID,
        planUuid: PLAN_UUID,
        numericPlanId: 42,
        title: 'Duplicate task create',
        tasks: [{ taskUuid: TASK_UUID, title: 'Duplicate', description: '' }],
      },
      { originNodeId: NODE_A, localSequence: 1 }
    );
    enqueueOperation(db, operation);

    rebuildPlanProjection(db, PLAN_UUID);

    expect(getPlanByUuid(db, PLAN_UUID)).toBeNull();
    expect(operationStatus(operation.operationUuid)).toBe('queued');
  });

  test('skips add_task against tombstoned canonical and deletes projection', async () => {
    writeCanonicalPlan({ revision: 2, title: 'Deleted canonical' });
    upsertProjectionPlanInTransaction(db, project.id, {
      uuid: PLAN_UUID,
      planId: 12,
      title: 'Old projection',
    });
    db.prepare(
      "INSERT INTO sync_tombstone (entity_type, entity_key, project_uuid, deletion_operation_uuid, deleted_revision, deleted_at, origin_node_id) VALUES ('plan', ?, ?, ?, ?, datetime('now'), ?)"
    ).run(`plan:${PLAN_UUID}`, PROJECT_UUID, crypto.randomUUID(), 3, 'main');
    await enqueuePlanAddTask('Skipped task');

    rebuildPlanProjection(db, PLAN_UUID);

    expect(getPlanByUuid(db, PLAN_UUID)).toBeNull();
    expect(getPlanTasksByUuid(db, PLAN_UUID)).toEqual([]);
  });

  test('preserves local-only base tracking fields while rebuilding from canonical', () => {
    writeCanonicalPlan({ revision: 4, title: 'Canonical update' });
    upsertProjectionPlanInTransaction(db, project.id, {
      uuid: PLAN_UUID,
      planId: 12,
      title: 'Old projection',
      baseCommit: 'abc123',
      baseChangeId: 'change-1',
    });

    rebuildPlanProjection(db, PLAN_UUID);

    expect(getPlanByUuid(db, PLAN_UUID)).toMatchObject({
      title: 'Canonical update',
      base_commit: 'abc123',
      base_change_id: 'change-1',
    });
  });

  // ── All 16 plan operation types ────────────────────────────────────────────

  test('patch_text: updates plan text field via three-way merge', async () => {
    writeCanonicalPlan({ revision: 2, title: 'Original title' });
    await enqueueOperation(
      db,
      await patchPlanTextOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, field: 'title', base: 'Original title', new: 'Updated title' },
        { originNodeId: NODE_A, localSequence: 1 }
      )
    );

    rebuildPlanProjection(db, PLAN_UUID);

    expect(getPlanByUuid(db, PLAN_UUID)).toMatchObject({
      title: 'Updated title',
      revision: 3,
    });
  });

  test('update_task_text: updates task title via three-way merge', async () => {
    writeCanonicalPlan({
      revision: 3,
      title: 'Plan',
      tasks: [{ uuid: TASK_UUID, title: 'Old task', description: '', done: false, revision: 1 }],
    });
    await enqueueOperation(
      db,
      await updatePlanTaskTextOperation(
        PROJECT_UUID,
        {
          planUuid: PLAN_UUID,
          taskUuid: TASK_UUID,
          field: 'title',
          base: 'Old task',
          new: 'New task',
        },
        { originNodeId: NODE_A, localSequence: 1 }
      )
    );

    rebuildPlanProjection(db, PLAN_UUID);

    const tasks = getPlanTasksByUuid(db, PLAN_UUID);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: 'New task', revision: 2 });
    expect(getPlanByUuid(db, PLAN_UUID)?.revision).toBe(4);
  });

  test('mark_task_done: marks a task as done in the projection', async () => {
    writeCanonicalPlan({
      revision: 2,
      title: 'Plan',
      tasks: [{ uuid: TASK_UUID, title: 'A task', description: '', done: false, revision: 1 }],
    });
    await enqueueOperation(
      db,
      await markPlanTaskDoneOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, taskUuid: TASK_UUID, done: true },
        { originNodeId: NODE_A, localSequence: 1 }
      )
    );

    rebuildPlanProjection(db, PLAN_UUID);

    expect(getPlanTasksByUuid(db, PLAN_UUID)[0]).toMatchObject({ done: 1 });
    expect(getPlanByUuid(db, PLAN_UUID)?.revision).toBe(3);
  });

  test('remove_task: removes the task from the projection', async () => {
    writeCanonicalPlan({
      revision: 2,
      title: 'Plan',
      tasks: [{ uuid: TASK_UUID, title: 'To remove', description: '', done: false, revision: 1 }],
    });
    await enqueueOperation(
      db,
      await removePlanTaskOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, taskUuid: TASK_UUID },
        { originNodeId: NODE_A, localSequence: 1 }
      )
    );

    rebuildPlanProjection(db, PLAN_UUID);

    expect(getPlanTasksByUuid(db, PLAN_UUID)).toHaveLength(0);
    expect(getPlanByUuid(db, PLAN_UUID)?.revision).toBe(3);
  });

  test('add_dependency: adds dependency row in projection', async () => {
    const DEP_UUID = '44444444-4444-4444-8444-444444444444';
    writeCanonicalPlan({ revision: 1, title: 'Plan' });
    upsertCanonicalPlanInTransaction(db, project.id, {
      uuid: DEP_UUID,
      planId: 20,
      title: 'Dep plan',
      status: 'pending',
      revision: 1,
      tasks: [],
      dependencyUuids: [],
      tags: [],
    });
    await enqueueOperation(
      db,
      await addPlanDependencyOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, dependsOnPlanUuid: DEP_UUID },
        { originNodeId: NODE_A, localSequence: 1 }
      )
    );

    rebuildPlanProjection(db, PLAN_UUID);

    const deps = getPlanDependenciesByUuid(db, PLAN_UUID);
    expect(deps).toHaveLength(1);
    expect(deps[0].depends_on_uuid).toBe(DEP_UUID);
  });

  test('remove_dependency: removes dependency from projection', async () => {
    const DEP_UUID = '44444444-4444-4444-8444-444444444444';
    writeCanonicalPlan({ revision: 1, title: 'Plan', dependencyUuids: [DEP_UUID] });
    upsertCanonicalPlanInTransaction(db, project.id, {
      uuid: DEP_UUID,
      planId: 20,
      title: 'Dep plan',
      status: 'pending',
      revision: 1,
      tasks: [],
      dependencyUuids: [],
      tags: [],
    });
    await enqueueOperation(
      db,
      await removePlanDependencyOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, dependsOnPlanUuid: DEP_UUID },
        { originNodeId: NODE_A, localSequence: 1 }
      )
    );

    rebuildPlanProjection(db, PLAN_UUID);

    expect(getPlanDependenciesByUuid(db, PLAN_UUID)).toHaveLength(0);
  });

  test('remove_tag: removes tag from projection', async () => {
    writeCanonicalPlan({ revision: 2, title: 'Plan', tags: ['sync', 'active'] });
    await enqueueOperation(
      db,
      await removePlanTagOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, tag: 'active' },
        { originNodeId: NODE_A, localSequence: 1 }
      )
    );

    rebuildPlanProjection(db, PLAN_UUID);

    const tags = getPlanTagsByUuid(db, PLAN_UUID);
    expect(tags.map((t) => t.tag)).toEqual(['sync']);
  });

  test('add_list_item: appends to docs list in projection', async () => {
    writeCanonicalPlan({ revision: 2, title: 'Plan' });
    await enqueueOperation(
      db,
      await addPlanListItemOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, list: 'docs', value: 'README.md' },
        { originNodeId: NODE_A, localSequence: 1 }
      )
    );

    rebuildPlanProjection(db, PLAN_UUID);

    const plan = getPlanByUuid(db, PLAN_UUID);
    expect(JSON.parse(plan?.docs ?? '[]')).toEqual(['README.md']);
    expect(plan?.revision).toBe(3);
  });

  test('remove_list_item: removes from docs list in projection', async () => {
    writeCanonicalPlan({ revision: 2, title: 'Plan', docs: ['README.md', 'SPEC.md'] });
    await enqueueOperation(
      db,
      await removePlanListItemOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, list: 'docs', value: 'README.md' },
        { originNodeId: NODE_A, localSequence: 1 }
      )
    );

    rebuildPlanProjection(db, PLAN_UUID);

    const plan = getPlanByUuid(db, PLAN_UUID);
    expect(JSON.parse(plan?.docs ?? '[]')).toEqual(['SPEC.md']);
  });

  test('plan.delete: removes all projection rows', async () => {
    writeCanonicalPlan({
      revision: 3,
      title: 'To delete',
      tasks: [{ uuid: TASK_UUID, title: 'Task', description: '', done: false, revision: 1 }],
      tags: ['tag1'],
    });
    // Build an initial projection so there are rows to delete
    rebuildPlanProjection(db, PLAN_UUID);
    expect(getPlanByUuid(db, PLAN_UUID)).not.toBeNull();

    await enqueueOperation(
      db,
      await deletePlanOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID },
        { originNodeId: NODE_A, localSequence: 1 }
      )
    );

    rebuildPlanProjection(db, PLAN_UUID);

    expect(getPlanByUuid(db, PLAN_UUID)).toBeNull();
    expect(getPlanTasksByUuid(db, PLAN_UUID)).toEqual([]);
    expect(getPlanTagsByUuid(db, PLAN_UUID)).toEqual([]);
  });

  test('set_parent: updates parent_uuid on the projection plan', async () => {
    const PARENT_UUID = '55555555-5555-4555-8555-555555555555';
    writeCanonicalPlan({ revision: 2, title: 'Child' });
    upsertCanonicalPlanInTransaction(db, project.id, {
      uuid: PARENT_UUID,
      planId: 30,
      title: 'Parent',
      status: 'pending',
      revision: 1,
      tasks: [],
      dependencyUuids: [],
      tags: [],
    });
    await enqueueOperation(
      db,
      await setPlanParentOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, newParentUuid: PARENT_UUID },
        { originNodeId: NODE_A, localSequence: 1 }
      )
    );

    rebuildPlanProjection(db, PLAN_UUID);

    expect(getPlanByUuid(db, PLAN_UUID)?.parent_uuid).toBe(PARENT_UUID);
    expect(getPlanByUuid(db, PLAN_UUID)?.revision).toBe(3);
  });

  test('enqueuing set_parent rebuilds both old and new parent dependency edges', async () => {
    const OLD_PARENT_UUID = '44444444-4444-4444-8444-444444444444';
    const NEW_PARENT_UUID = '55555555-5555-4555-8555-555555555555';

    // Set up canonical: child with old parent, old parent has child as dep edge, new parent has none
    upsertCanonicalPlanInTransaction(db, project.id, {
      uuid: PLAN_UUID,
      planId: 10,
      title: 'Child',
      status: 'pending',
      revision: 1,
      parentUuid: OLD_PARENT_UUID,
      tasks: [],
      dependencyUuids: [],
      tags: [],
    });
    upsertCanonicalPlanInTransaction(db, project.id, {
      uuid: OLD_PARENT_UUID,
      planId: 20,
      title: 'Old Parent',
      status: 'pending',
      revision: 1,
      tasks: [],
      dependencyUuids: [PLAN_UUID],
      tags: [],
    });
    upsertCanonicalPlanInTransaction(db, project.id, {
      uuid: NEW_PARENT_UUID,
      planId: 30,
      title: 'New Parent',
      status: 'pending',
      revision: 1,
      tasks: [],
      dependencyUuids: [],
      tags: [],
    });

    // Build initial projections matching canonical
    rebuildPlanProjection(db, PLAN_UUID);
    rebuildPlanProjection(db, OLD_PARENT_UUID);
    rebuildPlanProjection(db, NEW_PARENT_UUID);

    // Verify baseline: old parent has child as dep
    expect(getPlanDependenciesByUuid(db, OLD_PARENT_UUID).map((d) => d.depends_on_uuid)).toContain(
      PLAN_UUID
    );
    expect(getPlanDependenciesByUuid(db, NEW_PARENT_UUID)).toHaveLength(0);

    // Enqueue set_parent — this should rebuild all three plans' projections atomically
    await enqueueOperation(
      db,
      await setPlanParentOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, newParentUuid: NEW_PARENT_UUID },
        { originNodeId: NODE_A, localSequence: 1 }
      )
    );

    // Old parent's projection should no longer have child as a dependency
    expect(getPlanDependenciesByUuid(db, OLD_PARENT_UUID)).toHaveLength(0);
    // New parent's projection should now have child as a dependency
    expect(getPlanDependenciesByUuid(db, NEW_PARENT_UUID).map((d) => d.depends_on_uuid)).toContain(
      PLAN_UUID
    );
    // Child's parent_uuid updated in projection
    expect(getPlanByUuid(db, PLAN_UUID)?.parent_uuid).toBe(NEW_PARENT_UUID);
  });

  test('enqueuing promote_task rebuilds both source and destination plan projections without explicit rebuild calls', async () => {
    const NEW_PLAN_UUID = '66666666-6666-4666-8666-666666666666';
    writeCanonicalPlan({
      revision: 2,
      title: 'Source',
      tasks: [{ uuid: TASK_UUID, title: 'Promotable', description: '', done: false, revision: 1 }],
    });

    // Enqueue only — no explicit rebuildPlanProjection calls
    await enqueueOperation(
      db,
      await promotePlanTaskOperation(
        PROJECT_UUID,
        {
          sourcePlanUuid: PLAN_UUID,
          taskUuid: TASK_UUID,
          newPlanUuid: NEW_PLAN_UUID,
          numericPlanId: 99,
          title: 'Auto-rebuilt plan',
        },
        { originNodeId: NODE_A, localSequence: 1 }
      )
    );

    // Source plan projection updated by enqueueOperation
    expect(getPlanTasksByUuid(db, PLAN_UUID)[0]).toMatchObject({ uuid: TASK_UUID, done: 1 });
    // Destination plan projection created by enqueueOperation
    const dest = getPlanByUuid(db, NEW_PLAN_UUID);
    expect(dest).not.toBeNull();
    expect(dest?.title).toBe('Auto-rebuilt plan');
    expect(dest?.plan_id).toBe(99);
  });

  test('enqueuing plan.delete removes inbound dependency and parent references from other projections', async () => {
    const PLAN_A_UUID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const PLAN_B_UUID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const PLAN_C_UUID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

    upsertCanonicalPlanInTransaction(db, project.id, {
      uuid: PLAN_B_UUID,
      planId: 21,
      title: 'Deleted target',
      status: 'pending',
      revision: 1,
      tasks: [],
      dependencyUuids: [],
      tags: [],
    });
    upsertCanonicalPlanInTransaction(db, project.id, {
      uuid: PLAN_A_UUID,
      planId: 22,
      title: 'Dependency owner',
      status: 'pending',
      revision: 1,
      tasks: [],
      dependencyUuids: [PLAN_B_UUID],
      tags: [],
    });
    upsertCanonicalPlanInTransaction(db, project.id, {
      uuid: PLAN_C_UUID,
      planId: 23,
      title: 'Child plan',
      status: 'pending',
      parentUuid: PLAN_B_UUID,
      revision: 1,
      tasks: [],
      dependencyUuids: [],
      tags: [],
    });
    rebuildPlanProjection(db, PLAN_B_UUID);
    rebuildPlanProjection(db, PLAN_A_UUID);
    rebuildPlanProjection(db, PLAN_C_UUID);

    expect(getPlanDependenciesByUuid(db, PLAN_A_UUID).map((dep) => dep.depends_on_uuid)).toContain(
      PLAN_B_UUID
    );
    expect(getPlanByUuid(db, PLAN_C_UUID)?.parent_uuid).toBe(PLAN_B_UUID);

    await enqueueOperation(
      db,
      await deletePlanOperation(
        PROJECT_UUID,
        { planUuid: PLAN_B_UUID },
        { originNodeId: NODE_A, localSequence: 1 }
      )
    );

    expect(
      getPlanDependenciesByUuid(db, PLAN_A_UUID).map((dep) => dep.depends_on_uuid)
    ).not.toContain(PLAN_B_UUID);
    expect(getPlanByUuid(db, PLAN_C_UUID)?.parent_uuid).toBeNull();
    expect(getPlanByUuid(db, PLAN_B_UUID)).toBeNull();

    await enqueueOperation(
      db,
      await setPlanScalarOperation(
        PROJECT_UUID,
        {
          planUuid: PLAN_A_UUID,
          field: 'status',
          value: 'in_progress',
        },
        { originNodeId: NODE_A, localSequence: 2 }
      )
    );

    expect(getPlanByUuid(db, PLAN_A_UUID)?.status).toBe('in_progress');
    expect(
      getPlanDependenciesByUuid(db, PLAN_A_UUID).map((dep) => dep.depends_on_uuid)
    ).not.toContain(PLAN_B_UUID);

    await enqueueOperation(
      db,
      await setPlanScalarOperation(
        PROJECT_UUID,
        {
          planUuid: PLAN_C_UUID,
          field: 'status',
          value: 'in_progress',
        },
        { originNodeId: NODE_A, localSequence: 3 }
      )
    );

    expect(getPlanByUuid(db, PLAN_C_UUID)?.status).toBe('in_progress');
    expect(getPlanByUuid(db, PLAN_C_UUID)?.parent_uuid).toBeNull();
  });

  test('promote_task: creates destination plan and marks source task done', async () => {
    const NEW_PLAN_UUID = '66666666-6666-4666-8666-666666666666';
    writeCanonicalPlan({
      revision: 2,
      title: 'Source',
      tasks: [{ uuid: TASK_UUID, title: 'Promotable', description: '', done: false, revision: 1 }],
    });
    await enqueueOperation(
      db,
      await promotePlanTaskOperation(
        PROJECT_UUID,
        {
          sourcePlanUuid: PLAN_UUID,
          taskUuid: TASK_UUID,
          newPlanUuid: NEW_PLAN_UUID,
          numericPlanId: 99,
          title: 'Promoted plan',
        },
        { originNodeId: NODE_A, localSequence: 1 }
      )
    );

    rebuildPlanProjection(db, PLAN_UUID);
    rebuildPlanProjection(db, NEW_PLAN_UUID);

    // Source: task marked done, plan revision bumped
    const sourceTasks = getPlanTasksByUuid(db, PLAN_UUID);
    expect(sourceTasks[0]).toMatchObject({ uuid: TASK_UUID, done: 1 });
    expect(getPlanByUuid(db, PLAN_UUID)?.revision).toBe(3);

    // Destination: new plan created from ghost canonical
    const dest = getPlanByUuid(db, NEW_PLAN_UUID);
    expect(dest).not.toBeNull();
    expect(dest?.title).toBe('Promoted plan');
    expect(dest?.plan_id).toBe(99);
  });

  // ── Silent-skip invariant ───────────────────────────────────────────────────

  test('future baseRevision on set_scalar is silently skipped without mutating operation status', async () => {
    writeCanonicalPlan({ revision: 5, title: 'Plan', status: 'pending' });
    const op = await enqueueOperation(
      db,
      await setPlanScalarOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, field: 'status', value: 'in_progress', baseRevision: 6 },
        { originNodeId: NODE_A, localSequence: 1 }
      )
    );

    rebuildPlanProjection(db, PLAN_UUID);

    // Projection unchanged — future-base op skipped
    expect(getPlanByUuid(db, PLAN_UUID)).toMatchObject({ status: 'pending', revision: 5 });
    // Status not mutated by projector
    const row = db
      .prepare('SELECT status FROM sync_operation WHERE operation_uuid = ?')
      .get(op.operation.operationUuid) as { status: string };
    expect(row.status).toBe('queued');
  });

  test('missing task on mark_task_done is silently skipped', async () => {
    const MISSING_TASK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    writeCanonicalPlan({ revision: 2, title: 'Plan' });
    await enqueueOperation(
      db,
      await markPlanTaskDoneOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, taskUuid: MISSING_TASK, done: true },
        { originNodeId: NODE_A, localSequence: 1 }
      )
    );

    // Should not throw
    expect(() => rebuildPlanProjection(db, PLAN_UUID)).not.toThrow();
    // Plan still intact
    expect(getPlanByUuid(db, PLAN_UUID)).not.toBeNull();
  });

  test('add_dependency with missing dep plan is silently skipped', async () => {
    const MISSING_DEP = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    writeCanonicalPlan({ revision: 1, title: 'Plan' });
    await enqueueOperation(
      db,
      await addPlanDependencyOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, dependsOnPlanUuid: MISSING_DEP },
        { originNodeId: NODE_A, localSequence: 1 }
      )
    );

    expect(() => rebuildPlanProjection(db, PLAN_UUID)).not.toThrow();
    expect(getPlanDependenciesByUuid(db, PLAN_UUID)).toHaveLength(0);
  });

  test('tombstoned plan with no active ops deletes projection across all tables', () => {
    writeCanonicalPlan({
      revision: 3,
      title: 'Deleted',
      tasks: [{ uuid: TASK_UUID, title: 'Task', description: '', done: false, revision: 1 }],
      tags: ['old-tag'],
    });
    rebuildPlanProjection(db, PLAN_UUID);
    expect(getPlanByUuid(db, PLAN_UUID)).not.toBeNull();

    db.prepare(
      "INSERT INTO sync_tombstone (entity_type, entity_key, project_uuid, deletion_operation_uuid, deleted_revision, deleted_at, origin_node_id) VALUES ('plan', ?, ?, ?, ?, datetime('now'), ?)"
    ).run(`plan:${PLAN_UUID}`, PROJECT_UUID, crypto.randomUUID(), 4, 'main');

    rebuildPlanProjection(db, PLAN_UUID);

    expect(getPlanByUuid(db, PLAN_UUID)).toBeNull();
    expect(getPlanTasksByUuid(db, PLAN_UUID)).toEqual([]);
    expect(getPlanTagsByUuid(db, PLAN_UUID)).toEqual([]);
    expect(getPlanDependenciesByUuid(db, PLAN_UUID)).toEqual([]);
  });

  test('patch_text with future baseRevision is silently skipped', async () => {
    writeCanonicalPlan({ revision: 5, title: 'Original' });
    await enqueueOperation(
      db,
      await patchPlanTextOperation(
        PROJECT_UUID,
        {
          planUuid: PLAN_UUID,
          field: 'title',
          base: 'Original',
          new: 'Updated',
          baseRevision: 6,
        },
        { originNodeId: NODE_A, localSequence: 1 }
      )
    );

    rebuildPlanProjection(db, PLAN_UUID);

    // Projection unchanged — future-base op skipped
    expect(getPlanByUuid(db, PLAN_UUID)?.title).toBe('Original');
  });

  // ── Running revision discipline ─────────────────────────────────────────────

  test('three sequential ops produce revision = canonical + 3', async () => {
    writeCanonicalPlan({ revision: 10, title: 'Plan', status: 'pending' });
    await enqueuePlanSetScalar('status', 'in_progress', 10, 1);
    await enqueuePlanSetScalar('status', 'needs_review', 11, 2);
    await enqueuePlanSetScalar('status', 'done', 12, 3);

    rebuildPlanProjection(db, PLAN_UUID);

    expect(getPlanByUuid(db, PLAN_UUID)?.revision).toBe(13);
  });

  test('skipped op does not advance the projection revision', async () => {
    writeCanonicalPlan({ revision: 5, title: 'Plan', status: 'pending' });
    // Stale base — skipped
    await enqueuePlanSetScalar('status', 'in_progress', 4, 1);
    // Correct base — applied
    await enqueuePlanSetScalar('status', 'in_progress', 5, 2);

    rebuildPlanProjection(db, PLAN_UUID);

    expect(getPlanByUuid(db, PLAN_UUID)?.revision).toBe(6);
  });

  // ── Cross-field pending edits preserved after canonical update ──────────────

  test('canonical update for one field preserves pending edit on another field', async () => {
    writeCanonicalPlan({ revision: 1, title: 'Plan', status: 'pending' });
    // Enqueue a status change
    await enqueuePlanSetScalar('status', 'in_progress', 1, 1, 'pending');

    // Simulate canonical update arriving (e.g. title changed on main node)
    writeCanonicalPlan({ revision: 2, title: 'Updated by main' });

    // Rebuild — canonical rev is now 2, pending op has baseRevision: 1.
    // The title update from canonical and the unrelated pending status edit
    // should both remain visible.
    rebuildPlanProjection(db, PLAN_UUID);

    expect(getPlanByUuid(db, PLAN_UUID)).toMatchObject({
      title: 'Updated by main',
      status: 'in_progress',
      revision: 3,
    });
  });

  test('canonical update for same scalar field skips stale pending edit', async () => {
    writeCanonicalPlan({ revision: 1, title: 'Plan', status: 'pending' });
    await enqueuePlanSetScalar('status', 'in_progress', 1, 1, 'pending');

    writeCanonicalPlan({ revision: 2, title: 'Plan', status: 'needs_review' });

    rebuildPlanProjection(db, PLAN_UUID);

    expect(getPlanByUuid(db, PLAN_UUID)).toMatchObject({
      title: 'Plan',
      status: 'needs_review',
      revision: 2,
    });
  });

  test.each(['simple', 'tdd', 'temp', 'epic'] as const)(
    'canonical update preserves pending boolean scalar edit (%s)',
    async (field) => {
      // Canonical at revision 1 with field = false (stored as 0).
      upsertCanonicalPlanInTransaction(db, project.id, {
        uuid: PLAN_UUID,
        planId: 12,
        title: 'Plan',
        status: 'pending',
        revision: 1,
        tasks: [],
        dependencyUuids: [],
        tags: [],
        [field]: false,
      });

      // Pending op flips the boolean field, baseValue captures the false pre-state
      // and baseRevision is 1.
      await enqueueOperation(
        db,
        await setPlanScalarOperation(
          PROJECT_UUID,
          {
            planUuid: PLAN_UUID,
            field,
            value: true,
            baseValue: false,
            baseRevision: 1,
          },
          { originNodeId: NODE_A, localSequence: 1 }
        )
      );

      // Canonical advances to revision 2 with an unrelated title change; the
      // boolean field is unchanged.
      upsertCanonicalPlanInTransaction(db, project.id, {
        uuid: PLAN_UUID,
        planId: 12,
        title: 'Updated by main',
        status: 'pending',
        revision: 2,
        tasks: [],
        dependencyUuids: [],
        tags: [],
        [field]: false,
      });

      rebuildPlanProjection(db, PLAN_UUID);

      // The pending boolean edit must survive the unrelated canonical advance.
      expect(getPlanByUuid(db, PLAN_UUID)).toMatchObject({
        title: 'Updated by main',
        [field]: 1,
        revision: 3,
      });
    }
  );

  test('canonical plan update preserves pending task text edit when task is unchanged', async () => {
    writeCanonicalPlan({
      revision: 1,
      title: 'Plan',
      tasks: [{ uuid: TASK_UUID, title: 'Task', description: 'old', done: false, revision: 1 }],
    });
    await enqueueOperation(
      db,
      await updatePlanTaskTextOperation(
        PROJECT_UUID,
        {
          planUuid: PLAN_UUID,
          taskUuid: TASK_UUID,
          field: 'description',
          base: 'old',
          new: 'local edit',
          baseRevision: 1,
        },
        { originNodeId: NODE_A, localSequence: 1 }
      )
    );

    writeCanonicalPlan({
      revision: 2,
      title: 'Updated by main',
      tasks: [{ uuid: TASK_UUID, title: 'Task', description: 'old', done: false, revision: 1 }],
    });

    rebuildPlanProjection(db, PLAN_UUID);

    expect(getPlanByUuid(db, PLAN_UUID)).toMatchObject({
      title: 'Updated by main',
      revision: 3,
    });
    expect(getPlanTasksByUuid(db, PLAN_UUID)[0]).toMatchObject({
      uuid: TASK_UUID,
      description: 'local edit',
      revision: 2,
    });
  });

  test('promote_task: source task skipped silently when tombstoned and op collapses projection', async () => {
    const NEW_PLAN_UUID = '77777777-7777-4777-8777-777777777777';
    writeCanonicalPlan({
      revision: 2,
      title: 'Source',
      tasks: [{ uuid: TASK_UUID, title: 'Promotable', description: '', done: false, revision: 1 }],
    });
    await enqueueOperation(
      db,
      await promotePlanTaskOperation(
        PROJECT_UUID,
        {
          sourcePlanUuid: PLAN_UUID,
          taskUuid: TASK_UUID,
          newPlanUuid: NEW_PLAN_UUID,
          numericPlanId: 88,
          title: 'Promoted',
        },
        { originNodeId: NODE_A, localSequence: 1 }
      )
    );
    // Build initial projection
    rebuildPlanProjection(db, PLAN_UUID);
    rebuildPlanProjection(db, NEW_PLAN_UUID);
    expect(getPlanByUuid(db, NEW_PLAN_UUID)).not.toBeNull();

    // Mark the op terminal (rejected) — projection should collapse
    const opRow = db
      .prepare(
        "SELECT operation_uuid FROM sync_operation WHERE operation_type = 'plan.promote_task' LIMIT 1"
      )
      .get() as { operation_uuid: string };
    markOperationSending(db, opRow.operation_uuid);
    markOperationRejected(db, opRow.operation_uuid, 'precondition failed', {});

    // Rebuild after rejection — op no longer active, projection should reflect canonical only
    rebuildPlanProjection(db, PLAN_UUID);
    rebuildPlanProjection(db, NEW_PLAN_UUID);

    // Source task should not be marked done
    const sourceTasks = getPlanTasksByUuid(db, PLAN_UUID);
    expect(sourceTasks[0]).toMatchObject({ done: 0 });

    // Destination plan should disappear (no canonical + no active ops)
    expect(getPlanByUuid(db, NEW_PLAN_UUID)).toBeNull();
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
      revision: 4,
      updatedByNode: 'main',
    });
  });

  test('copies canonical revision when there are no active operations', () => {
    writeCanonicalProjectSettingRow(db, project.id, 'color', 'blue', {
      revision: 5,
      updatedByNode: 'main',
    });

    rebuildProjectSettingProjection(db, project.id, 'color');

    expect(getProjectSettingWithMetadata(db, project.id, 'color')).toMatchObject({
      value: 'blue',
      revision: 5,
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
      revision: 5,
      updatedByNode: NODE_A,
    });
  });

  test('increments projection revision for one matching set operation over canonical', async () => {
    writeCanonicalProjectSettingRow(db, project.id, 'color', 'blue', {
      revision: 5,
      updatedByNode: 'main',
    });
    await enqueueSet('color', 'green', 5);

    rebuildProjectSettingProjection(db, project.id, 'color');

    expect(getProjectSettingWithMetadata(db, project.id, 'color')).toMatchObject({
      value: 'green',
      revision: 6,
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
    expect(getProjectSettingWithMetadata(db, project.id, 'featured')?.revision).toBe(1);
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
      revision: 5,
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
    expect(getProjectSettingWithMetadata(db, project.id, 'color')?.revision).toBe(7);
  });

  test('persistent latest write uses projected revision and remains visible locally', async () => {
    const config = {
      sync: {
        role: 'persistent',
        nodeId: NODE_A,
        mainUrl: 'http://127.0.0.1:9999',
        nodeToken: 'secret-token',
        offline: true,
      },
    } as TimConfig;
    writeCanonicalProjectSettingRow(db, project.id, 'color', 'blue', {
      revision: 5,
      updatedByNode: 'main',
    });
    rebuildProjectSettingProjection(db, project.id, 'color');

    const result = await writeProjectSettingSet(db, config, project.id, 'color', 'green', 'latest');

    expect(result.mode).toBe('queued');
    const row = db
      .prepare(
        `
          SELECT payload
          FROM sync_operation
          WHERE operation_uuid = ?
        `
      )
      .get(result.operation.operationUuid) as { payload: string };
    const payload = assertValidPayload(JSON.parse(row.payload));
    expect(payload).toMatchObject({
      type: 'project_setting.set',
      baseRevision: 5,
    });
    expect(getProjectSettingWithMetadata(db, project.id, 'color')).toMatchObject({
      value: 'green',
      revision: 6,
      updatedByNode: NODE_A,
    });
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

function writeCanonicalPlan(
  input: Partial<Parameters<typeof upsertCanonicalPlanInTransaction>[2]> & {
    revision: number;
    title: string;
  }
) {
  return upsertCanonicalPlanInTransaction(db, project.id, {
    uuid: PLAN_UUID,
    planId: 12,
    title: input.title,
    status: input.status ?? 'pending',
    revision: input.revision,
    tasks: input.tasks ?? [],
    dependencyUuids: input.dependencyUuids ?? [],
    tags: input.tags ?? [],
    docs: input.docs,
  });
}

function operationStatus(operationUuid: string): string {
  return (
    db.prepare('SELECT status FROM sync_operation WHERE operation_uuid = ?').get(operationUuid) as {
      status: string;
    }
  ).status;
}

async function enqueuePlanSetScalar(
  field: 'status',
  value: 'pending' | 'in_progress' | 'done' | 'cancelled' | 'deferred' | 'needs_review',
  baseRevision?: number,
  localSequence = 1,
  baseValue?: 'pending' | 'in_progress' | 'done' | 'cancelled' | 'deferred' | 'needs_review'
) {
  return enqueueOperation(
    db,
    await setPlanScalarOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, field, value, baseRevision, baseValue },
      { originNodeId: NODE_A, localSequence }
    )
  ).operation;
}

async function enqueuePlanAddTask(title: string, localSequence = 1) {
  return enqueueOperation(
    db,
    await addPlanTaskOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, taskUuid: crypto.randomUUID(), title },
      { originNodeId: NODE_A, localSequence }
    )
  ).operation;
}

async function enqueuePlanAddTag(tag: string, localSequence = 1) {
  return enqueueOperation(
    db,
    await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag },
      { originNodeId: NODE_A, localSequence }
    )
  ).operation;
}
