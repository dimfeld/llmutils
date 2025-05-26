import type { BaseEvent } from './events.ts';
import { Node, FinalNode, ErrorNode, FlowNode, type SubMachineConfig } from './nodes.ts';
import { SharedStore, type PersistenceAdapter } from './store.ts';
import {
  initTelemetry,
  withSpan,
  recordStateTransition,
  recordEvent,
  recordError,
  getActiveSpan,
  type StateMachineAttributes,
} from './telemetry.ts';
import { type StateResult, type PrepResult } from './types.ts';
import { EventBus, type SystemEvent } from './event_bus.ts';

// Re-export types and classes from nodes.ts
export { Node, FinalNode, ErrorNode, FlowNode };
export type { SubMachineConfig };

// Re-export from events.ts
export type { BaseEvent };

// Re-export from store.ts
export { SharedStore };
export type { PersistenceAdapter };

// Re-export from types.ts
export type { StateResult, PrepResult };

// Re-export from event_bus.ts
export { EventBus };
export type { RoutedEvent, SystemEvent } from './event_bus.ts';

export interface StateMachineConfig<StateName extends string, TContext, TEvent extends BaseEvent> {
  initialState: StateName;
  errorState: StateName;
  nodes: Node<StateName, TContext, TEvent, any, any, any>[];
  maxRetries?: number;
  retryDelay?: (attempt: number) => number;
  onError?: (
    error: Error,
    store: SharedStore<TContext, TEvent>
  ) => Promise<StateResult<StateName, TEvent>>;
}

export interface StateMachineHooks<StateName extends string, TEvent extends BaseEvent> {
  onTransition?: (from: StateName, to: StateName, context: any) => void;
  onActions?: (actions: TEvent[], state: StateName) => void;
  onError?: (error: Error, store: SharedStore<any, any>) => Promise<StateResult<StateName, TEvent>>;
  onRetry?: (error: Error, state: string, attempt: number) => void;
}

export class StateMachine<StateName extends string, TContext, TEvent extends BaseEvent> {
  store: SharedStore<TContext, TEvent>;
  private initialized = false;
  private nodesMap: Map<StateName, Node<StateName, TContext, TEvent, any, any, any>>;
  private eventBusUnsubscribe?: () => void;
  private parentMachineId?: string;
  private eventBus?: EventBus;

  constructor(
    public config: StateMachineConfig<StateName, TContext, TEvent>,
    public adapter: PersistenceAdapter<TContext, TEvent>,
    initialContext: TContext,
    public instanceId: string,
    public hooks?: StateMachineHooks<StateName, TEvent>,
    parentMachineId?: string,
    eventBus?: EventBus
  ) {
    // Convert nodes array to Map
    this.nodesMap = new Map(
      config.nodes.map(
        (node) => [node.id, node] as [StateName, Node<StateName, TContext, TEvent, any, any, any>]
      )
    );

    // Pass retry configuration from config to store
    this.store = new SharedStore<TContext, TEvent>(instanceId, initialContext, adapter, {
      maxRetries: config.maxRetries,
      retryDelay: config.retryDelay,
    });

    this.parentMachineId = parentMachineId;
    this.eventBus = eventBus;
  }

  async loadPersistedState(): Promise<void> {
    await this.store.loadState();
  }

  async initialize(enableDebugLogging = false): Promise<void> {
    if (!this.initialized) {
      initTelemetry(enableDebugLogging);
      
      // Pass EventBus to FlowNodes
      if (this.eventBus) {
        for (const node of this.nodesMap.values()) {
          if (node instanceof FlowNode) {
            node.setEventBus(this.eventBus);
          }
        }
        
        // Register with event bus
        this.eventBus.registerMachine(
          this.instanceId,
          async (event) => {
            // Handle incoming events
            await this.handleEvent(event as TEvent);
          },
          this.parentMachineId
        );
      }
      
      this.initialized = true;
    }
  }

  /**
   * Handle an event from the event bus
   */
  private async handleEvent(event: TEvent): Promise<void> {
    const span = getActiveSpan();
    span?.addEvent('event_received_from_bus', {
      event_type: event.type,
      event_id: event.id,
      machine_id: this.instanceId,
    });

    // Queue the event for processing
    await this.store.enqueueEvents([event]);
    
    // If machine is waiting, resume processing
    const currentState = this.store.getCurrentState();
    if (currentState) {
      const node = this.nodesMap.get(currentState as StateName);
      if (node) {
        // Run the node with the new event
        await this.runNode(node);
      }
    }
  }

  /**
   * Clean up event bus registration
   */
  async destroy(): Promise<void> {
    if (this.eventBusUnsubscribe) {
      this.eventBusUnsubscribe();
    }
    if (this.eventBus) {
      this.eventBus.unregisterMachine(this.instanceId);
    }
  }

  async resume(events: TEvent[]): Promise<
    StateResult<StateName, TEvent> & {
      stateName?: StateName;
      context?: TContext;
    }
  > {
    if (!this.initialized) {
      await this.initialize();
    }

    const attributes: StateMachineAttributes = {
      instanceId: this.instanceId,
    };

    const result = await withSpan('state_machine.resume', attributes, async (span) => {
      // Record incoming events on the span
      const currentState = (this.store.getCurrentState() as StateName) ?? this.config.initialState;
      span.setAttributes({
        'state_machine.current_state': currentState as string,
        event_count: events.length,
      });

      for (const event of events) {
        recordEvent(span, event.type, event.id, currentState as string);
      }

      await this.store.enqueueEvents(events);
      const node = this.nodesMap.get(currentState);
      if (!node) throw new Error(`Unknown state: ${currentState}`);
      return await this.runNode(node);
    });

    // Add context and current state to result for easier testing
    return {
      ...result,
      stateName: this.store.getCurrentState() as StateName,
      context: this.store.getContext(),
    };
  }

  async runNode(
    node: Node<StateName, TContext, TEvent, any, any, any>
  ): Promise<StateResult<StateName, TEvent>> {
    const attributes: StateMachineAttributes = {
      instanceId: this.instanceId,
      stateName: node.id as string,
    };

    return await withSpan(`state_machine.run_node.${node.id}`, attributes, async (span) => {
      try {
        const stateResult = await node.run(this.store);
        return await this.handleStateResult(stateResult);
      } catch (e) {
        const error = e as Error;
        recordError(span, error, {
          state: node.id as string,
        });

        const handler = node.onError ?? this.config.onError;
        const stateResult = (await handler?.(error, this.store)) ?? {
          status: 'transition',
          to: this.config.errorState,
        };
        return await this.handleStateResult(stateResult);
      }
    });
  }

  private async handleStateResult(
    result: StateResult<StateName, TEvent>
  ): Promise<StateResult<StateName, TEvent>> {
    // TODO This should send the events instead
    if (result.actions) await this.store.enqueueEvents(result.actions);
    
    // Emit system event based on result status
    if (this.eventBus) {
      if (result.status === 'waiting') {
        await this.eventBus.emitSystemEvent({
          id: crypto.randomUUID(),
          type: 'MACHINE_WAITING',
          payload: {
            machineId: this.instanceId,
            state: this.store.getCurrentState(),
          },
        } as SystemEvent);
      } else if (result.status === 'terminal') {
        await this.eventBus.emitSystemEvent({
          id: crypto.randomUUID(),
          type: 'MACHINE_TERMINAL',
          payload: {
            machineId: this.instanceId,
            state: this.store.getCurrentState(),
          },
        } as SystemEvent);
      }
    }
    
    if (result.status === 'transition' && result.to) {
      const fromState = this.store.getCurrentState() as string;
      const toState = result.to as string;

      // Record state transition on the active span
      recordStateTransition(getActiveSpan(), fromState, toState, '<transition>', '<transition>');

      // Notify hooks if present
      this.hooks?.onTransition?.(fromState as StateName, result.to, this.store.getContext());

      this.store.clearScratchpad();
      this.store.setCurrentState(result.to as string);

      // Emit state change event
      if (this.eventBus) {
        await this.eventBus.emitSystemEvent({
          id: crypto.randomUUID(),
          type: 'MACHINE_STATE_CHANGED',
          payload: {
            machineId: this.instanceId,
            state: toState,
          },
        } as SystemEvent);
      }

      const nextNode = this.nodesMap.get(result.to);
      if (nextNode) {
        return new Promise((res, rej) => {
          setImmediate(() => {
            this.runNode(nextNode).then(res).catch(rej);
          });
        });
      } else {
        const error = new Error(`Unknown state: ${result.to}`);
        recordError(getActiveSpan(), error, { state: this.store.getCurrentState() });

        const stateResult = await this.config.onError?.(error, this.store);
        if (!stateResult) {
          throw error;
        }
        return stateResult;
      }
    }

    // When a node returns a terminal result, also include the pending actions
    if (result.status === 'terminal' && !result.actions) {
      const pendingActions = this.store.pendingEvents;
      if (pendingActions.length > 0) {
        return {
          ...result,
          actions: pendingActions,
        };
      }
    }

    return result;
  }
}
