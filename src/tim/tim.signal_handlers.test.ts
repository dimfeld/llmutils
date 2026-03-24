import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { registerShutdownSignalHandlers } from './tim.ts';
import { getSignalExitCode, isShuttingDown, resetShutdownState } from './shutdown_state.js';

type RegisteredHandler = () => void;

function createFakeProcess() {
  const handlers = new Map<string, RegisteredHandler>();

  return {
    handlers,
    on(event: string, handler: RegisteredHandler) {
      handlers.set(event, handler);
      return this;
    },
  };
}

describe('registerShutdownSignalHandlers', () => {
  beforeEach(() => {
    resetShutdownState();
  });

  test('registers exit and signal handlers', () => {
    const cleanupRegistry = { executeAll: mock(() => {}) };
    const fakeProcess = createFakeProcess();

    registerShutdownSignalHandlers(cleanupRegistry, fakeProcess);

    expect([...fakeProcess.handlers.keys()].sort()).toEqual([
      'SIGHUP',
      'SIGINT',
      'SIGTERM',
      'exit',
    ]);
  });

  test('signal handlers run synchronous cleanup and capture the first exit code', () => {
    const cleanupRegistry = { executeAll: mock(() => {}) };
    const fakeProcess = createFakeProcess();

    registerShutdownSignalHandlers(cleanupRegistry, fakeProcess);

    fakeProcess.handlers.get('SIGINT')?.();
    fakeProcess.handlers.get('SIGTERM')?.();

    expect(cleanupRegistry.executeAll).toHaveBeenCalledTimes(1);
    expect(isShuttingDown()).toBe(true);
    expect(getSignalExitCode()).toBe(130);
  });

  test('exit handler still runs cleanup after shutdown has already started', () => {
    const cleanupRegistry = { executeAll: mock(() => {}) };
    const fakeProcess = createFakeProcess();

    registerShutdownSignalHandlers(cleanupRegistry, fakeProcess);

    fakeProcess.handlers.get('SIGHUP')?.();
    fakeProcess.handlers.get('exit')?.();

    expect(cleanupRegistry.executeAll).toHaveBeenCalledTimes(2);
    expect(getSignalExitCode()).toBe(129);
  });
});
