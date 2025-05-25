import { describe, expect, test, beforeEach, jest } from 'bun:test';
import { EventBus } from './event_bus.ts';
import type { BaseEvent } from './events.ts';
import type { SystemEvent } from './event_bus.ts';

interface TestEvent extends BaseEvent {
  type: 'TEST_EVENT' | 'ANOTHER_EVENT';
  payload?: string;
}

describe('EventBus', () => {
  let eventBus: EventBus;

  beforeEach(() => {
    eventBus = new EventBus();
  });

  test('should register and unregister machines', async () => {
    const handler = jest.fn();
    eventBus.registerMachine('machine1', handler);
    
    // Emit event to machine
    await eventBus.emit({
      id: '1',
      type: 'TEST_EVENT',
      targetMachineId: 'machine1',
    });
    
    expect(handler).toHaveBeenCalledTimes(1);
    
    // Unregister and verify no more calls
    eventBus.unregisterMachine('machine1');
    await eventBus.emit({
      id: '2',
      type: 'TEST_EVENT',
      targetMachineId: 'machine1',
    });
    
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('should route events to correct machine', async () => {
    const handler1 = jest.fn();
    const handler2 = jest.fn();
    
    eventBus.registerMachine('machine1', handler1);
    eventBus.registerMachine('machine2', handler2);
    
    await eventBus.emit({
      id: '1',
      type: 'TEST_EVENT',
      targetMachineId: 'machine1',
    });
    
    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(0);
  });

  test('should support parent-child hierarchy', async () => {
    const parentHandler = jest.fn();
    const childHandler = jest.fn();
    
    eventBus.registerMachine('parent', parentHandler);
    eventBus.registerMachine('child', childHandler, 'parent');
    
    // System event from child should go to parent
    await eventBus.emitSystemEvent({
      id: '1',
      type: 'MACHINE_WAITING',
      payload: {
        machineId: 'child',
        state: 'waiting',
      },
    } as SystemEvent);
    
    expect(parentHandler).toHaveBeenCalledTimes(1);
    expect(childHandler).toHaveBeenCalledTimes(0);
  });

  test('should handle pattern subscriptions', async () => {
    const handler = jest.fn();
    const unsubscribe = eventBus.subscribe('parent.*', handler);
    
    eventBus.registerMachine('parent.child1', jest.fn());
    eventBus.registerMachine('parent.child2', jest.fn());
    
    await eventBus.emit({
      id: '1',
      type: 'TEST_EVENT',
      targetMachineId: 'parent.child1',
    });
    
    expect(handler).toHaveBeenCalledTimes(1);
    
    unsubscribe();
    
    await eventBus.emit({
      id: '2',
      type: 'TEST_EVENT',
      targetMachineId: 'parent.child2',
    });
    
    expect(handler).toHaveBeenCalledTimes(1); // Still 1, not called again
  });

  test('should bubble up events when target not found', async () => {
    const parentHandler = jest.fn();
    eventBus.registerMachine('parent', parentHandler);
    eventBus.registerMachine('child', jest.fn(), 'parent');
    
    // Event to non-existent grandchild should bubble to parent
    await eventBus.emit({
      id: '1',
      type: 'TEST_EVENT',
      targetMachineId: 'grandchild',
      sourceMachineId: 'child',
    });
    
    expect(parentHandler).toHaveBeenCalledTimes(1);
  });

  test('should broadcast events without target', async () => {
    const handler1 = jest.fn();
    const handler2 = jest.fn();
    
    eventBus.subscribe('*', handler1);
    eventBus.subscribe('*', handler2);
    
    await eventBus.emit({
      id: '1',
      type: 'TEST_EVENT',
      sourceMachineId: 'some-machine',
    });
    
    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
  });

  test('should handle machine ID paths correctly', () => {
    eventBus.registerMachine('grandparent', jest.fn());
    eventBus.registerMachine('parent', jest.fn(), 'grandparent');
    eventBus.registerMachine('child', jest.fn(), 'parent');
    
    const path = eventBus.getMachineIdPath('child');
    expect(path).toBe('grandparent.parent.child');
  });

  test('should clean up child machines when parent is unregistered', () => {
    eventBus.registerMachine('parent', jest.fn());
    eventBus.registerMachine('child1', jest.fn(), 'parent');
    eventBus.registerMachine('child2', jest.fn(), 'parent');
    eventBus.registerMachine('grandchild', jest.fn(), 'child1');
    
    eventBus.unregisterMachine('parent');
    
    // All descendants should be removed
    const handler = jest.fn();
    eventBus.registerMachine('test', handler);
    
    // These should not reach any handler since machines are unregistered
    ['parent', 'child1', 'child2', 'grandchild'].forEach(async (id) => {
      await eventBus.emit({
        id: '1',
        type: 'TEST_EVENT',
        targetMachineId: id,
      });
    });
    
    expect(handler).not.toHaveBeenCalled();
  });

  test('should handle errors in event handlers gracefully', async () => {
    const errorHandler = jest.fn().mockRejectedValue(new Error('Handler error'));
    const goodHandler = jest.fn();
    
    eventBus.registerMachine('error-machine', errorHandler);
    eventBus.registerMachine('good-machine', goodHandler);
    
    // Emit to both - error shouldn't prevent good handler from running
    await eventBus.emit({
      id: '1',
      type: 'TEST_EVENT',
      targetMachineId: 'error-machine',
    });
    
    await eventBus.emit({
      id: '2',
      type: 'TEST_EVENT',
      targetMachineId: 'good-machine',
    });
    
    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(goodHandler).toHaveBeenCalledTimes(1);
  });

  test('clear() should remove all handlers and registrations', async () => {
    const handler = jest.fn();
    eventBus.registerMachine('machine1', handler);
    eventBus.subscribe('*', handler);
    
    eventBus.clear();
    
    await eventBus.emit({
      id: '1',
      type: 'TEST_EVENT',
      targetMachineId: 'machine1',
    });
    
    await eventBus.emit({
      id: '2',
      type: 'TEST_EVENT',
    });
    
    expect(handler).not.toHaveBeenCalled();
  });
});