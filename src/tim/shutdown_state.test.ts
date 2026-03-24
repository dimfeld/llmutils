import { beforeEach, describe, expect, test } from 'bun:test';
import {
  getSignalExitCode,
  isDeferSignalExit,
  isShuttingDown,
  resetShutdownState,
  setDeferSignalExit,
  setShuttingDown,
} from './shutdown_state.js';

describe('shutdown_state', () => {
  beforeEach(() => {
    resetShutdownState();
  });

  test('starts in a non-shutdown state', () => {
    expect(isShuttingDown()).toBe(false);
    expect(getSignalExitCode()).toBeUndefined();
    expect(isDeferSignalExit()).toBe(false);
  });

  test('records the first shutdown exit code only', () => {
    setShuttingDown(130);
    setShuttingDown(143);

    expect(isShuttingDown()).toBe(true);
    expect(getSignalExitCode()).toBe(130);
  });

  test('resetShutdownState clears shutdown status and deferSignalExit', () => {
    setShuttingDown(129);
    setDeferSignalExit(true);

    resetShutdownState();

    expect(isShuttingDown()).toBe(false);
    expect(getSignalExitCode()).toBeUndefined();
    expect(isDeferSignalExit()).toBe(false);
  });

  test('setDeferSignalExit controls deferred exit behavior', () => {
    expect(isDeferSignalExit()).toBe(false);

    setDeferSignalExit(true);
    expect(isDeferSignalExit()).toBe(true);

    setDeferSignalExit(false);
    expect(isDeferSignalExit()).toBe(false);
  });
});
