import type { BaseEvent } from './events.ts';
import { StateMachine, type StateMachineConfig } from './index.ts';
import type { AllState, SharedStore } from './store.ts';
import { withSpan, type StateMachineAttributes, recordEvent } from './telemetry.ts';
import type { StateResult, PrepResult } from './types.ts';

/**
 * BaseNode: Core node class that executes prep, run, and post sequentially.
 */
export abstract class Node<
  StateName extends string,
  TContext,
  TEvent extends BaseEvent,
  TScratchpad = any,
  EXECARGS = any,
  EXECRESULT = any,
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

  protected doPrep(
    store: SharedStore<TContext, TEvent>,
    attributes: StateMachineAttributes
  ): Promise<PrepResult<TEvent, EXECARGS>> {
    // Prep phase
    return withSpan(`node.prep.${this.id}`, attributes, async (prepSpan) => {
      prepSpan.addEvent('node_prep_started', { node_id: this.id });
      const result = await store.retry(() => this._prep(store));
      prepSpan.addEvent('node_prep_completed', {
        event_count: result.events?.length ?? 0,
      });
      return result;
    });
  }

  protected async doExec(
    store: SharedStore<TContext, TEvent>,
    prepResult: PrepResult<TEvent, EXECARGS>,
    attributes: StateMachineAttributes
  ) {
    const result = await withSpan(`node.exec.${this.id}`, attributes, async (execSpan) => {
      execSpan.setAttributes({
        event_count: prepResult.events?.length ?? 0,
      });

      // Record events being processed in exec phase
      if (prepResult.events?.length) {
        for (const event of prepResult.events) {
          recordEvent(execSpan, event.type, event.id, this.id as string);
        }
      }

      execSpan.addEvent('node_exec_started', { node_id: this.id });
      const execResult = await store.retry(() =>
        this._exec(prepResult.args, prepResult.events ?? [], store.getScratchpad<TScratchpad>())
      );
      execSpan.addEvent('node_exec_completed');
      return execResult;
    });

    store.setScratchpad(result.scratchpad);
    return result.result;
  }

  protected async doPost(
    result: EXECRESULT,
    store: SharedStore<TContext, TEvent>,
    attributes: StateMachineAttributes
  ) {
    return withSpan(`node.post.${this.id}`, attributes, async (postSpan) => {
      postSpan.addEvent('node_post_started', { node_id: this.id });
      const stateResult = await this._post(result, store);

      postSpan.setAttributes({
        result_status: stateResult.status,
        ...(stateResult.status === 'transition' &&
          stateResult.to && {
            next_state: stateResult.to as string,
          }),
      });

      postSpan.addEvent('node_post_completed', {
        status: stateResult.status,
        ...(stateResult.status === 'transition' &&
          stateResult.to && {
            next_state: stateResult.to as string,
          }),
        has_actions: stateResult.actions !== undefined && stateResult.actions.length > 0,
      });

      return stateResult;
    });
  }

  async _run(
    store: SharedStore<TContext, TEvent>,
    attributes: StateMachineAttributes
  ): Promise<StateResult<StateName, TEvent>> {
    const prepResult = await this.doPrep(store, attributes);
    const result = await this.doExec(store, prepResult, attributes);
    const stateResult = await this.doPost(result, store, attributes);
    return stateResult;
  }

  /** Perform the entire node running process, including prep, exec, and post.
   * Don't override this unless you are creating a wholly new node type
   * */
  async run(store: SharedStore<TContext, TEvent>): Promise<StateResult<StateName, TEvent>> {
    const attributes: StateMachineAttributes = {
      instanceId: store.instanceId,
      stateName: this.id as string,
    };

    return await withSpan(`node.run.${this.id}`, attributes, async (span) => {
      return store.withRollback(() => this._run(store, attributes));
    });
  }
}

/** A node that has no execution but may transition based on events or other state. */
export abstract class NoopNode<
  StateName extends string,
  TContext,
  TEvent extends BaseEvent,
  TScratchpad = undefined,
> extends Node<StateName, TContext, TEvent, TScratchpad, undefined, undefined> {
  async prep(store: SharedStore<TContext, TEvent>): Promise<PrepResult<TEvent, undefined>> {
    return { events: [], args: undefined };
  }

  async exec(
    args: undefined,
    events: TEvent[],
    scratchpad: any
  ): Promise<{ result: undefined; scratchpad: any }> {
    return { result: undefined, scratchpad };
  }

  async _run(store: SharedStore<TContext, TEvent>, attributes: StateMachineAttributes) {
    return this.doPost(undefined, store, attributes);
  }
}

/**
 * FinalNode: A simple way to implement a terminal state in the state machine.
 */
export class FinalNode<StateName extends string, TContext, TEvent extends BaseEvent> extends Node<
  StateName,
  TContext,
  TEvent
> {
  constructor(id: StateName) {
    super(id);
  }

  async prep(store: SharedStore<TContext, TEvent>): Promise<PrepResult<TEvent, void>> {
    return { events: [], args: undefined };
  }

  async exec(
    args: void,
    events: TEvent[],
    scratchpad: any
  ): Promise<{ result: null; scratchpad: any }> {
    return { result: null, scratchpad };
  }

  async post(
    result: null,
    store: SharedStore<TContext, TEvent>
  ): Promise<StateResult<StateName, TEvent>> {
    // Final nodes are terminal states
    return { status: 'terminal' };
  }
}

/**
 * ErrorNode: Handles error states in the state machine.
 */
export class ErrorNode<StateName extends string, TContext, TEvent extends BaseEvent> extends Node<
  StateName,
  TContext,
  TEvent
> {
  constructor(id: StateName) {
    super(id);
  }

  async prep(
    store: SharedStore<TContext, TEvent>
  ): Promise<PrepResult<TEvent, AllState<TContext, TEvent>>> {
    return { events: store.pendingEvents, args: store.allState };
  }

  async exec(
    args: AllState<StateName, TEvent>,
    events: TEvent[],
    scratchpad: any
  ): Promise<{ result: null; scratchpad: any }> {
    return { result: null, scratchpad };
  }

  async post(
    result: null,
    store: SharedStore<TContext, TEvent>
  ): Promise<StateResult<StateName, TEvent>> {
    // Error states are generally terminal
    return { status: 'terminal' };
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
  EXECARG = any,
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
    this.subMachine = this.createSubMachine(subMachineConfig);
  }

  // Factory method to create the sub-machine
  private createSubMachine(
    config: StateMachineConfig<any, any, SubEvent>
  ): StateMachine<any, any, SubEvent> {
    return new StateMachine(
      config,
      {
        write: () => Promise.resolve(),
        writeEvents: () => Promise.resolve(),
        read: () => {
          throw new Error('Not implemented');
        },
      },
      { messages: [] }, // Initialize with empty context
      'submachine',
      // todo hooks that wrap our hooks
      {
        onError: (error: Error, store: any) => {
          return Promise.resolve({ status: 'terminal' });
        },
        onTransition: (from: string, to: string, context: any) => {},
      }
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
    const attributes: StateMachineAttributes = {
      instanceId: this.subMachine.instanceId,
      stateName: this.id as string,
      metadata: {
        is_sub_machine: true,
        parent_instance_id: this.subMachine.instanceId,
      },
    };

    return await withSpan(`flow_node.exec.${this.id}`, attributes, async (span) => {
      const existingState = scratchpad?.subMachineState;
      if (existingState) {
        this.subMachine.store.allState = existingState;
        span.addEvent('submachine_resumed', {
          from_state: existingState.history[existingState.history.length - 1]?.state,
        });
      } else {
        span.addEvent('submachine_initialized');
      }

      // Record events being processed by sub-machine
      if (events.length > 0 && span) {
        span.addEvent('events_translated', { count: events.length });
        const translatedEvents = this.translateEvents(events);
        for (const event of translatedEvents) {
          recordEvent(span, event.type, event.id, 'submachine');
        }
      }

      // Initialize the sub-machine
      await this.subMachine.initialize();

      // Run sub-machine with the translated events
      const translatedEvents = this.translateEvents(events);
      const result = await this.subMachine.resume(translatedEvents);

      // Check the current state of the subMachine before updating our result
      const currentSubState = this.subMachine.store.getCurrentState();

      let endState = result.status;
      if (currentSubState === 'inner_waiting') {
        endState = 'waiting';
      }

      span.setAttributes({
        sub_machine_status: result.status,
        sub_machine_current_state: currentSubState,
        translated_event_count: events.length,
        translated_action_count: result.actions?.length ?? 0,
      });

      if (result.actions && result.actions.length > 0) {
        span.addEvent('actions_translated', { count: result.actions.length });
      }

      span.addEvent('submachine_completed', {
        status: result.status,
        has_actions: result.actions !== undefined && result.actions.length > 0,
      });

      // Update the result status based on the current state of the subMachine
      return {
        result: {
          status: endState as any,
          actions: result.actions ? this.translateActions(result.actions) : undefined,
        },
        scratchpad: {
          subMachineState: this.subMachine.store.allState,
        },
      };
    });
  }
}
