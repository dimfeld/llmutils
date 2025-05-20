import { describe, test, expect, beforeEach, afterEach, jest } from 'bun:test';
import { StateMachine, type StateMachineConfig } from './index.ts';
import { Node, type StateResult, type PrepResult } from './nodes.ts';
import { SharedStore, type PersistenceAdapter, type AllState } from './store.ts';
import { BaseEvent } from './events.ts';
import { resetSpans, setupTestTelemetry, verifySpan } from './telemetry_test_utils.ts';
import { initTelemetry as originalInitTelemetry } from './telemetry.ts';

// Set up mock for initTelemetry
jest.mock('./telemetry.ts', () => {
  const original = jest.requireActual('./telemetry.ts');
  return {
    ...original,
    initTelemetry: jest.fn(original.initTelemetry),
  };
});

// Define state machine types for testing
type TestSMStateName = 'initial' | 'processing' | 'final' | 'error';

interface TestSMEvent extends BaseEvent {
  type: 'START' | 'PROCESS' | 'FINISH';
  payload: { data?: string; value?: number };
}

interface TestSMContext {
  status: string;
  items: string[];
}

// Create a mock Node implementation for testing
class MockNode extends Node<TestSMStateName, TestSMContext, TestSMEvent, any, any, any> {
  prepMock = jest.fn();
  execMock = jest.fn();
  postMock = jest.fn();

  constructor(id: TestSMStateName) {
    super(id);
  }

  async prep(): Promise<PrepResult<TestSMEvent, any>> {
    return this.prepMock();
  }

  async exec(
    args: any,
    events: TestSMEvent[],
    scratchpad: any
  ): Promise<{ result: any; scratchpad: any }> {
    return this.execMock();
  }

  async post(
    result: any,
    store: SharedStore<TestSMContext, TestSMEvent>
  ): Promise<StateResult<TestSMStateName, TestSMEvent>> {
    return this.postMock();
  }
}

describe('StateMachine', () => {
  // Set up test variables
  let mockPersistenceAdapter: PersistenceAdapter<TestSMContext, TestSMEvent>;
  let initialContext: TestSMContext;
  let nodesMap: Map<TestSMStateName, MockNode>;
  let stateMachineConfig: StateMachineConfig<TestSMStateName, TestSMContext, TestSMEvent>;
  let stateMachine: StateMachine<TestSMStateName, TestSMContext, TestSMEvent>;

  beforeEach(() => {
    // Reset telemetry and mocks
    resetSpans();
    setupTestTelemetry();

    // Create mock persistence adapter
    mockPersistenceAdapter = {
      write: jest.fn(() => Promise.resolve()),
      writeEvents: jest.fn(() => Promise.resolve()),
      read: jest.fn(() =>
        Promise.resolve({
          context: { status: 'idle', items: [] },
          scratchpad: undefined,
          pendingEvents: [],
          history: [],
        } as AllState<TestSMContext, TestSMEvent>)
      ),
    };

    // Set up initial context
    initialContext = {
      status: 'new',
      items: [],
    };

    // Create nodes map with mock nodes
    nodesMap = new Map<TestSMStateName, MockNode>();
    const initialNode = new MockNode('initial');
    const processingNode = new MockNode('processing');
    const finalNode = new MockNode('final');
    const errorNode = new MockNode('error');

    nodesMap.set('initial', initialNode);
    nodesMap.set('processing', processingNode);
    nodesMap.set('final', finalNode);
    nodesMap.set('error', errorNode);

    // Set up state machine config
    stateMachineConfig = {
      initialState: 'initial',
      errorState: 'error',
      nodes: nodesMap as any,
    };

    // Create state machine instance
    stateMachine = new StateMachine(
      stateMachineConfig,
      mockPersistenceAdapter,
      initialContext,
      'test-instance-1'
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('initialize() should call initTelemetry', async () => {
    await stateMachine.initialize();

    // Verify that initTelemetry was called
    expect(originalInitTelemetry).toHaveBeenCalled();

    // Verify that initialized flag is set
    expect(stateMachine['initialized']).toBe(true);
  });

  test('initialize() can be called multiple times without issues', async () => {
    await stateMachine.initialize();
    await stateMachine.initialize();

    // Verify that initTelemetry was called exactly once
    expect(originalInitTelemetry).toHaveBeenCalledTimes(1);
  });

  test('loadPersistedState() should load state from the adapter', async () => {
    // Mock the adapter to return a specific state
    const mockState: AllState<TestSMContext, TestSMEvent> = {
      context: {
        status: 'loaded',
        items: ['item1', 'item2'],
      },
      scratchpad: { someData: 'test' },
      pendingEvents: [{ id: 'evt1', type: 'START', payload: { data: 'start data' } }],
      history: [
        {
          state: 'initial',
          context: { status: 'new', items: [] },
          scratchpad: undefined,
          events: [],
          timestamp: Date.now() - 1000,
        },
      ],
    };

    mockPersistenceAdapter.read = jest.fn(() => Promise.resolve(mockState));

    // Call loadPersistedState
    await stateMachine.loadPersistedState();

    // Verify adapter.read was called
    expect(mockPersistenceAdapter.read).toHaveBeenCalledWith('test-instance-1');

    // Verify the state was loaded into the store
    expect(stateMachine.store.getContext()).toEqual(mockState.context);
    expect(stateMachine.store.getScratchpad()).toEqual(mockState.scratchpad);
    expect(stateMachine.store.getPendingEvents()).toEqual(mockState.pendingEvents);
    expect(stateMachine.store.getExecutionTrace()).toEqual(mockState.history);
  });
});
