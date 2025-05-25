import type { BaseEvent } from './events.ts';
import { getActiveSpan } from './telemetry.ts';

/**
 * Extended event type that includes routing information
 */
export interface RoutedEvent<T extends BaseEvent = BaseEvent> extends BaseEvent {
  /** Target machine ID using dot notation (e.g., "parent.child.grandchild") */
  targetMachineId?: string;
  /** Source machine ID for tracking event origin */
  sourceMachineId?: string;
  /** Original event payload */
  payload?: T['payload'];
}

/**
 * System events for internal state machine communication
 */
export interface SystemEvent extends BaseEvent {
  type: 'MACHINE_STATE_CHANGED' | 'MACHINE_WAITING' | 'MACHINE_TERMINAL' | 'MACHINE_ERROR';
  payload: {
    machineId: string;
    state?: string;
    error?: Error;
  };
}

/**
 * Event handler function type
 */
export type EventHandler<T extends BaseEvent = BaseEvent> = (event: T) => Promise<void>;

/**
 * EventBus manages event routing between state machines
 */
export class EventBus {
  private handlers = new Map<string, Set<EventHandler>>();
  private machineHandlers = new Map<string, EventHandler>();
  private parentChildMap = new Map<string, string>(); // child -> parent mapping

  /**
   * Subscribe a handler to events for a specific pattern
   * @param pattern - Can be a specific machine ID or a pattern (e.g., "parent.*" for all children)
   * @param handler - The event handler function
   */
  subscribe(pattern: string, handler: EventHandler): () => void {
    if (!this.handlers.has(pattern)) {
      this.handlers.set(pattern, new Set());
    }
    this.handlers.get(pattern)!.add(handler);

    // Return unsubscribe function
    return () => {
      const handlers = this.handlers.get(pattern);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          this.handlers.delete(pattern);
        }
      }
    };
  }

  /**
   * Register a machine's main event handler
   * @param machineId - The machine's unique ID
   * @param handler - The machine's event handler
   * @param parentId - Optional parent machine ID for hierarchy
   */
  registerMachine(machineId: string, handler: EventHandler, parentId?: string): void {
    this.machineHandlers.set(machineId, handler);
    if (parentId) {
      this.parentChildMap.set(machineId, parentId);
    }

    const span = getActiveSpan();
    span?.addEvent('machine_registered', {
      machine_id: machineId,
      parent_id: parentId,
    });
  }

  /**
   * Unregister a machine
   * @param machineId - The machine's unique ID
   */
  unregisterMachine(machineId: string): void {
    this.machineHandlers.delete(machineId);
    this.parentChildMap.delete(machineId);
    
    // Also remove any child machines
    const childIds = Array.from(this.parentChildMap.entries())
      .filter(([_, parentId]) => parentId === machineId)
      .map(([childId]) => childId);
    
    for (const childId of childIds) {
      this.unregisterMachine(childId);
    }

    const span = getActiveSpan();
    span?.addEvent('machine_unregistered', {
      machine_id: machineId,
      removed_children: childIds.length,
    });
  }

  /**
   * Emit an event to the bus
   * @param event - The event to emit
   */
  async emit(event: RoutedEvent): Promise<void> {
    const span = getActiveSpan();
    span?.addEvent('event_emitted', {
      event_type: event.type,
      event_id: event.id,
      source: event.sourceMachineId,
      target: event.targetMachineId,
    });

    const handlers: EventHandler[] = [];

    // If target is specified, route directly
    if (event.targetMachineId) {
      const targetHandler = this.machineHandlers.get(event.targetMachineId);
      if (targetHandler) {
        handlers.push(targetHandler);
      }
      
      // Also check pattern subscriptions
      for (const [pattern, patternHandlers] of this.handlers) {
        if (this.matchesPattern(event.targetMachineId, pattern)) {
          handlers.push(...patternHandlers);
        }
      }

      // If no handlers found and target not found, try bubbling up
      if (handlers.length === 0 && this.shouldBubbleUp(event)) {
        await this.bubbleUp(event);
        return;
      }
    } else {
      // Broadcast to all pattern subscribers
      for (const [pattern, patternHandlers] of this.handlers) {
        if (this.matchesPattern(event.sourceMachineId || '', pattern)) {
          handlers.push(...patternHandlers);
        }
      }
    }

    // Execute all handlers concurrently
    if (handlers.length > 0) {
      await Promise.all(handlers.map(async (handler) => {
        if (handler && typeof handler === 'function') {
          try {
            await handler(event);
          } catch (error) {
            span?.recordException(error);
            console.error(`Event handler error for ${event.type}:`, error);
          }
        }
      }));
    }
  }

  /**
   * Emit a system event (state change, waiting, terminal, etc.)
   * @param event - The system event
   */
  async emitSystemEvent(event: SystemEvent): Promise<void> {
    const parentId = this.parentChildMap.get(event.payload.machineId);
    if (parentId) {
      // Route system events to parent
      await this.emit({
        ...event,
        targetMachineId: parentId,
        sourceMachineId: event.payload.machineId,
      });
    }
  }

  /**
   * Check if an event should bubble up to parent
   */
  private shouldBubbleUp(event: RoutedEvent): boolean {
    // Don't bubble system events or events with explicit targets
    return !event.type.startsWith('MACHINE_') && !event.targetMachineId?.includes('.');
  }

  /**
   * Bubble an event up the hierarchy
   */
  private async bubbleUp(event: RoutedEvent): Promise<void> {
    if (!event.sourceMachineId) return;

    const parentId = this.parentChildMap.get(event.sourceMachineId);
    if (parentId) {
      const span = getActiveSpan();
      span?.addEvent('event_bubbled_up', {
        from: event.sourceMachineId,
        to: parentId,
      });

      await this.emit({
        ...event,
        targetMachineId: parentId,
      });
    }
  }

  /**
   * Check if a machine ID matches a pattern
   */
  private matchesPattern(machineId: string, pattern: string): boolean {
    if (pattern === '*') return true;
    if (pattern === machineId) return true;
    
    // Handle wildcard patterns like "parent.*"
    if (pattern.endsWith('.*')) {
      const prefix = pattern.slice(0, -2);
      return machineId.startsWith(prefix + '.');
    }
    
    return false;
  }

  /**
   * Get the full machine ID path including parent hierarchy
   */
  getMachineIdPath(machineId: string): string {
    const path: string[] = [machineId];
    let currentId = machineId;
    
    while (this.parentChildMap.has(currentId)) {
      const parentId = this.parentChildMap.get(currentId)!;
      path.unshift(parentId);
      currentId = parentId;
    }
    
    return path.join('.');
  }

  /**
   * Clear all handlers and registrations
   */
  clear(): void {
    this.handlers.clear();
    this.machineHandlers.clear();
    this.parentChildMap.clear();
  }
}

// Global event bus instance
export const globalEventBus = new EventBus();