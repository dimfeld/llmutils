import type {
  SessionNewEvent,
  SessionPromptEvent,
  SessionPromptClearedEvent,
  SessionDismissedEvent,
} from '$lib/types/session.js';
import { showBrowserNotification, closeNotification } from '$lib/utils/browser_notifications.js';
import type { SessionManager } from './session_state.svelte.js';

function notificationTag(connectionId: string): string {
  return `session:${connectionId}`;
}

function buildPromptTitle(sessionManager: SessionManager, connectionId: string): string {
  const session = sessionManager.sessions.get(connectionId);
  if (session?.sessionInfo.planTitle) {
    return `Prompt: ${session.sessionInfo.planTitle}`;
  }
  return 'Session prompt';
}

function buildPromptBody(event: SessionPromptEvent): string {
  const config = event.prompt.promptConfig;
  return config.header || config.question || config.message;
}

export function initSessionNotifications(sessionManager: SessionManager): () => void {
  return sessionManager.onEvent((eventName, parsed) => {
    if (document.hasFocus()) {
      return;
    }

    switch (eventName) {
      case 'session:prompt': {
        const event = parsed as SessionPromptEvent;
        showBrowserNotification({
          title: buildPromptTitle(sessionManager, event.connectionId),
          body: buildPromptBody(event),
          tag: notificationTag(event.connectionId),
          onClick: () => {
            window.focus();
            sessionManager.selectSession(event.connectionId);
          },
        });
        break;
      }
      case 'session:new': {
        const event = parsed as SessionNewEvent;
        if (event.session.status === 'notification') {
          showBrowserNotification({
            title: 'Notification',
            body: event.session.sessionInfo.planTitle || 'New notification',
            tag: notificationTag(event.session.connectionId),
            onClick: () => {
              window.focus();
              sessionManager.selectSession(event.session.connectionId);
            },
          });
        }
        break;
      }
      case 'session:prompt-cleared': {
        const event = parsed as SessionPromptClearedEvent;
        closeNotification(notificationTag(event.connectionId));
        break;
      }
      case 'session:dismissed': {
        const event = parsed as SessionDismissedEvent;
        closeNotification(notificationTag(event.connectionId));
        break;
      }
    }
  });
}
