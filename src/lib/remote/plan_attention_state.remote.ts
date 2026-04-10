import { query } from '$app/server';
import * as z from 'zod';

import { getPlansForProject } from '$lib/server/db_queries.js';
import { getServerContext } from '$lib/server/init.js';
import { loadEffectiveConfig } from '$tim/configLoader.js';
import { getPlanByUuid } from '$tim/db/plan.js';
import { getPreferredProjectGitRoot } from '$tim/workspace/workspace_info.js';
import { loadFinishConfigForProject } from '$lib/server/plans_browser.js';

const planUuidSchema = z.object({ planUuid: z.string().min(1) });

export interface PlanAttentionState {
  displayStatus: string;
  reviewIssueCount: number;
  canUpdateDocs: boolean;
  hasPr: boolean;
  epic: boolean;
  developmentWorkflow: 'pr-based' | 'trunk-based';
}

export const getPlanAttentionState = query(planUuidSchema, async ({ planUuid }) => {
  const { db } = await getServerContext();
  const planRow = getPlanByUuid(db, planUuid);
  if (!planRow) return null;

  const finishConfig = await loadFinishConfigForProject(db, planRow.project_id);
  const plans = getPlansForProject(db, planRow.project_id, finishConfig);
  const plan = plans.find((p) => p.uuid === planUuid);
  if (!plan) return null;

  let developmentWorkflow: 'pr-based' | 'trunk-based' = 'pr-based';
  const gitRoot = getPreferredProjectGitRoot(db, planRow.project_id);
  if (gitRoot) {
    try {
      const config = await loadEffectiveConfig(undefined, { cwd: gitRoot });
      developmentWorkflow = config.developmentWorkflow ?? 'pr-based';
    } catch {
      // default to pr-based
    }
  }

  const result: PlanAttentionState = {
    displayStatus: plan.displayStatus,
    reviewIssueCount: plan.reviewIssueCount,
    canUpdateDocs: plan.canUpdateDocs,
    hasPr: plan.pullRequests.length > 0 || plan.prSummaryStatus !== 'none' || plan.hasPlanPrLinks,
    epic: plan.epic,
    developmentWorkflow,
  };
  return result;
});
