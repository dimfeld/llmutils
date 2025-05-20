import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  toSpanAttributeValue,
  objectToSpanAttributeValues,
  StateMachineAttributes,
  setStateMachineAttributes,
  withSpan,
} from './telemetry';
import { trace, context as apiContext, SpanStatusCode } from '@opentelemetry/api';
import { getSpans, resetSpans, setupTestTelemetry } from './telemetry_test_utils';

// Since flattenAttributes is private, we'll test it indirectly through setStateMachineAttributes
// by creating a mock span and checking what attributes were set on it

describe('telemetry_test_utils', () => {
  test('MockSpan correctly tracks events and status', () => {
    const { MockSpan } = require('./telemetry_test_utils');

    const span = new MockSpan('test-span', { initialAttr: 'value' });
    expect(span.name).toBe('test-span');
    expect(span.attributes.initialAttr).toBe('value');
    expect(span.isEnded).toBe(false);

    // Add events and attributes
    span.addEvent('test-event', { key: 'value' });
    span.setAttribute('new-attr', 'new-value');
    span.setStatus({ code: SpanStatusCode.OK });

    // Verify they're tracked correctly
    expect(span.events.length).toBe(1);
    expect(span.events[0].name).toBe('test-event');
    expect(span.events[0].attributes?.key).toBe('value');
    expect(span.attributes['new-attr']).toBe('new-value');
    expect(span.status.code).toBe(SpanStatusCode.OK);

    // End the span
    span.end();
    expect(span.isEnded).toBe(true);
    expect(span.isRecording()).toBe(false);
  });

  test('getSpans and resetSpans work correctly', () => {
    const { MockSpan, getSpans, resetSpans } = require('./telemetry_test_utils');

    // Clear any existing spans
    resetSpans();
    expect(getSpans().length).toBe(0);

    // Create and end a span (which adds it to the finished spans)
    const span = new MockSpan('test-span');
    span.end();

    // Check that it was added
    expect(getSpans().length).toBe(1);
    expect(getSpans()[0].name).toBe('test-span');

    // Reset and check that the spans are cleared
    resetSpans();
    expect(getSpans().length).toBe(0);
  });
});

describe('telemetry module direct usage', () => {
  beforeEach(() => {
    // Import our test utilities inside each test to avoid global state issues
    const { resetSpans } = require('./telemetry_test_utils');
    resetSpans();
  });

  test('createSpan function creates spans with correct attributes', () => {
    // We'll test the exported functions more directly
    const { createSpan, setStateMachineAttributes } = require('./telemetry');
    const { MockSpan } = require('./telemetry_test_utils');

    // Create a test span with our mock tracer
    const testSpan = new MockSpan('test-span');

    // Set attributes on it
    const testAttributes: StateMachineAttributes = {
      instanceId: 'test-machine-123',
      stateName: 'test-state',
      eventType: 'TEST_EVENT',
    };

    setStateMachineAttributes(testSpan, testAttributes);

    // Verify the attributes were correctly flattened and set
    expect(testSpan.attributes['state_machine.instance_id']).toBe('test-machine-123');
    expect(testSpan.attributes['state_machine.state']).toBe('test-state');
    expect(testSpan.attributes['state_machine.event_type']).toBe('TEST_EVENT');
  });

  test('recordStateTransition adds correct event to span', () => {
    const { recordStateTransition } = require('./telemetry');
    const { MockSpan } = require('./telemetry_test_utils');

    // Create a test span with our mock tracer
    const testSpan = new MockSpan('test-span');

    // Record a state transition
    recordStateTransition(testSpan, 'initial', 'running', 'START', 'ev123', { custom: 'metadata' });

    // Verify the event was recorded correctly
    expect(testSpan.events.length).toBe(1);
    expect(testSpan.events[0].name).toBe('state_transition');
    expect(testSpan.events[0].attributes?.from_state).toBe('initial');
    expect(testSpan.events[0].attributes?.to_state).toBe('running');
    expect(testSpan.events[0].attributes?.event_type).toBe('START');
    expect(testSpan.events[0].attributes?.event_id).toBe('ev123');
    expect(testSpan.events[0].attributes?.custom).toBe('metadata');
  });

  test('recordError adds exception and details to span', () => {
    const { recordError } = require('./telemetry');
    const { MockSpan } = require('./telemetry_test_utils');

    // Create a test span and an error
    const testSpan = new MockSpan('test-span');
    const testError = new Error('Test error message');

    // Record the error with context
    recordError(testSpan, testError, {
      state: 'failed',
      eventType: 'FAILURE',
      eventId: 'ev456',
      metadata: { reason: 'test failure' },
    });

    // Verify exception was recorded
    expect(testSpan.events.length).toBe(2);

    // Ensure error details event was added with the correct attributes
    const errorDetailsEvent = testSpan.events.find((e) => e.name === 'error_details');
    expect(errorDetailsEvent).toBeDefined();
    expect(errorDetailsEvent?.attributes?.state).toBe('failed');
    expect(errorDetailsEvent?.attributes?.event_type).toBe('FAILURE');
    expect(errorDetailsEvent?.attributes?.event_id).toBe('ev456');
    expect(errorDetailsEvent?.attributes?.reason).toBe('test failure');
    expect(errorDetailsEvent?.attributes?.error_name).toBe('Error');
    expect(errorDetailsEvent?.attributes?.error_message).toBe('Test error message');
  });
});

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
