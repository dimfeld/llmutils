import type { Database } from 'bun:sqlite';

import { ingestWebhookEvents, type IngestResult } from '$common/github/webhook_ingest.js';

import { processInboxSignals } from './inbox_producer.js';
import { triggerReviewCommands } from './review_command_trigger.js';
import type { SessionManager } from './session_manager.js';

export type InboxSessionManager = Pick<
  SessionManager,
  'emitInboxUpdate' | 'hasInboxUpdateListeners'
>;

export interface WebhookIngestOrchestratorOptions {
  /** Use this manager when the caller already owns the server session manager. */
  sessionManager?: InboxSessionManager;
  /** Resolve the server manager inside the best-effort post-ingest boundary. */
  getSessionManager?: () => InboxSessionManager;
}

/**
 * Ingest webhook events, start `/tim review` PR comment commands, and persist the
 * resulting inbox signals.
 *
 * Ingestion errors still reject. Inbox processing happens after successful
 * ingestion and cannot turn a completed ingest into a refresh failure.
 */
export async function ingestWebhookEventsWithInbox(
  db: Database,
  options: WebhookIngestOrchestratorOptions = {}
): Promise<IngestResult> {
  const ingestResult = await ingestWebhookEvents(db);

  // Every ingest path advances the shared cursor, so `/tim review` requests must be handled
  // here. Otherwise a manual refresh would consume them before the poller sees them.
  if ((ingestResult.reviewCommands?.length ?? 0) > 0) {
    try {
      await triggerReviewCommands(db, ingestResult.reviewCommands);
    } catch (error) {
      console.warn('[webhook_ingest] Review command processing failed', error);
    }
  }

  if ((ingestResult.inboxSignals?.length ?? 0) === 0) {
    return ingestResult;
  }

  try {
    const sessionManager = options.sessionManager ?? options.getSessionManager?.();
    await processInboxSignals(db, ingestResult.inboxSignals, { sessionManager });
  } catch (error) {
    console.warn('[webhook_ingest] Inbox post-processing failed', error);
  }

  return ingestResult;
}
