import { describe, expect, test } from 'vitest';
import {
  ClaudePermissionPromptCancelledError,
  FifoClaudePermissionPromptCoordinator,
} from './claude_permission_prompt_coordinator.js';

function request<T>(
  requesterName: string,
  requesterToken: string,
  requestId: string,
  run: (signal: AbortSignal) => Promise<T>
) {
  return { requesterName, requesterToken, requestId, run };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('FifoClaudePermissionPromptCoordinator', () => {
  test('runs complete interactions in FIFO order and passes trusted labels and signals', async () => {
    const coordinator = new FifoClaudePermissionPromptCoordinator();
    const firstRelease = deferred<void>();
    const started: string[] = [];
    const receivedSignals: AbortSignal[] = [];

    const first = coordinator.enqueue(
      request('implementer-api', 'requester-a', 'request-a', async (signal) => {
        started.push('implementer-api');
        receivedSignals.push(signal);
        await firstRelease.promise;
        return 'first';
      })
    );
    const second = coordinator.enqueue(
      request('tester-api', 'requester-b', 'request-b', async (signal) => {
        started.push('tester-api');
        receivedSignals.push(signal);
        return 'second';
      })
    );

    await Promise.resolve();
    expect(started).toEqual(['implementer-api']);
    expect(receivedSignals).toHaveLength(1);
    expect(receivedSignals[0]?.aborted).toBe(false);

    firstRelease.resolve();
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    expect(started).toEqual(['implementer-api', 'tester-api']);

    await coordinator.dispose();
  });

  test('removes queued work for a disconnected requester without changing live order', async () => {
    const coordinator = new FifoClaudePermissionPromptCoordinator();
    const firstRelease = deferred<void>();
    const started: string[] = [];

    const first = coordinator.enqueue(
      request('agent-a', 'token-a', 'request-a', async () => {
        started.push('agent-a');
        await firstRelease.promise;
        return 'a';
      })
    );
    const cancelled = coordinator.enqueue(
      request('agent-b', 'token-b', 'request-b', async () => {
        started.push('agent-b');
        return 'b';
      })
    );
    const third = coordinator.enqueue(
      request('agent-c', 'token-c', 'request-c', async () => {
        started.push('agent-c');
        return 'c';
      })
    );

    coordinator.cancelRequester('token-b');
    await expect(cancelled).rejects.toBeInstanceOf(ClaudePermissionPromptCancelledError);

    firstRelease.resolve();
    await expect(first).resolves.toBe('a');
    await expect(third).resolves.toBe('c');
    expect(started).toEqual(['agent-a', 'agent-c']);

    await coordinator.dispose();
  });

  test('aborts active work and does not deliver a late result', async () => {
    const coordinator = new FifoClaudePermissionPromptCoordinator();
    const activeStarted = deferred<void>();
    let activeSignal: AbortSignal | undefined;

    const active = coordinator.enqueue(
      request('agent-a', 'token-a', 'request-a', async (signal) => {
        activeSignal = signal;
        activeStarted.resolve();
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return 'late answer';
      })
    );
    const next = coordinator.enqueue(
      request('agent-b', 'token-b', 'request-b', async () => 'next answer')
    );

    await activeStarted.promise;
    coordinator.cancelRequester('token-a');
    await expect(active).rejects.toBeInstanceOf(ClaudePermissionPromptCancelledError);
    await expect(next).resolves.toBe('next answer');
    expect(activeSignal?.aborted).toBe(true);

    await coordinator.dispose();
  });

  test('dispose is idempotent, cancels queued work, and waits for active cleanup', async () => {
    const coordinator = new FifoClaudePermissionPromptCoordinator();
    const activeStarted = deferred<void>();
    let activeSignal: AbortSignal | undefined;

    const active = coordinator.enqueue(
      request('agent-a', 'token-a', 'request-a', async (signal) => {
        activeSignal = signal;
        activeStarted.resolve();
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return 'ignored';
      })
    );
    const queued = coordinator.enqueue(
      request('agent-b', 'token-b', 'request-b', async () => 'ignored')
    );

    await activeStarted.promise;
    const disposeOne = coordinator.dispose();
    const disposeTwo = coordinator.dispose();
    expect(disposeOne).toBe(disposeTwo);
    await expect(queued).rejects.toBeInstanceOf(ClaudePermissionPromptCancelledError);
    await expect(active).rejects.toBeInstanceOf(ClaudePermissionPromptCancelledError);
    await disposeOne;
    expect(activeSignal?.aborted).toBe(true);
    await expect(
      coordinator.enqueue(request('agent-c', 'token-c', 'request-c', async () => 'no'))
    ).rejects.toBeInstanceOf(ClaudePermissionPromptCancelledError);
  });
});
