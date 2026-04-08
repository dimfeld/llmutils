import type { Database } from 'bun:sqlite';
import {
  fetchWebhookEvents,
  getWebhookInternalApiToken,
  getWebhookServerUrl,
} from './webhook_client.js';
import { fetchAndUpdatePrMergeableStatus } from './pr_status_service.js';
import {
  handleCheckRunEvent,
  handlePullRequestEvent,
  handlePullRequestReviewEvent,
  type PrRefreshTarget,
  type WebhookHandlerOptions,
} from './webhook_event_handlers.js';
import { constructGitHubRepositoryId } from './pull_requests.js';
import { getKnownRepoFullNames } from '../../tim/db/pr_status.js';
import { loadEffectiveConfig } from '../../tim/configLoader.js';
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

function computeNeedsFinishExecutor(
  docsUpdatedAt: string | null,
  lessonsAppliedAt: string | null,
  finishConfig: { updateDocs?: { mode?: string; applyLessons?: boolean } }
): boolean {
  const mode = finishConfig.updateDocs?.mode ?? 'never';
  const needsDocs = docsUpdatedAt === null && mode !== 'never';
  const needsLessons = lessonsAppliedAt === null && finishConfig.updateDocs?.applyLessons === true;
  return needsDocs || needsLessons;
}

function isMergedPrPayload(
  payload: unknown
): payload is {
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

  const finishConfig = project.last_git_root
    ? await loadEffectiveConfig(undefined, { cwd: project.last_git_root })
    : getDefaultConfig();

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
    if (
      plan.tasks.length === 0 ||
      !plan.tasks.every((task) => task.done === true) ||
      computeNeedsFinishExecutor(plan.docsUpdatedAt ?? null, plan.lessonsAppliedAt ?? null, {
        updateDocs: finishConfig.updateDocs,
      })
    ) {
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
    removeAssignment(db, project.id, completedPlan.uuid);

    if (completedPlan.parent != null) {
      completedParents.add(completedPlan.parent);
    }
  }

  for (const parentId of completedParents) {
    await checkAndMarkParentDone(parentId, finishConfig, { db, projectId: project.id });
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
  /** Deduplicated set of PRs needing API refresh, keyed by "owner/repo#number". */
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
        continue;
      }

      eventsProcessed += 1;

      try {
        const payload = JSON.parse(event.payloadJson) as unknown;
        const result =
          event.eventType === 'pull_request'
            ? handlePullRequestEvent(db, payload, handlerOptions)
            : event.eventType === 'pull_request_review'
              ? handlePullRequestReviewEvent(db, payload, handlerOptions)
              : event.eventType === 'check_run'
                ? handleCheckRunEvent(db, payload, handlerOptions)
                : null;

        if (!result) {
          continue;
        }

        if (result.prUrl) {
          prsUpdated.add(result.prUrl);
        }
        for (const prUrl of result.prUrls ?? []) {
          prsUpdated.add(prUrl);
        }

        // Collect refresh targets — deduplication happens via the Map key
        for (const target of result.apiRefreshTargets ?? []) {
          const key = `${target.owner}/${target.repo}#${target.prNumber}`;
          apiRefreshTargets.set(key, target);
        }

        if (
          event.eventType === 'pull_request' &&
          isMergedPrPayload(payload) &&
          typeof payload.pull_request.number === 'number'
        ) {
          const [owner, repo] = event.repositoryFullName.split('/');
          if (!owner || !repo) {
            continue;
          }
          try {
            await autoCompleteMergedLinkedPlans(db, owner, repo, payload.pull_request.number);
          } catch (err) {
            errors.push(
              `webhook auto-complete failed: ${
                err instanceof Error ? err.message : String(err)
              }`
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
  const apiCallPromises = [...apiRefreshTargets.values()].map((target) =>
    fetchAndUpdatePrMergeableStatus(db, target.owner, target.repo, target.prNumber).catch(
      (err: unknown) => {
        throw new Error(`${target.owner}/${target.repo}#${target.prNumber}: ${target.operation}`, {
          cause: err instanceof Error ? err : new Error(String(err)),
        });
      }
    )
  );

  const apiResults = await Promise.allSettled(apiCallPromises);
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
