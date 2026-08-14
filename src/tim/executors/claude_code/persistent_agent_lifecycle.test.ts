import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileSink } from 'bun';
import {
  PersistentClaudeTurnController,
  type PersistentClaudeTurnControllerOptions,
} from './persistent_agent_lifecycle.ts';

type WriteResult = number | Promise<number>;

class FakeStdin {
  public readonly writes: string[] = [];
  public endCalls = 0;
  public nextWrite: (() => WriteResult) | undefined;

  public write(chunk: string): WriteResult {
    this.writes.push(chunk);
    return this.nextWrite?.() ?? chunk.length;
  }

  public end(): Promise<void> {
    this.endCalls += 1;
    return Promise.resolve();
  }
}

function makeController(
  stdin: FakeStdin,
  overrides: Partial<Omit<PersistentClaudeTurnControllerOptions, 'stdin' | 'debugLog'>> = {}
): PersistentClaudeTurnController {
  return new PersistentClaudeTurnController({
    stdin: stdin as unknown as FileSink,
    debugLog: vi.fn(),
    initialPrompt: 'first assignment',
    ...overrides,
  });
}

function message(content: string): {
  messageId: string;
  source: never;
  content: string;
} {
  return { messageId: content, source: undefined as never, content };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('PersistentClaudeTurnController', () => {
  it('keeps stdin open across multiple settled turns and reports each completion', async () => {
    const stdin = new FakeStdin();
    const completed: Array<{ successful: boolean; generation: number }> = [];
    const controller = makeController(stdin, {
      onTurnComplete: (successful: boolean, generation: number): void => {
        completed.push({ successful, generation });
      },
    });

    controller.start();
    expect(controller.state).toBe('active');
    expect(stdin.writes).toHaveLength(1);

    controller.onResultMessage(true);
    expect(controller.state).toBe('idle');
    expect(stdin.endCalls).toBe(0);
    expect(completed).toEqual([{ successful: true, generation: 1 }]);

    expect(controller.deliver(message('second assignment'))).toBe('started-idle-turn');
    expect(controller.state).toBe('active');
    expect(stdin.writes).toHaveLength(2);

    controller.onResultMessage(false);
    expect(controller.state).toBe('idle');
    expect(completed).toEqual([
      { successful: true, generation: 1 },
      { successful: false, generation: 2 },
    ]);

    controller.cleanup();
    expect(stdin.endCalls).toBe(1);
  });

  it('claims an idle turn before an asynchronous write and refuses a concurrent second start', async () => {
    const stdin = new FakeStdin();
    let resolveWrite: ((value: number) => void) | undefined;
    stdin.nextWrite = (): Promise<number> =>
      new Promise<number>((resolve) => {
        resolveWrite = resolve;
      });
    const controller = makeController(stdin);
    controller.start();
    // The initial write is deliberately asynchronous in this test.
    resolveWrite?.(1);
    await Promise.resolve();
    controller.onResultMessage(true);

    let resolveContinuation: ((value: number) => void) | undefined;
    stdin.nextWrite = (): Promise<number> =>
      new Promise<number>((resolve) => {
        resolveContinuation = resolve;
      });

    const first = controller.deliver(message('first continuation'));
    expect(controller.state).toBe('active');
    const second = controller.deliver(message('second continuation'));
    expect(second).toBe('temporarily-unavailable');

    resolveContinuation?.(1);
    await expect(first).resolves.toBe('started-idle-turn');
    expect(stdin.writes).toHaveLength(2);
    controller.cleanup();
  });

  it('waits for background drain grace and becomes idle without closing stdin', () => {
    vi.useFakeTimers();
    const stdin = new FakeStdin();
    const controller = makeController(stdin, { graceMs: 10, stallTimeoutMs: 100 });
    controller.start();

    controller.observeFormattedMessage({
      type: 'system',
      backgroundActivity: { kind: 'background_tasks_changed', hasRunningTasks: true },
    });
    controller.onResultMessage(true);
    expect(controller.state).toBe('result-pending-background');
    expect(stdin.endCalls).toBe(0);

    controller.observeFormattedMessage({
      type: 'system',
      backgroundActivity: { kind: 'background_tasks_changed', hasRunningTasks: false },
    });
    vi.advanceTimersByTime(9);
    expect(controller.state).toBe('result-pending-background');
    vi.advanceTimersByTime(1);

    expect(controller.state).toBe('idle');
    expect(stdin.endCalls).toBe(0);
    controller.cleanup();
  });

  it('restores active state when activity invalidates a provisional result', () => {
    vi.useFakeTimers();
    const stdin = new FakeStdin();
    const controller = makeController(stdin, { graceMs: 10, stallTimeoutMs: 100 });
    controller.start();

    controller.observeFormattedMessage({
      type: 'system',
      backgroundActivity: { kind: 'background_tasks_changed', hasRunningTasks: true },
    });
    controller.onResultMessage(true);
    controller.observeFormattedMessage({
      type: 'system',
      backgroundActivity: { kind: 'background_tasks_changed', hasRunningTasks: false },
    });
    controller.observeFormattedMessage({ type: 'assistant' });

    expect(controller.state).toBe('active');
    vi.advanceTimersByTime(10);
    expect(controller.state).toBe('active');

    controller.onResultMessage(true);
    vi.advanceTimersByTime(10);
    expect(controller.state).toBe('idle');
    controller.cleanup();
  });

  it('treats stalled background work as drained after the stall and grace windows', () => {
    vi.useFakeTimers();
    const stdin = new FakeStdin();
    const controller = makeController(stdin, { graceMs: 10, stallTimeoutMs: 100 });
    controller.start();

    controller.observeFormattedMessage({
      type: 'system',
      backgroundActivity: { kind: 'background_tasks_changed', hasRunningTasks: true },
    });
    controller.onResultMessage(true);
    vi.advanceTimersByTime(100);
    expect(controller.state).toBe('result-pending-background');
    vi.advanceTimersByTime(10);
    expect(controller.state).toBe('idle');
    expect(stdin.endCalls).toBe(0);
    controller.cleanup();
  });

  it('closes only after a requested current result and rejects late input', async () => {
    const stdin = new FakeStdin();
    const completed = vi.fn();
    const controller = makeController(stdin, {
      onTurnComplete: completed,
    });
    controller.start();

    controller.requestCloseAfterCurrentResult();
    expect(controller.state).toBe('finish-after-result');
    expect(() => controller.deliver(message('late while finishing'))).toThrow(
      'cannot accept input'
    );
    expect(stdin.endCalls).toBe(0);

    controller.onResultMessage(true);
    expect(controller.state).toBe('closing');
    expect(stdin.endCalls).toBe(1);
    expect(completed).toHaveBeenCalledOnce();

    controller.cleanup();
    expect(stdin.endCalls).toBe(1);
  });

  it('starts a fresh generation when an active write settles after its result', async () => {
    const stdin = new FakeStdin();
    const controller = makeController(stdin);
    controller.start();
    expect(stdin.writes).toHaveLength(1);

    let resolveWrite: ((value: number) => void) | undefined;
    stdin.nextWrite = (): Promise<number> =>
      new Promise<number>((resolve) => {
        resolveWrite = resolve;
      });

    const continuation = controller.deliver(message('write racing result'));
    expect(controller.state).toBe('active');
    controller.onResultMessage(true);
    // The initial result was already settled; this message is accepted by the
    // stream writer and must become the next active generation.
    expect(controller.state).toBe('idle');
    resolveWrite?.(1);
    await expect(continuation as Promise<'steered'>).resolves.toBe('steered');
    expect(controller.state).toBe('active');
    expect(controller.generation).toBe(2);

    controller.onResultMessage(true);
    expect(controller.state).toBe('idle');
    controller.cleanup();
  });

  it('does not create a phantom generation when an idle-start write settles after its result', async () => {
    const stdin = new FakeStdin();
    const controller = makeController(stdin);
    controller.start();
    controller.onResultMessage(true);
    expect(controller.state).toBe('idle');
    expect(controller.generation).toBe(1);

    let resolveWrite: ((value: number) => void) | undefined;
    stdin.nextWrite = (): Promise<number> =>
      new Promise<number>((resolve) => {
        resolveWrite = resolve;
      });

    const continuation = controller.deliver(message('idle continuation racing result'));
    expect(controller.state).toBe('active');
    expect(controller.generation).toBe(2);

    controller.onResultMessage(true);
    expect(controller.state).toBe('idle');

    resolveWrite?.(1);
    await expect(continuation as Promise<'started-idle-turn'>).resolves.toBe('started-idle-turn');
    expect(controller.state).toBe('idle');
    expect(controller.generation).toBe(2);

    controller.cleanup();
  });

  it('rejects messages after provider exit and ignores late parser events', async () => {
    const stdin = new FakeStdin();
    const controller = makeController(stdin);
    controller.start();
    controller.markProviderExited();

    expect(() => controller.deliver(message('too late'))).toThrow('cannot accept input');
    controller.onResultMessage(true);
    controller.observeFormattedMessage({ type: 'assistant' });
    expect(controller.state).toBe('exited');
    expect(stdin.endCalls).toBe(0);
  });

  it('starts idle when no initial prompt is supplied and claims the first turn on delivery', () => {
    const stdin = new FakeStdin();
    const controller = makeController(stdin, { initialPrompt: undefined });

    controller.start();
    expect(controller.state).toBe('idle');
    expect(stdin.writes).toHaveLength(0);

    expect(controller.deliver(message('first message'))).toBe('started-idle-turn');
    expect(controller.state).toBe('active');
    expect(stdin.writes).toHaveLength(1);

    controller.cleanup();
  });

  it('rejects requestCloseAfterCurrentResult when there is no active turn', () => {
    const stdin = new FakeStdin();
    const controller = makeController(stdin, { initialPrompt: undefined });
    controller.start();

    expect(() => controller.requestCloseAfterCurrentResult()).toThrow('no active turn to close');

    controller.cleanup();
  });

  it('rejects requestCloseAfterCurrentResult once a turn has already settled idle', () => {
    const stdin = new FakeStdin();
    const controller = makeController(stdin);
    controller.start();
    controller.onResultMessage(true);
    expect(controller.state).toBe('idle');

    expect(() => controller.requestCloseAfterCurrentResult()).toThrow('no active turn to close');

    controller.cleanup();
  });

  it('is idempotent when requestCloseAfterCurrentResult is called twice for the same turn', () => {
    const stdin = new FakeStdin();
    const completed = vi.fn();
    const controller = makeController(stdin, { onTurnComplete: completed });
    controller.start();

    controller.requestCloseAfterCurrentResult();
    expect(controller.state).toBe('finish-after-result');
    controller.requestCloseAfterCurrentResult();
    expect(controller.state).toBe('finish-after-result');

    controller.onResultMessage(true);
    expect(controller.state).toBe('closing');
    expect(stdin.endCalls).toBe(1);
    expect(completed).toHaveBeenCalledOnce();

    controller.cleanup();
    expect(stdin.endCalls).toBe(1);
  });

  it('closes after a settled background-pending result once close-after-result is requested', () => {
    vi.useFakeTimers();
    const stdin = new FakeStdin();
    const completed = vi.fn();
    const controller = makeController(stdin, {
      graceMs: 10,
      stallTimeoutMs: 100,
      onTurnComplete: completed,
    });
    controller.start();

    controller.observeFormattedMessage({
      type: 'system',
      backgroundActivity: { kind: 'background_tasks_changed', hasRunningTasks: true },
    });
    controller.onResultMessage(true);
    expect(controller.state).toBe('result-pending-background');

    controller.requestCloseAfterCurrentResult();
    expect(controller.state).toBe('finish-after-result');
    expect(stdin.endCalls).toBe(0);

    controller.observeFormattedMessage({
      type: 'system',
      backgroundActivity: { kind: 'background_tasks_changed', hasRunningTasks: false },
    });
    vi.advanceTimersByTime(10);

    expect(controller.state).toBe('closing');
    expect(stdin.endCalls).toBe(1);
    expect(completed).toHaveBeenCalledOnce();

    controller.cleanup();
    expect(stdin.endCalls).toBe(1);
  });

  it('closes stdin exactly once across repeated cleanup and forceCloseInputNow calls', () => {
    const stdin = new FakeStdin();
    const controller = makeController(stdin);
    controller.start();

    controller.forceCloseInputNow();
    expect(controller.state).toBe('closing');
    expect(stdin.endCalls).toBe(1);

    // Further terminal-transition attempts must not close stdin again.
    controller.forceCloseInputNow();
    controller.cleanup();
    controller.cleanup();
    expect(stdin.endCalls).toBe(1);
  });

  it('rejects delivery once forceCloseInputNow has closed the input stream', () => {
    const stdin = new FakeStdin();
    const controller = makeController(stdin);
    controller.start();
    controller.forceCloseInputNow();

    expect(() => controller.deliver(message('too late'))).toThrow('cannot accept input');
    expect(stdin.endCalls).toBe(1);
  });

  it('is idempotent when markProviderExited or markProviderFailed run more than once', () => {
    const stdin = new FakeStdin();
    const controller = makeController(stdin);
    controller.start();

    controller.markProviderExited();
    expect(controller.state).toBe('exited');

    // A later failure signal must not override an already-settled exit.
    controller.markProviderFailed(new Error('late failure'));
    expect(controller.state).toBe('exited');

    controller.markProviderExited();
    expect(controller.state).toBe('exited');
    expect(stdin.endCalls).toBe(0);
  });

  it('notifies availability listeners registered on the controller as writes settle', async () => {
    const stdin = new FakeStdin();
    let resolveWrite: ((value: number) => void) | undefined;
    stdin.nextWrite = (): Promise<number> =>
      new Promise<number>((resolve) => {
        resolveWrite = resolve;
      });
    const controller = makeController(stdin, { initialPrompt: undefined });
    controller.start();

    let events = 0;
    const unsubscribe = controller.onAvailabilityChange(() => {
      events += 1;
    });

    const delivery = controller.deliver(message('claim idle'));
    // The idle claim happens synchronously inside the writer's write() call,
    // before the FileSink promise settles, so no notification fires yet.
    expect(events).toBe(0);

    resolveWrite?.(1);
    await delivery;
    // The write settling (accepted, active) must reach controller-level
    // listeners, not just internal writer state.
    expect(events).toBe(1);

    unsubscribe();
    controller.onResultMessage(true);
    // The unsubscribed listener must not observe the later idle transition.
    expect(events).toBe(1);

    controller.cleanup();
  });
});
