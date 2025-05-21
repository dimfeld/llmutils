import chalk from 'chalk';
import { z } from 'zod';
import * as clipboard from '../../common/clipboard.ts';
import { waitForEnter } from '../../common/terminal.ts';
import { log } from '../../logging';
import {
  FinalNode,
  Node,
  StateMachine,
  type BaseEvent,
  type StateResult,
  type PrepResult,
} from '../../state_machine/index.ts';
import type { SharedStore } from '../../state_machine/store.ts';
import type { PrepareNextStepOptions } from '../actions.ts';
import type { RmplanConfig } from '../configSchema.ts';
import type { ExecutorCommonOptions, Executor } from './types';
import type { Event } from '../../state_machine/events.ts';
import { NoopNode } from '../../state_machine/nodes.ts';

// Define states for our state machine
export type CopyOnlyState = 'copy' | 'waiting_for_user' | 'done';

// Define events that our state machine will handle
export type CopyOnlyEvent =
  | Event<'PROMPT', { message: string }>
  | Event<'RESPONSE', { message: string }>;

// Define the context type for our state machine
export interface CopyOnlyContext {
  contextContent: string;
  options: CopyOnlyExecutorOptions;
  sharedOptions: ExecutorCommonOptions;
  rmplanConfig: RmplanConfig;
}

// Schema for config options (same as CopyOnlyExecutor)
const copyOnlyOptionsSchema = z.object({});
export type CopyOnlyExecutorOptions = z.infer<typeof copyOnlyOptionsSchema>;

export class CopyNode extends Node<CopyOnlyState, CopyOnlyContext, CopyOnlyEvent> {
  constructor() {
    super('copy');
  }

  async prep(
    store: SharedStore<CopyOnlyContext, CopyOnlyEvent>
  ): Promise<PrepResult<CopyOnlyEvent, string>> {
    const context = store.getContext();
    return { events: [], args: context.contextContent };
  }

  async exec(
    prompt: string,
    events: CopyOnlyEvent[],
    scratchpad: any
  ): Promise<{ result: undefined; scratchpad: any }> {
    await clipboard.write(prompt);

    return { result: undefined, scratchpad };
  }

  async post(
    result: string,
    store: SharedStore<CopyOnlyContext, CopyOnlyEvent>
  ): Promise<StateResult<CopyOnlyState, CopyOnlyEvent>> {
    return {
      status: 'transition',
      to: 'waiting_for_user',
      actions: [
        {
          id: crypto.randomUUID(),
          type: 'PROMPT',
          payload: {
            message:
              'Please paste the prompt into your agent and when it is done, press Enter to continue or `c` to copy again.',
          },
        },
      ],
    };
  }
}

export class HandleResponseNode extends NoopNode<CopyOnlyState, CopyOnlyContext, CopyOnlyEvent> {
  constructor() {
    super('waiting_for_user');
  }

  async post(
    _result: undefined,
    store: SharedStore<CopyOnlyContext, CopyOnlyEvent>
  ): Promise<StateResult<CopyOnlyState, CopyOnlyEvent>> {
    const event = store.dequeueEvent();

    if (event?.payload.message === 'c') {
      return {
        status: 'transition',
        to: 'copy',
      };
    } else {
      return {
        status: 'transition',
        to: 'done',
      };
    }
  }
}

// Final node - represents completion
export class DoneNode extends FinalNode<CopyOnlyState, CopyOnlyContext, CopyOnlyEvent> {
  constructor() {
    super('done');
  }

  async post(
    result: null,
    store: SharedStore<CopyOnlyContext, CopyOnlyEvent>
  ): Promise<StateResult<CopyOnlyState, CopyOnlyEvent>> {
    return {
      status: 'terminal',
    };
  }
}

// Main state machine class for CopyOnly execution
export class CopyOnlyStateMachine {
  private machine: StateMachine<CopyOnlyState, CopyOnlyContext, CopyOnlyEvent>;

  constructor(
    contextContent: string,
    options: CopyOnlyExecutorOptions,
    sharedOptions: ExecutorCommonOptions,
    rmplanConfig: RmplanConfig
  ) {
    // Create initial context
    const initialContext: CopyOnlyContext = {
      contextContent,
      options,
      sharedOptions,
      rmplanConfig,
    };

    // Create the state machine
    this.machine = new StateMachine<CopyOnlyState, CopyOnlyContext, CopyOnlyEvent>(
      {
        initialState: 'copy',
        errorState: 'done',
        nodes: [new CopyNode(), new HandleResponseNode(), new DoneNode()],
      },
      // In-memory persistence adapter (no persistence needed)
      {
        write: async () => {},
        writeEvents: async () => {},
        read: async () => {
          throw new Error('Not implemented');
        },
      },
      initialContext,
      `copy-only-${Date.now()}`
    );
  }

  // Temporary runner until the parts farther up in the system are converted.
  // Run the state machine to completion
  async run(): Promise<void> {
    // Initialize the state machine
    await this.machine.initialize();

    // Start with no events
    let result = await this.machine.resume([]);

    // Keep running while the state machine is waiting or transitioning
    while (result.status === 'waiting' || result.status === 'transition') {
      // If we're in a transition, let the state machine continue
      if (result.status === 'transition') {
        // The machine will handle the transition itself in the resume call
        result = await this.machine.resume([]);
      } else {
        const newEvents: CopyOnlyEvent[] = [];
        for (const action of result.actions ?? []) {
          if (action.type === 'PROMPT') {
            log('\n' + chalk.bold(action.payload.message));
            const response = await waitForEnter();
            newEvents.push({
              id: crypto.randomUUID(),
              type: 'RESPONSE',
              payload: { message: response },
            });
          }
        }

        result = await this.machine.resume(newEvents);
      }
    }
  }
}

/**
 * The 'copy-only' executor that uses a state machine internally.
 * This executor copies the prompt to the clipboard, for pasting into an agent.
 */
export class CopyOnlyStateMachineExecutor implements Executor {
  static name = 'copy-only-statemachine';
  static description =
    'State machine based executor that copies the prompt into the clipboard for you to send to an agent';
  static optionsSchema = copyOnlyOptionsSchema;

  constructor(
    public options: CopyOnlyExecutorOptions,
    public sharedOptions: ExecutorCommonOptions,
    public rmplanConfig: RmplanConfig
  ) {}

  prepareStepOptions(): Partial<PrepareNextStepOptions> {
    return { rmfilter: false };
  }

  async execute(contextContent: string) {
    const stateMachine = new CopyOnlyStateMachine(
      contextContent,
      this.options,
      this.sharedOptions,
      this.rmplanConfig
    );

    await stateMachine.run();
  }
}

// Export the default executor for registration
export default CopyOnlyStateMachineExecutor;
