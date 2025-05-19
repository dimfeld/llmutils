import type { BaseEvent } from './events.ts';
import { StateMachine, type StateMachineConfig } from './index.ts';
import type { AllState, SharedStore } from './store.ts';

export type StateResult<StateName extends string, TEvent extends BaseEvent> =
  | { status: 'waiting' | 'terminal'; actions?: TEvent[] }
  | { status: 'transition'; actions?: TEvent[]; to?: StateName };

export interface PrepResult<TEvent extends BaseEvent, ARGS> {
  events?: TEvent[];
  args: ARGS;
}

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

  /** For base classes to override when they need some special prep behavior but also want to call the subclass */
  _prep(store: SharedStore<TContext, TEvent>): Promise<PrepResult<TEvent, EXECARGS>> {
    return this.prep(store);
  }

  /** For base classes to override when they need some special post behavior but also want to call the subclass */
  _post(
    result: EXECRESULT,
    store: SharedStore<TContext, TEvent>
  ): Promise<StateResult<StateName, TEvent>> {
    return this.post(result, store);
  }

  /** For base classes to override when they need some special exec behavior but also want to call the subclass */
  _exec(
    args: EXECARGS,
    events: TEvent[],
    scratchpad: TScratchpad | undefined
  ): Promise<{ result: EXECRESULT; scratchpad: TScratchpad | undefined }> {
    return this.exec(args, events, scratchpad);
  }

  /** Read pending events and state, and return arguments for `run` */
  abstract prep(store: SharedStore<TContext, TEvent>): Promise<PrepResult<TEvent, EXECARGS>>;

  /** Run the node with arguments */
  abstract exec(
    args: EXECARGS,
    events: TEvent[],
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

  /** Perform the entire node running process, including prep, exec, and post */
  async run(store: SharedStore<TContext, TEvent>): Promise<StateResult<StateName, TEvent>> {
    return store.withRollback(async () => {
      const prepResult = await store.retry(() => this._prep(store));
      const result = await store.retry(() =>
        this._exec(prepResult.args, prepResult.events ?? [], store.getScratchpad<TScratchpad>())
      );
      store.setScratchpad(result.scratchpad);
      return this._post(result.result, store);
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
  SubEvent extends BaseEvent,
  EXECARG,
> extends Node<
  StateName,
  TContext,
  TEvent,
  { subMachineState: AllState<any, SubEvent> },
  EXECARG,
  StateResult<any, TEvent>
> {
  subMachine: StateMachine<any, any, SubEvent>;

  constructor(
    id: StateName,
    private subMachineConfig: StateMachineConfig<any, any, SubEvent>
  ) {
    super(id);
    this.subMachine = new StateMachine(
      subMachineConfig,
      {
        write: () => Promise.resolve(),
        writeEvents: () => Promise.resolve(),
        read: () => {
          throw new Error('Not implemented');
        },
      },
      undefined,
      'submachine',
      // todo hooks that wrap our hooks
      undefined
    );
  }

  /** Translate events from the parent type to the sub machine type */
  abstract translateEvents(events: TEvent[]): SubEvent[];

  /** Translate events from the sub machine type to the parent type */
  abstract translateActions(actions: SubEvent[]): TEvent[];

  async exec(
    args: EXECARG,
    events: TEvent[],
    scratchpad: { subMachineState: AllState<any, SubEvent> } | undefined
  ): Promise<{
    result: StateResult<any, TEvent>;
    scratchpad: { subMachineState: AllState<any, SubEvent> } | undefined;
  }> {
    const existingState = scratchpad?.subMachineState;
    if (existingState) {
      this.subMachine.store.allState = existingState;
    }

    // Run sub-machine
    // TODO Figure out how to pass args to sub-machine
    const result = await this.subMachine.resume(this.translateEvents(events));

    return {
      result: {
        status: result.status,
        actions: result.actions ? this.translateActions(result.actions) : undefined,
      },
      scratchpad: {
        subMachineState: this.subMachine.store.allState,
      },
    };
  }
}
