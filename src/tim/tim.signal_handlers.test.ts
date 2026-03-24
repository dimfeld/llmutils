import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { registerShutdownSignalHandlers } from './tim.ts';
import {
  getSignalExitCode,
  isShuttingDown,
  resetShutdownState,
  setDeferSignalExit,
} from './shutdown_state.js';

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

// Mock process.exit to prevent test from actually exiting
const originalExit = process.exit;
let exitCalls: number[] = [];

describe('registerShutdownSignalHandlers', () => {
  beforeEach(() => {
    resetShutdownState();
    exitCalls = [];
    process.exit = mock((code?: number) => {
      exitCalls.push(code ?? 0);
    }) as typeof process.exit;
  });

  afterEach(() => {
    process.exit = originalExit;
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

  test('signal handlers call process.exit() immediately when deferSignalExit is false', () => {
    const cleanupRegistry = { executeAll: mock(() => {}) };
    const fakeProcess = createFakeProcess();

    registerShutdownSignalHandlers(cleanupRegistry, fakeProcess);

    fakeProcess.handlers.get('SIGINT')?.();

    expect(cleanupRegistry.executeAll).toHaveBeenCalledTimes(1);
    expect(isShuttingDown()).toBe(true);
    expect(getSignalExitCode()).toBe(130);
    expect(exitCalls).toEqual([130]);
  });

  test('signal handlers defer exit when deferSignalExit is true', () => {
    const cleanupRegistry = { executeAll: mock(() => {}) };
    const fakeProcess = createFakeProcess();
    setDeferSignalExit(true);

    registerShutdownSignalHandlers(cleanupRegistry, fakeProcess);

    fakeProcess.handlers.get('SIGINT')?.();

    // cleanupRegistry is NOT called on first signal in deferred mode —
    // async lifecycle shutdown() handles cleanup, killDaemons stays registered
    // for the force-exit path (second signal → process.exit → exit event)
    expect(cleanupRegistry.executeAll).toHaveBeenCalledTimes(0);
    expect(isShuttingDown()).toBe(true);
    expect(getSignalExitCode()).toBe(130);
    expect(exitCalls).toEqual([]); // No process.exit() called
  });

  test('second signal force-exits even when deferSignalExit is true', () => {
    const cleanupRegistry = { executeAll: mock(() => {}) };
    const fakeProcess = createFakeProcess();
    setDeferSignalExit(true);

    registerShutdownSignalHandlers(cleanupRegistry, fakeProcess);

    fakeProcess.handlers.get('SIGINT')?.();
    expect(exitCalls).toEqual([]); // First signal deferred

    fakeProcess.handlers.get('SIGTERM')?.();
    expect(exitCalls).toEqual([143]); // Second signal force-exits
  });

  test('exit handler still runs cleanup after shutdown has already started', () => {
    const cleanupRegistry = { executeAll: mock(() => {}) };
    const fakeProcess = createFakeProcess();
    setDeferSignalExit(true);

    registerShutdownSignalHandlers(cleanupRegistry, fakeProcess);

    fakeProcess.handlers.get('SIGHUP')?.();
    // First signal in deferred mode does NOT call executeAll
    expect(cleanupRegistry.executeAll).toHaveBeenCalledTimes(0);

    // Exit event (e.g., from process.exit after async cleanup) always runs cleanup
    fakeProcess.handlers.get('exit')?.();
    expect(cleanupRegistry.executeAll).toHaveBeenCalledTimes(1);
    expect(getSignalExitCode()).toBe(129);
  });
});
