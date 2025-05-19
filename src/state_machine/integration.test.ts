import { describe, test, expect, beforeEach, mock, afterEach } from 'bun:test';
import { StateMachine, type StateMachineConfig, type StateMachineHooks } from './index';
import { Node, type StateResult } from './nodes';
import { SharedStore, type PersistenceAdapter } from './store';
import { trace, context } from '@opentelemetry/api';
import * as telemetry from './telemetry';
import type { BaseEvent } from './events';

// Define a task management state machine for integration testing

// Task statuses
type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled' | 'blocked';

// State names for the task management workflow
type TaskStateNames = 
  | 'created'
  | 'assigned'
  | 'in_progress'
  | 'review'
  | 'completed'
  | 'cancelled'
  | 'error';

// Context for the task management state machine
interface TaskContext {
  taskId: string;
  title: string;
  description: string;
  assignee: string | null;
  status: TaskStatus;
  priority: 'low' | 'medium' | 'high';
  comments: Array<{
    id: string;
    author: string;
    text: string;
    timestamp: number;
  }>;
  history: Array<{
    action: string;
    timestamp: number;
    actor: string;
    details?: any;
  }>;
  createdAt: number;
  updatedAt: number;
}

// Events for the task management state machine
interface TaskEvent extends BaseEvent {
  id: string;
  type: 
    | 'CREATE_TASK'
    | 'ASSIGN_TASK'
    | 'START_TASK'
    | 'ADD_COMMENT'
    | 'REQUEST_REVIEW'
    | 'APPROVE_TASK'
    | 'REJECT_TASK'
    | 'CANCEL_TASK'
    | 'UPDATE_TASK';
  payload: any;
  timestamp: number;
  actor: string;
}

// Create a mock persistence adapter
class MemoryAdapter implements PersistenceAdapter<TaskContext, TaskEvent> {
  private storage: Map<string, any> = new Map();
  private eventLog: Map<string, TaskEvent[]> = new Map();
  
  writeCallCount = 0;
  writeEventsCallCount = 0;
  readCallCount = 0;

  async write(instanceId: string, state: any): Promise<void> {
    this.writeCallCount++;
    this.storage.set(instanceId, structuredClone(state));
  }

  async writeEvents(instanceId: string, events: TaskEvent[]): Promise<void> {
    this.writeEventsCallCount++;
    const storedEvents = this.eventLog.get(instanceId) || [];
    this.eventLog.set(instanceId, [...storedEvents, ...structuredClone(events)]);
  }

  async read(instanceId: string): Promise<any> {
    this.readCallCount++;
    return this.storage.get(instanceId) || {
      context: null,
      scratchpad: undefined,
      pendingEvents: [],
      history: []
    };
  }
  
  getState(instanceId: string): any {
    return this.storage.get(instanceId);
  }
  
  getEvents(instanceId: string): TaskEvent[] {
    return this.eventLog.get(instanceId) || [];
  }
}

// Implementation of task management state machine
class TaskNode implements Node<TaskStateNames, TaskContext, TaskEvent, any, any, any> {
  constructor(public id: TaskStateNames) {}
  
  async run(store: SharedStore<TaskContext, TaskEvent>): Promise<StateResult<TaskStateNames, TaskEvent>> {
    // Get all pending events
    const events = store.getPendingEvents();
    
    // Record event processing in history
    if (events.length > 0) {
      await this.updateHistory(store, events);
    }
    
    // Handle events based on current state
    switch (this.id) {
      case 'created':
        return this.handleCreatedState(store, events);
      case 'assigned':
        return this.handleAssignedState(store, events);
      case 'in_progress':
        return this.handleInProgressState(store, events);
      case 'review':
        return this.handleReviewState(store, events);
      case 'completed':
        return this.handleCompletedState(store, events);
      case 'cancelled':
        return this.handleCancelledState(store, events);
      case 'error':
        return { status: 'terminal' };
      default:
        throw new Error(`Unknown state: ${this.id}`);
    }
  }
  
  private async updateHistory(
    store: SharedStore<TaskContext, TaskEvent>,
    events: TaskEvent[]
  ): Promise<void> {
    await store.updateContext(ctx => ({
      ...ctx,
      history: [
        ...ctx.history,
        ...events.map(e => ({
          action: e.type,
          timestamp: e.timestamp,
          actor: e.actor,
          details: e.payload
        }))
      ],
      updatedAt: Date.now()
    }));
  }
  
  private async handleCreatedState(
    store: SharedStore<TaskContext, TaskEvent>,
    events: TaskEvent[]
  ): Promise<StateResult<TaskStateNames, TaskEvent>> {
    const assignEvent = events.find(e => e.type === 'ASSIGN_TASK');
    
    if (assignEvent) {
      await store.updateContext(ctx => ({
        ...ctx,
        assignee: assignEvent.payload.assignee,
        status: 'pending',
        updatedAt: Date.now()
      }));
      
      return {
        status: 'transition',
        to: 'assigned'
      };
    }
    
    return { status: 'waiting' };
  }
  
  private async handleAssignedState(
    store: SharedStore<TaskContext, TaskEvent>,
    events: TaskEvent[]
  ): Promise<StateResult<TaskStateNames, TaskEvent>> {
    const startEvent = events.find(e => e.type === 'START_TASK');
    const cancelEvent = events.find(e => e.type === 'CANCEL_TASK');
    
    if (cancelEvent) {
      await store.updateContext(ctx => ({
        ...ctx,
        status: 'cancelled',
        updatedAt: Date.now()
      }));
      
      return {
        status: 'transition',
        to: 'cancelled'
      };
    }
    
    if (startEvent) {
      await store.updateContext(ctx => ({
        ...ctx,
        status: 'in_progress',
        updatedAt: Date.now()
      }));
      
      return {
        status: 'transition',
        to: 'in_progress'
      };
    }
    
    // Handle comments
    const commentEvent = events.find(e => e.type === 'ADD_COMMENT');
    if (commentEvent) {
      await store.updateContext(ctx => ({
        ...ctx,
        comments: [
          ...ctx.comments,
          {
            id: `comment-${Date.now()}`,
            author: commentEvent.actor,
            text: commentEvent.payload.text,
            timestamp: commentEvent.timestamp
          }
        ],
        updatedAt: Date.now()
      }));
    }
    
    return { status: 'waiting' };
  }
  
  private async handleInProgressState(
    store: SharedStore<TaskContext, TaskEvent>,
    events: TaskEvent[]
  ): Promise<StateResult<TaskStateNames, TaskEvent>> {
    const reviewEvent = events.find(e => e.type === 'REQUEST_REVIEW');
    const cancelEvent = events.find(e => e.type === 'CANCEL_TASK');
    
    if (cancelEvent) {
      await store.updateContext(ctx => ({
        ...ctx,
        status: 'cancelled',
        updatedAt: Date.now()
      }));
      
      return {
        status: 'transition',
        to: 'cancelled'
      };
    }
    
    if (reviewEvent) {
      await store.updateContext(ctx => ({
        ...ctx,
        status: 'pending', // Pending review
        updatedAt: Date.now()
      }));
      
      return {
        status: 'transition',
        to: 'review'
      };
    }
    
    // Handle comments
    const commentEvent = events.find(e => e.type === 'ADD_COMMENT');
    if (commentEvent) {
      await store.updateContext(ctx => ({
        ...ctx,
        comments: [
          ...ctx.comments,
          {
            id: `comment-${Date.now()}`,
            author: commentEvent.actor,
            text: commentEvent.payload.text,
            timestamp: commentEvent.timestamp
          }
        ],
        updatedAt: Date.now()
      }));
    }
    
    // Handle task updates
    const updateEvent = events.find(e => e.type === 'UPDATE_TASK');
    if (updateEvent) {
      await store.updateContext(ctx => ({
        ...ctx,
        ...updateEvent.payload,
        updatedAt: Date.now()
      }));
    }
    
    return { status: 'waiting' };
  }
  
  private async handleReviewState(
    store: SharedStore<TaskContext, TaskEvent>,
    events: TaskEvent[]
  ): Promise<StateResult<TaskStateNames, TaskEvent>> {
    const approveEvent = events.find(e => e.type === 'APPROVE_TASK');
    const rejectEvent = events.find(e => e.type === 'REJECT_TASK');
    const cancelEvent = events.find(e => e.type === 'CANCEL_TASK');
    
    if (cancelEvent) {
      await store.updateContext(ctx => ({
        ...ctx,
        status: 'cancelled',
        updatedAt: Date.now()
      }));
      
      return {
        status: 'transition',
        to: 'cancelled'
      };
    }
    
    if (approveEvent) {
      await store.updateContext(ctx => ({
        ...ctx,
        status: 'completed',
        updatedAt: Date.now()
      }));
      
      return {
        status: 'transition',
        to: 'completed',
        actions: [{
          id: `notification-${Date.now()}`,
          type: 'TASK_COMPLETED',
          payload: { taskId: store.getContext().taskId },
          timestamp: Date.now(),
          actor: approveEvent.actor
        }]
      };
    }
    
    if (rejectEvent) {
      await store.updateContext(ctx => ({
        ...ctx,
        status: 'in_progress',
        updatedAt: Date.now()
      }));
      
      return {
        status: 'transition',
        to: 'in_progress'
      };
    }
    
    // Handle comments
    const commentEvent = events.find(e => e.type === 'ADD_COMMENT');
    if (commentEvent) {
      await store.updateContext(ctx => ({
        ...ctx,
        comments: [
          ...ctx.comments,
          {
            id: `comment-${Date.now()}`,
            author: commentEvent.actor,
            text: commentEvent.payload.text,
            timestamp: commentEvent.timestamp
          }
        ],
        updatedAt: Date.now()
      }));
    }
    
    return { status: 'waiting' };
  }
  
  private async handleCompletedState(
    store: SharedStore<TaskContext, TaskEvent>,
    events: TaskEvent[]
  ): Promise<StateResult<TaskStateNames, TaskEvent>> {
    // Completed is a terminal state
    return { status: 'terminal' };
  }
  
  private async handleCancelledState(
    store: SharedStore<TaskContext, TaskEvent>,
    events: TaskEvent[]
  ): Promise<StateResult<TaskStateNames, TaskEvent>> {
    // Cancelled is a terminal state
    return { status: 'terminal' };
  }
}

describe('State Machine Integration Tests', () => {
  let adapter: MemoryAdapter;
  let taskMachine: StateMachine<TaskStateNames, TaskContext, TaskEvent>;
  let config: StateMachineConfig<TaskStateNames, TaskContext, TaskEvent>;
  let hooks: StateMachineHooks<TaskStateNames, TaskEvent>;
  const instanceId = 'task-123';
  
  // Setup mocks for OpenTelemetry
  const originalWithSpan = telemetry.withSpan;
  const originalRecordState = telemetry.recordStateTransition;
  const originalRecordEvent = telemetry.recordEvent;
  const originalRecordError = telemetry.recordError;

  beforeEach(() => {
    // Create persistence adapter
    adapter = new MemoryAdapter();
    
    // Create nodes for each state
    const nodes = new Map<TaskStateNames, Node<TaskStateNames, TaskContext, TaskEvent, any, any, any>>();
    nodes.set('created', new TaskNode('created'));
    nodes.set('assigned', new TaskNode('assigned'));
    nodes.set('in_progress', new TaskNode('in_progress'));
    nodes.set('review', new TaskNode('review'));
    nodes.set('completed', new TaskNode('completed'));
    nodes.set('cancelled', new TaskNode('cancelled'));
    nodes.set('error', new TaskNode('error'));
    
    // Create hooks
    hooks = {
      onTransition: mock((from, to) => {}),
      onError: mock(async (error, store) => ({ status: 'transition', to: 'error' }))
    };
    
    // Create initial context
    const initialContext: TaskContext = {
      taskId: instanceId,
      title: 'Test Task',
      description: 'This is a test task',
      assignee: null,
      status: 'pending',
      priority: 'medium',
      comments: [],
      history: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    
    // Create state machine config
    config = {
      initialState: 'created',
      errorState: 'error',
      nodes
    };
    
    // Create state machine
    taskMachine = new StateMachine(config, adapter, initialContext, instanceId, hooks);
    
    // Mock telemetry functions to avoid setup requirements
    telemetry.withSpan = mock((name, attrs, fn) => fn({ 
      addEvent: () => {}, 
      setAttributes: () => {} 
    } as any));
    
    telemetry.recordStateTransition = mock(() => {});
    telemetry.recordEvent = mock(() => {});
    telemetry.recordError = mock(() => {});
  });

  afterEach(() => {
    // Restore original telemetry functions
    telemetry.withSpan = originalWithSpan;
    telemetry.recordStateTransition = originalRecordState;
    telemetry.recordEvent = originalRecordEvent;
    telemetry.recordError = originalRecordError;
  });
  
  test('Task progresses through the complete lifecycle', async () => {
    // Initialize state machine
    await taskMachine.initialize();
    
    // Step 1: Assign the task
    await taskMachine.resume([
      createEvent('ASSIGN_TASK', { assignee: 'user1' }, 'admin')
    ]);
    
    // Check state
    expect(taskMachine.store.getCurrentState()).toBe('assigned');
    let context = taskMachine.store.getContext();
    expect(context.assignee).toBe('user1');
    expect(context.status).toBe('pending');
    expect(context.history.length).toBe(1);
    
    // Step 2: Start working on the task
    await taskMachine.resume([
      createEvent('START_TASK', {}, 'user1')
    ]);
    
    // Check state
    expect(taskMachine.store.getCurrentState()).toBe('in_progress');
    context = taskMachine.store.getContext();
    expect(context.status).toBe('in_progress');
    expect(context.history.length).toBe(2);
    
    // Step 3: Add a comment
    await taskMachine.resume([
      createEvent('ADD_COMMENT', { text: 'Working on this now' }, 'user1')
    ]);
    
    // Check comment was added
    context = taskMachine.store.getContext();
    expect(context.comments.length).toBe(1);
    expect(context.comments[0].text).toBe('Working on this now');
    expect(context.comments[0].author).toBe('user1');
    
    // Step 4: Request review
    await taskMachine.resume([
      createEvent('REQUEST_REVIEW', {}, 'user1')
    ]);
    
    // Check state
    expect(taskMachine.store.getCurrentState()).toBe('review');
    context = taskMachine.store.getContext();
    expect(context.status).toBe('pending');
    expect(context.history.length).toBe(4); // Assign + Start + Comment + Review
    
    // Step 5: Add review comment
    await taskMachine.resume([
      createEvent('ADD_COMMENT', { text: 'Looks good, just one small change needed' }, 'reviewer1')
    ]);
    
    // Check comment was added
    context = taskMachine.store.getContext();
    expect(context.comments.length).toBe(2);
    expect(context.comments[1].text).toBe('Looks good, just one small change needed');
    expect(context.comments[1].author).toBe('reviewer1');
    
    // Step 6: Reject for changes
    await taskMachine.resume([
      createEvent('REJECT_TASK', { reason: 'Minor changes needed' }, 'reviewer1')
    ]);
    
    // Check state returned to in_progress
    expect(taskMachine.store.getCurrentState()).toBe('in_progress');
    context = taskMachine.store.getContext();
    expect(context.status).toBe('in_progress');
    
    // Step 7: Add comment about the fix
    await taskMachine.resume([
      createEvent('ADD_COMMENT', { text: 'Made the requested changes' }, 'user1')
    ]);
    
    // Step 8: Request review again
    await taskMachine.resume([
      createEvent('REQUEST_REVIEW', {}, 'user1')
    ]);
    
    // Check state
    expect(taskMachine.store.getCurrentState()).toBe('review');
    
    // Step 9: Approve the task
    await taskMachine.resume([
      createEvent('APPROVE_TASK', {}, 'reviewer1')
    ]);
    
    // Check state is completed
    expect(taskMachine.store.getCurrentState()).toBe('completed');
    context = taskMachine.store.getContext();
    expect(context.status).toBe('completed');
    
    // Check history entries
    expect(context.history.length).toBe(8);
    expect(context.history[7].action).toBe('APPROVE_TASK');
  });
  
  test('Task can be cancelled at any point', async () => {
    // Initialize state machine
    await taskMachine.initialize();
    
    // Assign and start the task
    await taskMachine.resume([
      createEvent('ASSIGN_TASK', { assignee: 'user1' }, 'admin')
    ]);
    
    await taskMachine.resume([
      createEvent('START_TASK', {}, 'user1')
    ]);
    
    // Cancel the task while in progress
    await taskMachine.resume([
      createEvent('CANCEL_TASK', { reason: 'No longer needed' }, 'admin')
    ]);
    
    // Check state is cancelled
    expect(taskMachine.store.getCurrentState()).toBe('cancelled');
    let context = taskMachine.store.getContext();
    expect(context.status).toBe('cancelled');
    
    // Try to modify a cancelled task (should have no effect)
    await taskMachine.resume([
      createEvent('ADD_COMMENT', { text: 'This task is cancelled' }, 'user1')
    ]);
    
    // Check state remains unchanged
    expect(taskMachine.store.getCurrentState()).toBe('cancelled');
    expect(taskMachine.store.getContext()).toEqual(context);
  });
  
  test('Task machine can be serialized and resumed', async () => {
    // Initialize and run part of the workflow
    await taskMachine.initialize();
    
    await taskMachine.resume([
      createEvent('ASSIGN_TASK', { assignee: 'user1' }, 'admin')
    ]);
    
    await taskMachine.resume([
      createEvent('START_TASK', {}, 'user1')
    ]);
    
    // Create a new state machine with the same instance ID
    const newMachine = new StateMachine(
      config,
      adapter,
      {} as TaskContext, // Empty initial context, should be loaded
      instanceId,
      hooks
    );
    
    // Load persisted state
    await newMachine.loadPersistedState();
    
    // Check state was restored
    expect(newMachine.store.getCurrentState()).toBe('in_progress');
    const context = newMachine.store.getContext();
    expect(context.taskId).toBe(instanceId);
    expect(context.assignee).toBe('user1');
    expect(context.status).toBe('in_progress');
    
    // Continue the workflow
    await newMachine.resume([
      createEvent('REQUEST_REVIEW', {}, 'user1')
    ]);
    
    // Check that workflow continued correctly
    expect(newMachine.store.getCurrentState()).toBe('review');
  });
  
  test('Error handling and recovery', async () => {
    // Mock an error in one of the nodes
    const errorNode = new TaskNode('in_progress');
    errorNode.run = async () => {
      throw new Error('Simulated node failure');
    };
    
    // Replace the in_progress node with our faulty one
    config.nodes.set('in_progress', errorNode);
    
    // Create a new state machine with the faulty node
    const errorMachine = new StateMachine(
      config,
      adapter,
      taskMachine.store.getContext(),
      instanceId,
      hooks
    );
    
    await errorMachine.initialize();
    
    // Get to the in_progress state
    await errorMachine.resume([
      createEvent('ASSIGN_TASK', { assignee: 'user1' }, 'admin')
    ]);
    
    // This will trigger the error in the in_progress node
    await errorMachine.resume([
      createEvent('START_TASK', {}, 'user1')
    ]);
    
    // Check that error state was reached
    expect(errorMachine.store.getCurrentState()).toBe('error');
    
    // Check that error hook was called
    expect(hooks.onError).toHaveBeenCalled();
  });
  
  test('Concurrent events are processed correctly', async () => {
    await taskMachine.initialize();
    
    // Process multiple events at once
    await taskMachine.resume([
      createEvent('ASSIGN_TASK', { assignee: 'user1' }, 'admin'),
      createEvent('ADD_COMMENT', { text: 'Important task' }, 'admin'),
      createEvent('START_TASK', {}, 'user1')
    ]);
    
    // Should end up in in_progress state
    expect(taskMachine.store.getCurrentState()).toBe('in_progress');
    
    const context = taskMachine.store.getContext();
    expect(context.assignee).toBe('user1');
    expect(context.status).toBe('in_progress');
    expect(context.comments.length).toBe(1);
    expect(context.history.length).toBe(3);
  });
  
  // Helper to create task events
  function createEvent(
    type: TaskEvent['type'],
    payload: any,
    actor: string
  ): TaskEvent {
    return {
      id: `event-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      type,
      payload,
      timestamp: Date.now(),
      actor
    };
  }
});