import type { HeadlessSessionInfo } from '$lib/types/session.js';

type SessionWindowTitleInfo = Pick<
  HeadlessSessionInfo,
  | 'command'
  | 'planId'
  | 'planTitle'
  | 'linkedPlanId'
  | 'linkedPlanTitle'
  | 'linkedPrNumber'
  | 'linkedPrTitle'
  | 'projectChatId'
  | 'projectChatBranch'
  | 'customTitle'
>;

/**
 * Label for a project-level chat session, or null when the session is not one. Trunk chats
 * have a chat ID but no chat branch.
 */
export function projectChatLabel(
  sessionInfo: Pick<HeadlessSessionInfo, 'projectChatId' | 'projectChatBranch'>
): string | null {
  if (!sessionInfo.projectChatId) return null;
  return sessionInfo.projectChatBranch ? 'Project Chat' : 'Trunk Chat';
}

/**
 * Primary name of a session: the user-assigned title, then the project chat label, then the
 * command.
 */
export function sessionDisplayName(
  sessionInfo: Pick<
    HeadlessSessionInfo,
    'command' | 'customTitle' | 'projectChatId' | 'projectChatBranch'
  >
): string {
  return sessionInfo.customTitle || projectChatLabel(sessionInfo) || sessionInfo.command;
}

/** Format the title used by a floating session window and its minimized button. */
export function formatSessionWindowTitle(sessionInfo: SessionWindowTitleInfo): string {
  if (sessionInfo.customTitle) return sessionInfo.customTitle;
  const planId = sessionInfo.planId ?? sessionInfo.linkedPlanId;
  const planTitle = sessionInfo.planTitle ?? sessionInfo.linkedPlanTitle;
  const plan =
    planId != null || planTitle
      ? [planId != null ? `#${planId}` : null, planTitle].filter(Boolean).join(': ')
      : null;
  const pr =
    sessionInfo.linkedPrNumber != null || sessionInfo.linkedPrTitle
      ? [
          sessionInfo.linkedPrNumber != null ? `PR #${sessionInfo.linkedPrNumber}` : 'PR',
          sessionInfo.linkedPrTitle,
        ]
          .filter(Boolean)
          .join(': ')
      : null;

  return (
    [plan, pr].filter(Boolean).join(' · ') ||
    (projectChatLabel(sessionInfo) ?? sessionInfo.command) ||
    'Session'
  );
}
