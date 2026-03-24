import { beforeEach, describe, expect, test } from 'bun:test';
import {
  getSignalExitCode,
  isShuttingDown,
  resetShutdownState,
  setShuttingDown,
} from './shutdown_state.js';

describe('shutdown_state', () => {
  beforeEach(() => {
    resetShutdownState();
  });

  test('starts in a non-shutdown state', () => {
    expect(isShuttingDown()).toBe(false);
    expect(getSignalExitCode()).toBeUndefined();
  });

  test('records the first shutdown exit code only', () => {
    setShuttingDown(130);
    setShuttingDown(143);

    expect(isShuttingDown()).toBe(true);
    expect(getSignalExitCode()).toBe(130);
  });

  test('resetShutdownState clears shutdown status', () => {
    setShuttingDown(129);

    resetShutdownState();

    expect(isShuttingDown()).toBe(false);
    expect(getSignalExitCode()).toBeUndefined();
  });
});
