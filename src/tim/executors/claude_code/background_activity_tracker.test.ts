import { describe, expect, it, vi } from 'vitest';
import {
  BackgroundActivityTracker,
  BACKGROUND_DRAIN_GRACE_MS,
  BACKGROUND_TASK_STALL_TIMEOUT_MS,
} from './background_activity_tracker.ts';

function makeFakeTimer(): {
  setTimeoutFn: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn: (handle: ReturnType<typeof setTimeout>) => void;
  fire: () => void;
  fireHandle: (handle: ReturnType<typeof setTimeout>) => void;
  hasPending: () => boolean;
  getLastHandle: () => ReturnType<typeof setTimeout> | undefined;
  getLastScheduledMs: () => number | undefined;
} {
  let nextHandle = 1;
  const pending = new Map<number, { cb: () => void; ms: number }>();
  let lastHandle: ReturnType<typeof setTimeout> | undefined;
  let lastScheduledMs: number | undefined;

  return {
    setTimeoutFn: (cb: () => void, ms: number): ReturnType<typeof setTimeout> => {
      const handle = nextHandle++;
      pending.set(handle, { cb, ms });
      lastHandle = handle as unknown as ReturnType<typeof setTimeout>;
      lastScheduledMs = ms;
      return lastHandle;
    },
    clearTimeoutFn: (handle: ReturnType<typeof setTimeout>): void => {
      pending.delete(handle as unknown as number);
    },
    fire: (): void => {
      const callbacks = [...pending.values()].map(({ cb }) => cb);
      pending.clear();
      for (const callback of callbacks) {
        callback();
      }
    },
    fireHandle: (handle: ReturnType<typeof setTimeout>): void => {
      const entry = pending.get(handle as unknown as number);
      if (!entry) {
        return;
      }
      pending.delete(handle as unknown as number);
      entry.cb();
    },
    hasPending: (): boolean => pending.size > 0,
    getLastHandle: (): ReturnType<typeof setTimeout> | undefined => lastHandle,
    getLastScheduledMs: (): number | undefined => lastScheduledMs,
  };
}

function makeTracker(
  graceMs = 10,
  stallTimeoutMs = 100
): {
  tracker: BackgroundActivityTracker;
  timer: ReturnType<typeof makeFakeTimer>;
  onClose: ReturnType<typeof vi.fn>;
} {
  const timer = makeFakeTimer();
  const onClose = vi.fn();
  const tracker = new BackgroundActivityTracker({
    onClose,
    graceMs,
    stallTimeoutMs,
    setTimeoutFn: timer.setTimeoutFn,
    clearTimeoutFn: timer.clearTimeoutFn,
  });

  return { tracker, timer, onClose };
}

describe('BACKGROUND_DRAIN_GRACE_MS', () => {
  it('is 10 seconds', () => {
    expect(BACKGROUND_DRAIN_GRACE_MS).toBe(10_000);
  });
});

describe('BackgroundActivityTracker', () => {
  it('closes immediately on a normal result', () => {
    const { tracker, timer, onClose } = makeTracker();

    tracker.onResultMessage(true);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(timer.hasPending()).toBe(false);
    expect(tracker.acceptedSuccessfulFinalResult()).toBe(true);
  });

  it('keeps stdin open while tasks are present and closes after an empty status and grace', () => {
    const { tracker, timer, onClose } = makeTracker();

    tracker.backgroundTasksChanged(true);
    tracker.onResultMessage(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(timer.hasPending()).toBe(true);
    expect(timer.getLastScheduledMs()).toBe(100);

    tracker.backgroundTasksChanged(false);
    expect(timer.hasPending()).toBe(true);
    expect(timer.getLastScheduledMs()).toBe(10);

    timer.fire();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(tracker.acceptedSuccessfulFinalResult()).toBe(true);
  });

  it('keeps stdin open while external activity is present without a stall timeout', () => {
    const { tracker, timer, onClose } = makeTracker();

    tracker.externalActivityChanged(true);
    tracker.onResultMessage(true);

    expect(onClose).not.toHaveBeenCalled();
    expect(timer.hasPending()).toBe(false);

    tracker.externalActivityChanged(false);
    expect(timer.hasPending()).toBe(true);
    expect(timer.getLastScheduledMs()).toBe(10);

    timer.fire();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps external activity independent from Claude background task status', () => {
    const { tracker, timer, onClose } = makeTracker();

    tracker.externalActivityChanged(true);
    tracker.backgroundTasksChanged(true);
    tracker.onResultMessage(true);
    tracker.backgroundTasksChanged(false);

    expect(tracker.hasPendingActivity()).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

    tracker.externalActivityChanged(false);
    expect(timer.hasPending()).toBe(true);
  });

  it('treats each status message as the complete authoritative task state', () => {
    const { tracker, timer, onClose } = makeTracker();

    tracker.backgroundTasksChanged(true);
    tracker.onResultMessage(true);
    tracker.backgroundTasksChanged(true);
    expect(timer.hasPending()).toBe(true);
    expect(timer.getLastScheduledMs()).toBe(100);

    tracker.backgroundTasksChanged(false);
    expect(timer.hasPending()).toBe(true);
    timer.fire();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('cancels drain grace when a later status contains tasks', () => {
    const { tracker, timer, onClose } = makeTracker();

    tracker.backgroundTasksChanged(true);
    tracker.onResultMessage(true);
    tracker.backgroundTasksChanged(false);
    expect(timer.hasPending()).toBe(true);

    tracker.backgroundTasksChanged(true);
    expect(timer.hasPending()).toBe(true);
    expect(timer.getLastScheduledMs()).toBe(100);
    timer.fire();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not close on an empty status until a result has been observed', () => {
    const { tracker, timer, onClose } = makeTracker();

    tracker.backgroundTasksChanged(true);
    tracker.onContinuationStarted();
    tracker.backgroundTasksChanged(false);

    expect(timer.hasPending()).toBe(false);
    expect(onClose).not.toHaveBeenCalled();

    tracker.onResultMessage(true);
    expect(timer.hasPending()).toBe(true);
  });

  it('does not accept an interactive result while tasks are present', () => {
    const { tracker, onClose } = makeTracker();

    tracker.backgroundTasksChanged(true);
    tracker.acceptResultWithoutClosing(true);

    expect(onClose).not.toHaveBeenCalled();
    expect(tracker.acceptedSuccessfulFinalResult()).toBe(false);
  });

  it('clears an accepted interactive result when tasks appear', () => {
    const { tracker } = makeTracker();

    tracker.acceptResultWithoutClosing(true);
    expect(tracker.acceptedSuccessfulFinalResult()).toBe(true);

    tracker.backgroundTasksChanged(true);
    expect(tracker.acceptedSuccessfulFinalResult()).toBe(false);
  });

  it('forceClose closes immediately and cancels grace', () => {
    const { tracker, timer, onClose } = makeTracker();

    tracker.backgroundTasksChanged(true);
    tracker.onResultMessage(true);
    tracker.backgroundTasksChanged(false);
    tracker.forceClose();

    expect(timer.hasPending()).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(tracker.acceptedSuccessfulFinalResult()).toBe(false);
  });

  it('cancel cancels grace without closing', () => {
    const { tracker, timer, onClose } = makeTracker();

    tracker.backgroundTasksChanged(true);
    tracker.onResultMessage(true);
    tracker.backgroundTasksChanged(false);
    tracker.cancel();

    expect(timer.hasPending()).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes after a non-empty status stalls and the drain grace elapses', () => {
    const { tracker, timer, onClose } = makeTracker();

    tracker.backgroundTasksChanged(true);
    tracker.onResultMessage(true);

    timer.fire();
    expect(onClose).not.toHaveBeenCalled();
    expect(tracker.hasPendingActivity()).toBe(false);
    expect(timer.getLastScheduledMs()).toBe(10);

    timer.fire();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(tracker.acceptedSuccessfulFinalResult()).toBe(true);
  });

  it('closes a stalled status even when a continuation cleared the result window', () => {
    const { tracker, timer, onClose } = makeTracker();

    tracker.backgroundTasksChanged(true);
    tracker.onResultMessage(true);
    tracker.onContinuationStarted();

    timer.fire();
    timer.fire();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(tracker.acceptedSuccessfulFinalResult()).toBe(false);
  });

  it('refreshes the stall deadline on each non-empty status', () => {
    const { tracker, timer, onClose } = makeTracker();

    tracker.backgroundTasksChanged(true);
    const firstStallTimer = timer.getLastHandle();
    tracker.backgroundTasksChanged(true);

    timer.fireHandle(firstStallTimer!);
    expect(tracker.hasPendingActivity()).toBe(true);
    expect(onClose).not.toHaveBeenCalled();

    timer.fire();
    timer.fire();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('cancels the stall deadline when an empty status arrives', () => {
    const { tracker, timer, onClose } = makeTracker();

    tracker.backgroundTasksChanged(true);
    const stallTimer = timer.getLastHandle();
    tracker.backgroundTasksChanged(false);

    timer.fireHandle(stallTimer!);
    expect(onClose).not.toHaveBeenCalled();
    expect(timer.hasPending()).toBe(false);
  });

  it('uses the production grace default when none is injected', () => {
    const recordedTimeouts: number[] = [];
    const tracker = new BackgroundActivityTracker({
      onClose: vi.fn(),
      setTimeoutFn: (_cb: () => void, ms: number): ReturnType<typeof setTimeout> => {
        recordedTimeouts.push(ms);
        return recordedTimeouts.length as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn: (_handle: ReturnType<typeof setTimeout>): void => {},
    });

    tracker.backgroundTasksChanged(true);
    tracker.onResultMessage(true);
    tracker.backgroundTasksChanged(false);

    expect(recordedTimeouts).toEqual([BACKGROUND_TASK_STALL_TIMEOUT_MS, BACKGROUND_DRAIN_GRACE_MS]);
  });
});
