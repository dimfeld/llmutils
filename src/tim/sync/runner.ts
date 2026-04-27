import type { Database } from 'bun:sqlite';
import { warn } from '../../logging.js';
import { getTimNodeCursor, updateTimNodeCursor } from '../db/sync_tables.js';
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
  mergeCanonicalRefresh,
  resetSendingOperations,
  type SyncOperationQueueRow,
} from './queue.js';
import { pruneSyncSequence } from './retention.js';
import { rejectedOperationSnapshotKeys } from './rejected_refresh.js';
import { applyOperationResultTransitions } from './result_transitions.js';
import { createSyncClient, rowsToFlushFrames, type SyncClient } from './ws_client.js';
import type { SyncOperationResult } from './ws_protocol.js';

export interface SyncRunnerOptions {
  db: Database;
  serverUrl: string;
  nodeId: string;
  token: string;
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
    this.client.start();
  }

  stop(): void {
    this.running = false;
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
      await applyOperationResultsOverHttp(options, flush.value.results);
      updateTimNodeCursor(options.db, options.nodeId, flush.value.currentSequenceId);
    }
  } catch (err) {
    for (const row of sendingRows) {
      markOperationFailedRetryable(options.db, row.operation_uuid, err);
    }
    throw err;
  }
}

async function applyOperationResultsOverHttp(
  options: SyncRunnerOptions,
  results: SyncOperationResult[]
): Promise<void> {
  const keys = new Set<string>();
  let maxSequenceId = 0;
  for (const result of results) {
    for (const key of result.invalidations ?? []) {
      keys.add(key);
    }
    for (const sequenceId of result.sequenceIds ?? []) {
      maxSequenceId = Math.max(maxSequenceId, sequenceId);
    }
  }
  for (const key of rejectedOperationSnapshotKeys(options.db, results)) {
    keys.add(key);
  }
  await fetchAndMergeSnapshots(options, [...keys]);
  applyOperationResultTransitions(options.db, results);
  if (maxSequenceId > 0) {
    updateTimNodeCursor(options.db, options.nodeId, maxSequenceId);
  }
}

async function applyInvalidationsOverHttp(
  options: SyncRunnerOptions,
  invalidations: Array<{ sequenceId: number; entityKeys: string[] }>
): Promise<void> {
  await fetchAndMergeSnapshots(options, [
    ...new Set(invalidations.flatMap((invalidation) => invalidation.entityKeys)),
  ]);
  const maxSequenceId = Math.max(
    0,
    ...invalidations.map((invalidation) => invalidation.sequenceId)
  );
  if (maxSequenceId > 0) {
    updateTimNodeCursor(options.db, options.nodeId, maxSequenceId);
  }
}

async function fetchAndMergeSnapshots(options: SyncRunnerOptions, keys: string[]): Promise<void> {
  if (keys.length === 0) {
    return;
  }
  const response = await httpFetchSnapshots(options.serverUrl, options.token, options.nodeId, keys);
  unwrapRetryable(response);
  for (const snapshot of response.value.snapshots) {
    mergeCanonicalRefresh(options.db, snapshot);
  }
  updateTimNodeCursor(options.db, options.nodeId, response.value.currentSequenceId);
}

function unwrapRetryable<T>(result: HttpSyncResult<T>): asserts result is { ok: true; value: T } {
  if (!result.ok) {
    throw result.error;
  }
}
