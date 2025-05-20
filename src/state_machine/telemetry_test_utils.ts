import type { Span, AttributeValue, Attributes } from '@opentelemetry/api';
import { SpanStatusCode } from '@opentelemetry/api';
import { initTelemetry } from './telemetry';
import { expect } from 'bun:test';

/**
 * A simple mock span for testing
 */
export class MockSpan implements Partial<Span> {
  name: string;
  attributes: Record<string, AttributeValue>;
  events: Array<{ name: string; attributes?: Record<string, AttributeValue> }>;
  #exceptions: Error[] = [];
  status: { code: number; message?: string };
  isEnded: boolean;
  startTime: number;
  endTime?: number;

  // Required by Span interface but not used in our tests
  spanContext() {
    return { traceId: '1', spanId: '1', traceFlags: 1 };
  }
  addLink() {
    return this;
  }
  addLinks() {
    return this;
  }

  constructor(name: string, initialAttributes: Record<string, AttributeValue> = {}) {
    this.name = name;
    this.attributes = { ...initialAttributes };
    this.events = [];
    this.status = { code: SpanStatusCode.UNSET };
    this.isEnded = false;
    this.startTime = Date.now();
  }

  setAttribute(key: string, value: AttributeValue): this {
    this.attributes[key] = value;
    return this;
  }

  setAttributes(attributes: Record<string, AttributeValue>): this {
    Object.assign(this.attributes, attributes);
    return this;
  }

  addEvent(name: string, attributes?: Attributes): this {
    this.events.push({ name, attributes: attributes as Record<string, AttributeValue> });
    return this;
  }

  setStatus(status: { code: number; message?: string }): this {
    this.status = { ...status };
    return this;
  }

  updateName(name: string): this {
    this.name = name;
    return this;
  }

  end(): void {
    if (!this.isEnded) {
      this.isEnded = true;
      this.endTime = Date.now();

      // Add to finished spans collection
      finishedSpans.push(this);
    }
  }

  recordException(exception: Error): void {
    this.#exceptions.push(exception);
    this.addEvent('exception', {
      'exception.type': exception.name,
      'exception.message': exception.message,
      'exception.stacktrace': exception.stack,
    });
  }

  isRecording(): boolean {
    return !this.isEnded;
  }
}

// Global store for spans across all tests
const finishedSpans: MockSpan[] = [];

/**
 * Get all captured spans from the mock store
 */
export function getSpans() {
  return [...finishedSpans];
}

/**
 * Reset the mock span collection, clearing all captured spans
 */
export function resetSpans() {
  finishedSpans.length = 0;
}

/**
 * Set up telemetry for testing. This reinitializes the tracer used by
 * the state machine code, ensuring it's using the test provider.
 *
 * @param debug Whether to enable debug logging
 */
export function setupTestTelemetry(debug = false) {
  initTelemetry(debug);
}

/**
 * Find a span by name in the captured spans
 *
 * @param name The name of the span to find
 * @returns The span if found, undefined otherwise
 */
export function findSpan(name: string) {
  return getSpans().find((span) => span.name === name);
}

/**
 * Verify that a span with the given name exists and has the expected attributes
 *
 * @param name The name of the span to verify
 * @param expectedAttributes The attributes the span should have (partial match)
 * @returns The verified span for further assertions
 */
export function verifySpan(name: string, expectedAttributes?: Record<string, any>) {
  const span = findSpan(name);
  if (!span) {
    throw new Error(`Span with name "${name}" not found`);
  }

  if (expectedAttributes) {
    for (const [key, value] of Object.entries(expectedAttributes)) {
      expect(span.attributes[key]).toEqual(value);
    }
  }

  return span;
}

/**
 * Mock tracer for testing
 */
export class MockTracer {
  private spans: MockSpan[] = [];

  startSpan(name: string, options?: { attributes?: Record<string, AttributeValue> }): MockSpan {
    const span = new MockSpan(name, options?.attributes);
    this.spans.push(span);
    return span;
  }

  startActiveSpan<T>(
    name: string,
    options: { attributes?: Record<string, AttributeValue> } | undefined,
    context: unknown,
    fn: (span: Span) => Promise<T>
  ): Promise<T> {
    const span = this.startSpan(name, options);

    return Promise.resolve().then(async () => {
      try {
        const result = await fn(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        if (error instanceof Error) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error.message,
          });
          span.recordException(error);
        } else {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: String(error),
          });
        }
        throw error;
      } finally {
        span.end();
      }
    });
  }

  getAllSpans(): MockSpan[] {
    return [...this.spans];
  }

  getSpanByName(name: string): MockSpan | undefined {
    return this.spans.find((span) => span.name === name);
  }

  getSpansByName(name: string): MockSpan[] {
    return this.spans.filter((span) => span.name === name);
  }

  clearSpans(): void {
    this.spans = [];
  }
}

/**
 * Create a mock tracer for testing
 */
export function createMockTracer() {
  return new MockTracer();
}

/**
 * Utility to mock the telemetry module for tests
 */
export function getMockTelemetryModule() {
  const mockTracer = createMockTracer();

  return {
    withSpan: (name: string, attributes: Record<string, any>, fn: (span: Span) => Promise<any>) => {
      return mockTracer.startActiveSpan(name, { attributes }, undefined, fn);
    },
    createSpan: (name: string, attributes?: Record<string, any>) => {
      return mockTracer.startSpan(name, { attributes });
    },
  };
}
