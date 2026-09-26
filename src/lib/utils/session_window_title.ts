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
>;

/** Format the title used by a floating session window and its minimized button. */
export function formatSessionWindowTitle(sessionInfo: SessionWindowTitleInfo): string {
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
    (sessionInfo.projectChatId ? 'Project Chat' : sessionInfo.command) ||
    'Session'
  );
}
