import type { PlanDisplayStatus } from '$lib/server/db_queries.js';

export const STATUS_ORDER: PlanDisplayStatus[] = [
  'needs_review',
  'in_progress',
  'ready',
  'pending',
  'recently_done',
  'blocked',
  'done',
  'cancelled',
  'deferred',
];

export const STATUS_ORDER_MAP: Record<PlanDisplayStatus, number> = Object.fromEntries(
  STATUS_ORDER.map((s, i) => [s, i])
) as Record<PlanDisplayStatus, number>;
