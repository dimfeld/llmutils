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

export function initSessionNotifications(
  sessionManager: SessionManager,
  navigate: (url: string) => void
): () => void {
  return sessionManager.onEvent((eventName, parsed) => {
    switch (eventName) {
      case 'session:prompt': {
        if (document.hasFocus()) break;
        const event = parsed as SessionPromptEvent;
        const session = sessionManager.sessions.get(event.connectionId);
        const projectId = session?.projectId ?? 'all';
        showBrowserNotification({
          title: buildPromptTitle(sessionManager, event.connectionId),
          body: buildPromptBody(event),
          tag: notificationTag(event.connectionId),
          onClick: () => {
            window.focus();
            navigate(`/projects/${projectId}/sessions/${encodeURIComponent(event.connectionId)}`);
          },
        });
        break;
      }
      case 'session:new': {
        if (document.hasFocus()) break;
        const event = parsed as SessionNewEvent;
        if (event.session.status === 'notification') {
          const projectId = event.session.projectId ?? 'all';
          showBrowserNotification({
            title: 'Notification',
            body: event.session.sessionInfo.planTitle || 'New notification',
            tag: notificationTag(event.session.connectionId),
            onClick: () => {
              window.focus();
              navigate(
                `/projects/${projectId}/sessions/${encodeURIComponent(event.session.connectionId)}`
              );
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
