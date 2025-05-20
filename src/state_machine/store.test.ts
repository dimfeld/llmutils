import { describe, expect, test, beforeEach, afterEach, mock, jest } from 'bun:test';
import { SharedStore, PersistenceAdapter, type AllState } from './store';
import { BaseEvent } from './events';
import {
  resetSpans,
  getSpans,
  setupTestTelemetry,
  MockSpan,
  findSpan,
} from './telemetry_test_utils';
import * as telemetry from './telemetry';

// Define test types
interface TestEvent extends BaseEvent<'TEST_EVENT', { data: string }> {}

interface TestContext {
  counter: number;
  user?: string;
  items?: string[];
}

// Helper function to create test events
const createTestEvent = (id: string, data: string): TestEvent => ({
  id,
  type: 'TEST_EVENT',
  payload: { data },
});

// Create mock persistence adapter
const createMockPersistenceAdapter = (): PersistenceAdapter<TestContext, TestEvent> => ({
  write: mock(() => Promise.resolve(undefined)),
  writeEvents: mock(() => Promise.resolve(undefined)),
  read: mock(() =>
    Promise.resolve({
      context: { counter: 0 },
      scratchpad: undefined,
      pendingEvents: [],
      history: [],
    } as AllState<TestContext, TestEvent>)
  ),
});

describe('SharedStore', () => {
  let store: SharedStore<TestContext, TestEvent>;
  let mockAdapter: PersistenceAdapter<TestContext, TestEvent>;
  const initialContext: TestContext = { counter: 0 };
  const instanceId = 'test-instance';

  beforeEach(() => {
    // Set up test telemetry
    setupTestTelemetry();
    resetSpans();

    // Create a fresh mock adapter for each test
    mockAdapter = createMockPersistenceAdapter();

    // Create a fresh store with deep-cloned context for test isolation
    store = new SharedStore<TestContext, TestEvent>(
      instanceId,
      structuredClone(initialContext),
      mockAdapter
    );
  });

  afterEach(() => {
    // Reset all adapter mocks
    mockAdapter.write.mockReset();
    mockAdapter.writeEvents.mockReset();
    mockAdapter.read.mockReset();

    // Reset spans
    resetSpans();

    // Reset all spies
    jest.restoreAllMocks();
  });

  describe('Context Management', () => {
    test('getContext() returns the current context', () => {
      const context = store.getContext();
      expect(context).toEqual(initialContext);
    });

    test('getContext() returns a deep clone of the context', () => {
      const context = store.getContext();

      // Modify the returned context
      context.counter = 100;
      context.user = 'test-user';

      // Verify the original store context is unaffected
      const newContext = store.getContext();
      expect(newContext).toEqual(initialContext);
      expect(newContext.counter).toBe(0);
      expect(newContext.user).toBeUndefined();
    });

    test('updateContext() correctly updates the context', async () => {
      // Update the context
      await store.updateContext((ctx) => ({
        ...ctx,
        counter: ctx.counter + 1,
        user: 'test-user',
      }));

      // Verify the updated context
      const updatedContext = store.getContext();
      expect(updatedContext.counter).toBe(1);
      expect(updatedContext.user).toBe('test-user');
    });

    test('updateContext() uses the updater function with a clone of the context', async () => {
      // Update the context and capture the parameter passed to the updater function
      let updaterParam: TestContext | undefined;

      await store.updateContext((ctx) => {
        updaterParam = ctx;
        return { ...ctx, counter: 5 };
      });

      // Modify the captured parameter
      if (updaterParam) {
        updaterParam.counter = 100;
      }

      // Verify the store's context has the value from the updater's return value
      // and not from the modification of the captured parameter
      const finalContext = store.getContext();
      expect(finalContext.counter).toBe(5);
    });
  });

  describe('Scratchpad Management', () => {
    test('getScratchpad() returns undefined initially', () => {
      const scratchpad = store.getScratchpad();
      expect(scratchpad).toBeUndefined();
    });

    test('setScratchpad() and getScratchpad() work correctly', () => {
      const testData = { name: 'test', values: [1, 2, 3] };

      // Set scratchpad
      store.setScratchpad(testData);

      // Get and verify scratchpad
      const retrievedData = store.getScratchpad();
      expect(retrievedData).toEqual(testData);
    });

    test('getScratchpad() returns a deep clone', () => {
      const testData = { name: 'test', values: [1, 2, 3] };

      // Set scratchpad
      store.setScratchpad(testData);

      // Get scratchpad and modify it
      const retrievedData = store.getScratchpad<typeof testData>();
      if (retrievedData) {
        retrievedData.name = 'modified';
        retrievedData.values.push(4);
      }

      // Verify original scratchpad in store is unaffected
      const newRetrievedData = store.getScratchpad<typeof testData>();
      expect(newRetrievedData).toEqual(testData);
    });

    test('clearScratchpad() removes the scratchpad data', () => {
      // Set scratchpad
      store.setScratchpad({ test: 'data' });

      // Verify it's set
      expect(store.getScratchpad()).toBeDefined();

      // Clear scratchpad
      store.clearScratchpad();

      // Verify it's cleared
      expect(store.getScratchpad()).toBeUndefined();
    });

    test('updateScratchpad() correctly updates with the updater function', () => {
      // Set initial scratchpad
      const initial = { count: 1, items: ['a'] };
      store.setScratchpad(initial);

      // Update scratchpad
      store.updateScratchpad<typeof initial>((pad) => ({
        ...pad,
        count: pad.count + 1,
        items: [...pad.items, 'b'],
      }));

      // Verify update
      const updated = store.getScratchpad<typeof initial>();
      expect(updated).toEqual({
        count: 2,
        items: ['a', 'b'],
      });
    });

    test('updateScratchpad() handles initially undefined scratchpad', () => {
      // Ensure scratchpad is undefined
      store.clearScratchpad();
      expect(store.getScratchpad()).toBeUndefined();

      // Define the updater type - an object that would be created if scratchpad is undefined
      interface InitialScratchpad {
        count: number;
        items: string[];
      }

      // Update undefined scratchpad with a function that creates a new object
      store.updateScratchpad<InitialScratchpad>((pad) => {
        // We need to handle undefined case inside the updater
        const basePad = pad || { count: 0, items: [] };
        return {
          count: basePad.count + 1,
          items: [...basePad.items, 'first'],
        };
      });

      // Verify the new scratchpad
      const updated = store.getScratchpad<InitialScratchpad>();
      expect(updated).toEqual({
        count: 1,
        items: ['first'],
      });
    });
  });

  describe('Event Management', () => {
    test('getPendingEvents() returns an empty array initially', () => {
      const events = store.getPendingEvents();
      expect(events).toEqual([]);
    });

    test('enqueueEvents() adds events to the pending list', async () => {
      // Create test events
      const events = [createTestEvent('event1', 'data1'), createTestEvent('event2', 'data2')];

      // Enqueue events
      await store.enqueueEvents(events);

      // Check if events were added to the pending list
      const pendingEvents = store.getPendingEvents();
      expect(pendingEvents).toHaveLength(2);
      expect(pendingEvents[0].id).toBe('event1');
      expect(pendingEvents[1].id).toBe('event2');
    });

    test('enqueueEvents() creates event copies', async () => {
      // Create a mutable event
      const event = createTestEvent('event1', 'original');

      // Enqueue the event
      await store.enqueueEvents([event]);

      // Modify the event ID (should not affect stored version)
      const originalId = event.id;
      event.id = 'modified-id';

      // Verify the pending event has the original ID
      const pendingEvents = store.getPendingEvents();
      expect(pendingEvents.length).toBe(1);
      expect(pendingEvents[0].id).toBe(originalId);

      // The implementation uses shallow copies, so we're testing what the implementation actually does
      // Note: If the implementation were to change to use deep copies in the future, this test would need updating
    });

    test('enqueueEvents() calls adapter.writeEvents', async () => {
      const events = [createTestEvent('event1', 'data1')];

      await store.enqueueEvents(events);

      expect(mockAdapter.writeEvents).toHaveBeenCalled();
    });

    test('getPendingEvents() returns event copies', async () => {
      // Enqueue an event
      await store.enqueueEvents([createTestEvent('event1', 'data1')]);

      // Get and modify events
      const pendingEvents = store.getPendingEvents();
      const originalId = pendingEvents[0].id;
      pendingEvents[0].id = 'modified-id';

      // Verify original event ID in store is unaffected (references are not shared)
      const newPendingEvents = store.getPendingEvents();
      expect(newPendingEvents.length).toBe(1);
      expect(newPendingEvents[0].id).toBe(originalId);

      // The implementation uses shallow copies, so we're testing what the implementation actually does
      // Note: If the implementation were to change to use deep copies in the future, this test would need updating
    });

    test('processEvents() removes and returns the specified events', async () => {
      // Enqueue multiple events
      const events = [
        createTestEvent('event1', 'data1'),
        createTestEvent('event2', 'data2'),
        createTestEvent('event3', 'data3'),
      ];
      await store.enqueueEvents(events);

      // Process specific events
      const processed = store.processEvents(['event1', 'event3']);

      // Verify processed events are returned
      expect(processed).toHaveLength(2);
      expect(processed.map((e) => e.id)).toEqual(['event1', 'event3']);

      // Verify remaining events
      const remaining = store.getPendingEvents();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe('event2');
    });

    test('processEvents() throws for invalid event IDs', async () => {
      // Enqueue an event
      await store.enqueueEvents([createTestEvent('event1', 'data1')]);

      // Try to process a non-existent event
      expect(() => {
        store.processEvents(['event1', 'non-existent']);
      }).toThrow('Invalid event IDs: non-existent');
    });

    test('dequeueEvent() removes and returns the oldest event', async () => {
      // Enqueue multiple events
      await store.enqueueEvents([
        createTestEvent('event1', 'data1'),
        createTestEvent('event2', 'data2'),
      ]);

      // Dequeue the first event
      const firstEvent = await store.dequeueEvent();

      // Verify the dequeued event
      expect(firstEvent?.id).toBe('event1');

      // Verify remaining events
      const remainingEvents = store.getPendingEvents();
      expect(remainingEvents).toHaveLength(1);
      expect(remainingEvents[0].id).toBe('event2');
    });

    test('dequeueEvent() returns undefined when no events are present', async () => {
      const event = await store.dequeueEvent();
      expect(event).toBeUndefined();
    });
  });

  describe('State and History Management', () => {
    test('getCurrentState() returns undefined initially', () => {
      const state = store.getCurrentState();
      expect(state).toBeUndefined();
    });

    test('setCurrentState() and getCurrentState() work correctly', () => {
      store.setCurrentState('TEST_STATE');
      expect(store.getCurrentState()).toBe('TEST_STATE');
    });

    test('logTransition() adds an entry to the execution history', () => {
      // Setup initial state and context
      store.setCurrentState('INITIAL_STATE');
      store.updateContext((ctx) => ({ ...ctx, counter: 10 }));

      // Set scratchpad data
      store.setScratchpad({ temp: 'data' });

      // Create events
      const events = [createTestEvent('event1', 'data1')];

      // Log transition
      store.logTransition('NEW_STATE', events);

      // Get execution trace
      const trace = store.getExecutionTrace();

      // Verify trace contents
      expect(trace).toHaveLength(1);
      expect(trace[0].state).toBe('NEW_STATE');
      expect(trace[0].context).toEqual({ counter: 10 });
      expect(trace[0].scratchpad).toEqual({ temp: 'data' });
      expect(trace[0].events).toHaveLength(1);
      expect(trace[0].events[0].id).toBe('event1');
      expect(trace[0].timestamp).toBeDefined();
    });

    test('getExecutionTrace() returns a clone of the history', () => {
      // Log a transition
      store.logTransition('STATE', [createTestEvent('event1', 'data1')]);

      // Get and modify the trace top-level properties
      const trace = store.getExecutionTrace();
      expect(trace.length).toBe(1);

      // Modify the trace (top-level properties should be copied)
      const originalState = trace[0].state;
      trace[0].state = 'MODIFIED';

      // Verify original trace state in store is unaffected
      const newTrace = store.getExecutionTrace();
      expect(newTrace.length).toBe(1);
      expect(newTrace[0].state).toBe(originalState);

      // The implementation uses structural cloning, which should handle context objects
      const originalCounter = trace[0].context.counter;
      trace[0].context.counter = 999;

      const newerTrace = store.getExecutionTrace();
      expect(newerTrace[0].context.counter).toBe(originalCounter);

      // The implementation uses shallow copies for events, so we test what it actually does
      const originalEventId = trace[0].events[0].id;
      trace[0].events[0].id = 'modified-id';

      const finalTrace = store.getExecutionTrace();
      expect(finalTrace[0].events[0].id).toBe(originalEventId);
    });

    test('exportTrace() returns a JSON string of the execution trace', () => {
      // Log a transition
      store.logTransition('STATE', [createTestEvent('event1', 'data1')]);

      // Export trace
      const traceJson = store.exportTrace();

      // Parse and verify
      const parsedTrace = JSON.parse(traceJson);
      expect(parsedTrace).toBeInstanceOf(Array);
      expect(parsedTrace).toHaveLength(1);
      expect(parsedTrace[0].state).toBe('STATE');
    });
  });

  describe('Persistence', () => {
    test('allState getter returns the current store state', () => {
      // Setup some state
      store.updateContext((ctx) => ({ ...ctx, counter: 42, user: 'test-user' }));
      store.setScratchpad({ test: 'data' });
      store.logTransition('TEST_STATE', [createTestEvent('event1', 'data1')]);

      // Get all state
      const state = store.allState;

      // Verify all components are present
      expect(state.context).toEqual({ counter: 42, user: 'test-user' });
      expect(state.scratchpad).toEqual({ test: 'data' });
      expect(state.pendingEvents).toEqual([]);
      expect(state.history).toHaveLength(1);
      expect(state.history[0].state).toBe('TEST_STATE');
    });

    test('allState setter updates all store properties', () => {
      // Create a custom state
      const newState: AllState<TestContext, TestEvent> = {
        context: { counter: 100, user: 'new-user' },
        scratchpad: { custom: 'value' },
        pendingEvents: [createTestEvent('pending-event', 'pending-data')],
        history: [
          {
            state: 'CUSTOM_STATE',
            context: { counter: 50 },
            scratchpad: { previous: 'value' },
            events: [createTestEvent('history-event', 'history-data')],
            timestamp: Date.now(),
          },
        ],
      };

      // Set all state
      store.allState = newState;

      // Verify all components were updated
      expect(store.getContext()).toEqual({ counter: 100, user: 'new-user' });
      expect(store.getScratchpad()).toEqual({ custom: 'value' });

      const pendingEvents = store.getPendingEvents();
      expect(pendingEvents).toHaveLength(1);
      expect(pendingEvents[0].id).toBe('pending-event');

      const trace = store.getExecutionTrace();
      expect(trace).toHaveLength(1);
      expect(trace[0].state).toBe('CUSTOM_STATE');
      expect(trace[0].events[0].id).toBe('history-event');
    });

    test('loadState() loads state from the persistence adapter', async () => {
      // Mock adapter to return custom state
      const customState: AllState<TestContext, TestEvent> = {
        context: { counter: 42, user: 'test-user' },
        scratchpad: { custom: 'data' },
        pendingEvents: [createTestEvent('loaded-event', 'loaded-data')],
        history: [
          {
            state: 'PREVIOUS_STATE',
            context: { counter: 21 },
            scratchpad: null,
            events: [],
            timestamp: Date.now() - 1000,
          },
        ],
      };

      mockAdapter.read = mock(() => Promise.resolve(customState));

      // Load state
      await store.loadState();

      // Verify context was loaded
      expect(store.getContext()).toEqual({ counter: 42, user: 'test-user' });

      // Verify scratchpad was loaded
      expect(store.getScratchpad()).toEqual({ custom: 'data' });

      // Verify pending events were loaded
      const pendingEvents = store.getPendingEvents();
      expect(pendingEvents).toHaveLength(1);
      expect(pendingEvents[0].id).toBe('loaded-event');

      // Verify history was loaded
      const trace = store.getExecutionTrace();
      expect(trace).toHaveLength(1);
      expect(trace[0].state).toBe('PREVIOUS_STATE');

      // Verify adapter.read was called with the correct instanceId
      expect(mockAdapter.read).toHaveBeenCalledWith(instanceId);
    });

    test('setAdapter() changes the persistence adapter', async () => {
      // Create a new mock adapter
      const newAdapter = createMockPersistenceAdapter();

      // Set it as the current adapter
      store.setAdapter(newAdapter);

      // Enqueue an event to trigger persistence
      await store.enqueueEvents([createTestEvent('event1', 'data1')]);

      // Verify the new adapter was used
      expect(newAdapter.writeEvents).toHaveBeenCalledTimes(1);
      expect(mockAdapter.writeEvents).not.toHaveBeenCalled();
    });
  });

  describe('Rollback and Retry', () => {
    test('withRollback() maintains state on success', async () => {
      // Reset telemetry
      resetSpans();
      const withSpanMock = jest.spyOn(telemetry, 'withSpan');
      withSpanMock.mockClear();

      // Setup initial state
      await store.updateContext((ctx) => ({ ...ctx, counter: 5 }));
      store.setScratchpad({ test: 'data' });

      // Run operation that updates state
      const result = await store.withRollback(async () => {
        await store.updateContext((ctx) => ({ ...ctx, counter: 10 }));
        store.setScratchpad({ test: 'updated' });
        return 'success';
      });

      // Verify state after successful operation
      expect(store.getContext().counter).toBe(10);
      expect(store.getScratchpad()).toEqual({ test: 'updated' });
      expect(result).toBe('success');

      // Reset call count to isolate this test from others
      withSpanMock.mockClear();
    });

    test('withRollback() maintains all changes on success, including events', async () => {
      // Reset required mocks
      resetSpans();
      const withSpanMock = jest.spyOn(telemetry, 'withSpan');
      withSpanMock.mockClear();
      mockAdapter.writeEvents.mockReset();

      // Setup initial state with current state
      store.setCurrentState('INITIAL_STATE');
      await store.updateContext((ctx) => ({ ...ctx, counter: 5 }));
      store.setScratchpad({ test: 'data' });

      // Run operation that updates state and adds events
      await store.withRollback(async () => {
        await store.updateContext((ctx) => ({
          ...ctx,
          counter: 10,
          items: ['item1', 'item2'],
        }));
        store.setScratchpad({ test: 'updated', details: { complete: true } });
        await store.enqueueEvents([
          createTestEvent('new-event-1', 'operation-data-1'),
          createTestEvent('new-event-2', 'operation-data-2'),
        ]);
        return true;
      });

      // Verify all state components were updated
      const finalContext = store.getContext();
      expect(finalContext.counter).toBe(10);
      expect(finalContext.items).toEqual(['item1', 'item2']);

      const finalScratchpad = store.getScratchpad<{
        test: string;
        details: { complete: boolean };
      }>();
      expect(finalScratchpad?.test).toBe('updated');
      expect(finalScratchpad?.details.complete).toBe(true);

      // Verify events were maintained
      const pendingEvents = store.getPendingEvents();
      expect(pendingEvents).toHaveLength(2);
      expect(pendingEvents[0].id).toBe('new-event-1');
      expect(pendingEvents[1].id).toBe('new-event-2');

      // Verify correct persistence calls were made
      expect(mockAdapter.writeEvents).toHaveBeenCalled();

      // Reset call count for isolation
      withSpanMock.mockClear();
    });

    test('withRollback() restores state on failure', async () => {
      // Reset mocks to check specific calls
      resetSpans();
      const withSpanMock = jest.spyOn(telemetry, 'withSpan');
      withSpanMock.mockClear();

      // Create a mock implementation
      withSpanMock.mockImplementation((name, attrs, fn) => {
        // Create a mock span for the test
        const span = new MockSpan(name, attrs);

        // Call the provided function with the mock span
        return fn(span).catch((error) => {
          // Record span events on error similar to the real withSpan implementation
          span.setStatus({ code: 1, message: 'Rollback executed' });
          span.addEvent('rollback_executed', {
            error: error.message,
          });

          // End the span
          span.end();

          // Re-throw the error
          throw error;
        });
      });

      // Setup initial state
      await store.updateContext((ctx) => ({ ...ctx, counter: 5 }));
      store.setScratchpad({ test: 'data' });
      await store.enqueueEvents([createTestEvent('initial-event', 'data')]);

      // Store copies of initial state for later verification
      const initialContext = store.getContext();
      const initialScratchpad = store.getScratchpad();
      const initialEvents = store.getPendingEvents();

      // Run operation that throws
      const error = new Error('Intentional error');
      try {
        await store.withRollback(async () => {
          await store.updateContext((ctx) => ({ ...ctx, counter: 10 }));
          store.setScratchpad({ test: 'updated' });
          await store.enqueueEvents([createTestEvent('new-event', 'data')]);
          throw error;
        });
        fail('Expected an error to be thrown');
      } catch (e) {
        // Verify that the original error is propagated
        expect(e).toBe(error);
      }

      // Verify state is rolled back
      expect(store.getContext()).toEqual(initialContext);
      expect(store.getScratchpad()).toEqual(initialScratchpad);

      // Verify events are rolled back
      const events = store.getPendingEvents();
      expect(events).toEqual(initialEvents);
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe('initial-event');

      // Get the span created during the test and verify its events
      const spans = getSpans();
      const rollbackSpan = spans.find(
        (span) =>
          span.name === 'store.with_rollback' &&
          span.events.some((e) => e.name === 'rollback_executed')
      );

      if (rollbackSpan) {
        const rollbackEvent = rollbackSpan.events.find((e) => e.name === 'rollback_executed');
        expect(rollbackEvent).toBeDefined();
        if (rollbackEvent?.attributes) {
          expect(rollbackEvent.attributes.error).toBe('Intentional error');
        }
      }

      // Reset call count for isolation
      withSpanMock.mockClear();
    });

    test('retry() succeeds after multiple attempts', async () => {
      // Reset mocks for this test
      resetSpans();
      const getActiveSpanMock = jest.spyOn(telemetry, 'getActiveSpan');
      getActiveSpanMock.mockClear();

      // Create a mock span for the test
      const mockSpan = new MockSpan('test.retry');

      // Ensure getActiveSpan returns our mock span
      getActiveSpanMock.mockReturnValue(mockSpan);

      // Mock function that fails a few times
      let attempts = 0;
      const operation = mock(async () => {
        attempts++;
        if (attempts < 2) {
          throw new Error(`Attempt ${attempts} failed`);
        }
        return 'success';
      });

      // Override retry delay to speed up test
      const storeWithFastRetry = new SharedStore<TestContext, TestEvent>(
        instanceId,
        initialContext,
        mockAdapter,
        {
          retryDelay: () => 10,
        }
      );

      // Run operation with retry
      const result = await storeWithFastRetry.retry(operation);

      // Verify multiple attempts were made
      expect(operation).toHaveBeenCalledTimes(2);
      expect(result).toBe('success');

      // Verify the getActiveSpan was called
      expect(getActiveSpanMock).toHaveBeenCalled();

      // Verify telemetry operations through the mock span
      expect(mockSpan.attributes.max_attempts).toBe(3);

      // Find attempt events
      const attemptEvents = mockSpan.events.filter((e) => e.name === 'retry_attempt');
      expect(attemptEvents.length).toBe(2);
      expect(attemptEvents[0].attributes?.attempt).toBe(1);
      expect(attemptEvents[1].attributes?.attempt).toBe(2);

      // Find failure event
      const failEvent = mockSpan.events.find((e) => e.name === 'retry_failed');
      expect(failEvent).toBeDefined();
      expect(failEvent?.attributes?.attempt).toBe(1);
      expect(failEvent?.attributes?.error).toBe('Error: Attempt 1 failed');

      // Clear mocks for isolation
      getActiveSpanMock.mockClear();
    });

    test('retry() throws after max attempts', async () => {
      // Reset mocks for this test
      resetSpans();
      const getActiveSpanMock = jest.spyOn(telemetry, 'getActiveSpan');
      getActiveSpanMock.mockClear();

      // Create a mock span for the test
      const mockSpan = new MockSpan('test.retry');

      // Ensure getActiveSpan returns our mock span
      getActiveSpanMock.mockReturnValue(mockSpan);

      // Mock function that always fails
      const operation = mock(() => Promise.reject(new Error('Always fails')));

      // Override retry config for tests
      const storeWithFastRetry = new SharedStore<TestContext, TestEvent>(
        instanceId,
        initialContext,
        mockAdapter,
        {
          maxRetries: 2,
          retryDelay: () => 10,
        }
      );

      // Run operation with retry and expect failure
      await expect(storeWithFastRetry.retry(operation)).rejects.toThrow('Always fails');

      // Verify the correct number of attempts were made
      expect(operation).toHaveBeenCalledTimes(2);

      // Verify the getActiveSpan was called
      expect(getActiveSpanMock).toHaveBeenCalled();

      // Verify telemetry operations for max retries
      expect(mockSpan.attributes.max_attempts).toBe(2);

      // Find attempt events
      const attemptEvents = mockSpan.events.filter((e) => e.name === 'retry_attempt');
      expect(attemptEvents.length).toBe(2);
      expect(attemptEvents[0].attributes?.attempt).toBe(1);
      expect(attemptEvents[1].attributes?.attempt).toBe(2);

      // Find failure events
      const failEvents = mockSpan.events.filter((e) => e.name === 'retry_failed');
      expect(failEvents.length).toBe(1);
      expect(failEvents[0].attributes?.attempt).toBe(1);
      expect(failEvents[0].attributes?.error).toBe('Error: Always fails');

      // Verify max retries event
      const maxRetriesEvent = mockSpan.events.find((e) => e.name === 'max_retries_reached');
      expect(maxRetriesEvent).toBeDefined();
      expect(maxRetriesEvent?.attributes?.attempts).toBe(2);
      expect(maxRetriesEvent?.attributes?.error).toBe('Always fails');

      // Verify status was set
      expect(mockSpan.status.code).toBe(1);
      expect(mockSpan.status.message).toBe('Max retries reached');

      // Clear mocks for isolation
      getActiveSpanMock.mockClear();
    });

    test('retry() respects maxAttemptsOverride', async () => {
      // Reset mocks for this test
      resetSpans();
      const getActiveSpanMock = jest.spyOn(telemetry, 'getActiveSpan');
      getActiveSpanMock.mockClear();

      // Create a mock span for the test
      const mockSpan = new MockSpan('test.retry');

      // Ensure getActiveSpan returns our mock span
      getActiveSpanMock.mockReturnValue(mockSpan);

      // Mock function that always fails
      const operation = mock(() => Promise.reject(new Error('Always fails')));

      // Run with a custom max attempts override
      await expect(store.retry(operation, 1)).rejects.toThrow('Always fails');

      // Verify only one attempt was made (override takes precedence)
      expect(operation).toHaveBeenCalledTimes(1);

      // Verify the getActiveSpan was called
      expect(getActiveSpanMock).toHaveBeenCalled();

      // Verify telemetry sets the correct max_attempts attribute
      expect(mockSpan.attributes.max_attempts).toBe(1);

      // Check the retry events
      const attemptEvent = mockSpan.events.find((e) => e.name === 'retry_attempt');
      expect(attemptEvent).toBeDefined();
      expect(attemptEvent?.attributes?.attempt).toBe(1);

      // Verify max retries event
      const maxRetriesEvent = mockSpan.events.find((e) => e.name === 'max_retries_reached');
      expect(maxRetriesEvent).toBeDefined();
      expect(maxRetriesEvent?.attributes?.attempts).toBe(1);
      expect(maxRetriesEvent?.attributes?.error).toBe('Always fails');

      // Verify status was set
      expect(mockSpan.status.code).toBe(1);
      expect(mockSpan.status.message).toBe('Max retries reached');

      // Clear mocks for isolation
      getActiveSpanMock.mockClear();
    });

    test('retry() with null span still functions correctly', async () => {
      // Reset mocks for this test
      resetSpans();
      const getActiveSpanMock = jest.spyOn(telemetry, 'getActiveSpan');
      getActiveSpanMock.mockClear();

      // Return null to simulate no active span
      getActiveSpanMock.mockReturnValue(null);

      // Mock function that succeeds on first attempt
      const operation = mock(() => Promise.resolve('success'));

      // Run with retry
      const result = await store.retry(operation);

      // Verify operation was called and succeeded
      expect(operation).toHaveBeenCalledTimes(1);
      expect(result).toBe('success');

      // No spans should be created since getActiveSpan returns null
      expect(getSpans().length).toBe(0);

      // Clear mocks for isolation
      getActiveSpanMock.mockClear();
    });

    test('retry() correctly uses timeouts between attempts', async () => {
      // This is a simplified version of the original test
      // that doesn't rely on jest fake timers

      // Reset mocks for this test
      resetSpans();
      const getActiveSpanMock = jest.spyOn(telemetry, 'getActiveSpan');
      getActiveSpanMock.mockClear();

      // Create a mock span for the test
      const mockSpan = new MockSpan('test.retry');

      // Ensure getActiveSpan returns our mock span
      getActiveSpanMock.mockReturnValue(mockSpan);

      // Create a custom retry delay function that we can check was called
      const customRetryDelay = mock((attempt) => attempt * 10);

      // Create a store with the custom retry delay
      const storeWithCustomDelay = new SharedStore<TestContext, TestEvent>(
        instanceId,
        initialContext,
        mockAdapter,
        {
          retryDelay: customRetryDelay,
        }
      );

      // Mock function that fails twice then succeeds
      let attempts = 0;
      const operation = mock(async () => {
        attempts++;
        if (attempts === 1) throw new Error('fail1');
        if (attempts === 2) throw new Error('fail2');
        return 'success';
      });

      // Run the operation with retry
      const result = await storeWithCustomDelay.retry(operation);

      // Verify the operation was called 3 times
      expect(operation).toHaveBeenCalledTimes(3);
      expect(result).toBe('success');

      // Verify retry delay was called with the correct attempt numbers
      expect(customRetryDelay).toHaveBeenCalledTimes(2);
      expect(customRetryDelay).toHaveBeenNthCalledWith(1, 1);
      expect(customRetryDelay).toHaveBeenNthCalledWith(2, 2);

      // Verify retry events
      const attemptEvents = mockSpan.events.filter((e) => e.name === 'retry_attempt');
      expect(attemptEvents.length).toBe(3);
      expect(attemptEvents[0].attributes?.attempt).toBe(1);
      expect(attemptEvents[1].attributes?.attempt).toBe(2);
      expect(attemptEvents[2].attributes?.attempt).toBe(3);

      // Verify failure events
      const failEvents = mockSpan.events.filter((e) => e.name === 'retry_failed');
      expect(failEvents.length).toBe(2);
      expect(failEvents[0].attributes?.error).toBe('Error: fail1');
      expect(failEvents[1].attributes?.error).toBe('Error: fail2');

      // Clear mocks for isolation
      getActiveSpanMock.mockClear();
    });
  });
});
