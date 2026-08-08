import type { Database } from 'bun:sqlite';

import { tryCanonicalizePrUrl } from '$common/github/identifiers.js';
import { planHref, prHref, type ObjectHref } from '$lib/server/object_hrefs.js';
import { type InboxItemKind, type InboxItemRow } from '$tim/db/inbox_item.js';
import { getLinkedPlansByPrUrl, type LinkedPlanSummary } from '$tim/db/pr_status.js';

export type InboxActionType = 'review-guide' | 'pr-fix' | 'ci-fix' | 'github';

export interface InboxActionDescriptor {
  type: InboxActionType | null;
  projectId: number | null;
  prNumber: number | null;
  planUuid?: string;
}

export interface EnrichedInboxItem extends InboxItemRow {
  viewHref: ObjectHref | null;
  planHref: string | null;
  action: InboxActionDescriptor;
}

function getActionType(kind: InboxItemKind): InboxActionType | null {
  switch (kind) {
    case 'review_requested':
      return 'review-guide';
    case 'pr_comment':
    case 'reviewed_pr_comment':
      return 'pr-fix';
    case 'ci_failure':
      return 'ci-fix';
    case 'merge_queue_removed':
      return 'github';
    case 'pr_merged':
    case 'pr_approved':
      return null;
    default:
      return null;
  }
}

function getLinkedPlansForItem(
  linkedPlansByPrUrl: Map<string, LinkedPlanSummary[]>,
  prUrl: string
): LinkedPlanSummary[] {
  const canonicalPrUrl = tryCanonicalizePrUrl(prUrl);
  return (
    (canonicalPrUrl ? linkedPlansByPrUrl.get(canonicalPrUrl) : undefined) ??
    linkedPlansByPrUrl.get(prUrl) ??
    []
  );
}

/**
 * Adds object links and launch metadata to inbox rows without requiring a
 * SvelteKit request context. This is also the shared enrichment path for the
 * toolbar and the full inbox page.
 */
export function enrichInboxItems(db: Database, rows: InboxItemRow[]): EnrichedInboxItem[] {
  const linkedPlansByPrUrl = getLinkedPlansByPrUrl(
    db,
    rows.map((row) => row.pr_url)
  );

  return rows.map((row) => {
    const linkedPlans = getLinkedPlansForItem(linkedPlansByPrUrl, row.pr_url);
    const planUuid = linkedPlans.length === 1 ? linkedPlans[0]?.planUuid : undefined;

    return {
      ...row,
      viewHref: prHref(row.project_id, row.pr_number, row.pr_url),
      planHref: planHref(row.project_id, planUuid ?? null),
      action: {
        type: getActionType(row.kind),
        projectId: row.project_id,
        prNumber: row.pr_number,
        ...(planUuid ? { planUuid } : {}),
      },
    };
  });
}
