import { describe, expect, it, vi } from 'vitest';
import {
  BackgroundActivityTracker,
  BACKGROUND_DRAIN_GRACE_MS,
} from './background_activity_tracker.ts';

function makeFakeTimer(): {
  setTimeoutFn: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn: (h: ReturnType<typeof setTimeout>) => void;
  fire: () => void;
  fireHandle: (h: ReturnType<typeof setTimeout>) => void;
  hasPending: () => boolean;
  getLastHandle: () => ReturnType<typeof setTimeout> | undefined;
  getLastScheduledMs: () => number | undefined;
} {
  let nextHandle = 1;
  const pending = new Map<number, { cb: () => void; ms: number }>();
  let lastHandleNum: number | undefined;

  const setTimeoutFn = (cb: () => void, ms: number): ReturnType<typeof setTimeout> => {
    const handle = nextHandle++;
    pending.set(handle, { cb, ms });
    lastHandleNum = handle;
    return handle as unknown as ReturnType<typeof setTimeout>;
  };

  const clearTimeoutFn = (h: ReturnType<typeof setTimeout>): void => {
    pending.delete(h as unknown as number);
  };

  const fireHandle = (h: ReturnType<typeof setTimeout>): void => {
    const entry = pending.get(h as unknown as number);
    if (!entry) {
      return;
    }
    pending.delete(h as unknown as number);
    entry.cb();
  };

  const fire = (): void => {
    const entries = [...pending.entries()];
    pending.clear();
    for (const [, { cb }] of entries) {
      cb();
    }
  };

  return {
    setTimeoutFn,
    clearTimeoutFn,
    fire,
    fireHandle,
    hasPending: (): boolean => pending.size > 0,
    getLastHandle: (): ReturnType<typeof setTimeout> | undefined =>
      lastHandleNum as unknown as ReturnType<typeof setTimeout> | undefined,
    getLastScheduledMs: (): number | undefined => {
      if (lastHandleNum === undefined) {
        return undefined;
      }
      return pending.get(lastHandleNum)?.ms;
    },
  };
}

function makeTracker(graceMs = 10): {
  tracker: BackgroundActivityTracker;
  timer: ReturnType<typeof makeFakeTimer>;
  onClose: ReturnType<typeof vi.fn>;
} {
  const timer = makeFakeTimer();
  const onClose = vi.fn();
  const tracker = new BackgroundActivityTracker({
    onClose,
    graceMs,
    setTimeoutFn: timer.setTimeoutFn,
    clearTimeoutFn: timer.clearTimeoutFn,
  });

  return { tracker, timer, onClose };
}

describe('BACKGROUND_DRAIN_GRACE_MS', () => {
  it('is 10_000', () => {
    expect(BACKGROUND_DRAIN_GRACE_MS).toBe(10_000);
  });
});

describe('BackgroundActivityTracker', () => {
  it('closes immediately on a normal result without a grace timer', () => {
    const { tracker, timer, onClose } = makeTracker();

    tracker.onResultMessage(true);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(timer.hasPending()).toBe(false);
    expect(tracker.acceptedSuccessfulFinalResult()).toBe(true);
  });

  it('does not accept a failed result as successful completion', () => {
    const { tracker, onClose } = makeTracker();

    tracker.onResultMessage(false);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(tracker.acceptedSuccessfulFinalResult()).toBe(false);
  });

  it('clears accepted completion when an intercepted result is superseded', () => {
    const { tracker, onClose } = makeTracker();

    tracker.wakeupScheduled();
    tracker.onResultMessage(true);
    tracker.onInterceptedResult();

    expect(onClose).toHaveBeenCalledTimes(0);
    expect(tracker.acceptedSuccessfulFinalResult()).toBe(false);
  });

  it('clears accepted completion when a continuation starts', () => {
    const { tracker, onClose } = makeTracker();

    tracker.acceptResultWithoutClosing(true);
    expect(tracker.acceptedSuccessfulFinalResult()).toBe(true);

    tracker.onContinuationStarted();

    expect(onClose).toHaveBeenCalledTimes(0);
    expect(tracker.acceptedSuccessfulFinalResult()).toBe(false);
  });

  it('does not accept an interactive keep-open result while a task is pending', () => {
    const { tracker, timer, onClose } = makeTracker();

    tracker.taskStarted('task-1');
    tracker.acceptResultWithoutClosing(true);

    expect(onClose).toHaveBeenCalledTimes(0);
    expect(tracker.acceptedSuccessfulFinalResult()).toBe(false);
    expect(timer.hasPending()).toBe(false);

    tracker.taskEnded('task-1');
    expect(timer.hasPending()).toBe(true);

    timer.fire();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(tracker.acceptedSuccessfulFinalResult()).toBe(true);
  });

  it('does not accept an interactive keep-open result while a wakeup is pending', () => {
    const { tracker, timer, onClose } = makeTracker();

    tracker.wakeupScheduled();
    tracker.acceptResultWithoutClosing(true);

    expect(onClose).toHaveBeenCalledTimes(0);
    expect(timer.hasPending()).toBe(false);
    expect(tracker.acceptedSuccessfulFinalResult()).toBe(false);

    tracker.onTurnActivity();
    tracker.acceptResultWithoutClosing(true);

    expect(onClose).toHaveBeenCalledTimes(0);
    expect(tracker.acceptedSuccessfulFinalResult()).toBe(true);
  });

  it('keeps stdin open while a wakeup is pending, then closes after turn activity and grace', () => {
    const { tracker, timer, onClose } = makeTracker();

    tracker.wakeupScheduled();
    tracker.onResultMessage(true);
    expect(onClose).toHaveBeenCalledTimes(0);
    expect(timer.hasPending()).toBe(false);

    tracker.onTurnActivity();

    expect(tracker.acceptedSuccessfulFinalResult()).toBe(false);

    tracker.onResultMessage(true);
    expect(onClose).toHaveBeenCalledTimes(0);
    expect(timer.hasPending()).toBe(true);

    timer.fire();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(tracker.acceptedSuccessfulFinalResult()).toBe(true);
  });

  it('cancels grace when new turn activity arrives during grace', () => {
    const { tracker, timer, onClose } = makeTracker();

    tracker.wakeupScheduled();
    tracker.onResultMessage(true);
    tracker.onTurnActivity();
    tracker.onResultMessage(true);
    tracker.onTurnActivity();

    expect(timer.hasPending()).toBe(false);
    timer.fire();
    expect(onClose).toHaveBeenCalledTimes(0);
  });

  it('keeps stdin open while a task is active, then closes after the task drains and grace elapses', () => {
    const { tracker, timer, onClose } = makeTracker();

    tracker.taskStarted('task-1');
    tracker.onResultMessage(true);
    expect(onClose).toHaveBeenCalledTimes(0);

    tracker.taskEnded('task-1');
    expect(timer.hasPending()).toBe(true);
    timer.fire();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(tracker.acceptedSuccessfulFinalResult()).toBe(true);
  });

  it('clears accepted completion when a task starts after an accepted result', () => {
    const { tracker, onClose } = makeTracker();

    tracker.acceptResultWithoutClosing(true);
    expect(tracker.acceptedSuccessfulFinalResult()).toBe(true);

    tracker.taskStarted('task-1');

    expect(onClose).toHaveBeenCalledTimes(0);
    expect(tracker.acceptedSuccessfulFinalResult()).toBe(false);
    expect(tracker.hasPendingActivity()).toBe(true);
  });

  it('cancels grace when a new task starts during grace and closes after the new task drains', () => {
    const { tracker, timer, onClose } = makeTracker();

    tracker.taskStarted('task-1');
    tracker.onResultMessage(true);
    tracker.taskEnded('task-1');
    expect(timer.hasPending()).toBe(true);

    tracker.taskStarted('task-2');
    expect(timer.hasPending()).toBe(false);
    tracker.taskEnded('task-2');
    expect(timer.hasPending()).toBe(true);

    timer.fire();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('waits for all overlapping tasks before starting grace', () => {
    const { tracker, timer, onClose } = makeTracker();

    tracker.taskStarted('task-a');
    tracker.taskStarted('task-b');
    tracker.taskStarted('task-c');
    tracker.onResultMessage(true);

    tracker.taskEnded('task-a');
    tracker.taskEnded('task-b');
    expect(timer.hasPending()).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(0);

    tracker.taskEnded('task-c');
    expect(timer.hasPending()).toBe(true);
    timer.fire();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('reports pending activity for active tasks and wakeups', () => {
    const { tracker } = makeTracker();

    expect(tracker.hasPendingActivity()).toBe(false);
    tracker.wakeupScheduled();
    expect(tracker.hasPendingActivity()).toBe(true);
    tracker.onResultMessage(true);
    tracker.onTurnActivity();
    expect(tracker.hasPendingActivity()).toBe(false);

    tracker.taskStarted('task-1');
    expect(tracker.hasPendingActivity()).toBe(true);
    tracker.taskEnded('task-1');
    expect(tracker.hasPendingActivity()).toBe(false);
  });

  it('does not close while a backgrounded task is still active', () => {
    const { tracker, timer, onClose } = makeTracker();

    tracker.taskStarted('task-bg');
    tracker.onResultMessage(true);
    timer.fire();
    expect(onClose).toHaveBeenCalledTimes(0);

    tracker.taskEnded('task-bg');
    timer.fire();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps a pending wakeup when a background task drains', () => {
    const { tracker, timer, onClose } = makeTracker();

    tracker.wakeupScheduled();
    tracker.taskStarted('task-1');
    tracker.onResultMessage(true);
    expect(tracker.hasPendingActivity()).toBe(true);

    tracker.taskEnded('task-1');
    expect(tracker.hasPendingActivity()).toBe(true);
    expect(timer.hasPending()).toBe(false);

    timer.fire();
    expect(onClose).toHaveBeenCalledTimes(0);

    tracker.onTurnActivity();
    tracker.onResultMessage(true);
    expect(timer.hasPending()).toBe(true);

    timer.fire();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('treats wakeup scheduling after a result as new-turn activity before setting the new wakeup', () => {
    const { tracker, timer, onClose } = makeTracker();

    tracker.wakeupScheduled();
    tracker.onResultMessage(true);

    tracker.wakeupScheduled();
    tracker.taskStarted('task-1');
    tracker.onResultMessage(true);
    tracker.taskEnded('task-1');

    expect(tracker.hasPendingActivity()).toBe(true);
    expect(timer.hasPending()).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(0);

    tracker.onTurnActivity();
    tracker.onResultMessage(true);
    expect(timer.hasPending()).toBe(true);

    timer.fire();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clears a stale wakeup on intercepted result while preserving active tasks', () => {
    const { tracker, timer, onClose } = makeTracker();

    tracker.wakeupScheduled();
    tracker.taskStarted('task-1');
    tracker.onResultMessage(true);
    expect(tracker.hasPendingActivity()).toBe(true);

    tracker.onInterceptedResult();
    expect(tracker.hasPendingActivity()).toBe(true);

    tracker.taskEnded('task-1');
    expect(tracker.hasPendingActivity()).toBe(false);
    expect(timer.hasPending()).toBe(false);

    tracker.onResultMessage(true);
    expect(timer.hasPending()).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(0);

    timer.fire();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('forceClose closes immediately and cancels a pending grace timer', () => {
    const { tracker, timer, onClose } = makeTracker();

    tracker.taskStarted('task-1');
    tracker.onResultMessage(true);
    tracker.taskEnded('task-1');
    expect(timer.hasPending()).toBe(true);

    tracker.forceClose();

    expect(timer.hasPending()).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(tracker.acceptedSuccessfulFinalResult()).toBe(false);
    timer.fire();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('cancel cancels a pending grace timer without closing', () => {
    const { tracker, timer, onClose } = makeTracker();

    tracker.taskStarted('task-1');
    tracker.onResultMessage(true);
    tracker.taskEnded('task-1');
    expect(timer.hasPending()).toBe(true);

    tracker.cancel();

    expect(timer.hasPending()).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(0);
  });

  it('ignores stale timer handles after cancellation', () => {
    const { tracker, timer, onClose } = makeTracker();

    tracker.taskStarted('task-1');
    tracker.onResultMessage(true);
    tracker.taskEnded('task-1');
    const staleHandle = timer.getLastHandle();
    expect(staleHandle).toBeDefined();

    tracker.taskStarted('task-2');
    expect(timer.hasPending()).toBe(false);
    timer.fireHandle(staleHandle!);

    expect(onClose).toHaveBeenCalledTimes(0);
  });

  it('uses the injected graceMs and the production default when not injected', () => {
    const injected = makeTracker(42);
    injected.tracker.taskStarted('task-1');
    injected.tracker.onResultMessage(true);
    injected.tracker.taskEnded('task-1');
    expect(injected.timer.getLastScheduledMs()).toBe(42);

    let recordedMs: number | undefined;
    const tracker = new BackgroundActivityTracker({
      onClose: vi.fn(),
      setTimeoutFn: (cb: () => void, ms: number): ReturnType<typeof setTimeout> => {
        recordedMs = ms;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn: (_h: ReturnType<typeof setTimeout>): void => {},
    });

    tracker.taskStarted('task-1');
    tracker.onResultMessage(true);
    tracker.taskEnded('task-1');

    expect(recordedMs).toBe(BACKGROUND_DRAIN_GRACE_MS);
  });

  it('does not close or schedule again after already closed', () => {
    const { tracker, timer, onClose } = makeTracker();

    tracker.onResultMessage(true);
    tracker.taskStarted('late-task');
    tracker.taskEnded('late-task');
    timer.fire();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(timer.hasPending()).toBe(false);
  });
});
