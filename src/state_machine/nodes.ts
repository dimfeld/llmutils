import type { BaseEvent } from './events.ts';
import type { StateMachine } from './index.ts';
import type { SharedStore } from './store.ts';

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
  RUNARGS,
  RUNRESULT,
> {
  id: StateName;
  constructor(id: StateName) {
    this.id = id;
  }

  abstract prep(store: SharedStore<TContext, TEvent>): Promise<RUNARGS>;

  abstract run(args: RUNARGS, store: SharedStore<TContext, TEvent>): Promise<RUNRESULT>;

  abstract post(
    result: RUNRESULT,
    store: SharedStore<TContext, TEvent>
  ): Promise<StateResult<StateName, TEvent>>;

  onError?: (
    error: Error,
    store: SharedStore<TContext, TEvent>
  ) => Promise<StateResult<StateName, TEvent>>;

  async _run(store: SharedStore<TContext, TEvent>): Promise<StateResult<StateName, TEvent>> {
    return store.withRollback(async () => {
      const args = await store.retry(() => this.prep(store));
      const result = await store.retry(() => this.run(args, store));
      return this.post(result, store);
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
  RUNARG,
  RUNRESULT,
> extends Node<StateName, TContext, TEvent, RUNARG, RUNRESULT> {
  constructor(
    id: StateName,
    private subMachine: StateMachine<StateName, TContext, TEvent>
  ) {
    super(id);
  }

  async _run(store: SharedStore<TContext, TEvent>): Promise<StateResult<StateName, TEvent>> {
    return store.withRollback(async () => {
      // TODO clean all this up

      const args = await store.retry(() => this.prep(store));
      // Store sub-machine state in scratchpad
      await store.setScratchpad({ subMachineState: args } as any);

      // Run sub-machine
      await store.retry(() => this.subMachine.resume());

      // Clear sub-machine state from scratchpad
      await store.clearScratchpad();

      // Post-process (e.g., based on sub-machine outcome)
      return this.post(args, store);
    });
  }
}
