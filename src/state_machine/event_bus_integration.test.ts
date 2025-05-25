import { describe, expect, test, beforeEach, jest } from 'bun:test';
import { StateMachine, globalEventBus } from './index.ts';
import { Node, FlowNode, FinalNode, type SubMachineConfig } from './nodes.ts';
import type { BaseEvent, PrepResult, StateResult, SharedStore } from './index.ts';

interface TestEvent extends BaseEvent {
  type: 'START' | 'PROCESS' | 'RESULT' | 'SYSTEM_EVENT';
  payload?: any;
}

type TestStates = 'initial' | 'processing' | 'done';

describe('EventBus Integration with StateMachine', () => {
  beforeEach(() => {
    globalEventBus.clear();
  });

  test('should register machine with event bus on initialize', async () => {
    const config = {
      initialState: 'initial' as TestStates,
      errorState: 'initial' as TestStates,
      nodes: [
        new FinalNode<TestStates, {}, TestEvent>('done'),
      ],
    };

    const machine = new StateMachine(
      config,
      {
        write: async () => {},
        writeEvents: async () => {},
        read: async () => ({ context: {}, scratchpad: undefined, pendingEvents: [], history: [] }),
      },
      {},
      'test-machine-1'
    );

    await machine.initialize();

    // Verify machine can receive events through event bus
    const eventReceived = jest.fn();
    const originalHandleEvent = machine['handleEvent'].bind(machine);
    machine['handleEvent'] = jest.fn(async (event) => {
      eventReceived(event);
      return originalHandleEvent(event);
    });

    await globalEventBus.emit({
      id: '1',
      type: 'START',
      targetMachineId: 'test-machine-1',
    });

    // The event should be handled by the machine
    expect(eventReceived).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '1',
        type: 'START',
        targetMachineId: 'test-machine-1',
      })
    );

    // Clean up
    await machine.destroy();
  });

  test('should emit system events on state changes', async () => {
    class TestNode extends Node<TestStates, {}, TestEvent> {
      constructor(id: TestStates) {
        super(id);
      }

      async prep(store: SharedStore<{}, TestEvent>): Promise<PrepResult<TestEvent, null>> {
        return { events: [], args: null };
      }

      async exec(
        args: null,
        events: TestEvent[],
        scratchpad: any
      ): Promise<{ result: null; scratchpad: any }> {
        return { result: null, scratchpad };
      }

      async post(
        result: null,
        store: SharedStore<{}, TestEvent>
      ): Promise<StateResult<TestStates, TestEvent>> {
        if (this.id === 'initial') {
          return { status: 'transition', to: 'processing' };
        } else if (this.id === 'processing') {
          return { status: 'waiting' };
        }
        return { status: 'terminal' };
      }
    }

    const systemEvents: any[] = [];
    
    // First create a parent machine to receive events
    const parentHandler = jest.fn(async (event) => {
      if (event.type.startsWith('MACHINE_')) {
        systemEvents.push(event);
      }
    });
    
    globalEventBus.registerMachine('parent', parentHandler);

    const machine = new StateMachine(
      {
        initialState: 'initial',
        errorState: 'initial',
        nodes: [
          new TestNode('initial'),
          new TestNode('processing'),
          new FinalNode('done'),
        ],
      },
      {
        write: async () => {},
        writeEvents: async () => {},
        read: async () => ({ context: {}, scratchpad: undefined, pendingEvents: [], history: [] }),
      },
      {},
      'child',
      undefined, // hooks
      'parent' // Set parent machine ID
    );

    await machine.initialize();
    await machine.resume([]);

    // Should have emitted state change and waiting events
    expect(systemEvents).toContainEqual(
      expect.objectContaining({
        type: 'MACHINE_STATE_CHANGED',
        payload: expect.objectContaining({
          machineId: 'child',
          state: 'processing',
        }),
      })
    );

    expect(systemEvents).toContainEqual(
      expect.objectContaining({
        type: 'MACHINE_WAITING',
        payload: expect.objectContaining({
          machineId: 'child',
        }),
      })
    );

    await machine.destroy();
  });

  test('should properly clean up on destroy', async () => {
    const machine = new StateMachine(
      {
        initialState: 'initial' as TestStates,
        errorState: 'initial' as TestStates,
        nodes: [new FinalNode<TestStates, {}, TestEvent>('done')],
      },
      {
        write: async () => {},
        writeEvents: async () => {},
        read: async () => ({ context: {}, scratchpad: undefined, pendingEvents: [], history: [] }),
      },
      {},
      'cleanup-test'
    );

    await machine.initialize();
    
    const handler = jest.fn();
    globalEventBus.registerMachine('test-handler', handler);

    await machine.destroy();

    // Machine should not receive events after destroy
    await globalEventBus.emit({
      id: '1',
      type: 'START',
      targetMachineId: 'cleanup-test',
    });

    // Handler should not have been called for the destroyed machine
    expect(handler).not.toHaveBeenCalled();
  });

  test('nested machines should communicate through event bus', async () => {
    interface WorkerEvent extends BaseEvent {
      type: 'WORK_START' | 'WORK_COMPLETE' | 'PARENT_EVENT';
      payload?: any;
    }

    type WorkerStates = 'idle' | 'working' | 'done';
    type ParentStates = 'parent_start' | 'parent_flow' | 'parent_end';

    class WorkerNode extends Node<WorkerStates, {}, WorkerEvent> {
      constructor(id: WorkerStates) {
        super(id);
      }

      async prep(store: SharedStore<{}, WorkerEvent>): Promise<PrepResult<WorkerEvent, null>> {
        return { events: store.pendingEvents, args: null };
      }

      async exec(
        args: null,
        events: WorkerEvent[],
        scratchpad: any
      ): Promise<{ result: null; scratchpad: any }> {
        return { result: null, scratchpad };
      }

      async post(
        result: null,
        store: SharedStore<{}, WorkerEvent>
      ): Promise<StateResult<WorkerStates, WorkerEvent>> {
        if (this.id === 'idle' && store.pendingEvents.some(e => e.type === 'WORK_START')) {
          return { status: 'transition', to: 'working' };
        }
        if (this.id === 'working') {
          return { 
            status: 'transition', 
            to: 'done',
            actions: [{
              id: crypto.randomUUID(),
              type: 'WORK_COMPLETE',
              payload: 'Work finished',
            }],
          };
        }
        return { status: 'terminal' };
      }
    }

    class ParentFlowNode extends FlowNode<ParentStates, {}, WorkerEvent, WorkerEvent, null> {
      constructor() {
        const workerConfig: SubMachineConfig<WorkerStates, {}, WorkerEvent> = {
          id: 'worker',
          config: {
            initialState: 'idle',
            errorState: 'idle',
            nodes: [
              new WorkerNode('idle'),
              new WorkerNode('working'),
              new FinalNode('done'),
            ],
          },
          initialContext: {},
        };
        
        super('parent_flow', workerConfig);
      }

      async prep(store: SharedStore<{}, WorkerEvent>): Promise<PrepResult<WorkerEvent, null>> {
        return { events: [], args: null };
      }

      async post(
        result: StateResult<any, WorkerEvent>,
        store: SharedStore<{}, WorkerEvent>
      ): Promise<StateResult<ParentStates, WorkerEvent>> {
        if (result.status === 'terminal') {
          return { status: 'transition', to: 'parent_end', actions: result.actions };
        }
        return result as StateResult<ParentStates, WorkerEvent>;
      }

      translateEvents(events: WorkerEvent[], machineId: string): WorkerEvent[] {
        return events;
      }

      translateActions(actions: WorkerEvent[], machineId: string): WorkerEvent[] {
        return actions;
      }
    }

    const parentEvents: any[] = [];
    
    const parentMachine = new StateMachine(
      {
        initialState: 'parent_start',
        errorState: 'parent_start',
        nodes: [
          new class extends Node<ParentStates, {}, WorkerEvent> {
            constructor() {
              super('parent_start');
            }
            async prep(store: SharedStore<{}, WorkerEvent>) {
              return { events: [], args: null };
            }
            async exec() {
              return { result: null, scratchpad: undefined };
            }
            async post() {
              return { 
                status: 'transition' as const, 
                to: 'parent_flow' as ParentStates,
                actions: [{
                  id: crypto.randomUUID(),
                  type: 'WORK_START' as const,
                  payload: 'Start work',
                }],
              };
            }
          }(),
          new ParentFlowNode(),
          new FinalNode('parent_end'),
        ],
      },
      {
        write: async () => {},
        writeEvents: async () => {},
        read: async () => ({ context: {}, scratchpad: undefined, pendingEvents: [], history: [] }),
      },
      {},
      'parent-machine'
    );

    // Register a handler to receive events from child machines
    const parentEventsHandler = jest.fn(async (event) => {
      parentEvents.push(event);
    });
    
    globalEventBus.registerMachine('parent-machine', parentEventsHandler);

    await parentMachine.initialize();
    const result = await parentMachine.resume([]);

    // Parent should reach terminal state
    expect(result.status).toBe('terminal');
    
    // Should have received system events from child machine
    expect(parentEvents).toContainEqual(
      expect.objectContaining({
        type: 'MACHINE_STATE_CHANGED',
      })
    );

    await parentMachine.destroy();
  });
});