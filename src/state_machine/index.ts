import type { BaseEvent } from './events.ts';
import type { Node, StateResult } from './nodes.ts';
import { SharedStore, type PersistenceAdapter } from './store.ts';

export interface StateMachineConfig<StateName extends string, TContext, TEvent extends BaseEvent> {
  initialState: StateName;
  errorState: StateName;
  nodes: Map<StateName, Node<StateName, TContext, TEvent, any, any, any>>;
  onError?: (
    error: Error,
    store: SharedStore<TContext, TEvent>
  ) => Promise<StateResult<StateName, TEvent>>;
}

export interface StateMachineHooks<StateName extends string, TEvent extends BaseEvent> {
  onTransition?: (from: StateName, to: StateName, context: any) => void;
  onActions?: (actions: TEvent[], state: StateName) => void;
}

export class StateMachine<StateName extends string, TContext, TEvent extends BaseEvent> {
  store: SharedStore<TContext, TEvent>;
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

  async resume(events: TEvent[]): Promise<StateResult<StateName, TEvent>> {
    await this.store.enqueueEvents(events);
    const currentState = (this.store.getCurrentState() as StateName) ?? this.config.initialState;
    const node = this.config.nodes.get(currentState);
    if (!node) throw new Error(`Unknown state: ${currentState}`);
    return await this.runNode(node);
  }

  async runNode(
    node: Node<StateName, TContext, TEvent, any, any, any>
  ): Promise<StateResult<StateName, TEvent>> {
    try {
      const stateResult = await node.run(this.store);
      return await this.handleStateResult(stateResult);
    } catch (e) {
      const handler = node.onError ?? this.config.onError;
      const stateResult = (await handler?.(e as Error, this.store)) ?? {
        status: 'transition',
        to: this.config.errorState,
      };
      return await this.handleStateResult(stateResult);
    }
  }

  private async handleStateResult(
    result: StateResult<StateName, TEvent>
  ): Promise<StateResult<StateName, TEvent>> {
    // TODO This should send the events instead
    if (result.actions) await this.store.enqueueEvents(result.actions);
    if (result.status === 'transition' && result.to) {
      this.store.clearScratchpad();
      const nextNode = this.config.nodes.get(result.to);
      if (nextNode) {
        return new Promise((res, rej) => {
          setImmediate(() => {
            this.runNode(nextNode).then(res).catch(rej);
          });
        });
      } else {
        const stateResult = await this.config.onError?.(
          new Error(`Unknown state: ${result.to}`),
          this.store
        );
        if (!stateResult) {
          throw new Error(`Unknown state: ${result.to}`);
        }
        return stateResult;
      }
    }

    return result;
  }
}
