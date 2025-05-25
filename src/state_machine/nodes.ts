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
 * Configuration for a sub-machine within a FlowNode
 */
export interface SubMachineConfig<
  SubStateName extends string,
  SubContext,
  SubEvent extends BaseEvent,
> {
  id: string;
  config: StateMachineConfig<SubStateName, SubContext, SubEvent>;
  initialContext: SubContext;
}

/**
 * FlowNode: Runs one or more nested state machines to completion.
 * All sub-machines run concurrently and the node waits for all to complete.
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
  { subMachineStates: Map<string, AllState<any, SubEvent>> },
  EXECARG,
  StateResult<any, TEvent>
> {
  subMachines: Map<string, StateMachine<any, any, SubEvent>>;

  constructor(
    id: StateName,
    private subMachineConfigs:
      | SubMachineConfig<any, any, SubEvent>
      | SubMachineConfig<any, any, SubEvent>[]
  ) {
    super(id);
    this.subMachines = new Map();

    // Handle both single and multiple sub-machine configurations
    const configs = Array.isArray(subMachineConfigs) ? subMachineConfigs : [subMachineConfigs];

    for (const subConfig of configs) {
      const subMachine = this.createSubMachine(subConfig);
      this.subMachines.set(subConfig.id, subMachine);
    }
  }

  // Factory method to create a sub-machine
  private createSubMachine(
    subConfig: SubMachineConfig<any, any, SubEvent>
  ): StateMachine<any, any, SubEvent> {
    // Generate a unique instance ID for the sub-machine
    const instanceId = `${subConfig.id}-${crypto.randomUUID()}`;

    return new StateMachine(
      subConfig.config,
      {
        write: () => Promise.resolve(),
        writeEvents: () => Promise.resolve(),
        read: () => {
          throw new Error('Not implemented');
        },
      },
      subConfig.initialContext,
      instanceId,
      // todo hooks that wrap our hooks
      {
        onError: (error: Error, store: any) => {
          return Promise.resolve({ status: 'terminal' });
        },
        onTransition: (from: string, to: string, context: any) => {},
      }
    );
  }

  /** Translate events from the parent type to the sub machine type for a specific machine */
  abstract translateEvents(events: TEvent[], machineId: string): SubEvent[];

  /** Translate events from the sub machine type to the parent type for a specific machine */
  abstract translateActions(actions: SubEvent[], machineId: string): TEvent[];

  async exec(
    args: EXECARG,
    events: TEvent[],
    scratchpad: { subMachineStates: Map<string, AllState<any, SubEvent>> } | undefined
  ): Promise<{
    result: StateResult<any, TEvent>;
    scratchpad: { subMachineStates: Map<string, AllState<any, SubEvent>> } | undefined;
  }> {
    const attributes: StateMachineAttributes = {
      instanceId: 'flow-node', // Will be overridden by parent context
      stateName: this.id as string,
      metadata: {
        is_flow_node: true,
        sub_machine_count: this.subMachines.size,
      },
    };

    return await withSpan(`flow_node.exec.${this.id}`, attributes, async (span) => {
      // Restore state for all sub-machines if we have scratchpad data
      const existingStates = scratchpad?.subMachineStates;
      if (existingStates) {
        for (const [machineId, state] of existingStates) {
          const subMachine = this.subMachines.get(machineId);
          if (subMachine) {
            subMachine.store.allState = state;
            span.addEvent('submachine_resumed', {
              machine_id: machineId,
              from_state: state.history[state.history.length - 1]?.state,
            });
          }
        }
      } else {
        span.addEvent('submachines_initialized', {
          count: this.subMachines.size,
        });
      }

      // Initialize all sub-machines
      const initPromises = Array.from(this.subMachines.values()).map((machine) =>
        machine.initialize()
      );
      await Promise.all(initPromises);

      // Run all sub-machines concurrently
      const subMachineResults = new Map<string, StateResult<any, SubEvent>>();
      const allActions: TEvent[] = [];
      let anyWaiting = false;
      let anyInProgress = false;

      const runPromises = Array.from(this.subMachines.entries()).map(
        async ([machineId, subMachine]) => {
          // Translate events for this specific machine
          const translatedEvents = this.translateEvents(events, machineId);

          // Record events being processed by this sub-machine
          if (translatedEvents.length > 0 && span) {
            span.addEvent('events_translated', {
              machine_id: machineId,
              count: translatedEvents.length,
            });
            for (const event of translatedEvents) {
              recordEvent(span, event.type, event.id, `submachine:${machineId}`);
            }
          }

          // Run the sub-machine
          const result = await subMachine.resume(translatedEvents);
          subMachineResults.set(machineId, result);

          // Check the current state
          const currentSubState = subMachine.store.getCurrentState();

          span.addEvent('submachine_result', {
            machine_id: machineId,
            status: result.status,
            current_state: currentSubState,
            has_actions: result.actions !== undefined && result.actions.length > 0,
          });

          // Track overall status
          if (result.status === 'waiting' || currentSubState?.includes('waiting')) {
            anyWaiting = true;
          } else if (result.status !== 'terminal') {
            anyInProgress = true;
          }

          // Translate and collect actions
          if (result.actions && result.actions.length > 0) {
            const translatedActions = this.translateActions(result.actions, machineId);
            allActions.push(...translatedActions);
          }
        }
      );

      await Promise.all(runPromises);

      // Determine overall status
      let overallStatus: StateResult<any, TEvent>['status'];
      if (anyWaiting) {
        overallStatus = 'waiting';
      } else if (anyInProgress) {
        // Some machines still running, continue waiting
        overallStatus = 'waiting';
      } else {
        // All machines are terminal
        overallStatus = 'terminal';
      }

      span.setAttributes({
        overall_status: overallStatus,
        total_actions: allActions.length,
        machines_waiting: anyWaiting ? 'true' : 'false',
        machines_in_progress: anyInProgress ? 'true' : 'false',
      });

      // Collect all sub-machine states for scratchpad
      const newSubMachineStates = new Map<string, AllState<any, SubEvent>>();
      for (const [machineId, subMachine] of this.subMachines) {
        newSubMachineStates.set(machineId, subMachine.store.allState);
      }

      return {
        result: {
          status: overallStatus,
          actions: allActions.length > 0 ? allActions : undefined,
        },
        scratchpad: {
          subMachineStates: newSubMachineStates,
        },
      };
    });
  }
}
