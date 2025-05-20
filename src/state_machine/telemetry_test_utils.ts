import type { Context, Span, AttributeValue, Attributes } from '@opentelemetry/api';

/**
 * Mock implementation of Span for testing
 */
export class MockSpan implements Span {
  private _name: string;
  private _attributes: Record<string, AttributeValue> = {};
  private _events: Array<{ name: string; attributes?: Record<string, AttributeValue> }> = [];
  private _exceptions: Array<Error> = [];
  private _status: { code: number; message?: string } = { code: 0 };
  private _isEnded = false;

  constructor(name: string, initialAttributes: Record<string, AttributeValue> = {}) {
    this._name = name;
    this._attributes = { ...initialAttributes };
  }

  get name(): string {
    return this._name;
  }

  get attributes(): Record<string, AttributeValue> {
    return { ...this._attributes };
  }

  get events(): Array<{ name: string; attributes?: Record<string, AttributeValue> }> {
    return [...this._events];
  }

  get exceptions(): Array<Error> {
    return [...this._exceptions];
  }

  get status(): { code: number; message?: string } {
    return { ...this._status };
  }

  get isEnded(): boolean {
    return this._isEnded;
  }

  // Span implementation
  setAttribute(key: string, value: AttributeValue): this {
    this._attributes[key] = value;
    return this;
  }

  setAttributes(attributes: Record<string, AttributeValue>): this {
    Object.assign(this._attributes, attributes);
    return this;
  }

  addEvent(name: string, attributes?: Attributes): this {
    this._events.push({ name, attributes: attributes as Record<string, AttributeValue> });
    return this;
  }

  setStatus(status: { code: number; message?: string }): this {
    this._status = { ...status };
    return this;
  }

  updateName(name: string): this {
    this._name = name;
    return this;
  }

  end(): void {
    this._isEnded = true;
  }

  recordException(exception: Error): void {
    this._exceptions.push(exception);
  }

  // Not implemented but required for the interface
  isRecording(): boolean {
    return !this._isEnded;
  }
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
    return fn(span);
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
 * Test utilities for OpenTelemetry mocks
 */
export class TelemetryTestUtils {
  private tracer: MockTracer;

  constructor() {
    this.tracer = new MockTracer();
  }

  /**
   * Get all spans
   */
  getSpans() {
    return this.tracer.getAllSpans();
  }

  /**
   * Get a span by name (returns the most recent one if multiple exist)
   */
  getSpanByName(name: string) {
    return this.tracer.getSpanByName(name);
  }

  /**
   * Get all spans by name
   */
  getSpansByName(name: string) {
    return this.tracer.getSpansByName(name);
  }

  /**
   * Clear all spans
   */
  clearSpans() {
    this.tracer.clearSpans();
  }

  /**
   * No-op shutdown for the mock implementation
   */
  async shutdown() {
    // No-op for mock implementation
  }

  /**
   * Helper function to get span events
   */
  getSpanEvents(spanName: string, eventName: string) {
    const span = this.getSpanByName(spanName);
    if (!span) return [];

    return span.events.filter((event) => event.name === eventName);
  }

  /**
   * Helper function to get span attributes
   */
  getSpanAttributes(spanName: string) {
    const span = this.getSpanByName(spanName);
    if (!span) return {};

    return span.attributes;
  }

  /**
   * Get the tracer
   */
  getMockTracer() {
    return this.tracer;
  }
}

/**
 * Create a test telemetry setup with mock tracer
 */
export function createTelemetryTestSetup() {
  return new TelemetryTestUtils();
}
