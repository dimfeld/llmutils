import { describe, test, expect, beforeEach, afterEach, jest, mock } from 'bun:test';
import { Node, StateResult, PrepResult } from './nodes';
import { SharedStore, PersistenceAdapter, AllState } from './store';
import { BaseEvent } from './events';
import {
  resetSpans,
  getSpans,
  setupTestTelemetry,
  verifySpan,
  findSpan,
} from './telemetry_test_utils';
import { initTelemetry } from './telemetry';

// First, call setupTestTelemetry to initialize the test telemetry environment
setupTestTelemetry();

// Define the test types for our concrete TestNode implementation
interface TestEvent extends BaseEvent<'TEST_NODE_EVENT', { data: string }> {}
interface TestContext {
  value: number;
}
interface TestScratchpad {
  temp: string;
}
interface TestExecArgs {
  input: string;
}
interface TestExecResult {
  output: string;
}
type TestNodeStateName = 'STATE_A' | 'STATE_B' | 'ERROR_STATE';

// Create a concrete TestNode implementation for testing
class TestNode extends Node<
  TestNodeStateName,
  TestContext,
  TestEvent,
  TestScratchpad,
  TestExecArgs,
  TestExecResult
> {
  public prepMock = jest.fn();
  public execMock = jest.fn();
  public postMock = jest.fn();
  public onErrorMock = jest.fn();

  constructor(id: TestNodeStateName) {
    super(id);
    // We'll set this in tests that need to test error handling
    // this.onError = this.onErrorMock;
  }

  async prep(
    store: SharedStore<TestContext, TestEvent>
  ): Promise<PrepResult<TestEvent, TestExecArgs>> {
    return this.prepMock(store);
  }

  async exec(
    args: TestExecArgs,
    events: TestEvent[],
    scratchpad: TestScratchpad | undefined
  ): Promise<{ result: TestExecResult; scratchpad: TestScratchpad | undefined }> {
    return this.execMock(args, events, scratchpad);
  }

  async post(
    result: TestExecResult,
    store: SharedStore<TestContext, TestEvent>
  ): Promise<StateResult<TestNodeStateName, TestEvent>> {
    return this.postMock(result, store);
  }
}

describe('Node', () => {
  let mockPersistenceAdapter: PersistenceAdapter<TestContext, TestEvent>;
  let sharedStore: SharedStore<TestContext, TestEvent>;
  let testNode: TestNode;

  beforeEach(() => {
    resetSpans();

    // Create a mock persistence adapter
    mockPersistenceAdapter = {
      write: jest.fn().mockResolvedValue(undefined),
      writeEvents: jest.fn().mockResolvedValue(undefined),
      read: jest.fn().mockRejectedValue(new Error('Not implemented for tests')),
    };

    // Create a shared store with the mock adapter
    sharedStore = new SharedStore<TestContext, TestEvent>(
      'test-instance',
      { value: 42 },
      mockPersistenceAdapter
    );

    // Create a test node
    testNode = new TestNode('STATE_A');
  });

  test('should execute lifecycle methods in order: prep, exec, post', async () => {
    // Set up mock return values for the lifecycle methods
    const testEvent: TestEvent = {
      id: 'ev1',
      type: 'TEST_NODE_EVENT',
      payload: { data: 'test data' },
    };

    testNode.prepMock.mockResolvedValue({
      args: { input: 'prep input' },
      events: [testEvent],
    });

    testNode.execMock.mockResolvedValue({
      result: { output: 'exec output' },
      scratchpad: { temp: 'test scratch data' },
    });

    testNode.postMock.mockResolvedValue({
      status: 'transition',
      to: 'STATE_B',
      actions: [],
    });

    // Run the node
    const result = await testNode.run(sharedStore);

    // Verify the lifecycle methods were called in the correct order
    expect(testNode.prepMock).toHaveBeenCalledWith(sharedStore);
    expect(testNode.execMock).toHaveBeenCalledWith({ input: 'prep input' }, [testEvent], undefined);
    expect(testNode.postMock).toHaveBeenCalledWith({ output: 'exec output' }, sharedStore);

    // Verify the result from post is returned
    expect(result).toEqual({
      status: 'transition',
      to: 'STATE_B',
      actions: [],
    });

    // Verify scratchpad was set in shared store
    expect(sharedStore.getScratchpad()).toEqual({ temp: 'test scratch data' });

    // Verify telemetry spans were created
    const runSpan = verifySpan(`node.run.STATE_A`, {
      'state_machine.instance_id': 'test-instance',
      'state_machine.state': 'STATE_A',
    });

    const prepSpan = verifySpan(`node.prep.STATE_A`, {
      'state_machine.instance_id': 'test-instance',
      'state_machine.state': 'STATE_A',
    });

    const execSpan = verifySpan(`node.exec.STATE_A`, {
      'state_machine.instance_id': 'test-instance',
      'state_machine.state': 'STATE_A',
    });

    const postSpan = verifySpan(`node.post.STATE_A`, {
      'state_machine.instance_id': 'test-instance',
      'state_machine.state': 'STATE_A',
      result_status: 'transition',
      next_state: 'STATE_B',
    });

    // Verify phases had the correct events
    expect(prepSpan.events.find((e) => e.name === 'node_prep_started')).toBeDefined();
    expect(prepSpan.events.find((e) => e.name === 'node_prep_completed')).toBeDefined();

    expect(execSpan.events.find((e) => e.name === 'node_exec_started')).toBeDefined();
    expect(execSpan.events.find((e) => e.name === 'node_exec_completed')).toBeDefined();

    expect(postSpan.events.find((e) => e.name === 'node_post_started')).toBeDefined();
    expect(postSpan.events.find((e) => e.name === 'node_post_completed')).toBeDefined();
  });

  test('should handle errors in exec and perform rollback', async () => {
    // Set up the error handler
    testNode.onError = testNode.onErrorMock;
    testNode.onErrorMock.mockResolvedValue({
      status: 'transition',
      to: 'ERROR_STATE',
      actions: [],
    });

    // Set up mock return values
    testNode.prepMock.mockResolvedValue({
      args: { input: 'prep input' },
      events: [],
    });

    // Make exec throw an error
    const testError = new Error('Test execution error');
    testNode.execMock.mockRejectedValue(testError);

    // Run the node
    const result = await testNode.run(sharedStore);

    // Verify onError was called with the error
    expect(testNode.onErrorMock).toHaveBeenCalledWith(testError, sharedStore);

    // Verify the result from onError is returned
    expect(result).toEqual({
      status: 'transition',
      to: 'ERROR_STATE',
      actions: [],
    });

    // Verify telemetry spans captured the error
    const execSpan = findSpan(`node.exec.STATE_A`);
    expect(execSpan).toBeDefined();
    expect(execSpan?.status.code).toBe(2);

    // Look for rollback event
    const rollbackSpan = findSpan('store.with_rollback');
    expect(rollbackSpan).toBeDefined();
    expect(rollbackSpan?.events.find((e) => e.name === 'rollback_executed')).toBeDefined();
  });

  test('should handle retry for transient failures', async () => {
    // Set up mock return values
    testNode.prepMock.mockResolvedValue({
      args: { input: 'prep input' },
      events: [],
    });

    // Make exec fail once, then succeed
    let execAttempts = 0;
    testNode.execMock.mockImplementation(async () => {
      execAttempts++;
      if (execAttempts === 1) {
        throw new Error('Transient failure');
      }
      return {
        result: { output: 'exec output after retry' },
        scratchpad: { temp: 'retry data' },
      };
    });

    testNode.postMock.mockResolvedValue({
      status: 'waiting',
      actions: [],
    });

    // Configure store with fast retry for testing
    const storeWithFastRetry = new SharedStore<TestContext, TestEvent>(
      'test-fast-retry',
      { value: 42 },
      mockPersistenceAdapter,
      {
        maxRetries: 3,
        retryDelay: () => 10,
      }
    );

    // Run the node
    const result = await testNode.run(storeWithFastRetry);

    // Verify exec was called twice (once for initial attempt, once for retry)
    expect(execAttempts).toBe(2);

    // Verify the final result is correct
    expect(result).toEqual({
      status: 'waiting',
      actions: [],
    });

    // Verify scratchpad was set in shared store
    expect(storeWithFastRetry.getScratchpad()).toEqual({ temp: 'retry data' });

    // Verify retry was recorded in spans
    const execSpan = findSpan(`node.exec.STATE_A`);
    expect(execSpan).toBeDefined();

    // Should find retry_attempt events
    const retryAttemptEvents = execSpan?.events.filter((e) => e.name === 'retry_attempt');
    expect(retryAttemptEvents?.length).toBeGreaterThan(0);

    // Should find retry_failed for the first attempt
    const retryFailedEvent = execSpan?.events.find((e) => e.name === 'retry_failed');
    expect(retryFailedEvent).toBeDefined();
  });

  test('handles waiting state with no next state', async () => {
    // Set up mock return values
    testNode.prepMock.mockResolvedValue({
      args: { input: 'prep input' },
      events: [],
    });

    testNode.execMock.mockResolvedValue({
      result: { output: 'exec output' },
      scratchpad: { temp: 'test scratch data' },
    });

    testNode.postMock.mockResolvedValue({
      status: 'waiting',
      actions: [],
    });

    // Run the node
    const result = await testNode.run(sharedStore);

    // Verify the result from post is returned
    expect(result).toEqual({
      status: 'waiting',
      actions: [],
    });

    // Verify telemetry reflects waiting state
    const postSpan = verifySpan(`node.post.STATE_A`, {
      'state_machine.instance_id': 'test-instance',
      'state_machine.state': 'STATE_A',
      result_status: 'waiting',
    });

    // Should not have next_state attribute since status is waiting
    expect(postSpan.attributes['next_state']).toBeUndefined();
  });

  test('handles terminal state with no next state', async () => {
    // Set up mock return values
    testNode.prepMock.mockResolvedValue({
      args: { input: 'prep input' },
      events: [],
    });

    testNode.execMock.mockResolvedValue({
      result: { output: 'exec output' },
      scratchpad: { temp: 'test scratch data' },
    });

    // Return terminal state
    testNode.postMock.mockResolvedValue({
      status: 'terminal',
      actions: [],
    });

    // Run the node
    const result = await testNode.run(sharedStore);

    // Verify the result from post is returned
    expect(result).toEqual({
      status: 'terminal',
      actions: [],
    });

    // Verify telemetry reflects terminal state
    const postSpan = verifySpan(`node.post.STATE_A`, {
      'state_machine.instance_id': 'test-instance',
      'state_machine.state': 'STATE_A',
      result_status: 'terminal',
    });

    // Should not have next_state attribute since status is terminal
    expect(postSpan.attributes['next_state']).toBeUndefined();
  });

  test('emits actions returned from post', async () => {
    // Create test action
    const testAction: TestEvent = {
      id: 'action1',
      type: 'TEST_NODE_EVENT',
      payload: { data: 'action data' },
    };

    // Set up mock return values
    testNode.prepMock.mockResolvedValue({
      args: { input: 'prep input' },
      events: [],
    });

    testNode.execMock.mockResolvedValue({
      result: { output: 'exec output' },
      scratchpad: undefined,
    });

    // Return actions array
    testNode.postMock.mockResolvedValue({
      status: 'transition',
      to: 'STATE_B',
      actions: [testAction],
    });

    // Run the node
    const result = await testNode.run(sharedStore);

    // Verify actions are included in result
    expect(result.actions).toEqual([testAction]);

    // Verify post completion event has has_actions attribute
    const postSpan = verifySpan(`node.post.STATE_A`);
    const postCompletedEvent = postSpan.events.find((e) => e.name === 'node_post_completed');
    expect(postCompletedEvent).toBeDefined();
    expect(postCompletedEvent?.attributes?.has_actions).toBe(true);
  });
});
