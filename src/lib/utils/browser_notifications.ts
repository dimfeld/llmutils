const activeNotifications = new Map<string, Notification>();

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!('Notification' in globalThis)) {
    return 'denied';
  }

  if (Notification.permission === 'default') {
    return Notification.requestPermission();
  }

  return Notification.permission;
}

export interface ShowNotificationOptions {
  title: string;
  body: string;
  tag: string;
  onClick?: () => void;
}

export function showBrowserNotification(options: ShowNotificationOptions): Notification | null {
  if (!('Notification' in globalThis) || Notification.permission !== 'granted') {
    return null;
  }

  // Close existing notification with same tag to replace it
  closeNotification(options.tag);

  const notification = new Notification(options.title, {
    body: options.body,
    tag: options.tag,
    requireInteraction: true,
  });

  if (options.onClick) {
    const handler = options.onClick;
    notification.onclick = () => {
      handler();
      notification.close();
    };
  }

  notification.onclose = () => {
    activeNotifications.delete(options.tag);
  };

  activeNotifications.set(options.tag, notification);
  return notification;
}

export function closeNotification(tag: string): void {
  const existing = activeNotifications.get(tag);
  if (existing) {
    existing.close();
    activeNotifications.delete(tag);
  }
}
