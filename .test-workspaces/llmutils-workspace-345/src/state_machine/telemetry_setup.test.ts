import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  initTelemetry,
  withSpan,
  recordStateTransition,
  recordEvent,
  recordError,
  setStateMachineAttributes,
} from './telemetry';
import { createMockSpan, createTestError } from './test_utils';
import type { Span } from '@opentelemetry/api';

describe('Telemetry utility functions', () => {
  test('recordStateTransition records the event correctly', () => {
    const mockSpan = createMockSpan('state_transition_test');

    // Record a state transition
    recordStateTransition(mockSpan, 'initial', 'running', 'START', 'ev-1', {
      customField: 'value',
    });

    // Get the events from our span
    const events = (mockSpan as any).events.filter((e: any) => e.name === 'state_transition');

    // Verify the event was recorded
    expect(events.length).toBe(1);

    // Verify event attributes
    const eventAttrs = events[0].attributes || {};
    expect(eventAttrs.from_state).toBe('initial');
    expect(eventAttrs.to_state).toBe('running');
    expect(eventAttrs.event_type).toBe('START');
    expect(eventAttrs.event_id).toBe('ev-1');
    expect(eventAttrs.customField).toBe('value');
  });

  test('recordEvent records the event correctly', () => {
    const mockSpan = createMockSpan('event_processing_test');

    // Record an event
    recordEvent(mockSpan, 'USER_ACTION', 'ev-2', 'idle', { actionType: 'click' });

    // Get the events from our span
    const events = (mockSpan as any).events.filter((e: any) => e.name === 'event_processed');

    // Verify the event was recorded
    expect(events.length).toBe(1);

    // Verify event attributes
    const eventAttrs = events[0].attributes || {};
    expect(eventAttrs.event_type).toBe('USER_ACTION');
    expect(eventAttrs.event_id).toBe('ev-2');
    expect(eventAttrs.current_state).toBe('idle');
    expect(eventAttrs.actionType).toBe('click');
  });

  test('recordError records exceptions with context', () => {
    const mockSpan = createMockSpan('error_test');
    const testError = createTestError('Something went wrong', 'TestError');

    // Record an error with context
    recordError(mockSpan, testError, {
      state: 'processing',
      eventType: 'SUBMIT',
      eventId: 'ev-3',
      metadata: {
        userId: 'user123',
        action: 'save',
      },
    });

    // Get the error events
    const events = (mockSpan as any).events.filter((e: any) => e.name === 'error_details');
    const exceptions = (mockSpan as any).exceptions;

    // Verify the error was recorded
    expect(events.length).toBe(1);
    expect(exceptions.length).toBe(1);

    // Verify error details
    const eventAttrs = events[0].attributes || {};
    expect(eventAttrs.state).toBe('processing');
    expect(eventAttrs.event_type).toBe('SUBMIT');
    expect(eventAttrs.event_id).toBe('ev-3');
    expect(eventAttrs.userId).toBe('user123');
    expect(eventAttrs.action).toBe('save');
    expect(eventAttrs.error_name).toBe('TestError');
    expect(eventAttrs.error_message).toBe('Something went wrong');

    // Verify the exception itself
    expect(exceptions[0]).toBe(testError);
  });

  test('setStateMachineAttributes sets flattened attributes on span', () => {
    const mockSpan = createMockSpan('attributes_test');

    // Set state machine attributes
    setStateMachineAttributes(mockSpan, {
      instanceId: 'machine-123',
      stateName: 'running',
      eventType: 'PROCESS',
      eventId: 'ev-4',
      previousState: 'waiting',
      nextState: 'complete',
      metadata: {
        runId: 'run-456',
        priority: 'high',
      },
    });

    // Verify attributes were set correctly
    const attrs = (mockSpan as any).attributes;
    expect(attrs['state_machine.instance_id']).toBe('machine-123');
    expect(attrs['state_machine.state']).toBe('running');
    expect(attrs['state_machine.event_type']).toBe('PROCESS');
    expect(attrs['state_machine.event_id']).toBe('ev-4');
    expect(attrs['state_machine.previous_state']).toBe('waiting');
    expect(attrs['state_machine.next_state']).toBe('complete');
    expect(attrs['state_machine.metadata.runId']).toBe('run-456');
    expect(attrs['state_machine.metadata.priority']).toBe('high');
  });
});
