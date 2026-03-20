import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { clearAppBadge, setAppBadge } from './pwa_badge.js';

type BadgeNavigatorMock = Navigator & {
  clearAppBadge?: ReturnType<typeof vi.fn>;
  setAppBadge?: ReturnType<typeof vi.fn>;
};

const originalNavigator = globalThis.navigator;

function installNavigatorMock(overrides: Partial<BadgeNavigatorMock> = {}): BadgeNavigatorMock {
  const navigatorMock = {
    ...(originalNavigator ?? {}),
    ...overrides,
  } as BadgeNavigatorMock;

  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: navigatorMock,
  });

  return navigatorMock;
}

describe('pwa_badge', () => {
  beforeEach(() => {
    installNavigatorMock();
  });

  afterEach(() => {
    if (originalNavigator) {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        writable: true,
        value: originalNavigator,
      });
    } else {
      Reflect.deleteProperty(globalThis, 'navigator');
    }

    vi.restoreAllMocks();
  });

  test('setAppBadge calls navigator.setAppBadge when available', async () => {
    const setBadge = vi.fn().mockResolvedValue(undefined);
    installNavigatorMock({ setAppBadge: setBadge });

    setAppBadge();
    await Promise.resolve();

    expect(setBadge).toHaveBeenCalledTimes(1);
  });

  test('clearAppBadge calls navigator.clearAppBadge when available', async () => {
    const clearBadge = vi.fn().mockResolvedValue(undefined);
    installNavigatorMock({ clearAppBadge: clearBadge });

    clearAppBadge();
    await Promise.resolve();

    expect(clearBadge).toHaveBeenCalledTimes(1);
  });

  test('badge helpers are no-ops when the Badge API is unavailable', () => {
    installNavigatorMock({ setAppBadge: undefined, clearAppBadge: undefined });

    expect(() => setAppBadge()).not.toThrow();
    expect(() => clearAppBadge()).not.toThrow();
  });

  test('badge helpers silently catch rejected Badge API calls', async () => {
    const setBadge = vi.fn().mockRejectedValue(new Error('set failed'));
    const clearBadge = vi.fn().mockRejectedValue(new Error('clear failed'));
    installNavigatorMock({ setAppBadge: setBadge, clearAppBadge: clearBadge });

    setAppBadge();
    clearAppBadge();

    await Promise.resolve();
    await Promise.resolve();

    expect(setBadge).toHaveBeenCalledTimes(1);
    expect(clearBadge).toHaveBeenCalledTimes(1);
  });
});
