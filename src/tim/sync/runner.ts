import type { Database } from 'bun:sqlite';
import { warn } from '../../logging.js';
import { getArtifactByUuid } from '../db/artifact.js';
import {
  type ListPendingTransfersCursor,
  listPendingTransfers,
  resetStrandedArtifactTransfers,
  type ArtifactTransferDirection,
  type ArtifactTransferRow,
} from '../db/artifact_transfer.js';
import { getTimNodeCursor, updateTimNodeCursor } from '../db/sync_tables.js';
import { downloadArtifact, uploadArtifact } from './artifact_transfer.js';
import {
  httpCatchUp,
  httpFetchSnapshots,
  httpFlushBatch,
  httpFlushOperations,
  type HttpSyncResult,
} from './client.js';
import {
  listPendingOperations,
  markOperationFailedRetryable,
  markOperationSending,
  resetSendingOperations,
  type SyncOperationQueueRow,
} from './queue.js';
import { pruneSyncSequence } from './retention.js';
import {
  applyInvalidationsWithSnapshots,
  applyOperationResultsWithSnapshots,
} from './result_application.js';
import {
  enqueueArtifactUploadsForFrame,
  enqueueMissingArtifactDownloads,
  syncServerTransferNodeId,
} from './artifact_scheduling.js';
import { createSyncClient, rowsToFlushFrames, type SyncClient } from './ws_client.js';
import type { SyncOperationResult } from './ws_protocol.js';

export { enqueueMissingArtifactDownloads } from './artifact_scheduling.js';

export interface SyncRunnerOptions {
  db: Database;
  serverUrl: string;
  nodeId: string;
  token: string;
  syncServerNodeId?: string;
  artifactTransferConcurrency?: number;
  artifactMaxAttempts?: number;
  artifactBackoffBaseMs?: number;
  reconnect?: boolean;
  minReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
}

export interface FlushPendingOperationsOnceOptions {
  recoverStranded?: boolean;
}

export interface SyncRunnerStatus {
  running: boolean;
  inProgress: boolean;
  connected: boolean;
  lastKnownSequenceId: number;
  pendingOperationCount: number;
}

export interface SyncRunner {
  runOnce(): Promise<void>;
  start(): void;
  stop(): void;
  getStatus(): SyncRunnerStatus;
}

export interface SyncSequenceRetentionRunnerOptions {
  db: Database;
  retentionMaxAgeMs?: number;
  intervalMs?: number;
}

export interface SyncSequenceRetentionRunner {
  stop(): void;
  runOnce(): number;
}

export function createSyncRunner(options: SyncRunnerOptions): SyncRunner {
  return new DefaultSyncRunner(options);
}

export function startSyncSequenceRetentionRunner(
  options: SyncSequenceRetentionRunnerOptions
): SyncSequenceRetentionRunner {
  let stopped = false;
  let running = false;

  function runOnce(): number {
    if (running) {
      return 0;
    }
    running = true;
    try {
      return pruneSyncSequence(options.db, { retentionMaxAgeMs: options.retentionMaxAgeMs });
    } finally {
      running = false;
    }
  }

  try {
    runOnce();
  } catch (error) {
    warn(
      `Initial sync sequence retention pruning failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const interval = setInterval(
    () => {
      try {
        runOnce();
      } catch (error) {
        warn(
          `Sync sequence retention pruning failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    },
    options.intervalMs ?? 60 * 60 * 1000
  );

  return {
    runOnce,
    stop(): void {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(interval);
    },
  };
}

class DefaultSyncRunner implements SyncRunner {
  private readonly client: SyncClient;
  private running = false;
  private inProgress: Promise<void> | null = null;
  private artifactTransferTimer: ReturnType<typeof setInterval> | null = null;
  private artifactTransferDrainInProgress = false;

  constructor(private readonly options: SyncRunnerOptions) {
    this.client = createSyncClient(options);
  }

  runOnce(): Promise<void> {
    if (this.inProgress) {
      return this.inProgress;
    }
    this.inProgress = this.runOnceInternal().finally(() => {
      this.inProgress = null;
    });
    return this.inProgress;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    resetStrandedArtifactTransfers(this.options.db);
    this.client.start();
    this.startArtifactTransferLoop();
  }

  stop(): void {
    this.running = false;
    this.stopArtifactTransferLoop();
    this.client.stop();
  }

  getStatus(): SyncRunnerStatus {
    const clientStatus = this.client.getStatus();
    return {
      running: this.running,
      inProgress: Boolean(this.inProgress),
      connected: clientStatus.connected,
      lastKnownSequenceId: clientStatus.lastKnownSequenceId,
      pendingOperationCount: clientStatus.pendingOperationCount,
    };
  }

  private async runOnceInternal(): Promise<void> {
    await runSyncCatchUpOnce(this.options);
    await flushPendingOperationsOnce(this.options);
    await drainArtifactTransfersOnce(this.options);
  }

  private startArtifactTransferLoop(): void {
    if (this.artifactTransferTimer) {
      return;
    }
    this.artifactTransferTimer = setInterval(() => {
      if (this.artifactTransferDrainInProgress) {
        return;
      }
      this.artifactTransferDrainInProgress = true;
      drainArtifactTransfersOnce(this.options)
        .catch((err) => {
          warn(
            `Artifact transfer drain failed: ${err instanceof Error ? err.message : String(err)}`
          );
        })
        .finally(() => {
          this.artifactTransferDrainInProgress = false;
        });
    }, 5_000);
    this.artifactTransferTimer.unref?.();
  }

  private stopArtifactTransferLoop(): void {
    if (!this.artifactTransferTimer) {
      return;
    }
    clearInterval(this.artifactTransferTimer);
    this.artifactTransferTimer = null;
  }
}

export async function runSyncCatchUpOnce(options: SyncRunnerOptions): Promise<void> {
  const cursor = getTimNodeCursor(options.db, options.nodeId);
  const catchUp = await httpCatchUp(
    options.serverUrl,
    options.token,
    options.nodeId,
    cursor.last_known_sequence_id
  );
  unwrapRetryable(catchUp);
  await applyInvalidationsOverHttp(options, catchUp.value.invalidations);
  await enqueueMissingArtifactDownloads(options);
  updateTimNodeCursor(options.db, options.nodeId, catchUp.value.currentSequenceId);
}

export async function flushPendingOperationsOnce(
  options: SyncRunnerOptions,
  flushOptions: FlushPendingOperationsOnceOptions = {}
): Promise<void> {
  if (flushOptions.recoverStranded) {
    resetSendingOperations(options.db, { originNodeId: options.nodeId });
  }
  const pendingRows = listPendingOperations(options.db, {
    originNodeId: options.nodeId,
  });
  if (pendingRows.length === 0) {
    return;
  }

  const sendingRows: SyncOperationQueueRow[] = [];
  const processedOperationUuids = new Set<string>();
  try {
    for (const row of pendingRows) {
      sendingRows.push(markOperationSending(options.db, row.operation_uuid));
    }
    for (const frame of rowsToFlushFrames(options.db, sendingRows)) {
      const flush =
        frame.type === 'batch'
          ? await httpFlushBatch(options.serverUrl, options.token, options.nodeId, frame.batch)
          : await httpFlushOperations(
              options.serverUrl,
              options.token,
              options.nodeId,
              frame.operations
            );
      unwrapRetryable(flush);
      const resultOperationUuids = flush.value.results.map((result) => result.operationId);
      await applyOperationResultsOverHttp(options, flush.value.results);
      enqueueArtifactUploadsForFrame(options, frame, flush.value.results);
      for (const operationUuid of resultOperationUuids) {
        processedOperationUuids.add(operationUuid);
      }
    }
  } catch (err) {
    for (const row of sendingRows) {
      if (processedOperationUuids.has(row.operation_uuid)) {
        continue;
      }
      markOperationFailedRetryable(options.db, row.operation_uuid, err);
    }
    throw err;
  }
}

export async function drainArtifactTransfersOnce(options: SyncRunnerOptions): Promise<void> {
  const transferNodeId = syncServerTransferNodeId(options);
  if (transferNodeId === options.nodeId) {
    return;
  }

  const concurrency = Math.max(1, options.artifactTransferConcurrency ?? 2);
  const limit = concurrency * 2;
  await drainDirection(options, 'upload', limit, concurrency);
  await drainDirection(options, 'download', limit, concurrency);
}

async function drainDirection(
  options: SyncRunnerOptions,
  direction: ArtifactTransferDirection,
  limit: number,
  concurrency: number
): Promise<void> {
  const rows: ArtifactTransferRow[] = [];
  const maxAttempts = options.artifactMaxAttempts ?? 5;
  let cursor: ListPendingTransfersCursor | undefined;

  while (rows.length < concurrency) {
    const page = listPendingTransfers(options.db, {
      direction,
      limit,
      includeFailed: true,
      maxAttempts,
      cursor,
    });
    if (page.length === 0) {
      break;
    }
    for (const row of page) {
      if (shouldAttemptTransfer(row, options)) {
        rows.push(row);
        if (rows.length >= concurrency) {
          break;
        }
      }
    }
    const last = page[page.length - 1];
    cursor = {
      status: last.status,
      lastAttemptAt: last.last_attempt_at,
      artifactUuid: last.artifact_uuid,
    };
    if (page.length < limit) {
      break;
    }
  }

  for (let index = 0; index < rows.length; index += concurrency) {
    const batch = rows.slice(index, index + concurrency);
    await Promise.all(batch.map((row) => drainTransferRow(options, row)));
  }
}

async function drainTransferRow(
  options: SyncRunnerOptions,
  row: ArtifactTransferRow
): Promise<void> {
  const transferNodeId = syncServerTransferNodeId(options);
  const artifact = getArtifactByUuid(options.db, row.artifact_uuid);
  if (!artifact) {
    return;
  }
  try {
    if (row.direction === 'upload') {
      await uploadArtifact({
        db: options.db,
        serverUrl: options.serverUrl,
        token: options.token,
        nodeId: options.nodeId,
        syncServerNodeId: transferNodeId,
        artifact,
      });
    } else {
      await downloadArtifact({
        db: options.db,
        serverUrl: options.serverUrl,
        token: options.token,
        nodeId: options.nodeId,
        syncServerNodeId: transferNodeId,
        artifact,
      });
    }
  } catch (err) {
    warn(
      `Artifact ${row.direction} failed for ${row.artifact_uuid}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

function shouldAttemptTransfer(row: ArtifactTransferRow, options: SyncRunnerOptions): boolean {
  const maxAttempts = options.artifactMaxAttempts ?? 5;
  if (row.attempts >= maxAttempts) {
    return false;
  }
  if (row.status !== 'failed' || !row.last_attempt_at) {
    return true;
  }
  const lastAttemptMs = Date.parse(row.last_attempt_at);
  if (!Number.isFinite(lastAttemptMs)) {
    return true;
  }
  return Date.now() - lastAttemptMs >= artifactBackoffMs(row.attempts, options);
}

function artifactBackoffMs(attempts: number, options: SyncRunnerOptions): number {
  const base = options.artifactBackoffBaseMs ?? 1_000;
  return Math.min(60_000, base * 2 ** Math.max(0, attempts - 1));
}

async function applyOperationResultsOverHttp(
  options: SyncRunnerOptions,
  results: SyncOperationResult[]
): Promise<void> {
  await applyOperationResultsWithSnapshots({
    db: options.db,
    results,
    fetchSnapshots: (keys) => fetchSnapshotsOverHttp(options, keys),
  });
}

async function applyInvalidationsOverHttp(
  options: SyncRunnerOptions,
  invalidations: Array<{ sequenceId: number; entityKeys: string[] }>
): Promise<void> {
  const maxSequenceId = await applyInvalidationsWithSnapshots({
    db: options.db,
    invalidations,
    fetchSnapshots: (keys) => fetchSnapshotsOverHttp(options, keys),
  });
  if (maxSequenceId > 0) {
    updateTimNodeCursor(options.db, options.nodeId, maxSequenceId);
  }
}

async function fetchSnapshotsOverHttp(options: SyncRunnerOptions, keys: string[]) {
  const uniqueKeys = [...new Set(keys)];
  if (uniqueKeys.length === 0) {
    return [];
  }
  const response = await httpFetchSnapshots(
    options.serverUrl,
    options.token,
    options.nodeId,
    uniqueKeys
  );
  unwrapRetryable(response);
  return response.value.snapshots;
}

function unwrapRetryable<T>(result: HttpSyncResult<T>): asserts result is { ok: true; value: T } {
  if (!result.ok) {
    throw result.error;
  }
}
