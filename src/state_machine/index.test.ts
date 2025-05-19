import { describe, test, expect, beforeEach, mock, afterEach } from 'bun:test';
import { StateMachine, type StateMachineConfig, type StateMachineHooks } from './index';
import { type Node, type StateResult } from './nodes';
import { SharedStore, type PersistenceAdapter } from './store';
import type { BaseEvent } from './events';
import * as telemetry from './telemetry';
import { trace, context } from '@opentelemetry/api';

// Define test types
interface TestContext {
  count: number;
  history: string[];
}

interface TestEvent extends BaseEvent {
  id: string;
  type: string;
  payload: any;
}

// Create a mock span for telemetry testing
class MockSpan {
  events: Array<{ name: string; attributes?: Record<string, any> }> = [];
  attributes: Record<string, any> = {};
  status: { code: number; message?: string } = { code: 0 };
  ended: boolean = false;

  constructor(public name: string = 'mock-span') {}

  addEvent(name: string, attributes?: Record<string, any>): this {
    this.events.push({ name, attributes });
    return this;
  }

  setAttributes(attributes: Record<string, any>): this {
    Object.assign(this.attributes, attributes);
    return this;
  }

  setStatus(status: { code: number; message?: string }): this {
    this.status = status;
    return this;
  }

  recordException(error: Error, attributes?: Record<string, any>): void {
    this.addEvent('exception', { error: error.message, ...attributes });
  }

  end(): void {
    this.ended = true;
  }
}

// Create a mock persistence adapter for testing
class MockAdapter implements PersistenceAdapter<TestContext, TestEvent> {
  private storage: Map<string, any> = new Map();

  writeCallCount = 0;
  writeEventsCallCount = 0;
  readCallCount = 0;

  async write(instanceId: string, state: any): Promise<void> {
    this.writeCallCount++;
    this.storage.set(instanceId, structuredClone(state));
  }

  async writeEvents(instanceId: string, events: TestEvent[]): Promise<void> {
    this.writeEventsCallCount++;
  }

  async read(instanceId: string): Promise<any> {
    this.readCallCount++;
    return (
      this.storage.get(instanceId) || {
        context: { count: 0, history: [] },
        scratchpad: undefined,
        pendingEvents: [],
        history: [],
      }
    );
  }
}

// Create mock nodes for testing
class MockNode implements Node<string, TestContext, TestEvent, any, any, any> {
  public runCount = 0;
  public shouldFail = false;
  public result: StateResult<string, TestEvent> = { status: 'waiting' };

  constructor(public id: string) {}

  async run(store: SharedStore<TestContext, TestEvent>): Promise<StateResult<string, TestEvent>> {
    this.runCount++;
    if (this.shouldFail) {
      throw new Error(`${this.id} node execution failed`);
    }

    // Record the state execution in context history
    await store.updateContext((ctx) => ({
      ...ctx,
      count: ctx.count + 1,
      history: [...ctx.history, `Executed ${this.id}`],
    }));

    return this.result;
  }
}

describe('StateMachine', () => {
  // Test configuration
  const initialContext: TestContext = { count: 0, history: [] };
  const instanceId = 'test-machine';

  // Create mocks for all dependencies
  let adapter: MockAdapter;
  let nodeA: MockNode;
  let nodeB: MockNode;
  let errorNode: MockNode;
  let stateMachine: StateMachine<string, TestContext, TestEvent>;
  let config: StateMachineConfig<string, TestContext, TestEvent>;
  let hooks: StateMachineHooks<string, TestEvent>;
  let mockSpan: MockSpan;

  // Spy on telemetry functions
  let initTelemetrySpy: jest.Mock;
  let withSpanSpy: jest.Mock;
  let recordStateSpy: jest.Mock;
  let recordEventSpy: jest.Mock;
  let recordErrorSpy: jest.Mock;

  // Setup mocks for OpenTelemetry
  const originalGetActiveSpan = trace.getActiveSpan;

  beforeEach(() => {
    // Reset mocks
    adapter = new MockAdapter();
    nodeA = new MockNode('state-a');
    nodeB = new MockNode('state-b');
    errorNode = new MockNode('error-state');

    // Configure mock node results
    nodeA.result = { status: 'transition', to: 'state-b' };
    nodeB.result = { status: 'terminal' };
    errorNode.result = { status: 'terminal' };

    // Create hooks
    hooks = {
      onTransition: mock((from, to) => {}),
      onActions: mock((actions) => {}),
      onError: mock(async (error, store) => ({ status: 'transition', to: 'error-state' })),
      onRetry: mock((error, state, attempt) => {}),
    };

    // Create config with zero retries by default for tests
    config = {
      initialState: 'state-a',
      errorState: 'error-state',
      nodes: new Map([
        ['state-a', nodeA],
        ['state-b', nodeB],
        ['error-state', errorNode],
      ]),
      maxRetries: 0,
      retryDelay: () => 0, // No delay in tests
    };

    // Create state machine
    stateMachine = new StateMachine(config, adapter, initialContext, instanceId, hooks);

    // Setup telemetry mocks
    mockSpan = new MockSpan();

    initTelemetrySpy = mock(telemetry.initTelemetry);
    withSpanSpy = mock(telemetry.withSpan, (name, attrs, fn) => fn(mockSpan));
    recordStateSpy = mock(telemetry.recordStateTransition);
    recordEventSpy = mock(telemetry.recordEvent);
    recordErrorSpy = mock(telemetry.recordError);

    telemetry.initTelemetry = initTelemetrySpy;
    telemetry.withSpan = withSpanSpy;
    telemetry.recordStateTransition = recordStateSpy;
    telemetry.recordEvent = recordEventSpy;
    telemetry.recordError = recordErrorSpy;

    trace.getActiveSpan = mock(() => mockSpan as any);
  });

  afterEach(() => {
    trace.getActiveSpan = originalGetActiveSpan;
  });

  test('initialize() sets up telemetry', async () => {
    await stateMachine.initialize(true);

    expect(initTelemetrySpy).toHaveBeenCalledWith(true);
    expect(stateMachine['initialized']).toBe(true);

    // Calling again shouldn't reinitialize
    initTelemetrySpy.mockClear();
    await stateMachine.initialize();
    expect(initTelemetrySpy).not.toHaveBeenCalled();
  });

  test('resume() executes current state node', async () => {
    // Initialize and resume with some events
    await stateMachine.initialize();

    const events: TestEvent[] = [{ id: 'e1', type: 'TEST_EVENT', payload: { value: 1 } }];

    const result = await stateMachine.resume(events);

    // Check that events were enqueued
    expect(recordEventSpy).toHaveBeenCalled();

    // Check that node was executed
    expect(nodeA.runCount).toBe(1);

    // Check that state transition happened
    expect(recordStateSpy).toHaveBeenCalled();
    expect(hooks.onTransition).toHaveBeenCalledWith('state-a', 'state-b', expect.any(Object));

    // Check that next node was executed
    expect(nodeB.runCount).toBe(1);

    // Final result should be from the last executed node
    expect(result.status).toBe('terminal');

    // Check context updates
    const context = stateMachine.store.getContext();
    expect(context.count).toBe(2); // Both nodes executed once
    expect(context.history).toEqual(['Executed state-a', 'Executed state-b']);
  });

  test('runNode() handles state transitions correctly', async () => {
    await stateMachine.initialize();

    // Execute the first node, which should transition to the second
    await stateMachine.runNode(nodeA);

    // Check that both nodes were executed in sequence
    expect(nodeA.runCount).toBe(1);
    expect(nodeB.runCount).toBe(1);

    // Check that transition was recorded
    expect(recordStateSpy).toHaveBeenCalled();
    expect(hooks.onTransition).toHaveBeenCalledWith('state-a', 'state-b', expect.any(Object));

    // Check that current state was updated
    expect(stateMachine.store.getCurrentState()).toBe('state-b');
  });

  test('runNode() handles node execution errors', async () => {
    await stateMachine.initialize();

    // Make node A fail
    nodeA.shouldFail = true;

    // Execute the node, which should fail and transition to error state
    await stateMachine.runNode(nodeA);

    // Check that error was recorded
    expect(recordErrorSpy).toHaveBeenCalled();

    // Check that onError hook was called
    expect(hooks.onError).toHaveBeenCalled();

    // Check that transition to error state happened
    expect(recordStateSpy).toHaveBeenCalled();
    expect(stateMachine.store.getCurrentState()).toBe('error-state');

    // Check that error node was executed
    expect(errorNode.runCount).toBe(1);
  });

  test('handleStateResult() processes transition and actions', async () => {
    await stateMachine.initialize();

    // Create a test result with actions
    const actions: TestEvent[] = [{ id: 'a1', type: 'ACTION', payload: { value: 'test' } }];

    const result: StateResult<string, TestEvent> = {
      status: 'transition',
      to: 'state-b',
      actions,
    };

    // Process the result
    await stateMachine['handleStateResult'](result);

    // Check that actions were enqueued
    const pendingEvents = stateMachine.store.getPendingEvents();
    expect(pendingEvents).toEqual(actions);

    // Check that transition was recorded
    expect(recordStateSpy).toHaveBeenCalled();
    expect(hooks.onActions).toHaveBeenCalledWith(actions, 'state-b');

    // Check that current state was updated
    expect(stateMachine.store.getCurrentState()).toBe('state-b');

    // Check that next node was executed
    expect(nodeB.runCount).toBe(1);
  });

  test('handleStateResult() handles unknown state nodes', async () => {
    await stateMachine.initialize();

    // Create a result with an unknown target state
    const result: StateResult<string, TestEvent> = {
      status: 'transition',
      to: 'unknown-state',
    };

    // Process the result, should fail and go to error state
    await stateMachine['handleStateResult'](result);

    // Check that error was recorded
    expect(recordErrorSpy).toHaveBeenCalled();

    // Check that error handler was called
    expect(hooks.onError).toHaveBeenCalled();

    // Check that error node was executed
    expect(errorNode.runCount).toBe(1);
  });

  test('loadPersistedState() loads state from adapter', async () => {
    // Set up the adapter to provide a persisted state
    await adapter.write(instanceId, {
      context: {
        count: 5,
        history: ['Previous state execution'],
      },
      scratchpad: { testValue: 'persisted' },
      pendingEvents: [],
      history: [
        {
          state: 'state-a',
          context: { count: 5, history: ['Previous state execution'] },
          scratchpad: { testValue: 'persisted' },
          events: [],
          timestamp: Date.now(),
        },
      ],
    });

    // Load the persisted state
    await stateMachine.loadPersistedState();

    // Check that adapter was called
    expect(adapter.readCallCount).toBe(1);

    // Check that state was loaded
    const context = stateMachine.store.getContext();
    expect(context.count).toBe(5);
    expect(context.history).toEqual(['Previous state execution']);

    const scratchpad = stateMachine.store.getScratchpad();
    expect(scratchpad).toEqual({ testValue: 'persisted' });
  });
});

describe('StateMachine Integration', () => {
  // Create a realistic state machine workflow for testing
  interface OrderContext {
    orderId: string;
    items: { id: string; quantity: number; price: number }[];
    customer: { id: string; name: string } | null;
    payment: { id: string; amount: number; status: string } | null;
    total: number;
    status: string;
    logs: string[];
  }

  type OrderStateNames =
    | 'created'
    | 'items_selected'
    | 'checkout'
    | 'payment'
    | 'completed'
    | 'error';

  interface OrderEvent extends BaseEvent {
    id: string;
    type:
      | 'ADD_ITEM'
      | 'REMOVE_ITEM'
      | 'SET_CUSTOMER'
      | 'PROCESS_PAYMENT'
      | 'CONFIRM_ORDER'
      | 'ERROR';
    payload: any;
  }

  // Create mock nodes for a simple order processing workflow
  class OrderNode implements Node<OrderStateNames, OrderContext, OrderEvent, any, any, any> {
    constructor(
      public id: OrderStateNames,
      private handler: (
        store: SharedStore<OrderContext, OrderEvent>
      ) => Promise<StateResult<OrderStateNames, OrderEvent>>
    ) {}

    async run(
      store: SharedStore<OrderContext, OrderEvent>
    ): Promise<StateResult<OrderStateNames, OrderEvent>> {
      // Log the state execution
      await store.updateContext((ctx) => ({
        ...ctx,
        logs: [...ctx.logs, `Executing ${this.id} state`],
      }));

      // Delegate to handler
      return await this.handler(store);
    }
  }

  let stateMachine: StateMachine<OrderStateNames, OrderContext, OrderEvent>;
  let adapter: MockAdapter;
  let mockSpan: MockSpan;

  // Setup mocks for OpenTelemetry
  const originalGetActiveSpan = trace.getActiveSpan;
  const originalWithSpan = telemetry.withSpan;

  beforeEach(() => {
    adapter = new MockAdapter();

    // Create nodes for each state in the workflow
    const nodes = new Map<
      OrderStateNames,
      Node<OrderStateNames, OrderContext, OrderEvent, any, any, any>
    >();

    // Created state - initial state
    nodes.set(
      'created',
      new OrderNode('created', async (store) => {
        const events = store.getPendingEvents();
        const addItemEvents = events.filter((e) => e.type === 'ADD_ITEM');

        if (addItemEvents.length > 0) {
          // Process add item events
          await store.updateContext((ctx) => {
            const newItems = addItemEvents.map((e) => e.payload.item);
            return {
              ...ctx,
              items: [...ctx.items, ...newItems],
              total:
                ctx.total + newItems.reduce((sum, item) => sum + item.price * item.quantity, 0),
              status: 'items_added',
            };
          });

          return {
            status: 'transition',
            to: 'items_selected',
          };
        }

        return { status: 'waiting' };
      })
    );

    // Items selected state
    nodes.set(
      'items_selected',
      new OrderNode('items_selected', async (store) => {
        const events = store.getPendingEvents();
        const setCustomerEvent = events.find((e) => e.type === 'SET_CUSTOMER');

        if (setCustomerEvent) {
          // Process customer information
          await store.updateContext((ctx) => ({
            ...ctx,
            customer: setCustomerEvent.payload.customer,
            status: 'customer_set',
          }));

          return {
            status: 'transition',
            to: 'checkout',
          };
        }

        return { status: 'waiting' };
      })
    );

    // Checkout state
    nodes.set(
      'checkout',
      new OrderNode('checkout', async (store) => {
        const events = store.getPendingEvents();
        const paymentEvent = events.find((e) => e.type === 'PROCESS_PAYMENT');

        if (paymentEvent) {
          // Process payment
          const context = store.getContext();
          const payment = {
            id: `payment-${Date.now()}`,
            amount: context.total,
            status: 'processing',
          };

          // Simulate payment processing
          await store.updateContext((ctx) => ({
            ...ctx,
            payment,
            status: 'payment_processing',
          }));

          // Check if payment should succeed or fail (for testing)
          if (paymentEvent.payload.shouldFail) {
            throw new Error('Payment processing failed');
          }

          // Update payment status
          await store.updateContext((ctx) => ({
            ...ctx,
            payment: { ...ctx.payment!, status: 'completed' },
            status: 'payment_completed',
          }));

          return {
            status: 'transition',
            to: 'payment',
          };
        }

        return { status: 'waiting' };
      })
    );

    // Payment state
    nodes.set(
      'payment',
      new OrderNode('payment', async (store) => {
        const events = store.getPendingEvents();
        const confirmEvent = events.find((e) => e.type === 'CONFIRM_ORDER');

        if (confirmEvent) {
          // Finalize order
          await store.updateContext((ctx) => ({
            ...ctx,
            status: 'completed',
          }));

          return {
            status: 'transition',
            to: 'completed',
          };
        }

        return { status: 'waiting' };
      })
    );

    // Completed state - terminal state
    nodes.set(
      'completed',
      new OrderNode('completed', async () => {
        return { status: 'terminal' };
      })
    );

    // Error state
    nodes.set(
      'error',
      new OrderNode('error', async (store) => {
        await store.updateContext((ctx) => ({
          ...ctx,
          status: 'error',
        }));

        return { status: 'terminal' };
      })
    );

    // Create hooks
    const hooks: StateMachineHooks<OrderStateNames, OrderEvent> = {
      onTransition: (from, to, context) => {
        // In a real app, this might trigger side effects or notifications
      },
      onError: async (error, store) => {
        await store.updateContext((ctx) => ({
          ...ctx,
          logs: [...ctx.logs, `Error: ${error.message}`],
        }));

        return {
          status: 'transition',
          to: 'error',
          actions: [
            {
              id: `error-${Date.now()}`,
              type: 'ERROR',
              payload: { message: error.message },
            },
          ],
        };
      },
    };

    // Initial context
    const initialContext: OrderContext = {
      orderId: `order-${Date.now()}`,
      items: [],
      customer: null,
      payment: null,
      total: 0,
      status: 'created',
      logs: [],
    };

    // Create state machine config with zero retries for tests
    const config: StateMachineConfig<OrderStateNames, OrderContext, OrderEvent> = {
      initialState: 'created',
      errorState: 'error',
      nodes,
      maxRetries: 0,
      retryDelay: () => 0,
    };

    // Create state machine
    stateMachine = new StateMachine(config, adapter, initialContext, 'order-workflow', hooks);

    // Mock telemetry
    mockSpan = new MockSpan();
    telemetry.withSpan = mock((name, attrs, fn) => fn(mockSpan));
    trace.getActiveSpan = mock(() => mockSpan as any);
  });

  afterEach(() => {
    trace.getActiveSpan = originalGetActiveSpan;
    telemetry.withSpan = originalWithSpan;
  });

  test('executes a complete order workflow', async () => {
    // Initialize state machine
    await stateMachine.initialize();

    // Step 1: Add items to the order
    await stateMachine.resume([
      {
        id: 'add-1',
        type: 'ADD_ITEM',
        payload: {
          item: { id: 'item-1', quantity: 2, price: 10.99 },
        },
      },
      {
        id: 'add-2',
        type: 'ADD_ITEM',
        payload: {
          item: { id: 'item-2', quantity: 1, price: 24.99 },
        },
      },
    ]);

    // Check state transition
    expect(stateMachine.store.getCurrentState()).toBe('items_selected');
    let context = stateMachine.store.getContext();
    expect(context.items.length).toBe(2);
    expect(context.total).toBeCloseTo(46.97);

    // Step 2: Set customer information
    await stateMachine.resume([
      {
        id: 'customer-1',
        type: 'SET_CUSTOMER',
        payload: {
          customer: { id: 'cust-1', name: 'Test Customer' },
        },
      },
    ]);

    // Check state transition
    expect(stateMachine.store.getCurrentState()).toBe('checkout');
    context = stateMachine.store.getContext();
    expect(context.customer?.id).toBe('cust-1');

    // Step 3: Process payment
    await stateMachine.resume([
      {
        id: 'payment-1',
        type: 'PROCESS_PAYMENT',
        payload: { shouldFail: false },
      },
    ]);

    // Check state transition
    expect(stateMachine.store.getCurrentState()).toBe('payment');
    context = stateMachine.store.getContext();
    expect(context.payment?.status).toBe('completed');

    // Step 4: Confirm order
    await stateMachine.resume([
      {
        id: 'confirm-1',
        type: 'CONFIRM_ORDER',
        payload: {},
      },
    ]);

    // Check state transition to terminal state
    expect(stateMachine.store.getCurrentState()).toBe('completed');
    context = stateMachine.store.getContext();
    expect(context.status).toBe('completed');

    // Check that all states were executed
    const expectedLogs = [
      'Executing created state',
      'Executing items_selected state',
      'Executing checkout state',
      'Executing payment state',
      'Executing completed state',
    ];

    expect(context.logs).toEqual(expectedLogs);
  });

  test('handles errors and transitions to error state', async () => {
    await stateMachine.initialize();

    // Add items and set customer
    await stateMachine.resume([
      {
        id: 'add-1',
        type: 'ADD_ITEM',
        payload: {
          item: { id: 'item-1', quantity: 1, price: 10.99 },
        },
      },
    ]);

    await stateMachine.resume([
      {
        id: 'customer-1',
        type: 'SET_CUSTOMER',
        payload: {
          customer: { id: 'cust-1', name: 'Test Customer' },
        },
      },
    ]);

    // Process payment with failure
    await stateMachine.resume([
      {
        id: 'payment-1',
        type: 'PROCESS_PAYMENT',
        payload: { shouldFail: true }, // This will cause an error
      },
    ]);

    // Check transition to error state
    expect(stateMachine.store.getCurrentState()).toBe('error');
    const context = stateMachine.store.getContext();
    expect(context.status).toBe('error');

    // Check error log
    expect(context.logs.some((log) => log.includes('Error: Payment processing failed'))).toBe(true);
  });

  test('can resume from persisted state', async () => {
    // Initialize and run part of the workflow
    await stateMachine.initialize();

    await stateMachine.resume([
      {
        id: 'add-1',
        type: 'ADD_ITEM',
        payload: {
          item: { id: 'item-1', quantity: 1, price: 10.99 },
        },
      },
    ]);

    // Store should have persisted the state
    expect(adapter.writeEventsCallCount).toBeGreaterThan(0);

    // Create a new state machine with the same instance ID
    const newStateMachine = new StateMachine(
      stateMachine.config,
      adapter,
      { orderId: '', items: [], customer: null, payment: null, total: 0, status: '', logs: [] },
      'order-workflow'
    );

    // Load persisted state
    await newStateMachine.loadPersistedState();

    // Check that state was restored
    const context = newStateMachine.store.getContext();
    expect(context.items.length).toBe(1);
    expect(context.items[0].id).toBe('item-1');
    expect(newStateMachine.store.getCurrentState()).toBe('items_selected');

    // Continue the workflow
    await newStateMachine.resume([
      {
        id: 'customer-1',
        type: 'SET_CUSTOMER',
        payload: {
          customer: { id: 'cust-1', name: 'Test Customer' },
        },
      },
    ]);

    // Check that workflow continued correctly
    expect(newStateMachine.store.getCurrentState()).toBe('checkout');
  });
});
