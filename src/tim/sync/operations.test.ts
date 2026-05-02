import { describe, expect, test } from 'vitest';
import type { TimConfig } from '../configSchema.js';
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
  setPlanParentOperation,
  setPlanScalarOperation,
  setProjectSettingOperation,
  updatePlanTaskTextOperation,
} from './operations.js';
import { SyncOperationEnvelopeSchema } from './types.js';

const PROJECT_UUID = '11111111-1111-4111-8111-111111111111';
const PLAN_UUID = '22222222-2222-4222-8222-222222222222';
const OTHER_PLAN_UUID = '33333333-3333-4333-8333-333333333333';
const TASK_UUID = '55555555-5555-4555-8555-555555555555';
const NEW_PLAN_UUID = '66666666-6666-4666-8666-666666666666';
const PROVIDED_OPERATION_UUID = '44444444-4444-4444-8444-444444444444';
const CONFIG = { sync: { nodeId: 'local-node', role: 'persistent' } } as TimConfig;

const OPERATION_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('sync operation constructors', () => {
  test('constructors round-trip through the envelope schema', async () => {
    const operations = [
      await createPlanOperation(
        {
          projectUuid: PROJECT_UUID,
          planUuid: PLAN_UUID,
          numericPlanId: 123,
          title: 'Created offline',
          goal: 'Goal',
          tags: ['sync'],
          dependencies: [OTHER_PLAN_UUID],
          tasks: [{ title: 'Initial task', description: 'Do it' }],
        },
        { config: CONFIG, localSequence: 1 }
      ),
      await setPlanScalarOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, field: 'status', value: 'in_progress' },
        { originNodeId: 'override-node', localSequence: 2 }
      ),
      await patchPlanTextOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, field: 'details', base: 'old', new: 'new' },
        { originNodeId: 'override-node', localSequence: 3 }
      ),
      await addPlanTaskOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, title: 'New task' },
        { originNodeId: 'override-node', localSequence: 4 }
      ),
      await updatePlanTaskTextOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, taskUuid: TASK_UUID, field: 'title', base: 'Old', new: 'New' },
        { originNodeId: 'override-node', localSequence: 5 }
      ),
      await markPlanTaskDoneOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, taskUuid: TASK_UUID, done: true },
        { originNodeId: 'override-node', localSequence: 6 }
      ),
      await addPlanDependencyOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, dependsOnPlanUuid: OTHER_PLAN_UUID },
        { originNodeId: 'override-node', localSequence: 7 }
      ),
      await removePlanDependencyOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, dependsOnPlanUuid: OTHER_PLAN_UUID },
        { originNodeId: 'override-node', localSequence: 8 }
      ),
      await addPlanTagOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, tag: 'offline' },
        { originNodeId: 'override-node', localSequence: 9 }
      ),
      await removePlanTagOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, tag: 'offline' },
        { originNodeId: 'override-node', localSequence: 10 }
      ),
      await addPlanListItemOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, list: 'docs', value: 'docs/sync.md' },
        { originNodeId: 'override-node', localSequence: 11 }
      ),
      await removePlanListItemOperation(
        PROJECT_UUID,
        {
          planUuid: PLAN_UUID,
          list: 'reviewIssues',
          value: { severity: 'major', category: 'bug', content: 'stale issue' },
        },
        { originNodeId: 'override-node', localSequence: 12 }
      ),
      await deletePlanOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, baseRevision: 4 },
        { originNodeId: 'override-node', localSequence: 13 }
      ),
      await setProjectSettingOperation(
        { projectUuid: PROJECT_UUID, setting: 'color', value: 'blue', baseRevision: 1 },
        { originNodeId: 'override-node', localSequence: 14 }
      ),
      await deleteProjectSettingOperation(
        { projectUuid: PROJECT_UUID, setting: 'color', baseRevision: 2 },
        { originNodeId: 'override-node', localSequence: 15 }
      ),
      await setPlanParentOperation(
        PROJECT_UUID,
        { planUuid: PLAN_UUID, newParentUuid: OTHER_PLAN_UUID },
        { originNodeId: 'override-node', localSequence: 16 }
      ),
      await promotePlanTaskOperation(
        PROJECT_UUID,
        {
          sourcePlanUuid: PLAN_UUID,
          taskUuid: TASK_UUID,
          newPlanUuid: NEW_PLAN_UUID,
          title: 'Promoted plan',
          description: 'From task',
        },
        { originNodeId: 'override-node', localSequence: 17 }
      ),
    ];

    for (const operation of operations) {
      expect(() => SyncOperationEnvelopeSchema.parse(operation)).not.toThrow();
      expect(JSON.parse(JSON.stringify(operation))).toEqual(operation);
    }
  });

  test('generates operation UUIDs and preserves provided operation UUIDs', async () => {
    const generated = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'sync' },
      { originNodeId: 'node-a', localSequence: 1 }
    );
    expect(generated.operationUuid).toMatch(OPERATION_UUID_V4);

    const provided = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'sync' },
      {
        originNodeId: 'node-a',
        localSequence: 2,
        operationUuid: PROVIDED_OPERATION_UUID,
      }
    );
    expect(provided.operationUuid).toBe(PROVIDED_OPERATION_UUID);
  });

  test('defaults originNodeId through getLocalNodeId and accepts override', async () => {
    const defaulted = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'sync' },
      { config: CONFIG, localSequence: 1 }
    );
    expect(defaulted.originNodeId).toBe('local-node');

    const overridden = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'sync' },
      { config: CONFIG, originNodeId: 'spawner-node', localSequence: 2 }
    );
    expect(overridden.originNodeId).toBe('spawner-node');
  });

  test('plan.create allocates task UUIDs for embedded tasks', async () => {
    const operation = await createPlanOperation(
      {
        projectUuid: PROJECT_UUID,
        planUuid: PLAN_UUID,
        title: 'Created offline',
        tasks: [
          { title: 'Generated task UUID', description: '' },
          { taskUuid: TASK_UUID, title: 'Provided task UUID', description: '' },
        ],
      },
      { originNodeId: 'node-a', localSequence: 1 }
    );

    expect(operation.op.type).toBe('plan.create');
    if (operation.op.type !== 'plan.create') {
      throw new Error('expected plan.create');
    }
    expect(operation.op.tasks[0]?.taskUuid).toMatch(OPERATION_UUID_V4);
    expect(operation.op.tasks[1]?.taskUuid).toBe(TASK_UUID);
  });

  test('addPlanTaskOperation auto-generates taskUuid and preserves provided taskUuid', async () => {
    const generated = await addPlanTaskOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, title: 'Task without uuid' },
      { originNodeId: 'node-a', localSequence: 1 }
    );
    expect(generated.op.type).toBe('plan.add_task');
    if (generated.op.type !== 'plan.add_task') throw new Error('expected plan.add_task');
    expect(generated.op.taskUuid).toMatch(OPERATION_UUID_V4);

    const withProvided = await addPlanTaskOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, taskUuid: TASK_UUID, title: 'Task with uuid' },
      { originNodeId: 'node-a', localSequence: 2 }
    );
    if (withProvided.op.type !== 'plan.add_task') throw new Error('expected plan.add_task');
    expect(withProvided.op.taskUuid).toBe(TASK_UUID);
  });

  test('envelope targetType and targetKey match entity_keys output for sampled operations', async () => {
    const tagOp = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'check' },
      { originNodeId: 'node-a', localSequence: 1 }
    );
    expect(tagOp.targetType).toBe('plan');
    expect(tagOp.targetKey).toBe(`plan:${PLAN_UUID}`);

    const taskOp = await markPlanTaskDoneOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, taskUuid: TASK_UUID, done: true },
      { originNodeId: 'node-a', localSequence: 2 }
    );
    expect(taskOp.targetType).toBe('task');
    expect(taskOp.targetKey).toBe(`task:${TASK_UUID}`);

    const settingOp = await setProjectSettingOperation(
      { projectUuid: PROJECT_UUID, setting: 'color', value: 'blue' },
      { originNodeId: 'node-a', localSequence: 3 }
    );
    expect(settingOp.targetType).toBe('project_setting');
    expect(settingOp.targetKey).toBe(`project_setting:${PROJECT_UUID}:color`);
  });

  test('set-like constructors do not dedupe values', async () => {
    const tag = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'same' },
      { originNodeId: 'node-a', localSequence: 1 }
    );
    const dependency = await addPlanDependencyOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, dependsOnPlanUuid: OTHER_PLAN_UUID },
      { originNodeId: 'node-a', localSequence: 2 }
    );
    const listItem = await addPlanListItemOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, list: 'changedFiles', value: 'src/a.ts' },
      { originNodeId: 'node-a', localSequence: 3 }
    );

    expect(tag.op).toMatchObject({ tag: 'same' });
    expect(dependency.op).toMatchObject({ dependsOnPlanUuid: OTHER_PLAN_UUID });
    expect(listItem.op).toMatchObject({ list: 'changedFiles', value: 'src/a.ts' });
  });
});
