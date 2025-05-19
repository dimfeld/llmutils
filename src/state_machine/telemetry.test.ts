import { describe, test, expect, afterEach, beforeEach, mock } from 'bun:test';
import {
  initTelemetry,
  createSpan,
  withSpan,
  recordStateTransition,
  recordEvent,
  recordError,
  getActiveSpan,
  type StateMachineAttributes,
} from './telemetry';
import {
  context,
  trace,
  SpanStatusCode,
  Span,
  SpanKind,
  Context,
  AttributeValue,
  diag,
} from '@opentelemetry/api';

// Mock OpenTelemetry classes and functions
class MockSpan implements Span {
  name: string;
  kind: SpanKind;
  events: Array<{ name: string; attributes?: Record<string, AttributeValue> }> = [];
  attributes: Record<string, AttributeValue> = {};
  status = { code: SpanStatusCode.UNSET, message: undefined };
  exception?: Error;
  startTime: number;
  endTime?: number;

  constructor(name: string, kind: SpanKind = SpanKind.INTERNAL) {
    this.name = name;
    this.kind = kind;
    this.startTime = Date.now();
  }

  // Implement Span interface methods
  setAttribute(key: string, value: AttributeValue): this {
    this.attributes[key] = value;
    return this;
  }

  setAttributes(attributes: Record<string, AttributeValue>): this {
    Object.assign(this.attributes, attributes);
    return this;
  }

  addEvent(name: string, attributes?: Record<string, AttributeValue>): this {
    this.events.push({ name, attributes });
    return this;
  }

  setStatus(status: { code: SpanStatusCode; message?: string }): this {
    this.status = status;
    return this;
  }

  updateName(name: string): this {
    this.name = name;
    return this;
  }

  end(endTime?: number): void {
    this.endTime = endTime ?? Date.now();
  }

  isRecording(): boolean {
    return this.endTime === undefined;
  }

  recordException(exception: Error, attributes?: Record<string, AttributeValue>): void {
    this.exception = exception;
    if (attributes) {
      this.addEvent('exception', { exception: exception.message, ...attributes });
    }
  }
}

class MockTracer {
  spans: MockSpan[] = [];

  startSpan(name: string, options?: any, ctx?: Context): MockSpan {
    const span = new MockSpan(name, options?.kind);
    if (options?.attributes) {
      span.setAttributes(options.attributes);
    }
    this.spans.push(span);
    return span;
  }

  getSpans(): MockSpan[] {
    return this.spans;
  }

  clearSpans(): void {
    this.spans = [];
  }
}

describe('State Machine Telemetry', () => {
  const mockTracer = new MockTracer();
  const mockActiveSpan = new MockSpan('active-span');

  // Mock OpenTelemetry APIs
  const originalGetTracer = trace.getTracer;
  const originalGetActiveSpan = trace.getActiveSpan;

  beforeEach(() => {
    // Setup mocks
    trace.getTracer = mock(() => mockTracer as any);
    trace.getActiveSpan = mock(() => mockActiveSpan);

    // Initialize telemetry
    initTelemetry(false);

    // Clear previous test data
    mockTracer.clearSpans();
    mockActiveSpan.events = [];
  });

  afterEach(() => {
    // Restore original functions
    trace.getTracer = originalGetTracer;
    trace.getActiveSpan = originalGetActiveSpan;
  });

  describe('Basic Telemetry Functions', () => {
    test('initTelemetry() initializes tracer', () => {
      // Spy on the DiagConsoleLogger
      const diagSetLoggerSpy = mock(diag.setLogger);

      // Call with debug = true
      initTelemetry(true);

      // Check that diag.setLogger was called with a console logger
      expect(diagSetLoggerSpy).toHaveBeenCalled();
      expect(trace.getTracer).toHaveBeenCalledTimes(1);
    });

    test('createSpan() creates a span with attributes', () => {
      const attributes: StateMachineAttributes = {
        instanceId: 'test-instance',
        stateName: 'test-state',
        eventType: 'test-event',
      };

      const span = createSpan('test-span', attributes);

      expect(span).not.toBeNull();
      expect(mockTracer.spans.length).toBe(1);

      const createdSpan = mockTracer.spans[0];
      expect(createdSpan.name).toBe('test-span');
      expect(createdSpan.attributes['state_machine.instance_id']).toBe('test-instance');
      expect(createdSpan.attributes['state_machine.state']).toBe('test-state');
      expect(createdSpan.attributes['state_machine.event_type']).toBe('test-event');
    });

    test('withSpan() executes function within span context', async () => {
      const attributes: StateMachineAttributes = {
        instanceId: 'test-instance',
        stateName: 'test-state',
      };

      const result = await withSpan('test-operation', attributes, async (span) => {
        expect(span).not.toBeNull();
        expect(getActiveSpan()).not.toBeNull();
        return 'success';
      });

      expect(result).toBe('success');
      expect(mockTracer.spans.length).toBe(1);

      const span = mockTracer.spans[0];
      expect(span.name).toBe('test-operation');
      expect(span.status.code).toBe(SpanStatusCode.OK);
      expect(span.endTime).not.toBeUndefined();
    });

    test('withSpan() handles errors properly', async () => {
      const error = new Error('Test error');

      try {
        await withSpan('failing-operation', { instanceId: 'test-instance' }, async () => {
          throw error;
        });
        expect(true).toBe(false); // Should not reach here
      } catch (e) {
        expect(e).toBe(error);
      }

      const span = mockTracer.spans[0];
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.status.message).toBe('Test error');
      expect(span.exception).toBe(error);
      expect(span.endTime).not.toBeUndefined();
    });
  });

  describe('Span Event Helpers', () => {
    test('recordStateTransition() adds span event', () => {
      recordStateTransition(mockActiveSpan, 'state-a', 'state-b', 'test-event', 'event-123', {
        custom: 'metadata',
      });

      // Check span event
      expect(mockActiveSpan.events.length).toBe(1);
      const event = mockActiveSpan.events[0];
      expect(event.name).toBe('state_transition');
      expect(event.attributes?.['from_state']).toBe('state-a');
      expect(event.attributes?.['to_state']).toBe('state-b');
      expect(event.attributes?.['event_type']).toBe('test-event');
      expect(event.attributes?.['event_id']).toBe('event-123');
      expect(event.attributes?.['custom']).toBe('metadata');
    });

    test('recordEvent() adds span event', () => {
      recordEvent(mockActiveSpan, 'user-login', 'event-456', 'idle-state', { userId: '123' });

      // Check span event
      expect(mockActiveSpan.events.length).toBe(1);
      const event = mockActiveSpan.events[0];
      expect(event.name).toBe('event_processed');
      expect(event.attributes?.['event_type']).toBe('user-login');
      expect(event.attributes?.['event_id']).toBe('event-456');
      expect(event.attributes?.['current_state']).toBe('idle-state');
      expect(event.attributes?.['userId']).toBe('123');
    });

    test('recordError() records exception on span', () => {
      const error = new Error('Something went wrong');

      recordError(mockActiveSpan, error, {
        state: 'processing-state',
        eventType: 'process-data',
        eventId: 'event-789',
        metadata: { userId: '456' },
      });

      // Check exception was recorded
      expect(mockActiveSpan.events.length).toBe(1);
      const event = mockActiveSpan.events[0];
      expect(event.name).toBe('exception');
      expect(event.attributes?.['exception']).toBe('Something went wrong');
      expect(event.attributes?.['state']).toBe('processing-state');
      expect(event.attributes?.['event_type']).toBe('process-data');
      expect(event.attributes?.['event_id']).toBe('event-789');
      expect(event.attributes?.['userId']).toBe('456');
    });
  });

  describe('State Machine Integration', () => {
    // Create a minimal state machine for testing
    interface TestContext {
      count: number;
      lastEvent?: string;
    }

    interface TestEvent {
      id: string;
      type: string;
      data?: any;
    }

    class MockNode {
      constructor(public id: string) {}

      async run(store: any): Promise<{ status: string; to?: string; actions?: any[] }> {
        // Get context and update it
        const context = store.getContext();
        await store.updateContext((ctx: TestContext) => ({
          ...ctx,
          count: ctx.count + 1,
          lastEvent: store.getPendingEvents()[0]?.type,
        }));

        // Record state transition (this would happen in the StateMachine class)
        const activeSpan = getActiveSpan();
        if (activeSpan) {
          recordStateTransition(
            activeSpan,
            this.id,
            'next-state',
            'test-transition',
            'transition-1',
            { nodeId: this.id }
          );
        }

        return { status: 'transition', to: 'next-state' };
      }
    }

    class MockStore {
      context: TestContext = { count: 0 };
      events: TestEvent[] = [];

      getContext(): TestContext {
        return { ...this.context };
      }

      async updateContext(updater: (ctx: TestContext) => TestContext): Promise<void> {
        this.context = updater(this.context);
      }

      getPendingEvents(): TestEvent[] {
        return [...this.events];
      }

      async enqueueEvents(events: TestEvent[]): Promise<void> {
        this.events.push(...events);

        // Record events on active span
        const span = getActiveSpan();
        if (span) {
          for (const event of events) {
            recordEvent(span, event.type, event.id, 'current-state', { eventData: event.data });
          }
        }
      }
    }

    test('State machine properly records transitions and events in spans', async () => {
      // Setup test state machine components
      const node = new MockNode('start-state');
      const store = new MockStore();

      // Execute node within a span (simulating state machine execution)
      await withSpan('state_machine.test', { instanceId: 'test-machine' }, async (span) => {
        // Add an event
        await store.enqueueEvents([
          { id: 'event-1', type: 'button-click', data: { buttonId: 'submit' } },
        ]);

        // Verify event was recorded on span
        expect(span.events.length).toBe(1);
        expect(span.events[0].name).toBe('event_processed');
        expect(span.events[0].attributes?.['event_type']).toBe('button-click');

        // Execute node
        return await node.run(store);
      });

      // Verify context was updated
      expect(store.context.count).toBe(1);
      expect(store.context.lastEvent).toBe('button-click');

      // Verify span events
      const span = mockTracer.spans[0];
      expect(span.name).toBe('state_machine.test');

      // Verify transition was recorded
      const transitionEvent = span.events.find((e) => e.name === 'state_transition');
      expect(transitionEvent).toBeDefined();
      expect(transitionEvent?.attributes?.['from_state']).toBe('start-state');
      expect(transitionEvent?.attributes?.['to_state']).toBe('next-state');
    });

    test('State machine records errors on spans', async () => {
      // Setup error scenario
      const error = new Error('State execution failed');

      try {
        await withSpan('state_machine.error_test', { instanceId: 'test-machine' }, async (span) => {
          // Record the error like the state machine would
          recordError(span, error, {
            state: 'error-state',
            eventType: 'process-data',
            metadata: { attempt: 2 },
          });

          throw error; // State machine would throw this after recording
        });
        expect(true).toBe(false); // Should not reach here
      } catch (e) {
        expect(e).toBe(error);
      }

      // Verify span has recorded the exception
      const span = mockTracer.spans[0];
      expect(span.status.code).toBe(SpanStatusCode.ERROR);
      expect(span.status.message).toBe('State execution failed');

      // Verify exception event
      const exceptionEvent = span.events.find((e) => e.name === 'exception');
      expect(exceptionEvent).toBeDefined();
      expect(exceptionEvent?.attributes?.['exception']).toBe('State execution failed');
      expect(exceptionEvent?.attributes?.['state']).toBe('error-state');
      expect(exceptionEvent?.attributes?.['event_type']).toBe('process-data');
      expect(exceptionEvent?.attributes?.['attempt']).toBe(2);
    });
  });
});
