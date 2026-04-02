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
import { getKnownRepoFullNames } from '../../tim/db/pr_status.js';
import {
  getWebhookCursor,
  insertWebhookLogEntry,
  pruneOldWebhookLogs,
  updateWebhookCursor,
} from '../../tim/db/webhook_log.js';

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
