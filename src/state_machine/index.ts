import type { BaseEvent } from './events.ts';
import type { Node, StateResult } from './nodes.ts';
import type { SharedStore } from './store.ts';

interface StateMachineConfig<StateName extends string, TEvent extends BaseEvent> {
  errorState: StateName;
  onError?: (error: Error, store: SharedStore<any, any>) => Promise<StateResult<StateName, TEvent>>;
  hooks?: {
    onTransition?: (from: string, to: string, context: any) => void;
    onError?: (error: Error, state: string) => void;
    onAction?: (action: Event, state: string) => void;
  };
}

export class StateMachine<StateName extends string, TContext, TEvent extends BaseEvent> {
  constructor(
    public initialState: string,
    public nodes: Map<string, Node<StateName, TContext, TEvent, any, any>>,
    public store: SharedStore<TContext, TEvent>,
    public config: StateMachineConfig<StateName, TEvent>
  ) {}

  async resume(): Promise<StateResult<StateName, TEvent>> {
    const currentState = this.store.getCurrentState() ?? this.initialState;
    const node = this.nodes.get(currentState);
    if (!node) throw new Error(`Unknown state: ${currentState}`);
    return await this.runNode(node);
  }

  async runNode(
    node: Node<StateName, TContext, TEvent, any, any>
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
    if (result.actions) await this.store.enqueueEvents(result.actions);
    if (result.status === 'transition' && result.to) {
      await this.store.clearScratchpad();
      const nextNode = this.nodes.get(result.to);
      if (nextNode) {
        return new Promise((res, rej) => {
          setImmediate(() => {
            this.runNode(nextNode).then(res).catch(rej);
          });
        });
      }
    }

    return result;
  }
}
