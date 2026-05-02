import { describe, expect, test } from 'vitest';
import {
  assertValidPayload,
  assertValidEnvelope,
  deriveTargetKey,
  ProjectSettingNameSchema,
  SyncOperationBatchEnvelopeSchema,
  SyncOperationEnvelopeSchema,
  SyncOperationPayloadSchema,
  SyncOperationTypeSchema,
  type SyncOperationEnvelope,
} from './types.js';
import { SyncValidationError } from './errors.js';
import { planKey, projectSettingKey, taskKey } from './entity_keys.js';
import { addPlanTagOperation } from './operations.js';

const PROJECT_UUID = '11111111-1111-4111-8111-111111111111';
const PLAN_UUID = '22222222-2222-4222-8222-222222222222';
const OPERATION_UUID = '44444444-4444-4444-8444-444444444444';

function envelopeWithOp(op: SyncOperationEnvelope['op']): SyncOperationEnvelope {
  return {
    operationUuid: OPERATION_UUID,
    projectUuid: PROJECT_UUID,
    originNodeId: 'node-a',
    localSequence: 1,
    createdAt: '2026-04-27T12:00:00.000Z',
    targetType: 'plan',
    targetKey: `plan:${PLAN_UUID}`,
    op,
  };
}

describe('sync operation schemas', () => {
  test('rejects unknown operation discriminator with SyncValidationError helper', () => {
    expect(() => assertValidPayload({ type: 'unknown.operation' })).toThrow(SyncValidationError);
  });

  test('requires base and new strings for plan text patches', () => {
    const parsed = SyncOperationPayloadSchema.parse({
      type: 'plan.patch_text',
      planUuid: PLAN_UUID,
      field: 'details',
      base: 'old',
      new: 'new',
    });
    expect('patch' in parsed).toBe(false);

    expect(
      SyncOperationPayloadSchema.safeParse({
        type: 'plan.patch_text',
        planUuid: PLAN_UUID,
        field: 'details',
        new: 'new',
      }).success
    ).toBe(false);
  });

  test('requires base and new strings for task text patches', () => {
    expect(
      SyncOperationPayloadSchema.parse({
        type: 'plan.update_task_text',
        planUuid: PLAN_UUID,
        taskUuid: '33333333-3333-4333-8333-333333333333',
        field: 'description',
        base: 'old',
        new: 'new',
        patch: '@@ diff',
      })
    ).toMatchObject({ patch: '@@ diff' });

    expect(
      SyncOperationPayloadSchema.safeParse({
        type: 'plan.update_task_text',
        planUuid: PLAN_UUID,
        taskUuid: '33333333-3333-4333-8333-333333333333',
        field: 'description',
        base: 'old',
      }).success
    ).toBe(false);
  });

  test('validates scalar field value shape', () => {
    expect(
      SyncOperationPayloadSchema.safeParse({
        type: 'plan.set_scalar',
        planUuid: PLAN_UUID,
        field: 'epic',
        value: 'done',
      }).success
    ).toBe(false);
  });

  test('rejects local-only base tracking as synced scalar fields', () => {
    expect(
      SyncOperationPayloadSchema.safeParse({
        type: 'plan.set_scalar',
        planUuid: PLAN_UUID,
        field: 'base_commit',
        value: 'deadbeef',
      }).success
    ).toBe(false);
    expect(
      SyncOperationPayloadSchema.safeParse({
        type: 'plan.set_scalar',
        planUuid: PLAN_UUID,
        field: 'base_change_id',
        value: 'change-id',
      }).success
    ).toBe(false);
  });

  test('allows empty titles for plan.create stub plans', () => {
    expect(
      SyncOperationPayloadSchema.safeParse({
        type: 'plan.create',
        planUuid: PLAN_UUID,
        title: '',
      }).success
    ).toBe(true);
  });

  test('requires discoveredFrom sync references to be UUIDs', () => {
    expect(
      SyncOperationPayloadSchema.safeParse({
        type: 'plan.create',
        planUuid: PLAN_UUID,
        title: 'Child',
        discoveredFrom: 7,
      }).success
    ).toBe(false);
    expect(
      SyncOperationPayloadSchema.safeParse({
        type: 'plan.create',
        planUuid: PLAN_UUID,
        title: 'Child',
        discoveredFrom: '33333333-3333-4333-8333-333333333333',
      }).success
    ).toBe(true);
  });

  test('round-trips JSON without Date objects', () => {
    const envelope = envelopeWithOp({
      type: 'plan.add_tag',
      planUuid: PLAN_UUID,
      tag: 'sync',
    });
    const parsed = SyncOperationEnvelopeSchema.parse(JSON.parse(JSON.stringify(envelope)));
    expect(parsed).toEqual(envelope);
  });

  test('batch envelope rejects duplicate operation UUIDs', async () => {
    const first = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'one' },
      {
        operationUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        originNodeId: 'node-a',
        localSequence: 1,
      }
    );
    const second = await addPlanTagOperation(
      PROJECT_UUID,
      { planUuid: PLAN_UUID, tag: 'two' },
      {
        operationUuid: first.operationUuid,
        originNodeId: 'node-a',
        localSequence: 2,
      }
    );

    const result = SyncOperationBatchEnvelopeSchema.safeParse({
      batchId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      originNodeId: 'node-a',
      createdAt: new Date().toISOString(),
      operations: [first, second],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toContain(
      'duplicate operationUuid also appears at operations.0.operationUuid'
    );
  });

  test('rejects mismatched envelope targetKey', () => {
    const envelope = envelopeWithOp({
      type: 'plan.add_tag',
      planUuid: PLAN_UUID,
      tag: 'sync',
    });

    expect(() =>
      assertValidEnvelope({
        ...envelope,
        targetKey: 'plan:33333333-3333-4333-8333-333333333333',
      })
    ).toThrow(SyncValidationError);
  });

  test('rejects mismatched envelope targetType', () => {
    const envelope = envelopeWithOp({
      type: 'plan.add_tag',
      planUuid: PLAN_UUID,
      tag: 'sync',
    });

    expect(() => assertValidEnvelope({ ...envelope, targetType: 'task' })).toThrow(
      SyncValidationError
    );
  });

  test('rejects project setting projectUuid mismatch between envelope and payload', () => {
    const envelope = {
      operationUuid: OPERATION_UUID,
      projectUuid: PROJECT_UUID,
      originNodeId: 'node-a',
      localSequence: 1,
      createdAt: '2026-04-27T12:00:00.000Z',
      targetType: 'project_setting',
      targetKey: projectSettingKey(PROJECT_UUID, 'color'),
      op: {
        type: 'project_setting.set',
        projectUuid: '55555555-5555-4555-8555-555555555555',
        setting: 'color',
        value: 'blue',
      },
    };

    expect(() => assertValidEnvelope(envelope)).toThrow(SyncValidationError);
  });

  test('validates plan list item values by list type', () => {
    expect(
      SyncOperationPayloadSchema.safeParse({
        type: 'plan.add_list_item',
        planUuid: PLAN_UUID,
        list: 'issue',
        value: 'not a url',
      }).success
    ).toBe(false);
    expect(
      SyncOperationPayloadSchema.safeParse({
        type: 'plan.remove_list_item',
        planUuid: PLAN_UUID,
        list: 'pullRequest',
        value: 'not a url',
      }).success
    ).toBe(false);
    expect(
      SyncOperationPayloadSchema.safeParse({
        type: 'plan.add_list_item',
        planUuid: PLAN_UUID,
        list: 'docs',
        value: '',
      }).success
    ).toBe(false);
    expect(
      SyncOperationPayloadSchema.safeParse({
        type: 'plan.remove_list_item',
        planUuid: PLAN_UUID,
        list: 'changedFiles',
        value: '',
      }).success
    ).toBe(false);
    expect(
      SyncOperationPayloadSchema.safeParse({
        type: 'plan.add_list_item',
        planUuid: PLAN_UUID,
        list: 'issue',
        value: 'https://github.com/example/repo/issues/1',
      }).success
    ).toBe(true);
    expect(
      SyncOperationPayloadSchema.safeParse({
        type: 'plan.remove_list_item',
        planUuid: PLAN_UUID,
        list: 'docs',
        value: 'docs/sync.md',
      }).success
    ).toBe(true);
    expect(
      SyncOperationPayloadSchema.safeParse({
        type: 'plan.add_list_item',
        planUuid: PLAN_UUID,
        list: 'reviewIssues',
        value: { nested: ['shape decided later'] },
      }).success
    ).toBe(false);
    expect(
      SyncOperationPayloadSchema.safeParse({
        type: 'plan.add_list_item',
        planUuid: PLAN_UUID,
        list: 'reviewIssues',
        value: {
          severity: 'major',
          category: 'bug',
          content: 'stale issue',
          file: 'src/app.ts',
          line: '10-12',
          suggestion: 'fix it',
          source: 'codex-cli',
        },
      }).success
    ).toBe(true);
  });

  test('project_setting.set requires JSON value', () => {
    const base = {
      type: 'project_setting.set',
      projectUuid: PROJECT_UUID,
      setting: 'color',
    };

    expect(SyncOperationPayloadSchema.safeParse(base).success).toBe(false);
    expect(SyncOperationPayloadSchema.safeParse({ ...base, value: undefined }).success).toBe(false);
    expect(SyncOperationPayloadSchema.safeParse({ ...base, value: () => 'blue' }).success).toBe(
      false
    );
    expect(SyncOperationPayloadSchema.safeParse({ ...base, value: Symbol('blue') }).success).toBe(
      false
    );

    for (const value of [
      'blue',
      1,
      true,
      null,
      ['nested', 1, false, null],
      { nested: { color: 'blue', enabled: true, count: 2 } },
    ]) {
      expect(SyncOperationPayloadSchema.safeParse({ ...base, value }).success).toBe(true);
    }
  });

  test('validates project setting names consistently', () => {
    expect(ProjectSettingNameSchema.safeParse(' color ').success).toBe(false);
    expect(ProjectSettingNameSchema.safeParse('bad:key').success).toBe(false);
    expect(ProjectSettingNameSchema.safeParse('branchPrefix').success).toBe(true);
  });

  test('SyncOperationTypeSchema rejects unknown operation type', () => {
    expect(SyncOperationTypeSchema.safeParse('plan.unknown_op').success).toBe(false);
    expect(SyncOperationTypeSchema.safeParse('').success).toBe(false);
    expect(SyncOperationTypeSchema.safeParse(null).success).toBe(false);
  });

  test('localSequence must be a non-negative integer', () => {
    const base = {
      operationUuid: OPERATION_UUID,
      projectUuid: PROJECT_UUID,
      originNodeId: 'node-a',
      createdAt: '2026-04-27T12:00:00.000Z',
      targetType: 'plan',
      targetKey: `plan:${PLAN_UUID}`,
      op: { type: 'plan.add_tag', planUuid: PLAN_UUID, tag: 'x' },
    };

    expect(SyncOperationEnvelopeSchema.safeParse({ ...base, localSequence: 0 }).success).toBe(true);
    expect(SyncOperationEnvelopeSchema.safeParse({ ...base, localSequence: 1 }).success).toBe(true);
    expect(SyncOperationEnvelopeSchema.safeParse({ ...base, localSequence: -1 }).success).toBe(
      false
    );
    expect(SyncOperationEnvelopeSchema.safeParse({ ...base, localSequence: 1.5 }).success).toBe(
      false
    );
    expect(SyncOperationEnvelopeSchema.safeParse({ ...base, localSequence: 'abc' }).success).toBe(
      false
    );
  });

  test('deriveTargetKey returns plan key for plan-scoped operations', () => {
    const planOp = { type: 'plan.add_tag' as const, planUuid: PLAN_UUID, tag: 'x' };
    const target = deriveTargetKey(planOp);
    expect(target.targetType).toBe('plan');
    expect(target.targetKey).toBe(planKey(PLAN_UUID));
  });

  test('deriveTargetKey returns task key for task-scoped operations', () => {
    const TASK_UUID = '33333333-3333-4333-8333-333333333333';
    const taskOp = {
      type: 'plan.mark_task_done' as const,
      planUuid: PLAN_UUID,
      taskUuid: TASK_UUID,
      done: true,
    };
    const target = deriveTargetKey(taskOp);
    expect(target.targetType).toBe('task');
    expect(target.targetKey).toBe(taskKey(TASK_UUID));
  });

  test('deriveTargetKey returns project_setting key for setting operations', () => {
    const settingOp = {
      type: 'project_setting.set' as const,
      projectUuid: PROJECT_UUID,
      setting: 'color',
      value: 'blue',
    };
    const target = deriveTargetKey(settingOp);
    expect(target.targetType).toBe('project_setting');
    expect(target.targetKey).toBe(projectSettingKey(PROJECT_UUID, 'color'));
  });

  test('deriveTargetKey uses newPlanUuid as target for plan.promote_task', () => {
    const NEW_PLAN_UUID = '66666666-6666-4666-8666-666666666666';
    const TASK_UUID = '33333333-3333-4333-8333-333333333333';
    const promoteOp = {
      type: 'plan.promote_task' as const,
      sourcePlanUuid: PLAN_UUID,
      taskUuid: TASK_UUID,
      newPlanUuid: NEW_PLAN_UUID,
      title: 'Promoted',
      tags: [],
      dependencies: [],
    };
    const target = deriveTargetKey(promoteOp);
    expect(target.targetType).toBe('plan');
    expect(target.targetKey).toBe(planKey(NEW_PLAN_UUID));
  });
});
