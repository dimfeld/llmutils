import { describe, test, expect, beforeEach, mock, afterEach } from 'bun:test';
import { Node, FlowNode, type PrepResult, type StateResult } from './nodes';
import { StateMachine } from './index';
import { SharedStore, type AllState } from './store';
import { trace, context } from '@opentelemetry/api';
import type { BaseEvent } from './events';

// Define test types
interface TestContext {
  count: number;
  data: string[];
}

interface TestEvent extends BaseEvent {
  id: string;
  type: string;
  payload: any;
}

interface TestSubEvent extends BaseEvent {
  id: string;
  type: string;
  payload: any;
}

// Create a mock span for telemetry testing
class MockSpan {
  events: Array<{ name: string; attributes?: Record<string, any> }> = [];
  attributes: Record<string, any> = {};

  addEvent(name: string, attributes?: Record<string, any>): this {
    this.events.push({ name, attributes });
    return this;
  }

  setAttributes(attributes: Record<string, any>): this {
    Object.assign(this.attributes, attributes);
    return this;
  }

  recordException(error: Error, attributes?: Record<string, any>): void {
    this.addEvent('exception', { error: error.message, ...attributes });
  }
}

// Create a test implementation of Node
class TestNode extends Node<
  string,
  TestContext,
  TestEvent,
  { tempValue: number },
  { processedEvents: TestEvent[] },
  { result: string }
> {
  constructor(id: string, private shouldFail = false) {
    super(id);
  }

  async prep(store: SharedStore<TestContext, TestEvent>): Promise<PrepResult<TestEvent, { processedEvents: TestEvent[] }>> {
    // Get all pending events
    const events = store.getPendingEvents();
    
    // Process events (in a real implementation, you might filter by event type)
    const processedEvents = events;
    
    return {
      events: processedEvents,
      args: { processedEvents }
    };
  }

  async exec(
    args: { processedEvents: TestEvent[] },
    events: TestEvent[],
    scratchpad: { tempValue: number } | undefined
  ): Promise<{ result: { result: string }; scratchpad: { tempValue: number } | undefined }> {
    if (this.shouldFail) {
      throw new Error('Intentional exec failure');
    }
    
    // Process events and update scratchpad
    const tempValue = (scratchpad?.tempValue ?? 0) + events.length;
    const eventTypes = events.map(e => e.type).join(',');
    
    return {
      result: { result: `Processed ${events.length} events: ${eventTypes}` },
      scratchpad: { tempValue }
    };
  }

  async post(
    result: { result: string },
    store: SharedStore<TestContext, TestEvent>
  ): Promise<StateResult<string, TestEvent>> {
    // Update context based on result
    await store.updateContext(ctx => ({
      ...ctx,
      count: ctx.count + 1,
      data: [...ctx.data, result.result]
    }));
    
    // In a real node, you might decide the next state based on the result
    return {
      status: 'transition',
      to: 'next-state',
      actions: [{
        id: 'action-1',
        type: 'NODE_COMPLETED',
        payload: { nodeId: this.id }
      }]
    };
  }

  // Override onError for testing error handling
  async onError(
    error: Error,
    store: SharedStore<TestContext, TestEvent>
  ): Promise<StateResult<string, TestEvent>> {
    await store.updateContext(ctx => ({
      ...ctx,
      data: [...ctx.data, `Error: ${error.message}`]
    }));
    
    return {
      status: 'transition',
      to: 'error-state',
      actions: [{
        id: 'error-action',
        type: 'NODE_ERROR',
        payload: { error: error.message }
      }]
    };
  }
}

// Create a test implementation of FlowNode
class TestFlowNode extends FlowNode<
  string,
  TestContext,
  TestEvent,
  TestSubEvent,
  { processedEvents: TestEvent[] }
> {
  constructor(id: string) {
    super(id, {
      initialState: 'sub-start',
      errorState: 'sub-error',
      nodes: new Map([
        ['sub-start', {
          id: 'sub-start',
          run: async () => ({
            status: 'transition',
            to: 'sub-end',
            actions: [{ id: 'sub-action', type: 'SUB_EVENT', payload: {} }]
          })
        }],
        ['sub-end', {
          id: 'sub-end',
          run: async () => ({
            status: 'terminal'
          })
        }]
      ])
    });
  }

  async prep(store: SharedStore<TestContext, TestEvent>): Promise<PrepResult<TestEvent, { processedEvents: TestEvent[] }>> {
    const events = store.getPendingEvents();
    return {
      events,
      args: { processedEvents: events }
    };
  }

  translateEvents(events: TestEvent[]): TestSubEvent[] {
    return events.map(e => ({
      id: `sub-${e.id}`,
      type: `SUB_${e.type}`,
      payload: e.payload
    }));
  }

  translateActions(actions: TestSubEvent[]): TestEvent[] {
    return actions.map(a => ({
      id: `parent-${a.id}`,
      type: `PARENT_${a.type}`,
      payload: a.payload
    }));
  }

  async post(
    result: StateResult<any, TestEvent>,
    store: SharedStore<TestContext, TestEvent>
  ): Promise<StateResult<string, TestEvent>> {
    await store.updateContext(ctx => ({
      ...ctx,
      count: ctx.count + 1,
      data: [...ctx.data, `FlowNode completed with status: ${result.status}`]
    }));
    
    return {
      status: 'transition',
      to: 'post-flow',
      actions: result.actions
    };
  }
}

// Create a mock store for testing
class MockStore extends SharedStore<TestContext, TestEvent> {
  constructor(instanceId: string, initialContext: TestContext) {
    super(instanceId, initialContext, {
      write: async () => {},
      writeEvents: async () => {},
      read: async () => {
        throw new Error('Not implemented');
      }
    });
  }
}

describe('Node', () => {
  let mockStore: MockStore;
  let testNode: TestNode;
  let mockSpan: MockSpan;
  
  // Setup mocks for OpenTelemetry
  const originalGetActiveSpan = trace.getActiveSpan;

  beforeEach(() => {
    mockStore = new MockStore('test-instance', { count: 0, data: [] });
    testNode = new TestNode('test-node');
    
    mockSpan = new MockSpan();
    trace.getActiveSpan = mock(() => mockSpan as any);
  });

  afterEach(() => {
    trace.getActiveSpan = originalGetActiveSpan;
  });

  test('run() executes prep, exec, and post phases in sequence', async () => {
    // Setup test events
    await mockStore.enqueueEvents([
      { id: 'e1', type: 'EVENT1', payload: { value: 1 } },
      { id: 'e2', type: 'EVENT2', payload: { value: 2 } }
    ]);
    
    // Set initial scratchpad
    mockStore.setScratchpad({ tempValue: 5 });
    
    // Run the node
    const result = await testNode.run(mockStore);
    
    // Check result
    expect(result.status).toBe('transition');
    expect(result.to).toBe('next-state');
    expect(result.actions?.length).toBe(1);
    expect(result.actions?.[0].type).toBe('NODE_COMPLETED');
    
    // Check context was updated
    const context = mockStore.getContext();
    expect(context.count).toBe(1);
    expect(context.data[0]).toContain('Processed 2 events');
    expect(context.data[0]).toContain('EVENT1,EVENT2');
    
    // Check scratchpad was updated
    const scratchpad = mockStore.getScratchpad<{ tempValue: number }>();
    expect(scratchpad?.tempValue).toBe(7); // 5 + 2 events
    
    // Check telemetry spans
    expect(mockSpan.events.filter(e => e.name === 'node_prep_started').length).toBe(1);
    expect(mockSpan.events.filter(e => e.name === 'node_prep_completed').length).toBe(1);
    expect(mockSpan.events.filter(e => e.name === 'node_exec_started').length).toBe(1);
    expect(mockSpan.events.filter(e => e.name === 'node_exec_completed').length).toBe(1);
    expect(mockSpan.events.filter(e => e.name === 'node_post_started').length).toBe(1);
    expect(mockSpan.events.filter(e => e.name === 'node_post_completed').length).toBe(1);
  });

  test('run() handles errors and invokes onError', async () => {
    // Create a node that will fail during execution
    const failingNode = new TestNode('failing-node', true);
    
    // Run the node
    const result = await failingNode.run(mockStore);
    
    // Check result (should be from onError)
    expect(result.status).toBe('transition');
    expect(result.to).toBe('error-state');
    expect(result.actions?.length).toBe(1);
    expect(result.actions?.[0].type).toBe('NODE_ERROR');
    
    // Check context was updated by onError
    const context = mockStore.getContext();
    expect(context.data[0]).toBe('Error: Intentional exec failure');
    
    // Check telemetry spans for error
    const exceptionEvents = mockSpan.events.filter(e => e.name === 'exception');
    expect(exceptionEvents.length).toBeGreaterThan(0);
    expect(exceptionEvents[0].attributes?.error).toBe('Intentional exec failure');
  });
});

describe('FlowNode', () => {
  let mockStore: MockStore;
  let flowNode: TestFlowNode;
  let mockSpan: MockSpan;
  
  // Setup mocks for OpenTelemetry
  const originalGetActiveSpan = trace.getActiveSpan;

  beforeEach(() => {
    mockStore = new MockStore('test-instance', { count: 0, data: [] });
    flowNode = new TestFlowNode('flow-node');
    
    mockSpan = new MockSpan();
    trace.getActiveSpan = mock(() => mockSpan as any);
  });

  afterEach(() => {
    trace.getActiveSpan = originalGetActiveSpan;
  });

  test('run() executes sub-machine and translates events/actions', async () => {
    // Setup test events
    await mockStore.enqueueEvents([
      { id: 'e1', type: 'PARENT_EVENT', payload: { value: 1 } }
    ]);
    
    // Run the flow node
    const result = await flowNode.run(mockStore);
    
    // Check result
    expect(result.status).toBe('transition');
    expect(result.to).toBe('post-flow');
    
    // Check actions were translated back to parent
    expect(result.actions?.length).toBe(1);
    expect(result.actions?.[0].type).toBe('PARENT_SUB_EVENT');
    
    // Check context was updated
    const context = mockStore.getContext();
    expect(context.count).toBe(1);
    expect(context.data[0]).toContain('FlowNode completed with status: terminal');
    
    // Check telemetry spans specific to FlowNode
    expect(mockSpan.events.some(e => e.name === 'submachine_initialized')).toBe(true);
    expect(mockSpan.events.some(e => e.name === 'events_translated')).toBe(true);
    expect(mockSpan.events.some(e => e.name === 'submachine_completed')).toBe(true);
  });

  test('run() correctly persists sub-machine state in scratchpad', async () => {
    // Run the flow node for the first time
    await flowNode.run(mockStore);
    
    // Check that scratchpad contains subMachineState
    const scratchpad = mockStore.getScratchpad<{ subMachineState: AllState<any, TestSubEvent> }>();
    expect(scratchpad).toBeDefined();
    expect(scratchpad?.subMachineState).toBeDefined();
    
    // The sub-machine should have completed and be in the terminal state
    const subState = scratchpad?.subMachineState;
    const lastHistoryEntry = subState?.history[subState.history.length - 1];
    expect(lastHistoryEntry?.state).toBe('sub-end');
    
    // Reset the store
    mockStore = new MockStore('test-instance', { count: 0, data: [] });
    
    // Create a new flow node with the same ID
    const newFlowNode = new TestFlowNode('flow-node');
    
    // Set the scratchpad with the previous sub-machine state
    mockStore.setScratchpad(scratchpad);
    
    // Run the flow node again
    await newFlowNode.run(mockStore);
    
    // Check telemetry spans for resumption
    expect(mockSpan.events.some(e => e.name === 'submachine_resumed')).toBe(true);
  });
});