import { command, query } from '$app/server';
import { error } from '@sveltejs/kit';
import * as z from 'zod';

import { formatWebhookIngestErrors, ingestWebhookEvents } from '$common/github/webhook_ingest.js';
import {
  ensurePrStatusFresh,
  refreshPrStatus as refreshPrStatusFromApi,
  syncPlanPrLinks,
} from '$common/github/pr_status_service.js';
import { resolveGitHubToken } from '$common/github/token.js';
import { getWebhookServerUrl } from '$common/github/webhook_client.js';
import { categorizePrUrls, parseJsonStringArray } from '$lib/server/db_queries.js';
import { getServerContext } from '$lib/server/init.js';
import { emitPrUpdatesForIngestResult } from '$lib/server/pr_event_utils.js';
import { getSessionManager } from '$lib/server/session_context.js';
import { cleanOrphanedPrStatus, getPrStatusByUrl, getPrStatusForPlan } from '$tim/db/pr_status.js';
import { getPlanByUuid } from '$tim/db/plan.js';

const PR_STATUS_MAX_AGE_MS = 5 * 60 * 1000;

const planUuidSchema = z.object({
  planUuid: z.string().min(1),
});

const prUrlSchema = z.object({
  prUrl: z.string().url(),
});

async function loadPlanAndContext(planUuid: string) {
  const { db } = await getServerContext();
  const plan = getPlanByUuid(db, planUuid);

  return {
    db,
    plan,
  };
}

function getAutoLinkedPrUrlsForPlan(
  db: Awaited<ReturnType<typeof getServerContext>>['db'],
  planUuid: string
): string[] {
  return db
    .prepare(
      `
        SELECT DISTINCT ps.pr_url
        FROM plan_pr pp
        INNER JOIN pr_status ps ON ps.id = pp.pr_status_id
        WHERE pp.plan_uuid = ? AND pp.source = 'auto'
        ORDER BY ps.pr_url
      `
    )
    .all(planUuid)
    .map((row) => (row as { pr_url: string }).pr_url);
}

async function refreshPlanPrStatusFromGitHub(
  db: Awaited<ReturnType<typeof getServerContext>>['db'],
  planUuid: string,
  plan: NonNullable<Awaited<ReturnType<typeof loadPlanAndContext>>['plan']>,
  options?: { force?: boolean }
): Promise<{ error?: string }> {
  const explicitPrUrls = parseJsonStringArray(plan.pull_request);
  const autoLinkedPrUrls = getAutoLinkedPrUrlsForPlan(db, planUuid);

  const { valid: normalizedPrUrls, invalid: invalidPrUrls } = categorizePrUrls(explicitPrUrls);
  const prUrls = [...new Set([...normalizedPrUrls, ...autoLinkedPrUrls])];

  if (!resolveGitHubToken()) {
    const cachedUrls = explicitPrUrls.filter((url) => getPrStatusByUrl(db, url) !== null);
    try {
      await syncPlanPrLinks(db, plan.uuid, cachedUrls);
    } catch {
      // best-effort
    }
    cleanOrphanedPrStatus(db);
    getPrStatus({ planUuid }).refresh();
    return {
      error: prUrls.length > 0 ? ('GITHUB_TOKEN not configured' as string | undefined) : undefined,
    };
  }

  let refreshError: string | undefined;
  try {
    // Sync plan-PR links first. If this fails (e.g. bad uncached URL), fall back to
    // syncing only already-cached URLs so stale links still get pruned.
    try {
      await syncPlanPrLinks(db, plan.uuid, explicitPrUrls);
    } catch {
      const cachedUrls = explicitPrUrls.filter((url) => getPrStatusByUrl(db, url) !== null);
      try {
        await syncPlanPrLinks(db, plan.uuid, cachedUrls);
      } catch {
        // Best-effort — continue to refresh even if sync fails
      }
    }
    if (prUrls.length === 0) {
      cleanOrphanedPrStatus(db);
      getPrStatus({ planUuid }).refresh();
      return { error: undefined as string | undefined };
    }

    const refreshResults = await Promise.allSettled(
      prUrls.map((prUrl) =>
        options?.force
          ? refreshPrStatusFromApi(db, prUrl)
          : ensurePrStatusFresh(db, prUrl, PR_STATUS_MAX_AGE_MS)
      )
    );
    const errors: string[] = invalidPrUrls.map((url) => `${url}: not a valid PR URL`);
    refreshResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        const prUrl = prUrls[index]!;
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
}

export const getPrStatus = query(planUuidSchema, async ({ planUuid }) => {
  const { db, plan } = await loadPlanAndContext(planUuid);
  if (!plan) {
    error(404, 'Plan not found');
  }

  const { valid: prUrls, invalid: invalidPrUrls } = categorizePrUrls(
    parseJsonStringArray(plan.pull_request)
  );
  const prStatuses = getPrStatusForPlan(db, plan.uuid, prUrls, { includeReviewThreads: true });

  return {
    prUrls,
    invalidPrUrls,
    prStatuses,
    tokenConfigured: !!resolveGitHubToken(),
  };
});

export const refreshPrStatus = command(planUuidSchema, async ({ planUuid }) => {
  const { db, plan } = await loadPlanAndContext(planUuid);
  if (!plan) {
    error(404, 'Plan not found');
  }

  const webhookServerUrl = getWebhookServerUrl();
  let webhookRefreshError: string | undefined;

  if (webhookServerUrl) {
    try {
      const ingestResult = await ingestWebhookEvents(db);
      try {
        emitPrUpdatesForIngestResult(db, ingestResult, getSessionManager());
      } catch (err) {
        console.warn('[pr_status] Failed to emit PR update event', err);
      }
      webhookRefreshError = formatWebhookIngestErrors(ingestResult.errors);
    } catch (err) {
      cleanOrphanedPrStatus(db);
      getPrStatus({ planUuid }).refresh();
      return {
        error: `Webhook ingestion failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const explicitPrUrls = parseJsonStringArray(plan.pull_request);
  const autoLinkedPrUrls = getAutoLinkedPrUrlsForPlan(db, planUuid);
  const { valid: normalizedPrUrls, invalid: invalidPrUrls } = categorizePrUrls(explicitPrUrls);
  const prUrls = [...new Set([...normalizedPrUrls, ...autoLinkedPrUrls])];

  // In webhook mode, sync only already-cached explicit junction rows (best-effort)
  // then return cached data without a full GitHub API refresh.
  if (webhookServerUrl) {
    const cachedExplicitUrls = explicitPrUrls.filter((url) => getPrStatusByUrl(db, url) !== null);
    try {
      await syncPlanPrLinks(db, plan.uuid, cachedExplicitUrls);
    } catch {
      // Best-effort
    }
    cleanOrphanedPrStatus(db);
    getPrStatus({ planUuid }).refresh();

    const errors: string[] = invalidPrUrls.map((url) => `${url}: not a valid PR URL`);
    const uncachedUrls = prUrls.filter((url) => getPrStatusByUrl(db, url) === null);
    if (uncachedUrls.length > 0) {
      errors.push(`Not yet available from webhooks: ${uncachedUrls.join(', ')}`);
    }
    if (webhookRefreshError) {
      errors.unshift(webhookRefreshError);
    }
    return {
      error: errors.length > 0 ? errors.join('; ') : (undefined as string | undefined),
    };
  }

  return refreshPlanPrStatusFromGitHub(db, planUuid, plan);
});

export const fullRefreshPrStatus = command(planUuidSchema, async ({ planUuid }) => {
  const { db, plan } = await loadPlanAndContext(planUuid);
  if (!plan) {
    error(404, 'Plan not found');
  }

  return refreshPlanPrStatusFromGitHub(db, planUuid, plan, { force: true });
});

export const refreshSinglePrStatus = command(prUrlSchema, async ({ prUrl }) => {
  const { db } = await getServerContext();

  if (!resolveGitHubToken()) {
    error(400, 'GITHUB_TOKEN not configured');
  }

  try {
    await refreshPrStatusFromApi(db, prUrl);
  } catch (err) {
    error(500, `Failed to refresh PR: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { success: true };
});
