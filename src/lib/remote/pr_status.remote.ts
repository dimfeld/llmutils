import { command, query } from '$app/server';
import { error } from '@sveltejs/kit';
import * as z from 'zod';

import { ensurePrStatusFresh, syncPlanPrLinks } from '$common/github/pr_status_service.js';
import { resolveGitHubToken } from '$common/github/token.js';
import { categorizePrUrls, parseJsonStringArray } from '$lib/server/db_queries.js';
import { getServerContext } from '$lib/server/init.js';
import { cleanOrphanedPrStatus, getPrStatusByUrl, getPrStatusForPlan } from '$tim/db/pr_status.js';
import { getPlanByUuid } from '$tim/db/plan.js';

const PR_STATUS_MAX_AGE_MS = 5 * 60 * 1000;

const planUuidSchema = z.object({
  planUuid: z.string().min(1),
});

async function loadPlanAndContext(planUuid: string) {
  const { db } = await getServerContext();
  const plan = getPlanByUuid(db, planUuid);

  return {
    db,
    plan,
  };
}

export const getPrStatus = query(planUuidSchema, async ({ planUuid }) => {
  const { db, plan } = await loadPlanAndContext(planUuid);
  if (!plan) {
    error(404, 'Plan not found');
  }

  const { valid: prUrls, invalid: invalidPrUrls } = categorizePrUrls(
    parseJsonStringArray(plan.pull_request)
  );
  const prStatuses = getPrStatusForPlan(db, plan.uuid, prUrls);

  return {
    prUrls,
    invalidPrUrls,
    prStatuses,
  };
});

export const refreshPrStatus = command(planUuidSchema, async ({ planUuid }) => {
  const { db, plan } = await loadPlanAndContext(planUuid);
  if (!plan) {
    error(404, 'Plan not found');
  }

  const prUrls = parseJsonStringArray(plan.pull_request);
  if (prUrls.length === 0) {
    try {
      await syncPlanPrLinks(db, plan.uuid, []);
    } catch {
      // Best-effort junction cleanup
    }
    cleanOrphanedPrStatus(db);
    getPrStatus({ planUuid }).refresh();
    return { error: undefined as string | undefined };
  }

  const { valid: normalizedPrUrls, invalid: invalidPrUrls } = categorizePrUrls(prUrls);

  if (!resolveGitHubToken()) {
    // Sync junctions for already-cached PRs only (can't fetch new ones without token).
    // Always sync — even if cachedUrls is empty — to prune stale links from removed PRs.
    const cachedUrls = prUrls.filter((url) => getPrStatusByUrl(db, url) !== null);
    try {
      await syncPlanPrLinks(db, plan.uuid, cachedUrls);
    } catch {
      // The cache may have changed between filtering and syncing; return cached rows anyway.
    }
    cleanOrphanedPrStatus(db);
    getPrStatus({ planUuid }).refresh();
    return { error: 'GITHUB_TOKEN not configured' as string | undefined };
  }

  let refreshError: string | undefined;
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
    refreshResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        const prUrl = normalizedPrUrls[index]!;
        errors.push(
          `${prUrl}: ${
            result.reason instanceof Error ? result.reason.message : String(result.reason)
          }`
        );
      }
    });

    if (errors.length > 0) {
      refreshError = `Some pull request entries had issues: ${errors.join('; ')}`;
    }
  } catch (err) {
    refreshError = `GitHub API error: ${err instanceof Error ? err.message : String(err)}`;
  }

  cleanOrphanedPrStatus(db);
  getPrStatus({ planUuid }).refresh();
  return { error: refreshError };
});
