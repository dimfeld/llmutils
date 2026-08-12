import { afterEach, describe, expect, test, vi } from 'vitest';

import { DeferredAgentInputAdapter } from '../../agent_messaging/agent_input_adapter.js';
import type { AgentInputMessage } from '../../agent_messaging/agent_manager_types.js';
import type { CodexAppServerConnection } from './app_server_connection.js';
import {
  CodexRootSteeringBridge,
  ROOT_STEERING_TAIL_WAIT_MS,
} from './codex_root_steering_bridge.js';

function createMessage(messageId: string, content: string): AgentInputMessage {
  return {
    messageId,
    source: {
      id: 'orchestrator-id' as never,
      name: 'orchestrator' as never,
      role: 'orchestrator',
      executor: 'codex-cli',
    },
    content,
  };
}

interface BridgeHarness {
  readonly rootInput: DeferredAgentInputAdapter;
  readonly connection: {
    readonly turnSteer: ReturnType<typeof vi.fn>;
    readonly setAlive: (value: boolean) => void;
  };
  readonly closeConnection: ReturnType<typeof vi.fn>;
  readonly bridge: CodexRootSteeringBridge;
}

function createHarness(): BridgeHarness {
  let alive = true;
  const turnSteer = vi.fn(async () => ({ turnId: 'turn-1' }));
  const connection = {
    get isAlive(): boolean {
      return alive;
    },
    turnSteer,
  } as unknown as CodexAppServerConnection;
  const closeConnection = vi.fn(async () => {
    alive = false;
  });
  const rootInput = new DeferredAgentInputAdapter();
  const bridge = new CodexRootSteeringBridge({
    orchestratorInputAdapter: rootInput,
    connection,
    threadId: () => 'thread-1',
    turnId: () => 'turn-1',
    isAttemptActive: () => true,
    closeConnection,
  });

  return {
    rootInput,
    connection: {
      turnSteer,
      setAlive: (value: boolean): void => {
        alive = value;
      },
    },
    closeConnection,
    bridge,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('CodexRootSteeringBridge', () => {
  test('binds the deferred root input and becomes unavailable after one close', async () => {
    const harness = createHarness();

    expect(harness.rootInput.isReady).toBe(false);
    harness.bridge.start();
    expect(harness.rootInput.isReady).toBe(true);
    expect(harness.rootInput.activity).toBe('temporarily-unavailable');
    expect(
      harness.rootInput.deliver(createMessage('before-active', 'not ready for steering'))
    ).toBe('temporarily-unavailable');

    harness.bridge.setActive();
    await expect(
      harness.rootInput.deliver(createMessage('active', 'steer the current turn'))
    ).resolves.toBe('steered');

    await harness.bridge.close();
    await harness.bridge.close();
    expect(harness.rootInput.isReady).toBe(false);
    expect(harness.rootInput.activity).toBe('not-ready');
    expect(harness.rootInput.deliver(createMessage('after-close', 'must not be delivered'))).toBe(
      'temporarily-unavailable'
    );
    expect(harness.closeConnection).not.toHaveBeenCalled();
  });

  test('returns unavailable instead of claiming delivery when the active turn cannot accept input', async () => {
    const harness = createHarness();
    harness.bridge.start();
    harness.bridge.setActive();
    harness.connection.setAlive(false);

    await expect(
      harness.rootInput.deliver(createMessage('unavailable', 'the connection is gone'))
    ).resolves.toBe('temporarily-unavailable');
    expect(harness.connection.turnSteer).not.toHaveBeenCalled();
  });

  test('settles a failed steer so a later message can retry the provider', async () => {
    const harness = createHarness();
    harness.bridge.start();
    harness.bridge.setActive();
    harness.connection.turnSteer
      .mockRejectedValueOnce(new Error('turn ended before steering'))
      .mockResolvedValueOnce({ turnId: 'turn-2' });

    await expect(harness.rootInput.deliver(createMessage('failed', 'first attempt'))).resolves.toBe(
      'temporarily-unavailable'
    );
    await expect(
      harness.rootInput.deliver(createMessage('retry', 'retry after failure'))
    ).resolves.toBe('steered');
    expect(harness.connection.turnSteer).toHaveBeenNthCalledWith(1, {
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'Agent message from orchestrator:\nfirst attempt' }],
      expectedTurnId: 'turn-1',
    });
    expect(harness.connection.turnSteer).toHaveBeenNthCalledWith(2, {
      threadId: 'thread-1',
      input: [{ type: 'text', text: 'Agent message from orchestrator:\nretry after failure' }],
      expectedTurnId: 'turn-1',
    });
  });

  test('serializes concurrent steering requests in message order', async () => {
    const harness = createHarness();
    harness.bridge.start();
    harness.bridge.setActive();
    let resolveFirst: ((value: { turnId: string }) => void) | undefined;
    harness.connection.turnSteer
      .mockImplementationOnce(
        () =>
          new Promise<{ turnId: string }>((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValueOnce({ turnId: 'turn-1' });

    const first = harness.rootInput.deliver(createMessage('first', 'first message'));
    const second = harness.rootInput.deliver(createMessage('second', 'second message'));
    await vi.waitFor(() => expect(harness.connection.turnSteer).toHaveBeenCalledTimes(1));
    expect(harness.connection.turnSteer.mock.calls[0]?.[0]).toMatchObject({
      input: [{ type: 'text', text: 'Agent message from orchestrator:\nfirst message' }],
    });

    resolveFirst?.({ turnId: 'turn-1' });
    await expect(first).resolves.toBe('steered');
    await expect(second).resolves.toBe('steered');
    expect(harness.connection.turnSteer.mock.calls[1]?.[0]).toMatchObject({
      input: [{ type: 'text', text: 'Agent message from orchestrator:\nsecond message' }],
    });
  });

  test('times out an unanswered request, closes the connection once, and releases the binding', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.bridge.start();
    harness.bridge.setActive();
    harness.connection.turnSteer.mockImplementationOnce(() => new Promise(() => {}));

    const delivery = harness.rootInput.deliver(
      createMessage('unanswered', 'provider never answers')
    );
    await vi.waitFor(() => expect(harness.connection.turnSteer).toHaveBeenCalledTimes(1));

    const firstWait = harness.bridge.waitForPending(true);
    await vi.advanceTimersByTimeAsync(ROOT_STEERING_TAIL_WAIT_MS);
    await firstWait;
    await expect(delivery).resolves.toBe('temporarily-unavailable');
    expect(harness.closeConnection).toHaveBeenCalledTimes(1);

    await harness.bridge.close();
    await harness.bridge.close();
    expect(harness.closeConnection).toHaveBeenCalledTimes(1);
    expect(harness.rootInput.isReady).toBe(false);
    expect(harness.rootInput.activity).toBe('not-ready');
  });

  test('settles timed-out deliveries and does not serialize later messages behind them', async () => {
    vi.useFakeTimers();
    const harness = createHarness();
    harness.bridge.start();
    harness.bridge.setActive();
    harness.connection.turnSteer
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({ turnId: 'turn-1' });

    const timedOutDelivery = harness.rootInput.deliver(
      createMessage('timed-out', 'provider never answers')
    );
    await vi.waitFor(() => expect(harness.connection.turnSteer).toHaveBeenCalledTimes(1));

    const wait = harness.bridge.waitForPending();
    await vi.advanceTimersByTimeAsync(ROOT_STEERING_TAIL_WAIT_MS);
    await wait;
    await expect(timedOutDelivery).resolves.toBe('temporarily-unavailable');

    const laterDelivery = harness.rootInput.deliver(
      createMessage('later', 'send after the timeout')
    );
    await expect(laterDelivery).resolves.toBe('steered');
    expect(harness.connection.turnSteer).toHaveBeenCalledTimes(2);
    expect(harness.connection.turnSteer).toHaveBeenLastCalledWith({
      threadId: 'thread-1',
      input: [
        {
          type: 'text',
          text: 'Agent message from orchestrator:\nsend after the timeout',
        },
      ],
      expectedTurnId: 'turn-1',
    });

    await harness.bridge.close();
  });
});
