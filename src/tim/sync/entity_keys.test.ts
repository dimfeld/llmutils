import { describe, expect, test } from 'vitest';
import { planKey, projectKey, projectSettingKey, taskKey } from './entity_keys.js';

const PROJECT_UUID = '11111111-1111-4111-8111-111111111111';
const PLAN_UUID = '22222222-2222-4222-8222-222222222222';
const TASK_UUID = '33333333-3333-4333-8333-333333333333';

describe('sync entity keys', () => {
  test('formats stable entity keys', () => {
    expect(projectKey(PROJECT_UUID)).toBe(`project:${PROJECT_UUID}`);
    expect(planKey(PLAN_UUID)).toBe(`plan:${PLAN_UUID}`);
    expect(taskKey(TASK_UUID)).toBe(`task:${TASK_UUID}`);
    expect(projectSettingKey(PROJECT_UUID, 'color')).toBe(`project_setting:${PROJECT_UUID}:color`);
  });

  test('rejects invalid UUID portions', () => {
    expect(() => projectKey('not-a-uuid')).toThrow('Invalid project UUID');
    expect(() => planKey('not-a-uuid')).toThrow('Invalid plan UUID');
    expect(() => taskKey('not-a-uuid')).toThrow('Invalid task UUID');
    expect(() => projectSettingKey('not-a-uuid', 'color')).toThrow('Invalid project UUID');
  });

  test('rejects ambiguous project setting keys', () => {
    expect(() => projectSettingKey(PROJECT_UUID, '')).toThrow('setting must not be empty');
    expect(() => projectSettingKey(PROJECT_UUID, ' color ')).toThrow(
      'setting must not contain whitespace'
    );
    expect(() => projectSettingKey(PROJECT_UUID, 'bad key')).toThrow(
      'setting must not contain whitespace'
    );
    expect(() => projectSettingKey(PROJECT_UUID, 'bad:key')).toThrow(
      'setting must not contain ":"'
    );
  });

  test('valid project setting names are not normalized', () => {
    expect(projectSettingKey(PROJECT_UUID, 'branchPrefix')).toBe(
      `project_setting:${PROJECT_UUID}:branchPrefix`
    );
  });
});
