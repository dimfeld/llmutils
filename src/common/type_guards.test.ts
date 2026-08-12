import { describe, expect, test } from 'vitest';
import { isRecord } from './type_guards.js';

describe('isRecord', () => {
  test('accepts non-null objects and rejects arrays and primitives', () => {
    expect(isRecord({ key: 'value' })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord('value')).toBe(false);
  });
});
