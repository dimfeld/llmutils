import { describe, test, expect, beforeEach, mock, afterEach } from 'bun:test';
import { SharedStore, type PersistenceAdapter, type AllState } from './store';
import { trace, context } from '@opentelemetry/api';
import type { BaseEvent } from './events';

// Define test types
interface TestContext {
  count: number;
  name: string;
  items: string[];
}

interface TestEvent extends BaseEvent {
  id: string;
  type: string;
  payload: any;
}

// Create a mock persistence adapter for testing
class MockPersistenceAdapter implements PersistenceAdapter<TestContext, TestEvent> {
  private storage: Map<string, AllState<TestContext, TestEvent>> = new Map();
  private eventLog: Map<string, TestEvent[]> = new Map();
  
  public writeCallCount = 0;
  public writeEventsCallCount = 0;
  public readCallCount = 0;

  async write(instanceId: string, state: AllState<TestContext, TestEvent>): Promise<void> {
    this.writeCallCount++;
    this.storage.set(instanceId, structuredClone(state));
  }

  async writeEvents(instanceId: string, events: TestEvent[]): Promise<void> {
    this.writeEventsCallCount++;
    const storedEvents = this.eventLog.get(instanceId) || [];
    this.eventLog.set(instanceId, [...storedEvents, ...structuredClone(events)]);
  }

  async read(instanceId: string): Promise<AllState<TestContext, TestEvent>> {
    this.readCallCount++;
    const state = this.storage.get(instanceId);
    if (!state) {
      throw new Error(`No state found for instance ${instanceId}`);
    }
    return structuredClone(state);
  }

  reset(): void {
    this.storage.clear();
    this.eventLog.clear();
    this.writeCallCount = 0;
    this.writeEventsCallCount = 0;
    this.readCallCount = 0;
  }
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

describe('SharedStore', () => {
  let store: SharedStore<TestContext, TestEvent>;
  let adapter: MockPersistenceAdapter;
  const instanceId = 'test-instance-1';
  const initialContext: TestContext = { count: 0, name: 'test', items: [] };
  let mockSpan: MockSpan;

  // Setup mocks for OpenTelemetry
  const originalGetActiveSpan = trace.getActiveSpan;

  beforeEach(() => {
    adapter = new MockPersistenceAdapter();
    store = new SharedStore<TestContext, TestEvent>(
      instanceId, 
      initialContext, 
      adapter, 
      { 
        maxRetries: 0, 
        retryDelay: () => 0 
      }
    );
    
    mockSpan = new MockSpan();
    trace.getActiveSpan = mock(() => mockSpan as any);
  });

  afterEach(() => {
    trace.getActiveSpan = originalGetActiveSpan;
  });

  describe('Context Management', () => {
    test('getContext() returns an immutable copy of context', () => {
      const context = store.getContext();
      expect(context).toEqual(initialContext);
      
      // Modify the returned context - should not affect the store
      context.count++;
      context.name = 'modified';
      context.items.push('new-item');
      
      // Original context in store should remain unchanged
      const newContext = store.getContext();
      expect(newContext).toEqual(initialContext);
    });

    test('updateContext() correctly updates context', async () => {
      await store.updateContext(ctx => ({
        ...ctx,
        count: ctx.count + 1,
        items: [...ctx.items, 'item-1']
      }));

      const updatedContext = store.getContext();
      expect(updatedContext.count).toBe(1);
      expect(updatedContext.items).toContain('item-1');
      expect(updatedContext.name).toBe('test');
    });
  });

  describe('Scratchpad Management', () => {
    test('setScratchpad() and getScratchpad() work correctly', () => {
      const scratchpad = { temp: 'data', values: [1, 2, 3] };
      store.setScratchpad(scratchpad);
      
      const retrievedScratchpad = store.getScratchpad();
      expect(retrievedScratchpad).toEqual(scratchpad);
      
      // Modify the returned scratchpad - should not affect the stored one
      if (retrievedScratchpad) {
        retrievedScratchpad.temp = 'modified';
        (retrievedScratchpad as any).values.push(4);
      }
      
      // Original scratchpad in store should remain unchanged
      const newScratchpad = store.getScratchpad();
      expect(newScratchpad).toEqual(scratchpad);
    });

    test('clearScratchpad() removes scratchpad data', () => {
      store.setScratchpad({ temp: 'data' });
      expect(store.getScratchpad()).not.toBeUndefined();
      
      store.clearScratchpad();
      expect(store.getScratchpad()).toBeUndefined();
    });

    test('updateScratchpad() correctly updates scratchpad', () => {
      const initial = { counter: 0, items: ['a'] };
      store.setScratchpad(initial);
      
      store.updateScratchpad<typeof initial>(scratch => ({
        ...scratch,
        counter: scratch.counter + 1,
        items: [...scratch.items, 'b']
      }));
      
      const updated = store.getScratchpad<typeof initial>();
      expect(updated?.counter).toBe(1);
      expect(updated?.items).toEqual(['a', 'b']);
    });
  });

  describe('Event Management', () => {
    test('enqueueEvents() adds events to the pending list', async () => {
      const events: TestEvent[] = [
        { id: 'e1', type: 'TEST', payload: { value: 1 } },
        { id: 'e2', type: 'TEST', payload: { value: 2 } }
      ];
      
      await store.enqueueEvents(events);
      
      const pendingEvents = store.getPendingEvents();
      expect(pendingEvents.length).toBe(2);
      expect(pendingEvents[0].id).toBe('e1');
      expect(pendingEvents[1].id).toBe('e2');
      
      // Check telemetry events were recorded
      expect(mockSpan.events.length).toBe(2);
      expect(mockSpan.events[0].name).toBe('event_processed');
      expect(mockSpan.events[1].name).toBe('event_processed');
    });

    test('getPendingEvents() returns an immutable copy', async () => {
      const events: TestEvent[] = [
        { id: 'e1', type: 'TEST', payload: { value: 1 } }
      ];
      
      await store.enqueueEvents(events);
      
      const pendingEvents = store.getPendingEvents();
      // Modify the returned events
      pendingEvents[0].payload.value = 999;
      
      // Original events in store should remain unchanged
      const newPendingEvents = store.getPendingEvents();
      expect(newPendingEvents[0].payload.value).toBe(1);
    });

    test('processEvents() correctly processes and removes events', async () => {
      const events: TestEvent[] = [
        { id: 'e1', type: 'TEST', payload: { value: 1 } },
        { id: 'e2', type: 'TEST', payload: { value: 2 } },
        { id: 'e3', type: 'TEST', payload: { value: 3 } }
      ];
      
      await store.enqueueEvents(events);
      
      // Process specific events
      const processed = store.processEvents(['e1', 'e3']);
      
      // Check the processed events
      expect(processed.length).toBe(2);
      expect(processed[0].id).toBe('e1');
      expect(processed[1].id).toBe('e3');
      
      // Check remaining events
      const remaining = store.getPendingEvents();
      expect(remaining.length).toBe(1);
      expect(remaining[0].id).toBe('e2');
    });

    test('processEvents() throws error for invalid IDs', async () => {
      const events: TestEvent[] = [
        { id: 'e1', type: 'TEST', payload: { value: 1 } }
      ];
      
      await store.enqueueEvents(events);
      
      // Try to process non-existent event
      expect(() => {
        store.processEvents(['e1', 'non-existent']);
      }).toThrow('Invalid event IDs: non-existent');
    });

    test('dequeueEvent() returns and removes the oldest event', async () => {
      const events: TestEvent[] = [
        { id: 'e1', type: 'TEST', payload: { value: 1 } },
        { id: 'e2', type: 'TEST', payload: { value: 2 } }
      ];
      
      await store.enqueueEvents(events);
      
      // Dequeue first event
      const event1 = await store.dequeueEvent();
      expect(event1?.id).toBe('e1');
      
      // Dequeue second event
      const event2 = await store.dequeueEvent();
      expect(event2?.id).toBe('e2');
      
      // No more events
      const event3 = await store.dequeueEvent();
      expect(event3).toBeUndefined();
    });
  });

  describe('State Management', () => {
    test('getCurrentState() and setCurrentState() work correctly', () => {
      // Initial state should be undefined
      expect(store.getCurrentState()).toBeUndefined();
      
      // Set state
      store.setCurrentState('test-state');
      expect(store.getCurrentState()).toBe('test-state');
      
      // Change state
      store.setCurrentState('another-state');
      expect(store.getCurrentState()).toBe('another-state');
    });

    test('logTransition() records state transitions correctly', () => {
      const events: TestEvent[] = [
        { id: 'e1', type: 'TRIGGER', payload: { value: 1 } }
      ];
      
      store.logTransition('state-a', events);
      
      // Update context and log another transition
      store.updateContext(ctx => ({ ...ctx, count: ctx.count + 1 }));
      store.setScratchpad({ tempValue: 42 });
      store.logTransition('state-b', []);
      
      // Get execution trace
      const trace = store.getExecutionTrace();
      expect(trace.length).toBe(2);
      
      // First transition
      expect(trace[0].state).toBe('state-a');
      expect(trace[0].events[0].id).toBe('e1');
      expect(trace[0].context.count).toBe(0);
      
      // Second transition
      expect(trace[1].state).toBe('state-b');
      expect(trace[1].events.length).toBe(0);
      expect(trace[1].context.count).toBe(1);
      expect(trace[1].scratchpad).toEqual({ tempValue: 42 });
    });

    test('exportTrace() returns trace as JSON string', () => {
      store.logTransition('state-a', []);
      store.logTransition('state-b', []);
      
      const traceJson = store.exportTrace();
      expect(typeof traceJson).toBe('string');
      
      const parsedTrace = JSON.parse(traceJson);
      expect(parsedTrace.length).toBe(2);
      expect(parsedTrace[0].state).toBe('state-a');
      expect(parsedTrace[1].state).toBe('state-b');
    });
  });

  describe('Rollback and Retry', () => {
    test('withRollback() commits changes on success', async () => {
      const result = await store.withRollback(async () => {
        await store.updateContext(ctx => ({ ...ctx, count: 10 }));
        return 'success';
      });
      
      expect(result).toBe('success');
      expect(store.getContext().count).toBe(10);
      
      // Check span events
      expect(mockSpan.events.some(e => e.name === 'rollback_executed')).toBe(false);
    });

    test('withRollback() rolls back changes on error', async () => {
      try {
        await store.withRollback(async () => {
          await store.updateContext(ctx => ({ ...ctx, count: 10 }));
          store.setScratchpad({ temp: 'value' });
          await store.enqueueEvents([{ id: 'e1', type: 'TEST', payload: {} }]);
          throw new Error('Test error');
        });
        expect(true).toBe(false); // Should not reach here
      } catch (e) {
        expect((e as Error).message).toBe('Test error');
        
        // Context should be rolled back
        expect(store.getContext().count).toBe(0);
        expect(store.getScratchpad()).toBeUndefined();
        expect(store.getPendingEvents().length).toBe(0);
        
        // Check span events
        expect(mockSpan.events.some(e => e.name === 'rollback_executed')).toBe(true);
      }
    });

    test('retry() succeeds after intermittent failures', async () => {
      // Create a store with retry values for this specific test
      const retryStore = new SharedStore<TestContext, TestEvent>(
        instanceId + '-retry', 
        initialContext, 
        adapter, 
        {
          maxRetries: 3,
          retryDelay: () => 0 // Use 0 delay for faster tests
        }
      );
      
      let attempts = 0;
      
      const result = await retryStore.retry(async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error(`Attempt ${attempts} failed`);
        }
        return 'success';
      });
      
      expect(result).toBe('success');
      expect(attempts).toBe(3);
      
      // Check span events
      const retryAttempts = mockSpan.events.filter(e => e.name === 'retry_attempt');
      expect(retryAttempts.length).toBe(3);
      
      const retryFailed = mockSpan.events.filter(e => e.name === 'retry_failed');
      expect(retryFailed.length).toBe(2);
      
      // Success doesn't record any special event
      expect(mockSpan.events.some(e => e.name === 'max_retries_reached')).toBe(false);
    });

    test('retry() fails after max attempts', async () => {
      // Create a store with retry values for this specific test
      const retryStore = new SharedStore<TestContext, TestEvent>(
        instanceId + '-retry-fail',
        initialContext, 
        adapter, 
        {
          maxRetries: 2,
          retryDelay: () => 0 // Use 0 delay for faster tests
        }
      );
      
      try {
        await retryStore.retry(async () => {
          throw new Error('Always fails');
        });
        expect(true).toBe(false); // Should not reach here
      } catch (e) {
        expect((e as Error).message).toBe('Always fails');
        
        // Check span events
        const retryAttempts = mockSpan.events.filter(e => e.name === 'retry_attempt');
        expect(retryAttempts.length).toBe(2);
        
        const retryFailed = mockSpan.events.filter(e => e.name === 'retry_failed');
        expect(retryFailed.length).toBe(1);
        
        expect(mockSpan.events.some(e => e.name === 'max_retries_reached')).toBe(true);
      }
    });
  });

  describe('Persistence', () => {
    test('loadState() loads state from adapter', async () => {
      // Set up initial state in adapter
      const customState: AllState<TestContext, TestEvent> = {
        context: { count: 42, name: 'loaded', items: ['item1'] },
        scratchpad: { temp: 'loaded-data' },
        pendingEvents: [{ id: 'e1', type: 'LOADED', payload: {} }],
        history: [{
          state: 'previous-state',
          context: { count: 10, name: 'previous', items: [] },
          scratchpad: null,
          events: [],
          timestamp: Date.now()
        }]
      };
      
      await adapter.write(instanceId, customState);
      adapter.readCallCount = 0; // Reset counter
      
      // Load state
      await store.loadState();
      
      // Check that adapter was called
      expect(adapter.readCallCount).toBe(1);
      
      // Verify loaded state
      expect(store.getContext()).toEqual(customState.context);
      expect(store.getScratchpad()).toEqual(customState.scratchpad);
      expect(store.getPendingEvents()).toEqual(customState.pendingEvents);
      
      const trace = store.getExecutionTrace();
      expect(trace).toEqual(customState.history);
    });

    test('allState getter/setter works correctly', () => {
      // Create custom state
      const customState: AllState<TestContext, TestEvent> = {
        context: { count: 99, name: 'custom', items: ['a', 'b'] },
        scratchpad: { value: 'test' },
        pendingEvents: [{ id: 'custom1', type: 'CUSTOM', payload: {} }],
        history: [{
          state: 'custom-state',
          context: { count: 50, name: 'history', items: [] },
          scratchpad: { old: 'data' },
          events: [{ id: 'h1', type: 'HISTORY', payload: {} }],
          timestamp: 123456789
        }]
      };
      
      // Set state
      store.allState = customState;
      
      // Get state
      const retrievedState = store.allState;
      
      // Verify state
      expect(retrievedState).toEqual(customState);
      
      // Check that internal state was updated
      expect(store.getContext()).toEqual(customState.context);
      expect(store.getScratchpad()).toEqual(customState.scratchpad);
      expect(store.getPendingEvents()).toEqual(customState.pendingEvents);
      expect(store.getExecutionTrace()).toEqual(customState.history);
    });
  });
});