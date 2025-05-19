import type { BaseEvent } from './events.ts';
import { StateMachine, type StateMachineConfig } from './index.ts';
import type { AllState, SharedStore } from './store.ts';
import { withSpan, type StateMachineAttributes, recordEvent } from './telemetry.ts';

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

  /** Perform the entire node running process, including prep, exec, and post.
   * Don't override this unless you are creating a wholly new node type
   * */
  async run(store: SharedStore<TContext, TEvent>): Promise<StateResult<StateName, TEvent>> {
    const attributes: StateMachineAttributes = {
      instanceId: store.instanceId,
      stateName: this.id as string,
    };

    return await withSpan(`node.run.${this.id}`, attributes, async (span) => {
      return store.withRollback(async () => {
        // Prep phase
        const prepResult = await withSpan(`node.prep.${this.id}`, attributes, async (prepSpan) => {
          prepSpan.addEvent('node_prep_started', { node_id: this.id });
          const result = await store.retry(() => this._prep(store));
          prepSpan.addEvent('node_prep_completed', {
            event_count: result.events?.length ?? 0,
          });
          return result;
        });

        // Exec phase
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

        // Post phase
        return await withSpan(`node.post.${this.id}`, attributes, async (postSpan) => {
          postSpan.addEvent('node_post_started', { node_id: this.id });
          const stateResult = await this._post(result.result, store);

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
      });
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

      // Run sub-machine
      // TODO Figure out how to pass args to sub-machine
      const result = await this.subMachine.resume(this.translateEvents(events));

      span.setAttributes({
        sub_machine_status: result.status,
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

      return {
        result: {
          status: result.status,
          actions: result.actions ? this.translateActions(result.actions) : undefined,
        },
        scratchpad: {
          subMachineState: this.subMachine.store.allState,
        },
      };
    });
  }
}
