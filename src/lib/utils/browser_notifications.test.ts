import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  closeNotification,
  requestNotificationPermission,
  showBrowserNotification,
} from './browser_notifications.js';

class MockNotification {
  static permission: NotificationPermission = 'default';
  static requestPermission = vi.fn(async () => MockNotification.permission);
  static instances: MockNotification[] = [];

  title: string;
  body: string;
  tag: string;
  requireInteraction: boolean;
  closed = false;
  onclick: Notification['onclick'] = null;
  onclose: Notification['onclose'] = null;

  constructor(title: string, options?: NotificationOptions) {
    this.title = title;
    this.body = options?.body ?? '';
    this.tag = options?.tag ?? '';
    this.requireInteraction = options?.requireInteraction ?? false;
    MockNotification.instances.push(this);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.call(this, new Event('close'));
  }
}

const originalNotification = globalThis.Notification;

function installNotificationMock(): void {
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    writable: true,
    value: MockNotification,
  });
}

describe('browser_notifications', () => {
  beforeEach(() => {
    installNotificationMock();
    MockNotification.instances = [];
    MockNotification.permission = 'default';
    MockNotification.requestPermission.mockReset();
    MockNotification.requestPermission.mockImplementation(async () => MockNotification.permission);
  });

  afterEach(() => {
    for (const instance of MockNotification.instances) {
      instance.close();
    }

    if (originalNotification) {
      Object.defineProperty(globalThis, 'Notification', {
        configurable: true,
        writable: true,
        value: originalNotification,
      });
    } else {
      Reflect.deleteProperty(globalThis, 'Notification');
    }
  });

  test('requestNotificationPermission returns denied when the Notification API is unavailable', async () => {
    Reflect.deleteProperty(globalThis, 'Notification');

    await expect(requestNotificationPermission()).resolves.toBe('denied');
  });

  test('requestNotificationPermission returns the existing permission without requesting again', async () => {
    MockNotification.permission = 'denied';

    await expect(requestNotificationPermission()).resolves.toBe('denied');
    expect(MockNotification.requestPermission).not.toHaveBeenCalled();
  });

  test('requestNotificationPermission requests permission when the state is default', async () => {
    MockNotification.permission = 'default';
    MockNotification.requestPermission.mockResolvedValueOnce('granted');

    await expect(requestNotificationPermission()).resolves.toBe('granted');
    expect(MockNotification.requestPermission).toHaveBeenCalledTimes(1);
  });

  test('showBrowserNotification returns null when the API is unavailable', () => {
    Reflect.deleteProperty(globalThis, 'Notification');

    expect(
      showBrowserNotification({
        title: 'Prompt',
        body: 'Continue?',
        tag: 'missing-api',
      })
    ).toBeNull();
  });

  test('showBrowserNotification returns null when permission is not granted', () => {
    MockNotification.permission = 'denied';

    expect(
      showBrowserNotification({
        title: 'Prompt',
        body: 'Continue?',
        tag: 'denied',
      })
    ).toBeNull();
    expect(MockNotification.instances).toHaveLength(0);
  });

  test('showBrowserNotification creates and tracks a notification', () => {
    MockNotification.permission = 'granted';

    const notification = showBrowserNotification({
      title: 'Prompt',
      body: 'Continue?',
      tag: 'tracked',
    });

    expect(notification).toBeInstanceOf(MockNotification);
    expect(MockNotification.instances).toHaveLength(1);
    expect(MockNotification.instances[0]).toMatchObject({
      title: 'Prompt',
      body: 'Continue?',
      tag: 'tracked',
      requireInteraction: true,
    });

    closeNotification('tracked');

    expect(MockNotification.instances[0]?.closed).toBe(true);
  });

  test('showBrowserNotification replaces an existing notification with the same tag', () => {
    MockNotification.permission = 'granted';

    const first = showBrowserNotification({
      title: 'Prompt',
      body: 'First',
      tag: 'dedupe',
    }) as MockNotification;

    const second = showBrowserNotification({
      title: 'Prompt',
      body: 'Second',
      tag: 'dedupe',
    }) as MockNotification;

    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);
    expect(MockNotification.instances).toHaveLength(2);
  });

  test('showBrowserNotification wires click handling and closes after clicking', () => {
    MockNotification.permission = 'granted';
    const onClick = vi.fn();

    const notification = showBrowserNotification({
      title: 'Prompt',
      body: 'Click me',
      tag: 'clickable',
      onClick,
    }) as MockNotification;

    notification.onclick?.call(notification, new Event('click'));

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(notification.closed).toBe(true);
  });

  test('closeNotification is a no-op for unknown tags', () => {
    expect(() => closeNotification('unknown')).not.toThrow();
  });
});
