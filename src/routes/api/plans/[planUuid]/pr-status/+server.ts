import type { RequestHandler } from './$types';

import { json } from '@sveltejs/kit';

import { ensurePrStatusFresh, syncPlanPrLinks } from '$common/github/pr_status_service.js';
import { categorizePrUrls, parseJsonStringArray } from '$lib/server/db_queries.js';
import { getServerContext } from '$lib/server/init.js';
import { cleanOrphanedPrStatus, getPrStatusByUrl, getPrStatusForPlan } from '$tim/db/pr_status.js';
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

  const { valid: prUrls, invalid: invalidPrUrls } = categorizePrUrls(
    parseJsonStringArray(plan.pull_request)
  );
  const prStatuses = getPrStatusForPlan(db, plan.uuid, prUrls);

  return json({
    prUrls,
    invalidPrUrls,
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
    try {
      await syncPlanPrLinks(db, plan.uuid, []);
    } catch {
      // Best-effort junction cleanup
    }
    cleanOrphanedPrStatus(db);
    return json({
      prUrls: [],
      invalidPrUrls: [],
      prStatuses: [],
    });
  }

  const { valid: normalizedPrUrls, invalid: invalidPrUrls } = categorizePrUrls(prUrls);

  if (!process.env.GITHUB_TOKEN) {
    // Sync junctions for already-cached PRs only (can't fetch new ones without token).
    // Always sync — even if cachedUrls is empty — to prune stale links from removed PRs.
    const cachedUrls = prUrls.filter((url) => getPrStatusByUrl(db, url) !== null);
    try {
      await syncPlanPrLinks(db, plan.uuid, cachedUrls);
    } catch {
      // The cache may have changed between filtering and syncing; return cached rows anyway.
    }
    cleanOrphanedPrStatus(db);
    return json({
      prUrls: normalizedPrUrls,
      invalidPrUrls,
      prStatuses: getPrStatusForPlan(db, plan.uuid, normalizedPrUrls),
      error: 'GITHUB_TOKEN not configured',
    });
  }

  try {
    // Sync plan-PR links first. If this fails (e.g. bad uncached URL), fall back to
    // syncing only already-cached URLs so stale links still get pruned.
    try {
      await syncPlanPrLinks(db, plan.uuid, prUrls);
    } catch {
      const cachedUrls = prUrls.filter((url) => getPrStatusByUrl(db, url) !== null);
      try {
        await syncPlanPrLinks(db, plan.uuid, cachedUrls);
      } catch {
        // Best-effort — continue to refresh even if sync fails
      }
    }

    const refreshResults = await Promise.allSettled(
      normalizedPrUrls.map((prUrl) => ensurePrStatusFresh(db, prUrl, PR_STATUS_MAX_AGE_MS))
    );
    const errors: string[] = invalidPrUrls.map((url) => `${url}: not a valid PR URL`);
    const prStatuses = refreshResults.flatMap((result, index) => {
      if (result.status === 'fulfilled') {
        return [result.value];
      }

      const prUrl = normalizedPrUrls[index]!;
      const cached = getPrStatusByUrl(db, prUrl);
      errors.push(
        `${prUrl}: ${
          result.reason instanceof Error ? result.reason.message : String(result.reason)
        }`
      );

      return cached ? [cached] : [];
    });

    cleanOrphanedPrStatus(db);
    return json({
      prUrls: normalizedPrUrls,
      invalidPrUrls,
      prStatuses,
      ...(errors.length > 0
        ? { error: `Some pull request entries had issues: ${errors.join('; ')}` }
        : {}),
    });
  } catch (err) {
    cleanOrphanedPrStatus(db);
    return json({
      prUrls: normalizedPrUrls,
      invalidPrUrls,
      prStatuses: getPrStatusForPlan(db, plan.uuid, normalizedPrUrls),
      error: `GitHub API error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
};
