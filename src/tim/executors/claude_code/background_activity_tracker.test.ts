import { describe, expect, it, vi } from 'vitest';
import {
  BackgroundActivityTracker,
  BACKGROUND_DRAIN_GRACE_MS,
} from './background_activity_tracker.ts';

function makeFakeTimer(): {
  setTimeoutFn: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn: (handle: ReturnType<typeof setTimeout>) => void;
  fire: () => void;
  hasPending: () => boolean;
  getLastScheduledMs: () => number | undefined;
} {
  let nextHandle = 1;
  const pending = new Map<number, { cb: () => void; ms: number }>();
  let lastScheduledMs: number | undefined;

  return {
    setTimeoutFn: (cb: () => void, ms: number): ReturnType<typeof setTimeout> => {
      const handle = nextHandle++;
      pending.set(handle, { cb, ms });
      lastScheduledMs = ms;
      return handle as unknown as ReturnType<typeof setTimeout>;
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
    hasPending: (): boolean => pending.size > 0,
    getLastScheduledMs: (): number | undefined => lastScheduledMs,
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
    expect(timer.hasPending()).toBe(false);

    tracker.backgroundTasksChanged(false);
    expect(timer.hasPending()).toBe(true);
    expect(timer.getLastScheduledMs()).toBe(10);

    timer.fire();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(tracker.acceptedSuccessfulFinalResult()).toBe(true);
  });

  it('treats each status message as the complete authoritative task state', () => {
    const { tracker, timer, onClose } = makeTracker();

    tracker.backgroundTasksChanged(true);
    tracker.onResultMessage(true);
    tracker.backgroundTasksChanged(true);
    expect(timer.hasPending()).toBe(false);

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
    expect(timer.hasPending()).toBe(false);
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

  it('uses the production grace default when none is injected', () => {
    let recordedMs: number | undefined;
    const tracker = new BackgroundActivityTracker({
      onClose: vi.fn(),
      setTimeoutFn: (_cb: () => void, ms: number): ReturnType<typeof setTimeout> => {
        recordedMs = ms;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn: (_handle: ReturnType<typeof setTimeout>): void => {},
    });

    tracker.backgroundTasksChanged(true);
    tracker.onResultMessage(true);
    tracker.backgroundTasksChanged(false);

    expect(recordedMs).toBe(BACKGROUND_DRAIN_GRACE_MS);
  });
});
