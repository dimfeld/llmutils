import type { Database } from 'bun:sqlite';
import { artifactFileExists } from '../artifacts/storage.js';
import {
  type ListArtifactsMissingDownloadTransferCursor,
  listArtifactsMissingDownloadTransfer,
  reenqueueDownloadTransfer,
  upsertPendingTransfer,
} from '../db/artifact_transfer.js';
import type { SyncOperationResult } from './ws_protocol.js';
import type { SyncFlushFrame } from './ws_client.js';

export interface ArtifactSchedulingOptions {
  db: Database;
  serverUrl: string;
  nodeId: string;
  syncServerNodeId?: string;
}

export function syncServerTransferNodeId(options: ArtifactSchedulingOptions): string {
  return options.syncServerNodeId ?? `sync-server:${options.serverUrl}`;
}

export function enqueueArtifactUploadsForFrame(
  options: ArtifactSchedulingOptions,
  frame: SyncFlushFrame,
  results: SyncOperationResult[]
): void {
  const transferNodeId = syncServerTransferNodeId(options);
  if (transferNodeId === options.nodeId) {
    return;
  }
  const appliedOperationIds = new Set(
    results.filter((result) => result.status === 'applied').map((result) => result.operationId)
  );
  const operations = frame.type === 'batch' ? frame.batch.operations : frame.operations;
  for (const operation of operations) {
    if (
      operation.op.type === 'plan_artifact.attach' &&
      appliedOperationIds.has(operation.operationUuid)
    ) {
      upsertPendingTransfer(options.db, operation.op.artifactUuid, transferNodeId, 'upload');
    }
  }
}

export async function enqueueMissingArtifactDownloads(
  options: ArtifactSchedulingOptions
): Promise<void> {
  const transferNodeId = syncServerTransferNodeId(options);
  if (transferNodeId === options.nodeId) {
    return;
  }
  const pageLimit = 200;
  const enqueueLimit = 500;
  let enqueued = 0;
  let cursor: ListArtifactsMissingDownloadTransferCursor | undefined;

  while (enqueued < enqueueLimit) {
    const candidates = listArtifactsMissingDownloadTransfer(options.db, transferNodeId, {
      limit: pageLimit,
      cursor,
    });
    if (candidates.length === 0) {
      break;
    }
    const exists = await Promise.all(
      candidates.map((candidate) => artifactFileExists(candidate.storage_path))
    );
    for (let index = 0; index < candidates.length; index += 1) {
      if (exists[index]) {
        continue;
      }
      const candidate = candidates[index];
      if (candidate.transfer_uuid) {
        reenqueueDownloadTransfer(options.db, candidate.uuid, transferNodeId);
      } else {
        upsertPendingTransfer(options.db, candidate.uuid, transferNodeId, 'download');
      }
      enqueued += 1;
      if (enqueued >= enqueueLimit) {
        break;
      }
    }
    const last = candidates[candidates.length - 1];
    cursor = { createdAt: last.created_at, uuid: last.uuid };
    if (candidates.length < pageLimit) {
      break;
    }
  }
}
