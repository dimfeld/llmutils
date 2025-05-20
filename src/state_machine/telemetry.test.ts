import { describe, test, expect } from 'bun:test';
import {
  toSpanAttributeValue,
  objectToSpanAttributeValues,
  StateMachineAttributes,
  setStateMachineAttributes,
} from './telemetry';

// Since flattenAttributes is private, we'll test it indirectly through setStateMachineAttributes
// by creating a mock span and checking what attributes were set on it

describe('toSpanAttributeValue', () => {
  test('handles primitive types', () => {
    expect(toSpanAttributeValue('string value')).toBe('string value');
    expect(toSpanAttributeValue(42)).toBe(42);
    expect(toSpanAttributeValue(true)).toBe(true);
    expect(toSpanAttributeValue(false)).toBe(false);
  });

  test('handles arrays of primitives', () => {
    const arr = ['a', 'b', 'c'];
    expect(toSpanAttributeValue(arr)).toEqual(arr);

    const numArr = [1, 2, 3];
    expect(toSpanAttributeValue(numArr)).toEqual(numArr);

    const mixedArr = [1, 'two', true];
    expect(toSpanAttributeValue(mixedArr)).toEqual(mixedArr);
  });

  test('stringifies objects', () => {
    const obj = { name: 'test', value: 42 };
    expect(toSpanAttributeValue(obj)).toBe(JSON.stringify(obj));

    const nestedObj = { outer: { inner: 'value' } };
    expect(toSpanAttributeValue(nestedObj)).toBe(JSON.stringify(nestedObj));
  });

  test('handles null and undefined', () => {
    expect(toSpanAttributeValue(null)).toBe(null);
    expect(toSpanAttributeValue(undefined)).toBe(undefined);
  });
});

describe('objectToSpanAttributeValues', () => {
  test('handles simple flat objects', () => {
    const input = { a: 1, b: 'text', c: true };
    const expected = { a: 1, b: 'text', c: true };
    expect(objectToSpanAttributeValues(input)).toEqual(expected);
  });

  test('stringifies nested objects', () => {
    const input = {
      a: 1,
      b: { nested: 'value' },
    };
    const expected = {
      a: 1,
      b: JSON.stringify({ nested: 'value' }),
    };
    expect(objectToSpanAttributeValues(input)).toEqual(expected);
  });

  test('applies prefix to keys when provided', () => {
    const input = { a: 1, b: 'text' };
    const expected = { 'prefix.a': 1, 'prefix.b': 'text' };
    expect(objectToSpanAttributeValues(input, 'prefix.')).toEqual(expected);
  });

  test('returns undefined for null or undefined input', () => {
    expect(objectToSpanAttributeValues(null)).toBeUndefined();
    expect(objectToSpanAttributeValues(undefined)).toBeUndefined();
  });

  test('handles objects with various types', () => {
    const input = {
      string: 'text',
      number: 42,
      boolean: true,
      array: [1, 2, 3],
      object: { key: 'value' },
      nullValue: null,
    };

    const expected = {
      string: 'text',
      number: 42,
      boolean: true,
      array: [1, 2, 3],
      object: JSON.stringify({ key: 'value' }),
      nullValue: null,
    };

    expect(objectToSpanAttributeValues(input)).toEqual(expected);
  });
});

// For testing private flattenAttributes, we'll use setStateMachineAttributes
// which calls flattenAttributes internally

// Instead of the direct flattenAttributes test, let's test the function indirectly
// via createSpan or setStateMachineAttributes which both use flattenAttributes
describe('flattenAttributes (via exported functions)', () => {
  // Mock the module to expose the private function directly for testing
  test('flattens StateMachineAttributes with all fields', () => {
    // Create a simple test helper that just returns what the flattened attributes would be
    // This tests the logic without requiring a direct flattenAttributes export
    function testFlattenAttributes(attrs?: StateMachineAttributes) {
      let result: Record<string, any> | undefined;

      // Create a mock span that captures the attributes
      const mockSpan = {
        setAttributes(attrs: Record<string, any>) {
          result = attrs;
        },
      };

      // Use the exported function that internally calls flattenAttributes
      setStateMachineAttributes(mockSpan as any, attrs);

      return result;
    }

    const input: StateMachineAttributes = {
      instanceId: 'test-instance',
      stateName: 'idle',
      eventType: 'START',
      eventId: 'ev-123',
      previousState: 'init',
      nextState: 'running',
      metadata: {
        customKey: 'customValue',
        numericKey: 42,
      },
    };

    const expected = {
      'state_machine.instance_id': 'test-instance',
      'state_machine.state': 'idle',
      'state_machine.event_type': 'START',
      'state_machine.event_id': 'ev-123',
      'state_machine.previous_state': 'init',
      'state_machine.next_state': 'running',
      'state_machine.metadata.customKey': 'customValue',
      'state_machine.metadata.numericKey': 42,
    };

    expect(testFlattenAttributes(input)).toEqual(expected);
  });

  test('flattens StateMachineAttributes with only some fields', () => {
    function testFlattenAttributes(attrs?: StateMachineAttributes) {
      let result: Record<string, any> | undefined;
      const mockSpan = {
        setAttributes(attrs: Record<string, any>) {
          result = attrs;
        },
      };
      setStateMachineAttributes(mockSpan as any, attrs);
      return result;
    }

    const input: StateMachineAttributes = {
      instanceId: 'test-instance',
      stateName: 'idle',
    };

    const expected = {
      'state_machine.instance_id': 'test-instance',
      'state_machine.state': 'idle',
    };

    expect(testFlattenAttributes(input)).toEqual(expected);
  });

  test('returns undefined for undefined input', () => {
    function testFlattenAttributes(attrs?: StateMachineAttributes) {
      let wasCalled = false;
      let result: Record<string, any> | undefined;

      const mockSpan = {
        setAttributes(attrs: Record<string, any>) {
          wasCalled = true;
          result = attrs;
        },
      };

      setStateMachineAttributes(mockSpan as any, attrs);

      // If setAttributes wasn't called, then flattenAttributes must have returned undefined
      return wasCalled ? result : undefined;
    }

    expect(testFlattenAttributes(undefined)).toBeUndefined();
  });

  test('handles StateMachineAttributes with empty metadata', () => {
    function testFlattenAttributes(attrs?: StateMachineAttributes) {
      let result: Record<string, any> | undefined;
      const mockSpan = {
        setAttributes(attrs: Record<string, any>) {
          result = attrs;
        },
      };
      setStateMachineAttributes(mockSpan as any, attrs);
      return result;
    }

    const input: StateMachineAttributes = {
      instanceId: 'test-instance',
      metadata: {},
    };

    const expected = {
      'state_machine.instance_id': 'test-instance',
    };

    expect(testFlattenAttributes(input)).toEqual(expected);
  });
});
