import type { BaseEvent } from './events.ts';
import {
  recordEvent,
  recordError,
  withSpan,
  getActiveSpan,
  type StateMachineAttributes,
} from './telemetry.ts';

export interface AllState<TContext, TEvent extends BaseEvent> {
  context: TContext;
  scratchpad: unknown;
  pendingEvents: TEvent[];
  history: {
    state: string;
    context: TContext;
    scratchpad: unknown;
    events: TEvent[];
    timestamp: number;
  }[];
}

export interface PersistenceAdapter<TContext, TEvent extends BaseEvent> {
  write(instanceId: string, state: AllState<TContext, TEvent>): Promise<void>;
  writeEvents(instanceId: string, events: TEvent[]): Promise<void>;
  read(instanceId: string): Promise<AllState<TContext, TEvent>>;
}

/**
 * SharedStore manages the state machine's shared context, scratchpad, events, and history.
 * It provides type-safe access, persistence, rollback, retry, and observability features.
 */
export class SharedStore<TContext, TEvent extends BaseEvent> {
  context: TContext;
  scratchpad: unknown;
  pendingEvents: TEvent[] = [];
  currentState: string | undefined;
  private isInRollback = false;
  private rollbackEventQueue: TEvent[] = [];
  history: {
    state: string;
    context: TContext;
    scratchpad: unknown;
    events: TEvent[];
    timestamp: number;
  }[] = [];

  private persistenceAdapter: PersistenceAdapter<TContext, TEvent>;

  public instanceId: string;

  // Retry configuration
  maxRetries: number = 3;
  retryDelay: (attempt: number) => number = (attempt) => 0;

  constructor(
    instanceId: string,
    initialContext: TContext,
    adapter: PersistenceAdapter<TContext, TEvent>,
    options?: {
      maxRetries?: number;
      retryDelay?: (attempt: number) => number;
    }
  ) {
    this.instanceId = instanceId;
    this.context = initialContext;
    this.scratchpad = undefined;
    this.persistenceAdapter = adapter;

    // Set retry configuration if provided
    if (options) {
      if (options.maxRetries !== undefined) {
        this.maxRetries = options.maxRetries;
      }

      if (options.retryDelay) {
        this.retryDelay = options.retryDelay;
      }
    }
  }

  get allState(): AllState<TContext, TEvent> {
    return {
      context: this.context,
      scratchpad: this.scratchpad,
      pendingEvents: this.pendingEvents,
      history: this.history,
    };
  }

  set allState(state: AllState<TContext, TEvent>) {
    this.context = state.context;
    this.scratchpad = state.scratchpad;
    this.pendingEvents = state.pendingEvents;
    this.history = state.history;
  }

  /** Override the persistence adapter */
  setAdapter(adapter: PersistenceAdapter<TContext, TEvent>): void {
    this.persistenceAdapter = adapter;
  }

  /**
   * Returns the current context.
   */
  getContext(): TContext {
    return this.context;
  }

  /**
   * Updates the context using a pure function, ensuring immutability.
   * Persists the updated state based on the provided strategy.
   */
  updateContext(updater: (context: TContext) => TContext): void {
    this.context = updater(this.getContext());
  }

  /**
   * Sets the scratchpad data, which is cleared on state exit.
   * Persists the scratchpad to support hibernation.
   */
  setScratchpad(scratchpad: unknown): void {
    this.scratchpad = scratchpad;
  }

  /**
   * Clears the scratchpad when exiting a state.
   */
  clearScratchpad(): void {
    this.scratchpad = undefined;
  }

  /**
   * Returns the scratchpad, or undefined if not set.
   */
  getScratchpad<TScratchpad>(): TScratchpad | undefined {
    return this.scratchpad as TScratchpad | undefined;
  }

  updateScratchpad<TScratchpad extends object>(
    updater: (scratchpad: TScratchpad) => TScratchpad
  ): void {
    this.scratchpad = updater(this.getScratchpad() as TScratchpad);
  }

  /**
   * Enqueues one or more events to the pending list and persists them.
   */
  async enqueueEvents(events: TEvent[]) {
    const attributes: StateMachineAttributes = {
      instanceId: this.instanceId,
      stateName: this.currentState,
    };

    await withSpan('store.enqueue_events', attributes, async (span) => {
      span.setAttributes({
        event_count: events.length,
      });

      const eventList = structuredClone(events);

      // If we're in a rollback, queue the events instead of adding them to pending
      if (this.isInRollback) {
        this.rollbackEventQueue.push(...eventList);
        span.addEvent('events_queued_during_rollback', {
          queued_count: events.length,
        });
      }

      this.pendingEvents.push(...eventList);
      await this.persistEvents();

      // Record each enqueued event on the span
      for (const event of events) {
        recordEvent(span, event.type, event.id, this.currentState || '<no-state>');
      }
    });
  }

  /**
   * Removes the specified events from the pending list by reference.
   * @param events The events to remove
   * @returns The number of events removed
   */
  removeEvents(events: TEvent[]): number {
    const initialLength = this.pendingEvents.length;
    this.pendingEvents = this.pendingEvents.filter((event) => !events.includes(event));
    return initialLength - this.pendingEvents.length;
  }

  /**
   * Gets all events of a specific type
   * @param type The event type to filter by
   * @returns Array of matching events
   */
  getEventsOfType<EventType extends TEvent['type']>(type: EventType): TEvent[] {
    return this.pendingEvents.filter((event) => event.type === type);
  }

  /**
   * Removes and returns all events of a specific type
   * @param type The event type to dequeue
   * @returns Array of removed events
   */
  dequeueEventsOfType<EventType extends TEvent['type']>(type: EventType): TEvent[] {
    const matching: TEvent[] = [];
    const remaining: TEvent[] = [];

    for (const event of this.pendingEvents) {
      if (event.type === type) {
        matching.push(event);
      } else {
        remaining.push(event);
      }
    }

    this.pendingEvents = remaining;
    return matching;
  }

  /**
   * Removes and returns all pending events
   * @returns Array of all pending events
   */
  dequeueAllEvents(): TEvent[] {
    const events = [...this.pendingEvents];
    this.pendingEvents = [];
    return events;
  }

  /**
   * Dequeues the oldest event, if any
   */
  dequeueEvent(): TEvent | undefined {
    return this.pendingEvents.shift();
  }

  /**
   * Logs a state transition with context, scratchpad, and events for observability.
   */
  logTransition(state: string, events: TEvent[]): void {
    this.history.push({
      state,
      context: this.getContext(),
      scratchpad: this.getScratchpad(),
      events: events.map((e) => ({ ...e })),
      timestamp: Date.now(),
    });
  }

  /**
   * Returns the current state from the latest history entry, or undefined if no history.
   */
  getCurrentState(): string | undefined {
    return this.currentState ?? this.history[this.history.length - 1]?.state;
  }

  /**
   * Sets the current state (used during transitions)
   */
  setCurrentState(state: string): void {
    this.currentState = state;
  }

  /**
   * Returns an immutable copy of the execution history.
   */
  getExecutionTrace(): typeof this.history {
    return structuredClone(this.history);
  }

  /**
   * Exports the execution trace as a JSON string for debugging.
   */
  exportTrace(): string {
    return JSON.stringify(this.getExecutionTrace(), null, 2);
  }

  /**
   * Executes an operation with rollback support to ensure context consistency.
   */
  async withRollback<T>(operation: () => Promise<T>): Promise<T> {
    const attributes: StateMachineAttributes = {
      instanceId: this.instanceId,
      stateName: this.currentState,
    };

    return await withSpan('store.with_rollback', attributes, async (span) => {
      const snapshot = {
        context: structuredClone(this.getContext()),
        scratchpad: structuredClone(this.getScratchpad()),
        pendingEvents: structuredClone(this.pendingEvents),
      };

      // Clear the rollback event queue and set the rollback flag
      this.rollbackEventQueue = [];
      this.isInRollback = true;

      try {
        return await operation();
      } catch (e) {
        span.setStatus({ code: 1, message: 'Rollback executed' });
        const queuedEventCount = this.rollbackEventQueue.length;

        // Restore the original state
        this.context = snapshot.context;
        this.scratchpad = snapshot.scratchpad;
        this.pendingEvents = snapshot.pendingEvents;

        // Add any events that arrived during the rollback to the pending events
        if (queuedEventCount > 0) {
          this.pendingEvents.push(...this.rollbackEventQueue);
          span.addEvent('applied_queued_events_after_rollback', {
            queued_event_count: queuedEventCount,
          });
        }

        // Clear the rollback flag and queue
        this.isInRollback = false;
        this.rollbackEventQueue = [];

        // Persist the final state (with any queued events if there was a rollback)
        await this.persist();

        // Re-throw the original error
        throw e;
      } finally {
        // Ensure we always clear the rollback flag, even if there was an error during rollback
        this.isInRollback = false;
      }
    });
  }

  /**
   * Retries an operation up to maxRetries times with configurable delay.
   * @param operation The operation to retry
   * @param maxAttemptsOverride Optional override for the configured maxRetries
   * @returns The result of the operation
   */
  async retry<T>(operation: () => Promise<T>, maxAttemptsOverride?: number): Promise<T> {
    const maxAttempts = maxAttemptsOverride !== undefined ? maxAttemptsOverride : this.maxRetries;
    const span = getActiveSpan();

    if (span) {
      span.setAttributes({ max_attempts: maxAttempts });
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (span) {
          span.addEvent('retry_attempt', { attempt });
        }
        return await operation();
      } catch (e) {
        if (attempt === maxAttempts) {
          if (span) {
            span.setStatus({ code: 1, message: 'Max retries reached' });
            span.addEvent('max_retries_reached', {
              attempts: maxAttempts,
              error: e instanceof Error ? e.message : String(e),
            });
          }
          throw e;
        }

        if (span) {
          span.addEvent('retry_failed', { attempt, error: String(e) });
        }

        // Use the configured retryDelay function
        const delay = this.retryDelay(attempt);
        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    throw new Error('Unreachable');
  }

  /**
   * Persists the context, scratchpad, pending events, and history to storage.
   */
  private async persist(): Promise<void> {
    await this.persistenceAdapter.write(this.instanceId, this.allState);
  }

  /**
   * Persists just the pending events to storage.
   */
  private async persistEvents(strategy: 'immediate' | 'batched' = 'immediate'): Promise<void> {
    await this.persistenceAdapter.writeEvents(this.instanceId, this.pendingEvents);
  }

  public async loadState(): Promise<void> {
    this.allState = await this.persistenceAdapter.read(this.instanceId);
  }
}
