# State Machine with OpenTelemetry

This module implements a flexible, type-safe state machine with built-in OpenTelemetry support for tracing.

## Features

- Strongly typed state machine with TypeScript generics
- Event-driven architecture with explicit state transitions
- Built-in persistence layer with adapter pattern
- Transaction support with rollback and retry mechanisms
- Comprehensive telemetry via OpenTelemetry spans
- Hierarchical state machines via FlowNode

## Basic Usage

```typescript
import { StateMachine } from './state_machine';
import { Node } from './state_machine/nodes';
import { initTelemetry } from './state_machine/telemetry';

// Initialize telemetry (typically done at app startup)
initTelemetry();

// Define your events
interface AppEvent extends BaseEvent {
  id: string;
  type: 'USER_LOGIN' | 'USER_LOGOUT' | 'UPDATE_PROFILE';
  payload: any;
}

// Define your context
interface AppContext {
  user?: {
    id: string;
    name: string;
  };
  isAuthenticated: boolean;
}

// Define your node classes
class LoginNode extends Node<'login', AppContext, AppEvent, any, any, any> {
  constructor() {
    super('login');
  }

  async prep(store) {
    // Process events, check context, etc.
    return { args: {} };
  }

  async exec(args, events, scratchpad) {
    // Process the login
    return {
      result: {},
      scratchpad: undefined,
    };
  }

  async post(result, store) {
    // Update context and decide next state
    await store.updateContext((ctx) => ({
      ...ctx,
      isAuthenticated: true,
      user: { id: 'user123', name: 'John Doe' },
    }));

    return {
      status: 'transition',
      to: 'home',
    };
  }
}

// Create state machine instance
const stateMachine = new StateMachine<string, AppContext, AppEvent>(
  {
    initialState: 'login',
    errorState: 'error',
    nodes: new Map([
      ['login', new LoginNode()],
      // Define other states...
    ]),
  },
  myPersistenceAdapter,
  { isAuthenticated: false }, // initial context
  'user-session-123' // instance id
);

// Initialize and use the state machine
await stateMachine.initialize();
const result = await stateMachine.resume([
  {
    id: 'evt1',
    type: 'USER_LOGIN',
    payload: { username: 'johndoe', password: '****' },
  },
]);
```

## OpenTelemetry Integration

This state machine provides detailed telemetry via OpenTelemetry spans:

1. **State Transitions**: All state transitions are captured with the previous and next state as span events
2. **Event Processing**: All events are tracked with the state machine's current state
3. **Error Handling**: Exceptions are recorded with context information on spans
4. **Performance Metrics**: Each phase of state processing is measured with its own span
5. **Tracing Context Propagation**: Context is maintained throughout the state machine's execution

### Custom Span Attributes

The telemetry includes standard state machine attributes like:

- `state_machine.instance_id`: Unique identifier for the state machine instance
- `state_machine.state`: Current state name
- `state_machine.from_state` / `state_machine.to_state`: For transitions
- `state_machine.event_type`: Type of event being processed
- `state_machine.event_id`: Unique identifier for the event

### Span Events

Key span events are captured for observability:

- `state_transition`: Records state changes with from/to information
- `event_processed`: Records event processing with event details
- `node_prep_started`/`node_prep_completed`: Captures node preparation phases
- `node_exec_started`/`node_exec_completed`: Tracks execution phases
- `node_post_started`/`node_post_completed`: Monitors post-processing phases
- `rollback_executed`: Captures when transaction rollbacks occur
- `retry_attempt`/`retry_failed`/`max_retries_reached`: Records retry behavior

### Visualization Examples

When using Jaeger, Zipkin, or other OpenTelemetry-compatible tracing tools, you can visualize:

- State transition flow through span events
- Event processing timeline with parent-child span relationships
- Error rates by state
- Execution durations by state
- Node execution phases and their timing

## Best Practices

1. Use descriptive state and event names to make traces more meaningful
2. Add custom attributes in your nodes to provide business context
3. Implement proper error handling for every state
4. Use FlowNode for complex sub-processes to maintain clean architecture
5. Add custom span events to capture business-relevant transitions
