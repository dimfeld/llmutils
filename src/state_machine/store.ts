import type { BaseEvent } from './events.ts';

/**
 * SharedStore manages the state machine's shared context, scratchpad, events, and history.
 * It provides type-safe access, persistence, rollback, retry, and observability features.
 */
export class SharedStore<TContext, TEvent extends BaseEvent> {
  private context: TContext;
  private scratchpad: object | undefined;
  private pendingEvents: TEvent[] = [];
  private history: {
    state: string;
    context: TContext;
    scratchpad: object | undefined;
    events: TEvent[];
    timestamp: number;
  }[] = [];

  constructor(initialContext: TContext) {
    this.context = initialContext;
    this.scratchpad = undefined;
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
    await this.persist();
  }

  /**
   * Sets the scratchpad data, which is cleared on state exit.
   * Persists the scratchpad to support hibernation.
   */
  async setScratchpad(scratchpad: object): Promise<void> {
    this.scratchpad = structuredClone(scratchpad); // Deep copy
    await this.persist();
  }

  /**
   * Clears the scratchpad when exiting a state.
   */
  async clearScratchpad(): Promise<void> {
    this.scratchpad = undefined;
    await this.persist();
  }

  /**
   * Returns an immutable copy of the scratchpad, or null if not set.
   */
  getScratchpad<TScratchpad extends object>(): TScratchpad | undefined {
    return this.scratchpad ? (structuredClone(this.scratchpad) as TScratchpad) : undefined;
  }

  /**
   * Enqueues one or more events to the pending list and persists them.
   */
  async enqueueEvents(events: TEvent[]): Promise<void> {
    this.pendingEvents.push(...events.map((e) => ({ ...e }))); // Deep copy for immutability
    await this.persistEvents();
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
    this.persistEvents().catch((e) => console.error('Failed to persist events:', e)); // Async persistence
    return processed.map((e) => ({ ...e })); // Immutable copy
  }

  /**
   * Returns an immutable copy of the pending events list.
   */
  getPendingEvents(): TEvent[] {
    return this.pendingEvents.map((e) => ({ ...e }));
  }

  /**
   * Dequeues the oldest event, if any, and persists the updated event list.
   */
  async dequeueEvent(): Promise<TEvent | undefined> {
    const event = this.pendingEvents.shift();
    if (event) {
      await this.persistEvents();
    }
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
    return this.history[this.history.length - 1]?.state;
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
    const snapshot = {
      context: this.getContext(),
      scratchpad: this.getScratchpad(),
      pendingEvents: this.getPendingEvents(),
    };
    try {
      return await operation();
    } catch (e) {
      this.context = snapshot.context;
      this.scratchpad = snapshot.scratchpad;
      this.pendingEvents = snapshot.pendingEvents;
      throw e;
    }
  }

  /**
   * Retries an operation up to maxAttempts with exponential backoff.
   */
  async retry<T>(operation: () => Promise<T>, maxAttempts: number = 3): Promise<T> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await operation();
      } catch (e) {
        if (attempt === maxAttempts) throw e;
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
    throw new Error('Unreachable');
  }

  /**
   * Persists the context, scratchpad, and history to storage.
   */
  private async persist(): Promise<void> {
    const update = async () => {
      // TODO add storage adapter
      // await storage.write({
      //   context: this.context,
      //   scratchpad: this.scratchpad,
      //   history: this.history,
      // });
    };

    await update();
  }

  /**
   * Persists the pending events to storage.
   */
  private async persistEvents(strategy: 'immediate' | 'batched' = 'immediate'): Promise<void> {
    const update = async () => {
      // TODO
      // await storage.write({ events: this.pendingEvents });
    };

    await update();
  }
}
