import type { EnrichedPlan } from '$lib/server/db_queries.js';

export function planMatchesSearch(
  plan: Pick<EnrichedPlan, 'planId' | 'title' | 'goal'>,
  query: string
): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  return (
    String(plan.planId).includes(normalizedQuery) ||
    (plan.title?.toLowerCase().includes(normalizedQuery) ?? false) ||
    (plan.goal?.toLowerCase().includes(normalizedQuery) ?? false)
  );
}
