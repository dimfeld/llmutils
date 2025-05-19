import type { BaseEvent } from './events.ts';
import type { StateMachine } from './index.ts';
import type { AllState, SharedStore } from './store.ts';

export type StateResult<StateName extends string, TEvent extends BaseEvent> =
  | { status: 'waiting' | 'terminal'; actions?: TEvent[] }
  | { status: 'transition'; actions?: TEvent[]; to?: StateName };

/**
 * BaseNode: Core node class that executes prep, run, and post sequentially.
 */
export abstract class Node<
  StateName extends string,
  TContext,
  TEvent extends BaseEvent,
  TScratchpad,
  EXECARGS,
  EXECRESULT,
> {
  id: StateName;
  constructor(id: StateName) {
    this.id = id;
  }

  /** Read pending events and state, and return arguments for `run` */
  abstract prep(store: SharedStore<TContext, TEvent>): Promise<EXECARGS>;

  /** Run the node with arguments */
  abstract exec(
    args: EXECARGS,
    scratchpad: TScratchpad | undefined
  ): Promise<{ result: EXECRESULT; scratchpad: TScratchpad | undefined }>;

  /**
   * Process the result, updating the state and returning a StateResult.
   * This is called after `exec` and before `post`.
   */
  abstract post(
    result: EXECRESULT,
    store: SharedStore<TContext, TEvent>
  ): Promise<StateResult<StateName, TEvent>>;

  /** When an unexpected error occurs, this is called instead of post */
  onError?: (
    error: Error,
    store: SharedStore<TContext, TEvent>
  ) => Promise<StateResult<StateName, TEvent>>;

  async run(store: SharedStore<TContext, TEvent>): Promise<StateResult<StateName, TEvent>> {
    return store.withRollback(async () => {
      const args = await store.retry(() => this.prep(store));
      const result = await store.retry(() => this.exec(args, store.getScratchpad<TScratchpad>()));
      store.setScratchpad(result.scratchpad);
      return this.post(result.result, store);
    });
  }
}

/**
 * FlowNode: Runs a nested state machine to completion.
 */
export abstract class FlowNode<
  StateName extends string,
  TContext,
  TEvent extends BaseEvent,
  EXECARG,
> extends Node<
  StateName,
  TContext,
  TEvent,
  { subMachineState: AllState<TContext, TEvent> },
  EXECARG,
  StateResult<any, TEvent>
> {
  constructor(
    id: StateName,
    private subMachine: StateMachine<any, any, TEvent>
  ) {
    super(id);
  }

  async exec(
    args: EXECARG,
    scratchpad: { subMachineState: AllState<TContext, TEvent> } | undefined
  ): Promise<{
    result: StateResult<any, TEvent>;
    scratchpad: { subMachineState: AllState<TContext, TEvent> } | undefined;
  }> {
    const existingState = scratchpad?.subMachineState;
    if (existingState) {
      this.subMachine.store.allState = existingState;
    }

    // Run sub-machine
    // TODO Figure out how to pass args to sub-machine
    const result = await this.subMachine.resume();

    return {
      result,
      scratchpad: {
        subMachineState: this.subMachine.store.allState,
      },
    };
  }
}
