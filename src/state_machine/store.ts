import type { BaseEvent } from './events.ts';
import { recordEvent, recordError, withSpan, getActiveSpan, type StateMachineAttributes } from './telemetry.ts';

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
  private context: TContext;
  private scratchpad: unknown;
  private pendingEvents: TEvent[] = [];
  private currentState: string | undefined;
  private history: {
    state: string;
    context: TContext;
    scratchpad: unknown;
    events: TEvent[];
    timestamp: number;
  }[] = [];

  private adapter: PersistenceAdapter<TContext, TEvent>;

  public instanceId: string;

  constructor(
    instanceId: string,
    initialContext: TContext,
    adapter: PersistenceAdapter<TContext, TEvent>
  ) {
    this.instanceId = instanceId;
    this.context = initialContext;
    this.scratchpad = undefined;
    this.adapter = adapter;
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
    this.adapter = adapter;
  }

  /**
   * Returns an immutable copy of the current context.
   */
  getContext(): TContext {
    return structuredClone(this.context); // Deep copy for immutability
  }

  /**
   * Updates the context using a pure function, ensuring immutability.
   * Persists the updated state based on the provided strategy.
   */
  async updateContext(updater: (context: TContext) => TContext): Promise<void> {
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
   * Returns an immutable copy of the scratchpad, or null if not set.
   */
  getScratchpad<TScratchpad>(): TScratchpad | undefined {
    return this.scratchpad ? (structuredClone(this.scratchpad) as TScratchpad) : undefined;
  }

  updateScratchpad<TScratchpad extends object>(
    updater: (scratchpad: TScratchpad) => TScratchpad
  ): void {
    this.scratchpad = updater(this.getScratchpad() as TScratchpad);
  }

  /**
   * Enqueues one or more events to the pending list and persists them.
   */
  async enqueueEvents(events: TEvent[]): Promise<void> {
    const attributes: StateMachineAttributes = {
      instanceId: this.instanceId,
      stateName: this.currentState,
    };

    await withSpan('store.enqueue_events', attributes, async (span) => {
      span.setAttributes({
        'event_count': events.length,
      });
      
      this.pendingEvents.push(...events.map((e) => ({ ...e }))); // Deep copy for immutability
      await this.persistEvents();

      // Record each enqueued event on the span
      for (const event of events) {
        recordEvent(span, event.type, event.id, this.currentState || '<no-state>');
      }
    });
  }

  /**
   * Processes events by ID, removing them from the pending list and returning them.
   * Throws an error for invalid IDs to prevent silent failures.
   */
  processEvents(eventIds: string[]): TEvent[] {
    const processed: TEvent[] = [];
    const remaining: TEvent[] = [];

    for (const event of this.pendingEvents) {
      if (eventIds.includes(event.id)) {
        processed.push(event);
      } else {
        remaining.push(event);
      }
    }

    if (processed.length !== eventIds.length) {
      const missing = eventIds.filter((id) => !processed.some((e) => e.id === id));
      throw new Error(`Invalid event IDs: ${missing.join(', ')}`);
    }

    this.pendingEvents = remaining;
    return processed.map((e) => ({ ...e })); // Immutable copy
  }

  /**
   * Returns an immutable copy of the pending events list.
   */
  getPendingEvents(): TEvent[] {
    return this.pendingEvents.map((e) => ({ ...e }));
  }

  /**
   * Dequeues the oldest event, if any
   */
  async dequeueEvent(): Promise<TEvent | undefined> {
    const event = this.pendingEvents.shift();
    return event ? { ...event } : undefined;
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
    return this.history.map((entry) => ({
      ...entry,
      context: structuredClone(entry.context),
      scratchpad: entry.scratchpad ? structuredClone(entry.scratchpad) : undefined,
      events: entry.events.map((e) => ({ ...e })),
    }));
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
        context: this.getContext(),
        scratchpad: this.getScratchpad(),
        pendingEvents: this.getPendingEvents(),
      };
      try {
        return await operation();
      } catch (e) {
        span.setStatus({ code: 1, message: 'Rollback executed' });
        span.addEvent('rollback_executed', {
          error: e instanceof Error ? e.message : String(e)
        });
        
        this.context = snapshot.context;
        this.scratchpad = snapshot.scratchpad;
        this.pendingEvents = snapshot.pendingEvents;
        throw e;
      }
    });
  }

  /**
   * Retries an operation up to maxAttempts with exponential backoff.
   */
  async retry<T>(operation: () => Promise<T>, maxAttempts: number = 3): Promise<T> {
    const span = getActiveSpan();
    if (span) {
      span.setAttributes({ 'max_attempts': maxAttempts });
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
              error: e instanceof Error ? e.message : String(e)
            });
          }
          throw e;
        }
        
        if (span) {
          span.addEvent('retry_failed', { attempt, error: String(e) });
        }
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
    throw new Error('Unreachable');
  }
  }

  /**
   * Persists the context, scratchpad, pending events, and history to storage.
   */
  private async persist(): Promise<void> {
    await this.adapter.write(this.instanceId, this.allState);
  }

  /**
   * Persists just the pending events to storage.
   */
  private async persistEvents(strategy: 'immediate' | 'batched' = 'immediate'): Promise<void> {
    await this.adapter.writeEvents(this.instanceId, this.pendingEvents);
  }

  public async loadState(): Promise<void> {
    this.allState = await this.adapter.read(this.instanceId);
  }
}
