import type { Database } from 'bun:sqlite';
import {
  fetchWebhookEvents,
  getWebhookInternalApiToken,
  getWebhookServerUrl,
} from './webhook_client.js';
import {
  fetchAndUpdatePrMergeableStatus,
  fetchAndUpdatePrReviewThreads,
} from './pr_status_service.js';
import {
  handleCheckRunEvent,
  handlePullRequestEvent,
  handlePullRequestReviewEvent,
  handlePullRequestReviewThreadEvent,
  type PrRefreshTarget,
  type WebhookHandlerOptions,
} from './webhook_event_handlers.js';
import { constructGitHubRepositoryId } from './pull_requests.js';
import { getKnownRepoFullNames } from '../../tim/db/pr_status.js';
import { removeAssignment } from '../../tim/db/assignment.js';
import {
  getPlanByUuid,
  getPlanDependenciesByUuid,
  getPlanTasksByUuid,
  getPlanTagsByUuid,
  getPlansByProject,
  upsertPlan,
} from '../../tim/db/plan.js';
import { getProject } from '../../tim/db/project.js';
import {
  getWebhookCursor,
  insertWebhookLogEntry,
  pruneOldWebhookLogs,
  updateWebhookCursor,
} from '../../tim/db/webhook_log.js';
import { checkAndMarkParentDone } from '../../tim/plans/parent_cascade.js';
import { invertPlanIdToUuidMap, planRowToSchemaInput } from '../../tim/plans_db.js';
import { toPlanUpsertInput } from '../../tim/db/plan_sync.js';
import { type PlanSchema } from '../../tim/planSchema.js';
import { getDefaultConfig } from '../../tim/configSchema.js';
import { getPrStatusByRepoAndNumber } from '../../tim/db/pr_status.js';

function isMergedPrPayload(payload: unknown): payload is {
  pull_request: { number: number; merged_at?: string | null; state?: string };
} {
  if (!payload || typeof payload !== 'object') {
    return false;
  }

  const pullRequest = (payload as { pull_request?: unknown }).pull_request;
  if (!pullRequest || typeof pullRequest !== 'object') {
    return false;
  }

  const mergedAt = (pullRequest as { merged_at?: unknown }).merged_at;
  const state = (pullRequest as { state?: unknown }).state;
  return typeof mergedAt === 'string' && state === 'closed';
}

async function autoCompleteMergedLinkedPlans(
  db: Database,
  owner: string,
  repo: string,
  prNumber: number
): Promise<void> {
  const prStatus = getPrStatusByRepoAndNumber(db, owner, repo, prNumber);
  if (!prStatus) {
    return;
  }

  const project = getProject(db, constructGitHubRepositoryId(owner, repo));
  if (!project) {
    return;
  }

  const linkedPlanRows = db
    .prepare(
      `
      SELECT DISTINCT plan_uuid
      FROM plan_pr
      WHERE pr_status_id = ?
      ORDER BY plan_uuid
    `
    )
    .all(prStatus.id) as Array<{ plan_uuid: string }>;

  if (linkedPlanRows.length === 0) {
    return;
  }

  const planRows = getPlansByProject(db, project.id);
  const planIdToUuid = new Map(planRows.map((row) => [row.plan_id, row.uuid]));
  const uuidToPlanId = invertPlanIdToUuidMap(planIdToUuid);
  const completedParents = new Set<number>();
  const nowIso = new Date().toISOString();

  for (const { plan_uuid: planUuid } of linkedPlanRows) {
    const planRow = getPlanByUuid(db, planUuid);
    if (!planRow || planRow.status !== 'needs_review') {
      continue;
    }

    const plan = planRowToSchemaInput(
      planRow,
      getPlanTasksByUuid(db, planUuid).map((task) => ({
        title: task.title,
        description: task.description,
        done: task.done === 1,
      })),
      getPlanDependenciesByUuid(db, planUuid).map((dependency) => dependency.depends_on_uuid),
      getPlanTagsByUuid(db, planUuid).map((tag) => tag.tag),
      uuidToPlanId
    );
    if (plan.tasks.length === 0 || !plan.tasks.every((task) => task.done === true)) {
      continue;
    }

    const completedPlan: PlanSchema = {
      ...plan,
      status: 'done',
      updatedAt: nowIso,
    };

    upsertPlan(db, project.id, {
      ...toPlanUpsertInput(completedPlan, planIdToUuid),
      forceOverwrite: true,
    });
    removeAssignment(db, project.id, planUuid);

    if (completedPlan.parent != null) {
      completedParents.add(completedPlan.parent);
    }
  }

  for (const parentId of completedParents) {
    await checkAndMarkParentDone(parentId, getDefaultConfig(), { db, projectId: project.id });
  }
}

export interface IngestResult {
  eventsIngested: number;
  prsUpdated: string[];
  errors: string[];
}

export function formatWebhookIngestErrors(errors: string[]): string | undefined {
  return errors.length > 0 ? `Webhook ingestion had issues: ${errors.join('; ')}` : undefined;
}

function formatIngestError(eventId: number, message: string): string {
  return `webhook event ${eventId}: ${message}`;
}

export async function ingestWebhookEvents(db: Database): Promise<IngestResult> {
  const serverUrl = getWebhookServerUrl();
  if (!serverUrl) {
    return { eventsIngested: 0, prsUpdated: [], errors: [] };
  }

  const token = getWebhookInternalApiToken();
  if (!token) {
    console.warn('TIM_WEBHOOK_SERVER_URL is set but WEBHOOK_INTERNAL_API_TOKEN is missing');
    return {
      eventsIngested: 0,
      prsUpdated: [],
      errors: ['WEBHOOK_INTERNAL_API_TOKEN is not configured but TIM_WEBHOOK_SERVER_URL is set'],
    };
  }

  const BATCH_SIZE = 500;
  const prsUpdated = new Set<string>();
  const errors: string[] = [];
  /** Deduplicated set of PRs needing API refresh, keyed by "owner/repo#number:type[:threadId]". */
  const apiRefreshTargets = new Map<string, PrRefreshTarget>();
  let eventsProcessed = 0;
  let cursorId = getWebhookCursor(db);

  // Cache known repos once per ingestion run to avoid repeated DB queries
  const knownRepos = getKnownRepoFullNames(db);
  const handlerOptions: WebhookHandlerOptions = { knownRepos };

  // Fetch and process in batches until the server returns fewer than BATCH_SIZE events
  while (true) {
    const events = await fetchWebhookEvents(serverUrl, token, {
      afterId: cursorId,
      limit: BATCH_SIZE,
    });
    if (events.length === 0) {
      break;
    }

    for (const event of events) {
      console.log(
        `[webhook-ingest] event id=${event.id} delivery=${event.deliveryId} type=${event.eventType} action=${event.action ?? 'none'} repo=${event.repositoryFullName ?? 'unknown'}`
      );
      const { inserted } = insertWebhookLogEntry(db, {
        deliveryId: event.deliveryId,
        eventType: event.eventType,
        action: event.action,
        repositoryFullName: event.repositoryFullName,
        payloadJson: event.payloadJson,
        receivedAt: event.receivedAt,
      });

      // Skip handler dispatch for duplicate delivery IDs
      if (!inserted) {
        console.log(`[webhook-ingest] skipped duplicate delivery ${event.deliveryId}`);
        continue;
      }

      eventsProcessed += 1;

      try {
        const payload = JSON.parse(event.payloadJson) as unknown;
        console.log(`[webhook-ingest] dispatching handler for event ${event.id}`);
        const result =
          event.eventType === 'pull_request'
            ? handlePullRequestEvent(db, payload, handlerOptions)
            : event.eventType === 'pull_request_review'
              ? handlePullRequestReviewEvent(db, payload, handlerOptions)
              : event.eventType === 'pull_request_review_thread' ||
                  event.eventType === 'pull_request_review_comment'
                ? handlePullRequestReviewThreadEvent(db, payload, handlerOptions)
                : event.eventType === 'check_run'
                  ? handleCheckRunEvent(db, payload, handlerOptions)
                  : null;

        if (!result) {
          console.log(`[webhook-ingest] no handler result for event ${event.id}`);
          continue;
        }

        console.log(
          `[webhook-ingest] handler result event=${event.id} updated=${result.updated} prUrl=${result.prUrl ?? 'none'} prUrls=${(result.prUrls ?? []).join(',') || 'none'} refreshTargets=${(result.apiRefreshTargets ?? []).length}`
        );

        if (result.prUrl) {
          prsUpdated.add(result.prUrl);
        }
        for (const prUrl of result.prUrls ?? []) {
          prsUpdated.add(prUrl);
        }

        // Collect refresh targets. Deduplicate by PR and refresh type so a review-thread
        // refresh cannot overwrite a mergeable refresh for the same PR in the same batch.
        for (const target of result.apiRefreshTargets ?? []) {
          const key =
            target.type === 'review_threads'
              ? `${target.owner}/${target.repo}#${target.prNumber}:${target.type}:${target.threadId ?? 'all'}`
              : `${target.owner}/${target.repo}#${target.prNumber}:${target.type}`;
          console.log(
            `[webhook-ingest] queued refresh key=${key} type=${target.type} thread=${target.threadId ?? 'all'} op=${target.operation}`
          );
          apiRefreshTargets.set(key, target);
        }

        if (
          event.eventType === 'pull_request' &&
          isMergedPrPayload(payload) &&
          typeof payload.pull_request.number === 'number'
        ) {
          if (!event.repositoryFullName) {
            continue;
          }
          const [owner, repo] = event.repositoryFullName.split('/');
          if (!owner || !repo) {
            continue;
          }
          try {
            await autoCompleteMergedLinkedPlans(db, owner, repo, payload.pull_request.number);
          } catch (err) {
            errors.push(
              `webhook auto-complete failed: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      } catch (err) {
        errors.push(formatIngestError(event.id, err instanceof Error ? err.message : String(err)));
      }
    }

    // Advance cursor to the max event ID in this batch
    cursorId = events.reduce((maxId, event) => Math.max(maxId, event.id), cursorId);
    updateWebhookCursor(db, cursorId);

    if (events.length < BATCH_SIZE) {
      break;
    }
  }

  // Execute deduplicated API refresh calls
  const apiCallPromises = [...apiRefreshTargets.values()].map((target) => {
    const refreshType = target.type ?? 'mergeable'; // Default to mergeable for backwards compatibility
    if (refreshType === 'review_threads') {
      console.log(
        `[webhook-ingest] starting review-thread refresh ${target.owner}/${target.repo}#${target.prNumber} thread=${target.threadId ?? 'all'}`
      );
      return fetchAndUpdatePrReviewThreads(
        db,
        `${target.owner}/${target.repo}/pull/${target.prNumber}`,
        target.threadId
      )
        .then(() => {
          console.log(
            `[webhook-ingest] completed review-thread refresh ${target.owner}/${target.repo}#${target.prNumber} thread=${target.threadId ?? 'all'}`
          );
        })
        .catch((err: unknown) => {
          console.error(
            `[webhook-ingest] review-thread refresh failed ${target.owner}/${target.repo}#${target.prNumber} thread=${target.threadId ?? 'all'}: ${err instanceof Error ? err.message : String(err)}`
          );
          throw new Error(
            `${target.owner}/${target.repo}#${target.prNumber}: ${target.operation}`,
            {
              cause: err instanceof Error ? err : new Error(String(err)),
            }
          );
        });
    } else {
      console.log(
        `[webhook-ingest] starting mergeable refresh ${target.owner}/${target.repo}#${target.prNumber}`
      );
      return fetchAndUpdatePrMergeableStatus(db, target.owner, target.repo, target.prNumber).catch(
        (err: unknown) => {
          console.error(
            `[webhook-ingest] mergeable refresh failed ${target.owner}/${target.repo}#${target.prNumber}: ${err instanceof Error ? err.message : String(err)}`
          );
          throw new Error(
            `${target.owner}/${target.repo}#${target.prNumber}: ${target.operation}`,
            {
              cause: err instanceof Error ? err : new Error(String(err)),
            }
          );
        }
      );
    }
  });

  const apiResults = await Promise.allSettled(apiCallPromises);
  if (apiResults.length) {
    console.log(
      `[webhook-ingest] refresh results fulfilled=${apiResults.filter((result) => result.status === 'fulfilled').length} rejected=${apiResults.filter((result) => result.status === 'rejected').length}`
    );
  }
  for (const result of apiResults) {
    if (result.status === 'rejected') {
      errors.push(
        `webhook follow-up refresh failed: ${
          result.reason instanceof Error ? result.reason.message : String(result.reason)
        }`
      );
    }
  }

  if (eventsProcessed > 0) {
    pruneOldWebhookLogs(db, 30);
  }

  return {
    eventsIngested: eventsProcessed,
    prsUpdated: [...prsUpdated],
    errors,
  };
}
