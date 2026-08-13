import { afterEach, describe, expect, test, vi } from 'vitest';

import { DEFAULT_AGENT_MANAGER_SCHEDULER } from './lifecycle_scheduler.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DEFAULT_AGENT_MANAGER_SCHEDULER', () => {
  test('unrefs timer handles that support unref', () => {
    const timer = { unref: vi.fn() };
    const setTimeoutMock = vi.fn(() => timer);
    vi.stubGlobal('setTimeout', setTimeoutMock);
    const callback = vi.fn();

    const handle = DEFAULT_AGENT_MANAGER_SCHEDULER.setTimeout(callback, 120_000);

    expect(handle).toBe(timer);
    expect(setTimeoutMock).toHaveBeenCalledWith(callback, 120_000);
    expect(timer.unref).toHaveBeenCalledOnce();
  });

  test('does not require unref on timer handles without it', () => {
    const timer = 42;
    const setTimeoutMock = vi.fn(() => timer);
    vi.stubGlobal('setTimeout', setTimeoutMock);

    expect(DEFAULT_AGENT_MANAGER_SCHEDULER.setTimeout(() => {}, 250)).toBe(timer);
    expect(setTimeoutMock).toHaveBeenCalledOnce();
  });

  test('delegates clearTimeout with the original timer handle', () => {
    const clearTimeoutMock = vi.fn();
    vi.stubGlobal('clearTimeout', clearTimeoutMock);
    const timer = { unref: vi.fn() };

    DEFAULT_AGENT_MANAGER_SCHEDULER.clearTimeout(timer);

    expect(clearTimeoutMock).toHaveBeenCalledWith(timer);
  });
});
