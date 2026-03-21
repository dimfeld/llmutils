import type { RequestHandler } from './$types';

import { json } from '@sveltejs/kit';

import { ensurePrStatusFresh, syncPlanPrLinks } from '$common/github/pr_status_service.js';
import { parseJsonStringArray } from '$lib/server/db_queries.js';
import { getServerContext } from '$lib/server/init.js';
import { getPrStatusByUrl, getPrStatusForPlan } from '$tim/db/pr_status.js';
import { getPlanByUuid } from '$tim/db/plan.js';

const PR_STATUS_MAX_AGE_MS = 5 * 60 * 1000;

async function loadPlanAndContext(planUuid: string) {
  const { db } = await getServerContext();
  const plan = getPlanByUuid(db, planUuid);

  return {
    db,
    plan,
  };
}

export const GET: RequestHandler = async ({ params }) => {
  const { db, plan } = await loadPlanAndContext(params.planUuid);
  if (!plan) {
    return json({ error: 'Plan not found' }, { status: 404 });
  }

  const prUrls = parseJsonStringArray(plan.pull_request);
  const prStatuses = getPrStatusForPlan(db, plan.uuid);

  return json({
    prUrls,
    prStatuses,
  });
};

export const POST: RequestHandler = async ({ params }) => {
  const { db, plan } = await loadPlanAndContext(params.planUuid);
  if (!plan) {
    return json({ error: 'Plan not found' }, { status: 404 });
  }

  const prUrls = parseJsonStringArray(plan.pull_request);
  if (prUrls.length === 0) {
    await syncPlanPrLinks(db, plan.uuid, []);
    return json({
      prUrls,
      prStatuses: [],
    });
  }

  if (!process.env.GITHUB_TOKEN) {
    // Sync junctions for already-cached PRs only (can't fetch new ones without token).
    const cachedUrls = prUrls.filter((url) => getPrStatusByUrl(db, url) !== null);
    if (cachedUrls.length > 0) {
      await syncPlanPrLinks(db, plan.uuid, cachedUrls);
    }
    return json({
      prUrls,
      prStatuses: getPrStatusForPlan(db, plan.uuid),
      error: 'GITHUB_TOKEN not configured',
    });
  }

  try {
    await syncPlanPrLinks(db, plan.uuid, prUrls);
    const prStatuses = await Promise.all(
      prUrls.map((prUrl) => ensurePrStatusFresh(db, prUrl, PR_STATUS_MAX_AGE_MS))
    );

    return json({
      prUrls,
      prStatuses,
    });
  } catch (err) {
    return json({
      prUrls,
      prStatuses: getPrStatusForPlan(db, plan.uuid),
      error: `GitHub API error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
};
