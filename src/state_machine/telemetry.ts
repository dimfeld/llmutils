import {
  context,
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  trace,
  SpanStatusCode,
  SpanKind,
} from '@opentelemetry/api';
import type { Tracer, Context, Span, AttributeValue } from '@opentelemetry/api';

// Initialize tracer for state machine
const TRACER_NAME = 'state-machine';
const TRACER_VERSION = '1.0.0';

let tracer: Tracer;

export function initTelemetry(debug = false): void {
  // Set up diagnostic logging if debug is enabled
  if (debug) {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);
  }

  // Get tracer instance
  tracer = trace.getTracer(TRACER_NAME, TRACER_VERSION);
}

// Attributes common to state machine operations
export interface StateMachineAttributes {
  instanceId: string;
  stateName?: string;
  eventType?: string;
  eventId?: string;
  previousState?: string;
  nextState?: string;
  metadata?: Record<string, AttributeValue>;
}

// Create a span for state machine operations
export function createSpan(
  name: string,
  attributes?: StateMachineAttributes,
  parentContext?: Context
): Span {
  if (!tracer) {
    throw new Error('Telemetry not initialized. Call initTelemetry() first.');
  }

  const ctx = parentContext || context.active();
  const span = tracer.startSpan(
    name,
    {
      kind: SpanKind.INTERNAL,
      attributes: flattenAttributes(attributes),
    },
    ctx
  );

  return span;
}

// Create a span and execute function within its context
export async function withSpan<T>(
  name: string,
  attributes: StateMachineAttributes | undefined,
  fn: (span: Span) => Promise<T>
): Promise<T> {
  const span = createSpan(name, attributes);

  try {
    const result = await context.with(trace.setSpan(context.active(), span), () => fn(span));
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });

    if (error instanceof Error) {
      span.recordException(error);
    }

    throw error;
  } finally {
    span.end();
  }
}

// Context propagation helpers
export function setSpanInContext(span: Span, ctx?: Context): Context {
  return trace.setSpan(ctx || context.active(), span);
}

export function getActiveSpan(): Span | undefined {
  return trace.getActiveSpan();
}

export function withContext<T>(ctx: Context, fn: () => T): T {
  return context.with(ctx, fn);
}

// Record state transition events on spans
export function recordStateTransition(
  span: Span | undefined,
  fromState: string,
  toState: string,
  eventType: string,
  eventId: string,
  metadata?: Record<string, AttributeValue>
): void {
  if (!span) return;

  span.addEvent('state_transition', {
    from_state: fromState,
    to_state: toState,
    event_type: eventType,
    event_id: eventId,
    ...metadata,
  });
}

// Record event processing on spans
export function recordEvent(
  span: Span | undefined,
  eventType: string,
  eventId: string,
  currentState: string,
  metadata?: Record<string, AttributeValue>
): void {
  if (!span) return;

  span.addEvent('event_processed', {
    event_type: eventType,
    event_id: eventId,
    current_state: currentState,
    ...metadata,
  });
}

// Record errors on spans
export function recordError(
  span: Span | undefined,
  error: Error,
  context?: {
    state?: string;
    eventType?: string;
    eventId?: string;
    metadata?: Record<string, AttributeValue>;
  }
): void {
  if (!span) return;

  // First, record the exception without attributes (compliant with OpenTelemetry API)
  span.recordException(error);

  // Then add the detailed event with all our context
  if (context) {
    span.addEvent('error_details', {
      ...(context.state && { state: context.state }),
      ...(context.eventType && { event_type: context.eventType }),
      ...(context.eventId && { event_id: context.eventId }),
      ...context?.metadata,
      error_name: error.name,
      error_message: error.message,
    });
  }
}

// Helper to flatten nested attributes for OpenTelemetry
function flattenAttributes(
  attrs?: StateMachineAttributes
): Record<string, AttributeValue> | undefined {
  if (!attrs) return undefined;

  const flat: Record<string, AttributeValue> = {};

  if (attrs.instanceId) flat['state_machine.instance_id'] = attrs.instanceId;
  if (attrs.stateName) flat['state_machine.state'] = attrs.stateName;
  if (attrs.eventType) flat['state_machine.event_type'] = attrs.eventType;
  if (attrs.eventId) flat['state_machine.event_id'] = attrs.eventId;
  if (attrs.previousState) flat['state_machine.previous_state'] = attrs.previousState;
  if (attrs.nextState) flat['state_machine.next_state'] = attrs.nextState;

  if (attrs.metadata) {
    Object.entries(attrs.metadata).forEach(([key, value]) => {
      flat[`state_machine.metadata.${key}`] = value;
    });
  }

  return flat;
}

// Custom span attributes setter
export function setStateMachineAttributes(span: Span, attributes: StateMachineAttributes): void {
  const flattened = flattenAttributes(attributes);
  if (flattened) {
    span.setAttributes(flattened);
  }
}

// Export types for external use
export type { Span, Context, AttributeValue } from '@opentelemetry/api';
