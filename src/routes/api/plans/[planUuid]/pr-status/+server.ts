import type { RequestHandler } from './$types';

import { json } from '@sveltejs/kit';

import { ensurePrStatusFresh, syncPlanPrLinks } from '$common/github/pr_status_service.js';
import { getServerContext } from '$lib/server/init.js';
import { getPrStatusForPlan } from '$tim/db/pr_status.js';
import { getPlanByUuid } from '$tim/db/plan.js';

const PR_STATUS_MAX_AGE_MS = 5 * 60 * 1000;

function parsePlanPullRequests(pullRequestValue: string | null): string[] {
  if (!pullRequestValue) {
    return [];
  }

  try {
    const parsed = JSON.parse(pullRequestValue);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

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

  const prUrls = parsePlanPullRequests(plan.pull_request);
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

  const prUrls = parsePlanPullRequests(plan.pull_request);
  if (prUrls.length === 0) {
    return json({
      prUrls,
      prStatuses: [],
    });
  }

  if (!process.env.GITHUB_TOKEN) {
    return json({
      prUrls,
      prStatuses: getPrStatusForPlan(db, plan.uuid),
      error: 'GITHUB_TOKEN not configured',
    });
  }

  await syncPlanPrLinks(db, plan.uuid, prUrls);
  const prStatuses = await Promise.all(
    prUrls.map((prUrl) => ensurePrStatusFresh(db, prUrl, PR_STATUS_MAX_AGE_MS))
  );

  return json({
    prUrls,
    prStatuses,
  });
};
