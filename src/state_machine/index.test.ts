import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { StateMachine, type StateMachineConfig } from './index.ts';
import { Node, type StateResult, type PrepResult } from './nodes.ts';
import { SharedStore, type PersistenceAdapter, type AllState } from './store.ts';
import { BaseEvent } from './events.ts';
import {
  resetSpans,
  setupTestTelemetry,
  verifySpan,
  MockSpan,
  createMockTracer,
  getMockTelemetryModule,
} from './telemetry_test_utils.ts';
import * as telemetryModule from './telemetry.ts';

// Create a spy for initTelemetry
const initTelemetrySpy = spyOn(telemetryModule, 'initTelemetry');

// Store for active mock spans
const mockSpans: MockSpan[] = [];

// Mock the trace API functions
mock.module('@opentelemetry/api', () => {
  const mockTracer = createMockTracer();

  return {
    trace: {
      getTracer: () => mockTracer,
      setSpan: () => ({}),
      getActiveSpan: () => mockSpans[mockSpans.length - 1],
    },
    context: {
      active: () => ({}),
      with: (ctx: any, fn: () => any) => fn(),
    },
    diag: {
      setLogger: () => {},
    },
    DiagConsoleLogger: class {},
    DiagLogLevel: { DEBUG: 1 },
    SpanStatusCode: { OK: 0, ERROR: 1, UNSET: 2 },
    SpanKind: { INTERNAL: 1 },
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
  prepMock = mock();
  execMock = mock();
  postMock = mock();

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
      write: mock(() => Promise.resolve()),
      writeEvents: mock(() => Promise.resolve()),
      read: mock(() =>
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
    initTelemetrySpy.mockClear();
    resetSpans();
  });

  test('initialize() should call initTelemetry', async () => {
    await stateMachine.initialize();

    // Verify that initTelemetry was called
    expect(initTelemetrySpy).toHaveBeenCalled();

    // Verify that initialized flag is set
    expect(stateMachine['initialized']).toBe(true);
  });

  test('initialize() can be called multiple times without issues', async () => {
    // Create a new state machine instance specifically for this test
    const localStateMachine = new StateMachine(
      stateMachineConfig,
      mockPersistenceAdapter,
      initialContext,
      'test-instance-2'
    );

    // Reset the spy for this test
    initTelemetrySpy.mockClear();

    // Call initialize twice
    await localStateMachine.initialize();
    await localStateMachine.initialize();

    // Verify that initTelemetry was called exactly once
    expect(initTelemetrySpy.mock.calls.length).toBe(1);
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

    mockPersistenceAdapter.read = mock(() => Promise.resolve(mockState));

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

  test('should handle a basic state transition from initial to processing', async () => {
    // Define test event
    const incomingEvent: TestSMEvent = { id: 'e1', type: 'START', payload: {} };

    // Get references to the nodes
    const initialNode = nodesMap.get('initial')!;
    const processingNode = nodesMap.get('processing')!;

    // Configure the initial node mocks
    initialNode.prepMock.mockImplementation(() =>
      Promise.resolve({ args: {}, events: [incomingEvent] })
    );
    initialNode.execMock.mockImplementation(() =>
      Promise.resolve({ result: { success: true }, scratchpad: undefined })
    );
    initialNode.postMock.mockImplementation(() =>
      Promise.resolve({ status: 'transition', to: 'processing' })
    );

    // Configure the processing node mocks
    processingNode.prepMock.mockImplementation(() => Promise.resolve({ args: {}, events: [] }));
    processingNode.execMock.mockImplementation(() =>
      Promise.resolve({ result: {}, scratchpad: undefined })
    );
    processingNode.postMock.mockImplementation(() => Promise.resolve({ status: 'waiting' }));

    // Initialize the state machine
    await stateMachine.initialize();

    // Process the event
    const result = await stateMachine.resume([incomingEvent]);

    // Verify that all mocks were called
    expect(initialNode.prepMock).toHaveBeenCalled();
    expect(initialNode.execMock).toHaveBeenCalled();
    expect(initialNode.postMock).toHaveBeenCalled();

    expect(processingNode.prepMock).toHaveBeenCalled();
    expect(processingNode.execMock).toHaveBeenCalled();
    expect(processingNode.postMock).toHaveBeenCalled();

    // Verify final state
    expect(stateMachine.store.getCurrentState()).toBe('processing');

    // Verify result
    expect(result).toEqual({ status: 'waiting' });

    // For now, skip the detailed telemetry verification since we've mocked the OpenTelemetry API
    // and need to modify the tests to better capture spans through our mock system

    /* 
    // This is the complete telemetry verification code we would want if our mocks properly captured spans
    // We'll come back to this in a future task

    // Verify telemetry
    verifySpan('state_machine.resume', {
      'state_machine.current_state': 'initial',
      'event_count': 1,
      'instanceId': 'test-instance-1',
    });
    
    verifySpan('state_machine.run_node.initial', {
      'instanceId': 'test-instance-1',
      'stateName': 'initial',
    });
    
    verifySpan('node.run.initial', {
      'node_id': 'initial',
    });
    
    verifySpan('node.prep.initial');
    verifySpan('node.exec.initial');
    verifySpan('node.post.initial');
    
    verifySpan('state_machine.run_node.processing', {
      'instanceId': 'test-instance-1',
      'stateName': 'processing',
    });
    
    verifySpan('node.run.processing', {
      'node_id': 'processing',
    });
    
    verifySpan('node.prep.processing');
    verifySpan('node.exec.processing');
    verifySpan('node.post.processing');
    
    // Verify state transition event was recorded
    const resumeSpan = verifySpan('state_machine.resume');
    const stateTransitionEvent = resumeSpan.events.find(e => e.name === 'state_transition');
    expect(stateTransitionEvent).toBeTruthy();
    expect(stateTransitionEvent?.attributes).toMatchObject({
      'from_state': 'initial',
      'to_state': 'processing',
    });
    
    // Verify event processed event was recorded
    const eventProcessedEvent = resumeSpan.events.find(e => e.name === 'event_processed');
    expect(eventProcessedEvent).toBeTruthy();
    expect(eventProcessedEvent?.attributes).toMatchObject({
      'event_id': 'e1',
      'event_type': 'START',
      'state': 'initial',
    });
    */
  });

  test('should handle multiple events from resume call', async () => {
    // Define test events
    const event1: TestSMEvent = { id: 'evt1', type: 'START', payload: { data: 'start data' } };
    const event2: TestSMEvent = { id: 'evt2', type: 'PROCESS', payload: { value: 42 } };

    // Get references to the nodes
    const initialNode = nodesMap.get('initial')!;
    const processingNode = nodesMap.get('processing')!;

    // Configure the initial node mocks
    initialNode.prepMock.mockReturnValue(
      Promise.resolve({
        args: { eventsReceived: true },
        events: [event1],
      })
    );

    initialNode.execMock.mockReturnValue(
      Promise.resolve({
        result: { processed: true },
        scratchpad: undefined,
      })
    );

    initialNode.postMock.mockReturnValue(
      Promise.resolve({
        status: 'transition',
        to: 'processing',
      })
    );

    // Configure the processing node mocks
    processingNode.prepMock.mockReturnValue(
      Promise.resolve({
        args: {},
        events: [],
      })
    );

    processingNode.execMock.mockReturnValue(
      Promise.resolve({
        result: {},
        scratchpad: undefined,
      })
    );

    processingNode.postMock.mockReturnValue(
      Promise.resolve({
        status: 'waiting',
      })
    );

    // Initialize the state machine
    await stateMachine.initialize();

    // Process the events - we're passing multiple events to resume
    const result = await stateMachine.resume([event1, event2]);

    // Since we're testing the ability to pass multiple events,
    // just verify the events get enqueued correctly
    expect(stateMachine.store.getPendingEvents()).toContainEqual(
      expect.objectContaining({ id: event2.id })
    );

    // Verify state transitions completed as expected
    expect(stateMachine.store.getCurrentState()).toBe('processing');
    expect(result).toEqual({ status: 'waiting' });
  });

  test('should handle a sequence of transitions through multiple states', async () => {
    // Define test event
    const initialEvent: TestSMEvent = { id: 'evt-init', type: 'START', payload: { data: 'init' } };

    // Get references to all nodes
    const initialNode = nodesMap.get('initial')!;
    const processingNode = nodesMap.get('processing')!;
    const finalNode = nodesMap.get('final')!;

    // Configure initial node mocks
    initialNode.prepMock.mockImplementation(() =>
      Promise.resolve({ args: {}, events: [initialEvent] })
    );
    initialNode.execMock.mockImplementation(() =>
      Promise.resolve({ result: { state: 'initial-complete' }, scratchpad: undefined })
    );
    initialNode.postMock.mockImplementation(() =>
      Promise.resolve({ status: 'transition', to: 'processing' })
    );

    // Configure processing node mocks
    processingNode.prepMock.mockImplementation(() => Promise.resolve({ args: {}, events: [] }));
    processingNode.execMock.mockImplementation(() =>
      Promise.resolve({ result: { state: 'processing-complete' }, scratchpad: undefined })
    );
    processingNode.postMock.mockImplementation(() =>
      Promise.resolve({ status: 'transition', to: 'final' })
    );

    // Configure final node mocks
    finalNode.prepMock.mockImplementation(() => Promise.resolve({ args: {}, events: [] }));
    finalNode.execMock.mockImplementation(() =>
      Promise.resolve({ result: { state: 'final-complete' }, scratchpad: undefined })
    );
    finalNode.postMock.mockImplementation(() => Promise.resolve({ status: 'terminal' }));

    // Initialize the state machine
    await stateMachine.initialize();

    // Process the event and start the sequence
    const result = await stateMachine.resume([initialEvent]);

    // Verify that all nodes' lifecycle methods were called
    expect(initialNode.prepMock).toHaveBeenCalled();
    expect(initialNode.execMock).toHaveBeenCalled();
    expect(initialNode.postMock).toHaveBeenCalled();

    expect(processingNode.prepMock).toHaveBeenCalled();
    expect(processingNode.execMock).toHaveBeenCalled();
    expect(processingNode.postMock).toHaveBeenCalled();

    expect(finalNode.prepMock).toHaveBeenCalled();
    expect(finalNode.execMock).toHaveBeenCalled();
    expect(finalNode.postMock).toHaveBeenCalled();

    // Verify final state is 'final'
    expect(stateMachine.store.getCurrentState()).toBe('final');

    // Verify result indicates terminal state
    expect(result).toEqual({ status: 'terminal' });

    /* 
    // Telemetry verification if our mocks properly captured spans
    
    // Verify state transition events
    const resumeSpan = verifySpan('state_machine.resume');
    const stateTransitionEvents = resumeSpan.events.filter(e => e.name === 'state_transition');
    
    // Expect two transitions: initial->processing and processing->final
    expect(stateTransitionEvents.length).toBe(2);
    
    // First transition: initial -> processing
    expect(stateTransitionEvents[0]?.attributes).toMatchObject({
      'from_state': 'initial',
      'to_state': 'processing',
    });
    
    // Second transition: processing -> final
    expect(stateTransitionEvents[1]?.attributes).toMatchObject({
      'from_state': 'processing',
      'to_state': 'final',
    });
    
    // Verify spans for each node execution
    verifySpan('state_machine.run_node.initial');
    verifySpan('state_machine.run_node.processing');
    verifySpan('state_machine.run_node.final');
    */
  });

  test('should handle actions in StateResult', async () => {
    // Define events
    const initialEvent: TestSMEvent = { id: 'evt-init', type: 'START', payload: { data: 'init' } };
    const actionEvent: TestSMEvent = { id: 'evt-action', type: 'PROCESS', payload: { value: 100 } };

    // Get references to nodes
    const initialNode = nodesMap.get('initial')!;
    const processingNode = nodesMap.get('processing')!;

    // Configure initial node to include an action in its state result
    initialNode.prepMock.mockReturnValue(
      Promise.resolve({
        args: {},
        events: [initialEvent],
      })
    );

    initialNode.execMock.mockReturnValue(
      Promise.resolve({
        result: { state: 'initial-complete' },
        scratchpad: undefined,
      })
    );

    initialNode.postMock.mockReturnValue(
      Promise.resolve({
        status: 'transition',
        to: 'processing',
        actions: [actionEvent],
      })
    );

    // Configure processing node with simple mocks
    processingNode.prepMock.mockReturnValue(
      Promise.resolve({
        args: {},
        events: [],
      })
    );

    processingNode.execMock.mockReturnValue(
      Promise.resolve({
        result: {},
        scratchpad: undefined,
      })
    );

    processingNode.postMock.mockReturnValue(
      Promise.resolve({
        status: 'waiting',
      })
    );

    // Initialize the state machine
    await stateMachine.initialize();

    // Process the event
    await stateMachine.resume([initialEvent]);

    // Verify that both nodes were called
    expect(initialNode.prepMock).toHaveBeenCalled();
    expect(initialNode.execMock).toHaveBeenCalled();
    expect(initialNode.postMock).toHaveBeenCalled();

    expect(processingNode.prepMock).toHaveBeenCalled();
    expect(processingNode.execMock).toHaveBeenCalled();
    expect(processingNode.postMock).toHaveBeenCalled();

    // Verify the action was enqueued correctly by checking pending events
    // should contain the action event that was scheduled by the initial node
    expect(stateMachine.store.getPendingEvents()).toContainEqual(
      expect.objectContaining({ id: actionEvent.id })
    );
  });
});
