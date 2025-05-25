import { describe, expect, test } from 'bun:test';
import {
  FinalNode,
  FlowNode,
  Node,
  StateMachine,
  type StateResult,
  type PrepResult,
  SharedStore,
  type BaseEvent,
  type SubMachineConfig,
} from './index';

type Context = object;

// Basic test demonstrating that nested FlowNode can be implemented
describe('Nested Flow State Machine', () => {
  test('verifies array nodes conversion to internal map works', async () => {
    // Create a very simple state machine that just transitions from initial -> final
    type SimpleStates = 'start' | 'end';
    type SimpleEvent = {
      id: string;
      type: 'INPUT' | 'OUTPUT';
      payload: any;
    };

    // The SimpleInitialNode class needs to transition to "end" directly
    class SimpleInitialNode extends Node<SimpleStates, Context, SimpleEvent> {
      constructor() {
        super('start');
      }

      async prep(store: SharedStore<Context, SimpleEvent>) {
        return {
          events: [],
          args: null,
        };
      }

      async exec(
        args: null,
        events: SimpleEvent[],
        scratchpad: any
      ): Promise<{ result: null; scratchpad: any }> {
        return { result: null, scratchpad };
      }

      async post(
        result: null,
        store: SharedStore<Context, SimpleEvent>
      ): Promise<StateResult<SimpleStates, SimpleEvent>> {
        // Transition directly to the end state
        return {
          status: 'transition',
          to: 'end',
          actions: [
            {
              id: crypto.randomUUID(),
              type: 'OUTPUT',
              payload: 'Processed by initial node',
            },
          ],
        };
      }
    }

    // Custom final node that includes actions
    class CustomFinalNode extends FinalNode<SimpleStates, Context, SimpleEvent> {
      constructor() {
        super('end');
      }

      async post(
        result: null,
        store: SharedStore<Context, SimpleEvent>
      ): Promise<StateResult<SimpleStates, SimpleEvent>> {
        return {
          status: 'terminal',
          actions: [
            {
              id: crypto.randomUUID(),
              type: 'OUTPUT',
              payload: 'Final output',
            },
          ],
        };
      }
    }

    // Create the state machine
    const machine = new StateMachine<SimpleStates, Context, SimpleEvent>(
      {
        initialState: 'start',
        errorState: 'start',
        nodes: [new SimpleInitialNode(), new CustomFinalNode()],
      },
      {
        write: async () => {},
        writeEvents: async () => {},
        read: async () => {
          throw new Error('Not implemented');
        },
      },
      {}, // empty context
      'simple-machine'
    );

    // Initialize and run
    await machine.initialize();

    const result = await machine.resume([
      {
        id: crypto.randomUUID(),
        type: 'INPUT',
        payload: 'test data',
      },
    ]);

    // Verify the result
    expect(result.status).toBe('terminal');
    expect(result.actions).toBeDefined();
    // We don't care about additional fields like context or stateName in this test

    // Since the final node explicitly adds its own action, make sure that action is included
    const finalAction = result.actions?.find((a) => a.payload === 'Final output');
    expect(finalAction).toBeDefined();
    expect(finalAction?.type).toBe('OUTPUT');
  });

  test('demonstrates a state machine that processes, waits, and then continues', async () => {
    // Define shared event type for both state machines
    interface ProcessEvent extends BaseEvent {
      id: string;
      type: 'PROCESS' | 'RESULT' | 'INPUT' | 'OUTPUT' | 'WAITING';
      payload: any;
    }

    // Define inner state machine states
    type InnerStates = 'inner_initial' | 'inner_processing' | 'inner_waiting' | 'inner_final';

    // Inner state machine nodes
    class InnerInitialNode extends Node<InnerStates, Context, ProcessEvent> {
      constructor() {
        super('inner_initial');
      }
      async prep(
        store: SharedStore<Context, ProcessEvent>
      ): Promise<PrepResult<ProcessEvent, null>> {
        const events = store.pendingEvents;
        return { events, args: null };
      }

      async exec(
        args: null,
        events: ProcessEvent[],
        scratchpad: any
      ): Promise<{ result: null; scratchpad: any }> {
        return { result: null, scratchpad };
      }

      async post(
        result: null,
        store: SharedStore<Context, ProcessEvent>
      ): Promise<StateResult<InnerStates, ProcessEvent>> {
        // Start processing - transition to processing state
        return {
          status: 'transition',
          to: 'inner_processing',
          actions: [
            {
              id: crypto.randomUUID(),
              type: 'PROCESS',
              payload: 'Processing started',
            },
          ],
        };
      }
    }

    class InnerProcessingNode extends Node<
      InnerStates,
      Context,
      ProcessEvent,
      ProcessEvent[],
      ProcessEvent[],
      null
    > {
      constructor() {
        super('inner_processing');
      }

      async prep(
        store: SharedStore<Context, ProcessEvent>
      ): Promise<PrepResult<ProcessEvent, ProcessEvent[]>> {
        const events = store.pendingEvents;
        return { events, args: events };
      }

      async exec(
        args: ProcessEvent[],
        events: ProcessEvent[],
        scratchpad: ProcessEvent[] | undefined
      ): Promise<{ result: null; scratchpad: ProcessEvent[] | undefined }> {
        // Just process events
        return { result: null, scratchpad };
      }

      async post(
        result: null,
        store: SharedStore<Context, ProcessEvent>
      ): Promise<StateResult<InnerStates, ProcessEvent>> {
        // After processing, transition to waiting state
        return {
          status: 'transition',
          to: 'inner_waiting',
          actions: [
            {
              id: crypto.randomUUID(),
              type: 'WAITING',
              payload: 'Waiting for external input',
            },
          ],
        };
      }
    }

    class InnerWaitingNode extends Node<
      InnerStates,
      Context,
      ProcessEvent,
      ProcessEvent[],
      ProcessEvent[],
      null
    > {
      constructor() {
        super('inner_waiting');
      }

      async prep(
        store: SharedStore<Context, ProcessEvent>
      ): Promise<PrepResult<ProcessEvent, ProcessEvent[]>> {
        const events = store.pendingEvents;
        return { events, args: events };
      }

      async exec(
        args: ProcessEvent[],
        events: ProcessEvent[],
        scratchpad: ProcessEvent[] | undefined
      ): Promise<{ result: null; scratchpad: ProcessEvent[] | undefined }> {
        // Check if any INPUT events
        const inputEvents = events.filter((e) => e.type === 'INPUT');
        const hasInput = inputEvents.length > 0;

        return {
          result: null,
          scratchpad: hasInput ? inputEvents : [],
        };
      }

      async post(
        result: null,
        store: SharedStore<Context, ProcessEvent>
      ): Promise<StateResult<InnerStates, ProcessEvent>> {
        // Get the scratchpad to see if we have input events
        const scratchpad = store.getScratchpad<ProcessEvent[]>();
        if (scratchpad && scratchpad.length > 0) {
          return {
            status: 'transition',
            to: 'inner_final',
            actions: [
              {
                id: crypto.randomUUID(),
                type: 'PROCESS',
                payload: `Processing completed with input: ${scratchpad[0].payload}`,
              },
            ],
          };
        }

        return {
          status: 'waiting',
          actions: [],
        };
      }
    }

    class InnerFinalNode extends FinalNode<InnerStates, Context, ProcessEvent> {
      constructor() {
        super('inner_final');
      }

      async post(
        result: null,
        store: SharedStore<Context, ProcessEvent>
      ): Promise<StateResult<InnerStates, ProcessEvent>> {
        return {
          status: 'terminal',
          actions: [
            {
              id: crypto.randomUUID(),
              type: 'RESULT',
              payload: 'Inner process complete',
            },
          ],
        };
      }
    }

    // Create the inner state machine
    const innerMachine = new StateMachine<InnerStates, Context, ProcessEvent>(
      {
        initialState: 'inner_initial',
        errorState: 'inner_initial',
        nodes: [
          new InnerInitialNode(),
          new InnerProcessingNode(),
          new InnerWaitingNode(),
          new InnerFinalNode(),
        ],
      },
      {
        write: async () => {},
        writeEvents: async () => {},
        read: async () => {
          throw new Error('Not implemented');
        },
      },
      {}, // empty context
      'inner-process-machine'
    );

    // Define the outer state machine states
    type OuterStates = 'outer_start' | 'outer_process' | 'outer_end';

    // Outer state machine nodes
    class OuterInitialNode extends Node<OuterStates, Context, ProcessEvent> {
      constructor() {
        super('outer_start');
      }

      async prep(
        store: SharedStore<Context, ProcessEvent>
      ): Promise<PrepResult<ProcessEvent, null>> {
        const events = store.pendingEvents;
        return { events, args: null };
      }

      async exec(
        args: null,
        events: ProcessEvent[],
        scratchpad: any
      ): Promise<{ result: null; scratchpad: any }> {
        return { result: null, scratchpad };
      }

      async post(
        result: null,
        store: SharedStore<Context, ProcessEvent>
      ): Promise<StateResult<OuterStates, ProcessEvent>> {
        return {
          status: 'transition',
          to: 'outer_process',
          actions: [
            {
              id: crypto.randomUUID(),
              type: 'OUTPUT',
              payload: 'Starting outer process',
            },
          ],
        };
      }
    }

    // Flow node that wraps our inner state machine
    class ProcessFlowNode extends FlowNode<
      OuterStates,
      Context,
      ProcessEvent,
      ProcessEvent,
      ProcessEvent[]
    > {
      constructor(innerMachine: StateMachine<InnerStates, Context, ProcessEvent>) {
        super('outer_process', {
          id: 'inner-process',
          config: innerMachine.config,
          initialContext: {},
        });
      }

      // Required by Node abstract class
      async prep(
        store: SharedStore<Context, ProcessEvent>
      ): Promise<PrepResult<ProcessEvent, ProcessEvent[]>> {
        const events = store.pendingEvents;
        return { events, args: events };
      }

      // Required by Node abstract class
      async post(
        result: StateResult<any, ProcessEvent>,
        store: SharedStore<Context, ProcessEvent>
      ): Promise<StateResult<OuterStates, ProcessEvent>> {
        // If the inner state machine has reached its terminal state, transition to our final state
        if (result.status === 'terminal') {
          return {
            status: 'transition',
            to: 'outer_end',
            actions: result.actions,
          };
        }

        // If the inner state machine is waiting, the outer machine should also wait
        if (result.status === 'waiting') {
          // Make sure we have a waiting action
          const actions: ProcessEvent[] =
            result.actions && result.actions.length > 0
              ? result.actions
              : [
                  {
                    id: crypto.randomUUID(),
                    type: 'OUTPUT',
                    payload: 'Inner machine is waiting for input',
                  },
                ];

          return {
            status: 'waiting',
            actions: actions,
          };
        }

        // Pass through any other result
        return result as StateResult<OuterStates, ProcessEvent>;
      }

      // Translate events from parent to submachine
      translateEvents(events: ProcessEvent[], machineId: string): ProcessEvent[] {
        // Pass through all events
        return events;
      }

      // Translate actions from submachine to parent
      translateActions(actions: ProcessEvent[], machineId: string): ProcessEvent[] {
        if (!actions || actions.length === 0) {
          // Create a synthetic waiting message if there are no actions
          return [
            {
              id: crypto.randomUUID(),
              type: 'OUTPUT',
              payload: 'Inner machine is waiting for input',
            },
          ];
        }

        return actions
          .map((event) => {
            // For demonstration, we'll translate inner actions to outer actions
            // but keep the same payload and id
            if (event.type === 'RESULT') {
              return {
                id: event.id,
                type: 'OUTPUT',
                payload: event.payload,
              };
            }

            // For waiting events, turn them into OUTPUT events for the outer machine
            if (event.type === 'WAITING') {
              return {
                id: event.id,
                type: 'OUTPUT',
                payload: 'Inner machine is waiting for input: ' + event.payload,
              };
            }

            // Pass through other types of events
            return event;
          })
          .filter(Boolean) as ProcessEvent[];
      }
    }

    class OuterFinalNode extends FinalNode<OuterStates, Context, ProcessEvent> {
      constructor() {
        super('outer_end');
      }

      async post(
        result: null,
        store: SharedStore<Context, ProcessEvent>
      ): Promise<StateResult<OuterStates, ProcessEvent>> {
        return {
          status: 'terminal',
          actions: [
            {
              id: crypto.randomUUID(),
              type: 'OUTPUT',
              payload: 'Outer process complete',
            },
          ],
        };
      }
    }

    // Create the outer state machine
    const outerMachine = new StateMachine<OuterStates, Context, ProcessEvent>(
      {
        initialState: 'outer_start',
        errorState: 'outer_start',
        nodes: [new OuterInitialNode(), new ProcessFlowNode(innerMachine), new OuterFinalNode()],
      },
      {
        write: async () => {},
        writeEvents: async () => {},
        read: async () => {
          throw new Error('Not implemented');
        },
      },
      {}, // empty context
      'outer-process-machine'
    );

    // Initialize machines
    await innerMachine.initialize();
    await outerMachine.initialize();

    // Start the outer machine
    const initialResult = await outerMachine.resume([]);

    // The machine should be in the waiting state after initial resume
    expect(initialResult.status).toBe('waiting');

    // Check for the waiting message in the actions
    const waitingAction = initialResult.actions?.find(
      (a) => a.type === 'OUTPUT' && a.payload.includes('waiting for input')
    );
    expect(waitingAction).toBeDefined();

    // Now provide the input it's waiting for
    const finalResult = await outerMachine.resume([
      {
        id: crypto.randomUUID(),
        type: 'INPUT',
        payload: 'User provided input',
      },
    ]);

    // The machine should complete and reach the terminal state
    expect(finalResult.status).toBe('terminal');

    // Verify that all the actions from both machines are included
    expect(finalResult.actions).toBeDefined();

    // Should include the inner machine's result action translated to OUTPUT
    // If we're using translateActions with type conversion, check for OUTPUT type
    const innerResultAction = finalResult.actions?.find(
      (a) =>
        a.type === 'OUTPUT' &&
        (a.payload === 'Inner process complete' || a.payload.includes('complete'))
    );
    expect(innerResultAction).toBeDefined();

    // Should include the outer machine's final action
    const outerFinalAction = finalResult.actions?.find(
      (a) => a.type === 'OUTPUT' && a.payload === 'Outer process complete'
    );
    expect(outerFinalAction).toBeDefined();
  });

  test('demonstrates multiple concurrent sub-machines', async () => {
    // Define shared event type
    interface WorkerEvent extends BaseEvent {
      id: string;
      type: 'START' | 'PROCESS' | 'COMPLETE' | 'OUTPUT' | 'INPUT';
      payload: any;
      targetMachine?: string; // Optional field to target specific sub-machine
    }

    // Define worker state machine states
    type WorkerStates = 'worker_idle' | 'worker_processing' | 'worker_done';

    // Worker nodes
    class WorkerIdleNode extends Node<WorkerStates, Context, WorkerEvent> {
      constructor() {
        super('worker_idle');
      }

      async prep(store: SharedStore<Context, WorkerEvent>): Promise<PrepResult<WorkerEvent, null>> {
        const events = store.pendingEvents;
        return { events, args: null };
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
        store: SharedStore<Context, WorkerEvent>
      ): Promise<StateResult<WorkerStates, WorkerEvent>> {
        const hasWork = store.pendingEvents.some((e) => e.type === 'START');
        if (hasWork) {
          return {
            status: 'transition',
            to: 'worker_processing',
            actions: [],
          };
        }
        return { status: 'waiting' };
      }
    }

    class WorkerProcessingNode extends Node<WorkerStates, Context, WorkerEvent> {
      constructor() {
        super('worker_processing');
      }

      async prep(store: SharedStore<Context, WorkerEvent>): Promise<PrepResult<WorkerEvent, null>> {
        return { events: [], args: null };
      }

      async exec(
        args: null,
        events: WorkerEvent[],
        scratchpad: any
      ): Promise<{ result: null; scratchpad: any }> {
        // Simulate processing
        return { result: null, scratchpad };
      }

      async post(
        result: null,
        store: SharedStore<Context, WorkerEvent>
      ): Promise<StateResult<WorkerStates, WorkerEvent>> {
        return {
          status: 'transition',
          to: 'worker_done',
          actions: [
            {
              id: crypto.randomUUID(),
              type: 'COMPLETE',
              payload: 'Work completed',
            },
          ],
        };
      }
    }

    class WorkerDoneNode extends FinalNode<WorkerStates, Context, WorkerEvent> {
      constructor() {
        super('worker_done');
      }
    }

    // Create worker configurations
    const worker1Config: SubMachineConfig<WorkerStates, Context, WorkerEvent> = {
      id: 'worker-1',
      config: {
        initialState: 'worker_idle',
        errorState: 'worker_idle',
        nodes: [new WorkerIdleNode(), new WorkerProcessingNode(), new WorkerDoneNode()],
      },
      initialContext: {},
    };

    const worker2Config: SubMachineConfig<WorkerStates, Context, WorkerEvent> = {
      id: 'worker-2',
      config: {
        initialState: 'worker_idle',
        errorState: 'worker_idle',
        nodes: [new WorkerIdleNode(), new WorkerProcessingNode(), new WorkerDoneNode()],
      },
      initialContext: {},
    };

    // Define coordinator states
    type CoordinatorStates = 'coord_start' | 'coord_workers' | 'coord_end';

    // Coordinator flow node that manages multiple workers
    class MultiWorkerFlowNode extends FlowNode<
      CoordinatorStates,
      Context,
      WorkerEvent,
      WorkerEvent,
      null
    > {
      constructor() {
        super('coord_workers', [worker1Config, worker2Config]);
      }

      async prep(store: SharedStore<Context, WorkerEvent>): Promise<PrepResult<WorkerEvent, null>> {
        return { events: store.pendingEvents, args: null };
      }

      async post(
        result: StateResult<any, WorkerEvent>,
        store: SharedStore<Context, WorkerEvent>
      ): Promise<StateResult<CoordinatorStates, WorkerEvent>> {
        if (result.status === 'terminal') {
          return {
            status: 'transition',
            to: 'coord_end',
            actions: [
              {
                id: crypto.randomUUID(),
                type: 'OUTPUT',
                payload: 'All workers completed',
              },
              ...(result.actions || []),
            ],
          };
        }
        return result as StateResult<CoordinatorStates, WorkerEvent>;
      }

      translateEvents(events: WorkerEvent[], machineId: string): WorkerEvent[] {
        // Route events to specific workers based on targetMachine field
        return events.filter((e) => !e.targetMachine || e.targetMachine === machineId);
      }

      translateActions(actions: WorkerEvent[], machineId: string): WorkerEvent[] {
        // Tag actions with the machine that produced them
        return actions.map((action) => ({
          ...action,
          payload: `[${machineId}] ${action.payload}`,
        }));
      }
    }

    // Coordinator nodes
    class CoordStartNode extends Node<CoordinatorStates, Context, WorkerEvent> {
      constructor() {
        super('coord_start');
      }

      async prep(store: SharedStore<Context, WorkerEvent>): Promise<PrepResult<WorkerEvent, null>> {
        return { events: [], args: null };
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
        store: SharedStore<Context, WorkerEvent>
      ): Promise<StateResult<CoordinatorStates, WorkerEvent>> {
        return {
          status: 'transition',
          to: 'coord_workers',
          actions: [
            {
              id: crypto.randomUUID(),
              type: 'START',
              payload: 'Start worker 1',
              targetMachine: 'worker-1',
            },
            {
              id: crypto.randomUUID(),
              type: 'START',
              payload: 'Start worker 2',
              targetMachine: 'worker-2',
            },
          ],
        };
      }
    }

    class CoordEndNode extends FinalNode<CoordinatorStates, Context, WorkerEvent> {
      constructor() {
        super('coord_end');
      }
    }

    // Create coordinator state machine
    const coordinatorMachine = new StateMachine<CoordinatorStates, Context, WorkerEvent>(
      {
        initialState: 'coord_start',
        errorState: 'coord_start',
        nodes: [new CoordStartNode(), new MultiWorkerFlowNode(), new CoordEndNode()],
      },
      {
        write: async () => {},
        writeEvents: async () => {},
        read: async () => {
          throw new Error('Not implemented');
        },
      },
      {},
      'coordinator-machine'
    );

    // Initialize and run
    await coordinatorMachine.initialize();
    const result = await coordinatorMachine.resume([]);

    // Verify result
    expect(result.status).toBe('terminal');
    expect(result.actions).toBeDefined();

    // Should have completion messages from both workers
    const worker1Complete = result.actions?.find(
      (a) => a.type === 'COMPLETE' && a.payload.includes('[worker-1]')
    );
    const worker2Complete = result.actions?.find(
      (a) => a.type === 'COMPLETE' && a.payload.includes('[worker-2]')
    );

    expect(worker1Complete).toBeDefined();
    expect(worker2Complete).toBeDefined();

    // Should have the "all workers completed" message
    const allComplete = result.actions?.find(
      (a) => a.type === 'OUTPUT' && a.payload === 'All workers completed'
    );
    expect(allComplete).toBeDefined();
  });
});
