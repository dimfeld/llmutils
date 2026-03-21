import { resolve } from '$app/paths';
import type {
  SessionClientEvent,
  SessionClientEventMap,
  SessionClientEventName,
  SessionDisconnectEvent,
  SessionMessageEvent,
  SessionPromptClearedEvent,
  SessionPromptEvent,
} from '$lib/types/session.js';
import {
  showBrowserNotification,
  closeNotification,
  closeAllNotifications,
  getActiveNotificationTags,
} from '$lib/utils/browser_notifications.js';
import type { SessionManager } from './session_state.svelte.js';

function toSessionClientEvent<TEventName extends SessionClientEventName>(
  eventName: TEventName,
  payload: SessionClientEventMap[TEventName]
): SessionClientEvent {
  return { eventName, payload } as SessionClientEvent;
}

function notificationTag(connectionId: string): string {
  return `session:${connectionId}`;
}

const NOTIFICATION_TAG_PREFIX = 'session:';

function buildSessionTitle(
  sessionManager: SessionManager,
  connectionId: string,
  prefix: string
): string {
  const session = sessionManager.sessions.get(connectionId);
  if (session?.sessionInfo.planTitle) {
    return `${prefix}: ${session.sessionInfo.planTitle}`;
  }
  return prefix;
}

function buildPromptBody(event: SessionPromptEvent): string {
  const config = event.prompt.promptConfig;
  return config.header || config.question || config.message;
}

function extractMessageText(event: SessionMessageEvent): string | null {
  const body = event.message.body;
  if (body.type === 'text') {
    return body.text;
  }
  return null;
}

function sessionUrl(projectId: number | null, connectionId: string): string {
  return resolve(`/projects/${projectId ?? 'all'}/sessions/${encodeURIComponent(connectionId)}`);
}

export function initSessionNotifications(
  sessionManager: SessionManager,
  navigate: (url: string) => void
): () => void {
  /** Track seen notification message IDs to avoid re-notifying on replayed messages. */
  const seenMessageIds = new Set<string>();

  const unsubscribe = sessionManager.onEvent((eventName, parsed) => {
    const event = toSessionClientEvent(eventName, parsed);

    switch (event.eventName) {
      case 'session:list': {
        // Reconcile: close browser notifications for sessions that no longer need attention.
        const activeConnectionIds = new Set(event.payload.sessions.map((s) => s.connectionId));
        // Record all existing message IDs so we don't re-notify on reconnect
        for (const session of event.payload.sessions) {
          for (const msg of session.messages) {
            if (msg.triggersNotification) {
              seenMessageIds.add(msg.id);
            }
          }
        }
        for (const tag of getActiveNotificationTags()) {
          if (!tag.startsWith(NOTIFICATION_TAG_PREFIX)) continue;
          const connectionId = tag.slice(NOTIFICATION_TAG_PREFIX.length);
          if (!activeConnectionIds.has(connectionId)) {
            // Session no longer exists
            closeNotification(tag);
            continue;
          }
          const session = event.payload.sessions.find((s) => s.connectionId === connectionId);
          if (session && !session.activePrompt) {
            // Session exists but prompt was cleared while disconnected
            closeNotification(tag);
          }
        }
        break;
      }
      case 'session:prompt': {
        if (document.hasFocus() || !sessionManager.initialized) break;
        const session = sessionManager.sessions.get(event.payload.connectionId);
        showBrowserNotification({
          title: buildSessionTitle(sessionManager, event.payload.connectionId, 'Prompt'),
          body: buildPromptBody(event.payload),
          tag: notificationTag(event.payload.connectionId),
          onClick: () => {
            window.focus();
            navigate(sessionUrl(session?.projectId ?? null, event.payload.connectionId));
          },
        });
        break;
      }
      case 'session:message': {
        if (document.hasFocus() || !sessionManager.initialized) break;
        if (!event.payload.message.triggersNotification) break;
        // Skip already-seen messages (e.g. from reconciliation/replay)
        if (seenMessageIds.has(event.payload.message.id)) break;
        seenMessageIds.add(event.payload.message.id);
        const text = extractMessageText(event.payload);
        if (!text) break;
        const session = sessionManager.sessions.get(event.payload.connectionId);
        showBrowserNotification({
          title: buildSessionTitle(sessionManager, event.payload.connectionId, 'Notification'),
          body: text,
          tag: notificationTag(event.payload.connectionId),
          onClick: () => {
            window.focus();
            navigate(sessionUrl(session?.projectId ?? null, event.payload.connectionId));
          },
        });
        break;
      }
      case 'session:prompt-cleared': {
        closeNotification(notificationTag(event.payload.connectionId));
        break;
      }
      case 'session:disconnect': {
        closeNotification(notificationTag(event.payload.session.connectionId));
        break;
      }
      case 'session:dismissed': {
        closeNotification(notificationTag(event.payload.connectionId));
        break;
      }
    }
  });

  return () => {
    unsubscribe();
    closeAllNotifications();
  };
}
