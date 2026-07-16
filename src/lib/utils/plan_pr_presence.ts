export interface PlanPrPresenceSource {
  pullRequests?: readonly string[];
  prSummaryStatus?: 'passing' | 'failing' | 'pending' | 'none';
  hasPlanPrLinks?: boolean;
}

export function hasPlanPrData(plan: PlanPrPresenceSource): boolean {
  return (
    (plan.pullRequests?.length ?? 0) > 0 ||
    (plan.prSummaryStatus ?? 'none') !== 'none' ||
    plan.hasPlanPrLinks === true
  );
}
