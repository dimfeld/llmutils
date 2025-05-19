import type { BaseEvent } from './events.ts';
import type { Node, StateResult } from './nodes.ts';
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

export interface StateMachineConfig<StateName extends string, TContext, TEvent extends BaseEvent> {
  initialState: StateName;
  errorState: StateName;
  nodes: Map<StateName, Node<StateName, TContext, TEvent, any, any, any>>;
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
  
  constructor(
    public config: StateMachineConfig<StateName, TContext, TEvent>,
    public adapter: PersistenceAdapter<TContext, TEvent>,
    initialContext: TContext,
    public instanceId: string,
    public hooks?: StateMachineHooks<StateName, TEvent>
  ) {
    this.store = new SharedStore<TContext, TEvent>(instanceId, initialContext, adapter);
  }

  async loadPersistedState(): Promise<void> {
    await this.store.loadState();
  }

  async initialize(enableDebugLogging = false): Promise<void> {
    if (!this.initialized) {
      initTelemetry(enableDebugLogging);
      this.initialized = true;
    }
  }

  async resume(events: TEvent[]): Promise<StateResult<StateName, TEvent>> {
    if (!this.initialized) {
      await this.initialize();
    }

    const attributes: StateMachineAttributes = {
      instanceId: this.instanceId,
    };

    return await withSpan('state_machine.resume', attributes, async (span) => {
      // Record incoming events on the span
      const currentState = (this.store.getCurrentState() as StateName) ?? this.config.initialState;
      span.setAttributes({
        'state_machine.current_state': currentState as string,
        'event_count': events.length,
      });

      for (const event of events) {
        recordEvent(span, event.type, event.id, currentState as string);
      }

      await this.store.enqueueEvents(events);
      const node = this.config.nodes.get(currentState);
      if (!node) throw new Error(`Unknown state: ${currentState}`);
      return await this.runNode(node);
    });
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
    if (result.status === 'transition' && result.to) {
      const fromState = this.store.getCurrentState() as string;
      const toState = result.to as string;
      
      // Record state transition on the active span
      recordStateTransition(getActiveSpan(), fromState, toState, '<transition>', '<transition>');
      
      // Notify hooks if present
      this.hooks?.onTransition?.(fromState as StateName, result.to, this.store.getContext());
      
      this.store.clearScratchpad();
      this.store.setCurrentState(result.to as string);
      
      const nextNode = this.config.nodes.get(result.to);
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

    return result;
  }
}
