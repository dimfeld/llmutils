import type {
  SessionMessageEvent,
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

function extractMessageText(event: SessionMessageEvent): string | null {
  const body = event.message.body;
  if (body.type === 'text') {
    return body.text;
  }
  return null;
}

export function initSessionNotifications(
  sessionManager: SessionManager,
  navigate: (url: string) => void
): () => void {
  return sessionManager.onEvent((eventName, parsed) => {
    switch (eventName) {
      case 'session:prompt': {
        if (document.hasFocus() || !sessionManager.initialized) break;
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
      case 'session:message': {
        if (document.hasFocus() || !sessionManager.initialized) break;
        const event = parsed as SessionMessageEvent;
        const session = sessionManager.sessions.get(event.connectionId);
        if (!session || session.status !== 'notification') break;
        const text = extractMessageText(event);
        if (!text) break;
        const projectId = session.projectId ?? 'all';
        showBrowserNotification({
          title: 'Notification',
          body: text,
          tag: notificationTag(event.connectionId),
          onClick: () => {
            window.focus();
            navigate(
              `/projects/${projectId}/sessions/${encodeURIComponent(event.connectionId)}`
            );
          },
        });
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
