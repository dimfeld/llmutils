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
  actionReason: 'ready_to_merge' | 'checks_failing' | 'changes_requested' | 'review_requested';
  checkStatus: 'passing' | 'failing' | 'pending' | 'none';
  linkedPlanId: number | null;
  linkedPlanUuid: string | null;
  linkedPlanTitle: string | null;
  projectId: number;
}

// --- Attention item types ---

export type PlanAttentionReason =
  | { type: 'waiting_for_input'; sessionId: string; promptType: string }
  | { type: 'needs_review' }
  | { type: 'agent_finished' };

export interface PlanAttentionItem {
  kind: 'plan';
  planUuid: string;
  planId: number;
  planTitle: string | null;
  projectId: number;
  reasons: PlanAttentionReason[];
}

export interface PrAttentionItem {
  kind: 'pr';
  actionablePr: ActionablePr;
}

export type AttentionItem = PlanAttentionItem | PrAttentionItem;

export interface AttentionItems {
  planItems: PlanAttentionItem[];
  prItems: PrAttentionItem[];
}

// --- Running now types ---

export interface RunningSession {
  connectionId: string;
  planUuid: string | null;
  planId: number | null;
  planTitle: string | null;
  workspacePath: string | null;
  command: string;
  connectedAt: string;
  projectId: number | null;
}

// --- Derivation functions ---

const AGENT_COMMANDS = new Set(['agent', 'generate', 'chat']);

export function deriveAttentionItems(
  plans: EnrichedPlan[],
  sessions: Iterable<SessionData>,
  actionablePrs: ActionablePr[]
): AttentionItems {
  // Index sessions by planUuid for fast lookup
  const sessionsByPlanUuid = new Map<string, SessionData[]>();
  for (const session of sessions) {
    const uuid = session.sessionInfo.planUuid;
    if (!uuid) continue;
    let list = sessionsByPlanUuid.get(uuid);
    if (!list) {
      list = [];
      sessionsByPlanUuid.set(uuid, list);
    }
    list.push(session);
  }

  const planItems: PlanAttentionItem[] = [];

  for (const plan of plans) {
    const reasons: PlanAttentionReason[] = [];
    const planSessions = sessionsByPlanUuid.get(plan.uuid) ?? [];

    // Check for active sessions waiting for input
    for (const session of planSessions) {
      if (session.status === 'active' && session.activePrompt) {
        reasons.push({
          type: 'waiting_for_input',
          sessionId: session.connectionId,
          promptType: session.activePrompt.promptType,
        });
      }
    }

    // Check for agent finished (offline agent/generate/chat session + plan still in_progress)
    if (plan.displayStatus === 'in_progress') {
      for (const session of planSessions) {
        if (session.status === 'offline' && AGENT_COMMANDS.has(session.sessionInfo.command)) {
          reasons.push({ type: 'agent_finished' });
          break; // Only add once regardless of how many offline sessions
        }
      }
    }

    // Check for needs_review
    if (plan.displayStatus === 'needs_review') {
      reasons.push({ type: 'needs_review' });
    }

    if (reasons.length > 0) {
      planItems.push({
        kind: 'plan',
        planUuid: plan.uuid,
        planId: plan.planId,
        planTitle: plan.title,
        projectId: plan.projectId,
        reasons,
      });
    }
  }

  const prItems: PrAttentionItem[] = actionablePrs.map((pr) => ({
    kind: 'pr' as const,
    actionablePr: pr,
  }));

  return { planItems, prItems };
}

export function deriveRunningNowSessions(
  sessions: Iterable<SessionData>,
  projectId: string
): RunningSession[] {
  const numericProjectId = projectId === 'all' ? null : Number(projectId);
  const results: RunningSession[] = [];

  for (const session of sessions) {
    if (session.status !== 'active') continue;
    if (!AGENT_COMMANDS.has(session.sessionInfo.command)) continue;
    if (numericProjectId !== null && session.projectId !== numericProjectId) continue;

    results.push({
      connectionId: session.connectionId,
      planUuid: session.sessionInfo.planUuid ?? null,
      planId: session.sessionInfo.planId ?? null,
      planTitle: session.sessionInfo.planTitle ?? null,
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

export function deriveReadyToStartPlans(
  plans: EnrichedPlan[],
  sessions: Iterable<SessionData>
): EnrichedPlan[] {
  // Collect planUuids with active sessions
  const activePlanUuids = new Set<string>();
  for (const session of sessions) {
    if (session.status === 'active' && session.sessionInfo.planUuid) {
      activePlanUuids.add(session.sessionInfo.planUuid);
    }
  }

  return plans
    .filter(
      (plan) => plan.displayStatus === 'ready' && !plan.epic && !activePlanUuids.has(plan.uuid)
    )
    .sort((a, b) => {
      const aPriority = a.priority ? (PRIORITY_ORDER[a.priority] ?? 0) : 0;
      const bPriority = b.priority ? (PRIORITY_ORDER[b.priority] ?? 0) : 0;
      return bPriority - aPriority;
    });
}
