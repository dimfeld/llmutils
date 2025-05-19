import { describe, test, expect } from 'bun:test';
import { Event, type BaseEvent, type BaseAction } from './events';

describe('Events', () => {
  test('BaseEvent interface has required properties', () => {
    const event: BaseEvent = {
      id: 'test-id',
      type: 'TEST_EVENT',
      payload: { value: 'test' }
    };
    
    expect(event.id).toBe('test-id');
    expect(event.type).toBe('TEST_EVENT');
    expect(event.payload).toEqual({ value: 'test' });
  });
  
  test('BaseAction interface has required properties', () => {
    const action: BaseAction = {
      id: 'action-id',
      type: 'TEST_ACTION',
      payload: { value: 'action' }
    };
    
    expect(action.id).toBe('action-id');
    expect(action.type).toBe('TEST_ACTION');
    expect(action.payload).toEqual({ value: 'action' });
  });
  
  test('Event type utility creates proper event types', () => {
    type TestEvent =
      | Event<'USER_LOGIN', { username: string; password: string }>
      | Event<'USER_LOGOUT', void>
      | Event<'UPDATE_PROFILE', { name: string; email: string }>;
    
    // Login event
    const loginEvent: TestEvent = {
      id: 'login-1',
      type: 'USER_LOGIN',
      payload: { username: 'test', password: 'password' }
    };
    
    // Logout event
    const logoutEvent: TestEvent = {
      id: 'logout-1',
      type: 'USER_LOGOUT',
      payload: undefined
    };
    
    // Profile update event
    const updateEvent: TestEvent = {
      id: 'update-1',
      type: 'UPDATE_PROFILE',
      payload: { name: 'Test User', email: 'test@example.com' }
    };
    
    // Type checking (TypeScript will fail if these don't match the types)
    expect(loginEvent.type).toBe('USER_LOGIN');
    expect(loginEvent.payload.username).toBe('test');
    expect(loginEvent.payload.password).toBe('password');
    
    expect(logoutEvent.type).toBe('USER_LOGOUT');
    expect(logoutEvent.payload).toBeUndefined();
    
    expect(updateEvent.type).toBe('UPDATE_PROFILE');
    expect(updateEvent.payload.name).toBe('Test User');
    expect(updateEvent.payload.email).toBe('test@example.com');
  });
  
  test('Events can be used for type discrimination', () => {
    type AppEvent =
      | Event<'INCREMENT', { amount: number }>
      | Event<'DECREMENT', { amount: number }>
      | Event<'RESET', void>;
    
    function processEvent(event: AppEvent): number {
      switch (event.type) {
        case 'INCREMENT':
          return event.payload.amount; // TypeScript knows payload has amount
        case 'DECREMENT':
          return -event.payload.amount; // TypeScript knows payload has amount
        case 'RESET':
          return 0; // TypeScript knows payload is void
        default:
          // This exhaustiveness check ensures all event types are handled
          const _exhaustiveCheck: never = event;
          return 0;
      }
    }
    
    const incrementEvent: AppEvent = {
      id: 'inc-1',
      type: 'INCREMENT',
      payload: { amount: 5 }
    };
    
    const decrementEvent: AppEvent = {
      id: 'dec-1',
      type: 'DECREMENT',
      payload: { amount: 3 }
    };
    
    const resetEvent: AppEvent = {
      id: 'reset-1',
      type: 'RESET',
      payload: undefined
    };
    
    expect(processEvent(incrementEvent)).toBe(5);
    expect(processEvent(decrementEvent)).toBe(-3);
    expect(processEvent(resetEvent)).toBe(0);
  });
  
  test('Events with complex payloads', () => {
    interface User {
      id: string;
      name: string;
      email: string;
      roles: string[];
    }
    
    interface Order {
      id: string;
      items: { id: string; quantity: number; price: number }[];
      total: number;
    }
    
    type ComplexEvent =
      | Event<'USER_CREATED', User>
      | Event<'ORDER_PLACED', Order>
      | Event<'ITEMS_SHIPPED', { orderId: string; trackingNumber: string }>;
    
    const userEvent: ComplexEvent = {
      id: 'user-1',
      type: 'USER_CREATED',
      payload: {
        id: 'u123',
        name: 'Test User',
        email: 'test@example.com',
        roles: ['customer']
      }
    };
    
    const orderEvent: ComplexEvent = {
      id: 'order-1',
      type: 'ORDER_PLACED',
      payload: {
        id: 'o456',
        items: [
          { id: 'item1', quantity: 2, price: 10.99 },
          { id: 'item2', quantity: 1, price: 24.99 }
        ],
        total: 46.97
      }
    };
    
    const shippingEvent: ComplexEvent = {
      id: 'ship-1',
      type: 'ITEMS_SHIPPED',
      payload: {
        orderId: 'o456',
        trackingNumber: 'TRK123456'
      }
    };
    
    // Ensure TypeScript correctly identifies the payload types
    function getEventDescription(event: ComplexEvent): string {
      switch (event.type) {
        case 'USER_CREATED':
          return `User ${event.payload.name} (${event.payload.email}) created with ${event.payload.roles.length} roles`;
        case 'ORDER_PLACED':
          return `Order ${event.payload.id} placed with ${event.payload.items.length} items for $${event.payload.total}`;
        case 'ITEMS_SHIPPED':
          return `Order ${event.payload.orderId} shipped with tracking number ${event.payload.trackingNumber}`;
      }
    }
    
    expect(getEventDescription(userEvent)).toBe('User Test User (test@example.com) created with 1 roles');
    expect(getEventDescription(orderEvent)).toBe('Order o456 placed with 2 items for $46.97');
    expect(getEventDescription(shippingEvent)).toBe('Order o456 shipped with tracking number TRK123456');
  });
});