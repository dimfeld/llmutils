import type { Span, AttributeValue } from '@opentelemetry/api';

/**
 * Creates a mock span for testing telemetry functions
 */
export function createMockSpan(name: string, initialAttributes = {}): Span {
  const events: Array<{ name: string; attributes?: Record<string, any> }> = [];
  const attributes: Record<string, any> = { ...initialAttributes };
  const exceptions: Error[] = [];

  return {
    addEvent(eventName: string, eventAttributes?: Record<string, any>): any {
      events.push({ name: eventName, attributes: eventAttributes });
      return this;
    },
    setAttributes(attrs: Record<string, any>): any {
      Object.assign(attributes, attrs);
      return this;
    },
    setAttribute(key: string, value: any): any {
      attributes[key] = value;
      return this;
    },

    recordException(error: Error): void {
      exceptions.push(error);
    },

    // Mock implementations for required methods
    updateName: () => ({}) as any,
    end: () => {},
    isRecording: () => true,
    setStatus: () => ({}) as any,

    // For testing
    events,
    attributes,
    exceptions,
    name,
  } as unknown as Span;
}

/**
 * Creates a mock error for testing
 */
export function createTestError(message: string, name = 'TestError'): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}
