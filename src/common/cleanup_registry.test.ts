import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { CleanupRegistry } from './cleanup_registry.ts';

describe('CleanupRegistry', () => {
  beforeEach(() => {
    // Reset the singleton instance before each test
    CleanupRegistry['instance'] = undefined;
  });

  test('should be a singleton', () => {
    const instance1 = CleanupRegistry.getInstance();
    const instance2 = CleanupRegistry.getInstance();
    expect(instance1).toBe(instance2);
  });

  test('should register a handler and return unregister function', () => {
    const registry = CleanupRegistry.getInstance();
    const handler = mock(() => {});

    const unregister = registry.register(handler);
    expect(typeof unregister).toBe('function');
  });

  test('should execute all registered handlers', () => {
    const registry = CleanupRegistry.getInstance();
    const handler1 = mock(() => {});
    const handler2 = mock(() => {});
    const handler3 = mock(() => {});

    registry.register(handler1);
    registry.register(handler2);
    registry.register(handler3);

    registry.executeAll();

    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
    expect(handler3).toHaveBeenCalledTimes(1);
  });

  test('should unregister handlers', () => {
    const registry = CleanupRegistry.getInstance();
    const handler1 = mock(() => {});
    const handler2 = mock(() => {});

    const unregister1 = registry.register(handler1);
    registry.register(handler2);

    unregister1();
    registry.executeAll();

    expect(handler1).toHaveBeenCalledTimes(0);
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  test('should handle errors during cleanup execution', () => {
    const registry = CleanupRegistry.getInstance();
    const errorMessage = 'Cleanup failed';
    const failingHandler = mock(() => {
      throw new Error(errorMessage);
    });
    const successfulHandler = mock(() => {});

    registry.register(failingHandler);
    registry.register(successfulHandler);

    // Should not throw
    expect(() => registry.executeAll()).not.toThrow();

    // Both handlers should be called despite the error
    expect(failingHandler).toHaveBeenCalledTimes(1);
    expect(successfulHandler).toHaveBeenCalledTimes(1);
  });

  test('should clear registry after executeAll', () => {
    const registry = CleanupRegistry.getInstance();
    const handler = mock(() => {});

    registry.register(handler);
    registry.executeAll();

    // Handler should be called once
    expect(handler).toHaveBeenCalledTimes(1);

    // Executing again should not call the handler
    registry.executeAll();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('should run cleanup functions only once', () => {
    const registry = CleanupRegistry.getInstance();
    const handler = mock(() => {});

    const unregister = registry.register(handler);

    // Unregister the handler
    unregister();

    // Try to unregister again - should not throw
    expect(() => unregister()).not.toThrow();

    registry.executeAll();

    // Handler should not be called since it was unregistered
    expect(handler).toHaveBeenCalledTimes(0);
  });

  test('should handle multiple handlers with different execution orders', () => {
    const registry = CleanupRegistry.getInstance();
    const executionOrder: number[] = [];

    const handler1 = mock(() => executionOrder.push(1));
    const handler2 = mock(() => executionOrder.push(2));
    const handler3 = mock(() => executionOrder.push(3));

    registry.register(handler1);
    registry.register(handler2);
    registry.register(handler3);

    registry.executeAll();

    expect(executionOrder).toEqual([1, 2, 3]);
  });

  test('should generate unique IDs for each handler', () => {
    const registry = CleanupRegistry.getInstance();
    const unregisterFns: Array<() => void> = [];

    // Register multiple handlers
    for (let i = 0; i < 10; i++) {
      const unregister = registry.register(() => {});
      unregisterFns.push(unregister);
    }

    // All unregister functions should be unique
    const uniqueUnregisterFns = new Set(unregisterFns);
    expect(uniqueUnregisterFns.size).toBe(10);
  });

  test('should handle synchronous operations correctly', () => {
    const registry = CleanupRegistry.getInstance();
    let completed = false;

    const handler = () => {
      // Simulate synchronous operation
      for (let i = 0; i < 100; i++) {
        // Do some work
      }
      completed = true;
    };

    registry.register(handler);
    registry.executeAll();

    expect(completed).toBe(true);
  });
});
