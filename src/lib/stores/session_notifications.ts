import { resolve } from '$app/paths';
import type {
  SessionListEvent,
  SessionDisconnectEvent,
  SessionMessageEvent,
  SessionPromptEvent,
  SessionPromptClearedEvent,
  SessionDismissedEvent,
} from '$lib/types/session.js';
import {
  showBrowserNotification,
  closeNotification,
  closeAllNotifications,
  getActiveNotificationTags,
} from '$lib/utils/browser_notifications.js';
import type { SessionManager } from './session_state.svelte.js';

/** Sequence number used by the server for HTTP notification messages. */
const NOTIFICATION_SEQ = 0;

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
    switch (eventName) {
      case 'session:list': {
        // Reconcile: close browser notifications for sessions that no longer need attention.
        const event = parsed as SessionListEvent;
        const activeConnectionIds = new Set(event.sessions.map((s) => s.connectionId));
        // Record all existing message IDs so we don't re-notify on reconnect
        for (const session of event.sessions) {
          for (const msg of session.messages) {
            if (msg.seq === NOTIFICATION_SEQ) {
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
          const session = event.sessions.find((s) => s.connectionId === connectionId);
          if (session && !session.activePrompt) {
            // Session exists but prompt was cleared while disconnected
            closeNotification(tag);
          }
        }
        break;
      }
      case 'session:prompt': {
        if (document.hasFocus() || !sessionManager.initialized) break;
        const event = parsed as SessionPromptEvent;
        const session = sessionManager.sessions.get(event.connectionId);
        showBrowserNotification({
          title: buildSessionTitle(sessionManager, event.connectionId, 'Prompt'),
          body: buildPromptBody(event),
          tag: notificationTag(event.connectionId),
          onClick: () => {
            window.focus();
            navigate(sessionUrl(session?.projectId ?? null, event.connectionId));
          },
        });
        break;
      }
      case 'session:message': {
        if (document.hasFocus() || !sessionManager.initialized) break;
        const event = parsed as SessionMessageEvent;
        // Notification-origin messages use seq === 0 (NOTIFICATION_SEQ) on both
        // dedicated notification sessions and active sessions that receive merged notifications.
        if (event.message.seq !== NOTIFICATION_SEQ) break;
        // Skip already-seen messages (e.g. from reconciliation/replay)
        if (seenMessageIds.has(event.message.id)) break;
        seenMessageIds.add(event.message.id);
        const text = extractMessageText(event);
        if (!text) break;
        const session = sessionManager.sessions.get(event.connectionId);
        showBrowserNotification({
          title: buildSessionTitle(sessionManager, event.connectionId, 'Notification'),
          body: text,
          tag: notificationTag(event.connectionId),
          onClick: () => {
            window.focus();
            navigate(sessionUrl(session?.projectId ?? null, event.connectionId));
          },
        });
        break;
      }
      case 'session:prompt-cleared': {
        const event = parsed as SessionPromptClearedEvent;
        closeNotification(notificationTag(event.connectionId));
        break;
      }
      case 'session:disconnect': {
        const event = parsed as SessionDisconnectEvent;
        closeNotification(notificationTag(event.session.connectionId));
        break;
      }
      case 'session:dismissed': {
        const event = parsed as SessionDismissedEvent;
        closeNotification(notificationTag(event.connectionId));
        break;
      }
    }
  });

  return () => {
    unsubscribe();
    closeAllNotifications();
  };
}
