import type { SessionData } from '$lib/types/session.js';
import type { EnrichedPlan } from '$lib/server/db_queries.js';

// --- Actionable PR types (defined here for Task 1 to implement later) ---

export interface ActionablePr {
  prUrl: string;
  prNumber: number;
  title: string | null;
  owner: string;
  repo: string;
  author: string | null;
  actionReason:
    | 'ready_to_merge'
    | 'checks_failing'
    | 'changes_requested'
    | 'review_requested'
    | 'open';
  checkStatus: 'passing' | 'failing' | 'pending' | 'none';
  linkedPlanId: number | null;
  linkedPlanUuid: string | null;
  linkedPlanTitle: string | null;
  projectId: number;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
}

// --- Attention item types ---

export type PlanAttentionReason =
  | { type: 'waiting_for_input'; sessionId: string; promptType: string }
  | { type: 'needs_review' }
  | { type: 'reviewed' }
  | { type: 'agent_finished' };

export interface PlanAttentionItem {
  kind: 'plan';
  planUuid: string;
  planId: number;
  planTitle: string | null;
  projectId: number;
  epic: boolean;
  docsUpdatedAt: string | null;
  lessonsAppliedAt: string | null;
  canUpdateDocs: boolean;
  hasPr: boolean;
  reviewIssueCount: number;
  depsFullyResolved: boolean;
  reasons: PlanAttentionReason[];
}

export interface PrAttentionItem {
  kind: 'pr';
  actionablePr: ActionablePr;
}

export type AttentionItem = PlanAttentionItem | PrAttentionItem;

export interface AttentionItems {
  planItems: PlanAttentionItem[];
  stackedPlanItems: PlanAttentionItem[];
  reviewedPlanItems: PlanAttentionItem[];
  prItems: PrAttentionItem[];
  sessionItems: RunningSession[];
}

// --- Running now types ---

export interface RunningSession {
  connectionId: string;
  planUuid: string | null;
  planId: number | null;
  planTitle: string | null;
  prUrl: string | null;
  prNumber: number | null;
  prTitle: string | null;
  workspacePath: string | null;
  command: string;
  connectedAt: string;
  projectId: number | null;
}

// --- Derivation functions ---

const AGENT_FINISHED_COMMANDS = new Set([
  'agent',
  'agent-multi',
  'generate',
  'chat',
  'pr-create',
  'pr-fix',
]);

const RUNNING_NOW_INCLUDED_NONINTERACTIVE_COMMANDS = new Set([
  'agent',
  'agent-multi',
  'generate',
  'chat',
  'pr-create',
  'pr-fix',
]);

const RUNNING_NOW_EXCLUDED_INTERACTIVE_COMMANDS = new Set(['review-guide', 'show']);

function isRunningNowSession(session: SessionData): boolean {
  if (session.status !== 'active') {
    return false;
  }

  if (session.sessionInfo.interactive === true) {
    return !RUNNING_NOW_EXCLUDED_INTERACTIVE_COMMANDS.has(session.sessionInfo.command);
  }

  return RUNNING_NOW_INCLUDED_NONINTERACTIVE_COMMANDS.has(session.sessionInfo.command);
}

export function indexSessionsByPlanUuid(
  sessions: Iterable<SessionData>
): Map<string, SessionData[]> {
  const sessionsByPlanUuid = new Map<string, SessionData[]>();

  for (const session of sessions) {
    const planUuid = session.sessionInfo.planUuid;
    if (!planUuid) {
      continue;
    }

    const planSessions = sessionsByPlanUuid.get(planUuid);
    if (planSessions) {
      planSessions.push(session);
    } else {
      sessionsByPlanUuid.set(planUuid, [session]);
    }
  }

  return sessionsByPlanUuid;
}

export function deriveAttentionItems(
  plans: EnrichedPlan[],
  sessionsByPlanUuid: ReadonlyMap<string, SessionData[]>,
  actionablePrs: ActionablePr[],
  notificationSessions: RunningSession[] = []
): AttentionItems {
  const activePlanUuids = new Set<string>();
  for (const [planUuid, planSessions] of sessionsByPlanUuid.entries()) {
    if (planSessions.some((session) => session.status === 'active')) {
      activePlanUuids.add(planUuid);
    }
  }

  const planItems: PlanAttentionItem[] = [];
  const stackedPlanItems: PlanAttentionItem[] = [];
  const reviewedPlanItems: PlanAttentionItem[] = [];

  for (const plan of plans) {
    // Skip plans that already have an active session; they should appear in "Running Now".
    if (activePlanUuids.has(plan.uuid)) {
      continue;
    }

    const reasons: PlanAttentionReason[] = [];
    const planSessions = sessionsByPlanUuid.get(plan.uuid) ?? [];

    // Check for active sessions waiting for input
    for (const session of planSessions) {
      const activePrompt = session.activePrompts[0];
      if (session.status === 'active' && activePrompt) {
        reasons.push({
          type: 'waiting_for_input',
          sessionId: session.connectionId,
          promptType: activePrompt.promptType,
        });
      }
    }

    // Check for agent finished (offline agent/generate/chat session + plan still in_progress)
    if (plan.displayStatus === 'in_progress') {
      for (const session of planSessions) {
        if (
          session.status === 'offline' &&
          AGENT_FINISHED_COMMANDS.has(session.sessionInfo.command)
        ) {
          reasons.push({ type: 'agent_finished' });
          break; // Only add once regardless of how many offline sessions
        }
      }
    }

    // Check for review states that still need a direct action.
    if (plan.displayStatus === 'needs_review') {
      reasons.push({ type: 'needs_review' });
    } else if (plan.displayStatus === 'reviewed') {
      reasons.push({ type: 'reviewed' });
    }

    if (reasons.length > 0) {
      const item: PlanAttentionItem = {
        kind: 'plan',
        planUuid: plan.uuid,
        planId: plan.planId,
        planTitle: plan.title,
        projectId: plan.projectId,
        epic: plan.epic,
        docsUpdatedAt: plan.docsUpdatedAt,
        lessonsAppliedAt: plan.lessonsAppliedAt,
        canUpdateDocs: plan.canUpdateDocs,
        hasPr:
          plan.pullRequests.length > 0 || plan.prSummaryStatus !== 'none' || plan.hasPlanPrLinks,
        reviewIssueCount: plan.reviewIssueCount,
        depsFullyResolved: plan.depsFullyResolved,
        reasons,
      };
      if (plan.displayStatus === 'needs_review' && !plan.depsFullyResolved) {
        stackedPlanItems.push(item);
      } else if (plan.displayStatus === 'reviewed') {
        reviewedPlanItems.push(item);
      } else {
        planItems.push(item);
      }
    }
  }

  const prItems: PrAttentionItem[] = actionablePrs.map((pr) => ({
    kind: 'pr' as const,
    actionablePr: pr,
  }));
  const reviewRequestItems: PrAttentionItem[] = [];
  const otherPrItems: PrAttentionItem[] = [];

  for (const prItem of prItems) {
    if (prItem.actionablePr.actionReason === 'review_requested') {
      reviewRequestItems.push(prItem);
    } else {
      otherPrItems.push(prItem);
    }
  }

  return {
    planItems,
    stackedPlanItems,
    reviewedPlanItems,
    prItems: [...reviewRequestItems, ...otherPrItems],
    sessionItems: notificationSessions,
  };
}

export function deriveRunningNowSessions(
  sessions: Iterable<SessionData>,
  projectId: string
): RunningSession[] {
  const numericProjectId = projectId === 'all' ? null : Number(projectId);
  const results: RunningSession[] = [];

  for (const session of sessions) {
    if (!isRunningNowSession(session)) continue;
    if (numericProjectId !== null && session.projectId !== numericProjectId) continue;

    results.push({
      connectionId: session.connectionId,
      planUuid: session.sessionInfo.planUuid ?? null,
      planId: session.sessionInfo.planId ?? null,
      planTitle: session.sessionInfo.planTitle ?? null,
      prUrl: session.sessionInfo.linkedPrUrl ?? null,
      prNumber: session.sessionInfo.linkedPrNumber ?? null,
      prTitle: session.sessionInfo.linkedPrTitle ?? null,
      workspacePath: session.sessionInfo.workspacePath ?? null,
      command: session.sessionInfo.command,
      connectedAt: session.connectedAt,
      projectId: session.projectId,
    });
  }

  // Sort by connectedAt, most recent first
  results.sort((a, b) => b.connectedAt.localeCompare(a.connectedAt));

  return results;
}

const PRIORITY_ORDER: Record<string, number> = {
  urgent: 5,
  high: 4,
  medium: 3,
  low: 2,
  maybe: 1,
};

function collectActivePlanUuids(sessions: Iterable<SessionData>): Set<string> {
  const activePlanUuids = new Set<string>();
  for (const session of sessions) {
    if (session.status === 'active' && session.sessionInfo.planUuid) {
      activePlanUuids.add(session.sessionInfo.planUuid);
    }
  }
  return activePlanUuids;
}

export function deriveReadyToStartPlans(
  plans: EnrichedPlan[],
  sessions: Iterable<SessionData>
): EnrichedPlan[] {
  const activePlanUuids = collectActivePlanUuids(sessions);

  return plans
    .filter(
      (plan) =>
        (plan.displayStatus === 'ready' || plan.displayStatus === 'in_progress') &&
        !activePlanUuids.has(plan.uuid) &&
        !plan.epic
    )
    .toSorted((a, b) => {
      const aPriority = a.priority ? (PRIORITY_ORDER[a.priority] ?? 0) : 0;
      const bPriority = b.priority ? (PRIORITY_ORDER[b.priority] ?? 0) : 0;
      return bPriority - aPriority;
    });
}
