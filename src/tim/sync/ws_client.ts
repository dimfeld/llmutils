import { EventEmitter } from 'node:events';
import type { Database } from 'bun:sqlite';
import { getTimNodeCursor, updateTimNodeCursor, type TimNodeCursorRow } from '../db/sync_tables.js';
import {
  listPendingOperations,
  markOperationFailedRetryable,
  markOperationSending,
  resetSendingOperations,
  subscribeToQueueChanges,
  type SyncOperationQueueRow,
} from './queue.js';
import { mergeCanonicalRefresh, type CanonicalSnapshot } from './snapshots.js';
import {
  applyInvalidationsWithSnapshots,
  applyOperationResultsWithSnapshots,
} from './result_application.js';
import {
  createBatchEnvelope,
  type SyncOperationBatchEnvelope,
  type SyncOperationEnvelope,
} from './types.js';
import {
  SyncServerFrameSchema,
  type SyncCatchUpInvalidation,
  type SyncClientFrame,
  type SyncBatchResultFrame,
  type SyncOperationResult,
  type SyncOpResultFrame,
  type SyncServerFrame,
} from './ws_protocol.js';

export interface SyncClientOptions {
  db: Database;
  serverUrl: string;
  nodeId: string;
  token: string;
  reconnect?: boolean;
  minReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  snapshotRequestTimeoutMs?: number;
}

export interface SyncClientStatus {
  connected: boolean;
  connecting: boolean;
  lastKnownSequenceId: number;
  pendingOperationCount: number;
}

export type SyncClientEvent = 'connected' | 'disconnected' | 'invalidated' | 'error';

export interface SyncClient {
  start(): void;
  stop(): void;
  flushNow(): Promise<void>;
  requestSnapshots(keys: string[]): Promise<CanonicalSnapshot[]>;
  getStatus(): SyncClientStatus;
  on(event: SyncClientEvent, listener: (...args: unknown[]) => void): SyncClient;
  off(event: SyncClientEvent, listener: (...args: unknown[]) => void): SyncClient;
}

export type SyncFlushFrame =
  | { type: 'op_batch'; operations: SyncOperationEnvelope[] }
  | { type: 'batch'; batch: SyncOperationBatchEnvelope };

export function createSyncClient(options: SyncClientOptions): SyncClient {
  return new WebSocketSyncClient(options);
}

class SyncClientProtocolError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'SyncClientProtocolError';
    this.cause = cause;
  }
}

class WebSocketSyncClient implements SyncClient {
  private readonly events = new EventEmitter();
  private ws: WebSocket | null = null;
  private stopped = true;
  private connecting = false;
  private helloAccepted = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private flushSafetyTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeQueueChanges: (() => void) | null = null;
  private flushPromise: Promise<void> | null = null;
  private flushDirty = false;
  private flushProcessedOperationUuids: Set<string> | null = null;
  private readonly snapshotWaiters = new Map<
    string,
    {
      resolve: (snapshots: CanonicalSnapshot[]) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private catchUpWaiter: {
    resolve: () => void;
    reject: (error: Error) => void;
  } | null = null;
  private flushWaiter: {
    matches: (frame: SyncOpResultFrame | SyncBatchResultFrame) => boolean;
    resolve: () => void;
    reject: (error: Error) => void;
  } | null = null;

  constructor(private readonly options: SyncClientOptions) {}

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.unsubscribeQueueChanges = subscribeToQueueChanges(() => {
      if (!this.isConnected()) {
        return;
      }
      if (this.flushPromise) {
        // Queue changed during an in-flight flush whose batch was already
        // snapshotted. Mark dirty so the in-flight flush schedules a follow-up.
        this.flushDirty = true;
        return;
      }
      this.flushPending().catch((err) => this.emitError(err));
    });
    resetSendingOperations(this.options.db, { originNodeId: this.options.nodeId });
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectWaiters(new Error('Sync client stopped'));
    this.ws?.close();
    this.ws = null;
    this.connecting = false;
    this.helloAccepted = false;
    this.stopFlushLoop();
    this.unsubscribeQueueChanges?.();
    this.unsubscribeQueueChanges = null;
  }

  async flushNow(): Promise<void> {
    await this.waitUntilConnected();
    await this.flushPending();
  }

  async requestSnapshots(keys: string[]): Promise<CanonicalSnapshot[]> {
    if (keys.length === 0) {
      return [];
    }
    await this.waitUntilConnected();
    const requestId = crypto.randomUUID();
    return new Promise<CanonicalSnapshot[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiter = this.snapshotWaiters.get(requestId);
        if (!waiter) {
          return;
        }
        this.snapshotWaiters.delete(requestId);
        clearTimeout(waiter.timer);
        waiter.reject(new Error('Sync snapshot request timed out'));
      }, this.options.snapshotRequestTimeoutMs ?? 30_000);
      this.snapshotWaiters.set(requestId, { resolve, reject, timer });
      this.send({ type: 'snapshot_request', requestId, entityKeys: [...new Set(keys)] });
    });
  }

  getStatus(): SyncClientStatus {
    return {
      connected: this.isConnected(),
      connecting: this.connecting,
      lastKnownSequenceId: getTimNodeCursor(this.options.db, this.options.nodeId)
        .last_known_sequence_id,
      pendingOperationCount: listPendingOperations(this.options.db, {
        originNodeId: this.options.nodeId,
      }).length,
    };
  }

  on(event: SyncClientEvent, listener: (...args: unknown[]) => void): SyncClient {
    this.events.on(event, listener);
    return this;
  }

  off(event: SyncClientEvent, listener: (...args: unknown[]) => void): SyncClient {
    this.events.off(event, listener);
    return this;
  }

  private connect(): void {
    if (this.stopped || this.connecting || this.isConnected()) {
      return;
    }
    this.connecting = true;
    this.helloAccepted = false;

    const ws = new WebSocket(wsUrl(this.options.serverUrl, 'sync/ws'));
    this.ws = ws;

    ws.addEventListener('open', () => {
      const cursor = getTimNodeCursor(this.options.db, this.options.nodeId);
      this.send({
        type: 'hello',
        nodeId: this.options.nodeId,
        token: this.options.token,
        lastKnownSequenceId: cursor.last_known_sequence_id,
      });
    });
    ws.addEventListener('message', (event) => this.handleMessage(event.data));
    ws.addEventListener('close', () => this.handleDisconnect());
    ws.addEventListener('error', () => {
      this.emitError(new Error('Sync WebSocket error'));
    });
  }

  private async handleMessage(data: unknown): Promise<void> {
    let frame: SyncServerFrame;
    try {
      frame = SyncServerFrameSchema.parse(JSON.parse(rawToString(data)));
    } catch (err) {
      this.failConnection(
        new SyncClientProtocolError(
          err instanceof Error ? err.message : 'Invalid sync server frame',
          err
        )
      );
      return;
    }

    try {
      switch (frame.type) {
        case 'hello_ack':
          this.connecting = false;
          this.helloAccepted = true;
          this.reconnectAttempts = 0;
          this.events.emit('connected', frame);
          this.startFlushLoop();
          resetSendingOperations(this.options.db, { originNodeId: this.options.nodeId });
          await this.catchUpFrom(getTimNodeCursor(this.options.db, this.options.nodeId));
          await this.flushPending();
          return;
        case 'catch_up_response':
          await this.applyInvalidations(frame.invalidations);
          updateTimNodeCursor(this.options.db, this.options.nodeId, frame.currentSequenceId);
          this.catchUpWaiter?.resolve();
          this.catchUpWaiter = null;
          return;
        case 'op_result':
          await this.handleOperationResults(frame);
          return;
        case 'batch_result':
          await this.handleOperationResults(frame);
          return;
        case 'invalidate':
          await this.applyInvalidations([
            { sequenceId: frame.sequenceId, entityKeys: frame.entityKeys },
          ]);
          updateTimNodeCursor(this.options.db, this.options.nodeId, frame.sequenceId);
          this.events.emit('invalidated', frame);
          return;
        case 'snapshot_response':
          this.resolveSnapshotWaiter(frame.requestId, frame.snapshots);
          return;
        case 'ping':
          this.send({ type: 'pong' });
          return;
        case 'pong':
          return;
        case 'error': {
          const error = new Error(frame.message);
          this.emitError(error);
          this.rejectSnapshotWaiters(error);
          this.catchUpWaiter?.reject(error);
          this.catchUpWaiter = null;
          this.flushWaiter?.reject(error);
          this.flushWaiter = null;
          return;
        }
      }
    } catch (err) {
      this.failConnection(
        err instanceof Error
          ? err
          : new SyncClientProtocolError('Sync server frame processing failed', err)
      );
    }
  }

  private async catchUpFrom(cursor: TimNodeCursorRow): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.catchUpWaiter = { resolve, reject };
      this.send({
        type: 'catch_up_request',
        sinceSequenceId: cursor.last_known_sequence_id,
      });
    });
  }

  private async flushPending(): Promise<void> {
    if (this.flushPromise) {
      return this.flushPromise;
    }
    this.flushDirty = false;
    let flushFailed = false;
    this.flushPromise = this.flushPendingInternal()
      .catch((err) => {
        flushFailed = true;
        throw err;
      })
      .finally(() => {
        this.flushPromise = null;
        // Don't auto-retry when the flush rejected. The catch path inside
        // flushPendingInternal transitions in-flight ops to failed_retryable,
        // which fires queue notifications and sets flushDirty=true; retrying
        // immediately would re-flush the same just-failed ops in a tight loop.
        // The 30s safety poll, reconnect handshake's flushPending(), and the
        // next genuine enqueue all cover eventual retry.
        if (flushFailed) {
          this.flushDirty = false;
          return;
        }
        if (this.flushDirty && !this.stopped && this.isConnected()) {
          this.flushDirty = false;
          this.flushPending().catch((err) => this.emitError(err));
        }
      });
    return this.flushPromise;
  }

  private async flushPendingInternal(): Promise<void> {
    const pendingRows = listPendingOperations(this.options.db, {
      originNodeId: this.options.nodeId,
    });
    if (pendingRows.length === 0) {
      return;
    }
    const sendingRows: SyncOperationQueueRow[] = [];
    const processed = new Set<string>();
    this.flushProcessedOperationUuids = processed;
    try {
      for (const row of pendingRows) {
        sendingRows.push(markOperationSending(this.options.db, row.operation_uuid));
      }
      for (const frame of rowsToFlushFrames(this.options.db, sendingRows)) {
        await new Promise<void>((resolve, reject) => {
          this.setFlushWaiter(this.createFlushWaiter(frame, resolve, reject));
          this.send(frame);
        });
      }
    } catch (err) {
      this.flushWaiter = null;
      // Skip rows whose results already arrived in an earlier frame and were
      // transitioned out of `sending` by handleOperationResults. Marking them
      // failed_retryable here would either trip the illegal-transition assertion
      // (failed_retryable -> failed_retryable) or silently no-op via
      // tolerateTerminal, masking the real failure.
      for (const row of sendingRows) {
        if (processed.has(row.operation_uuid)) {
          continue;
        }
        markOperationFailedRetryable(this.options.db, row.operation_uuid, err);
      }
      throw err;
    } finally {
      this.flushProcessedOperationUuids = null;
    }
  }

  private startFlushLoop(): void {
    if (this.flushSafetyTimer) {
      return;
    }
    this.flushSafetyTimer = setInterval(() => {
      if (!this.isConnected()) {
        return;
      }
      this.flushPending().catch((err) => this.emitError(err));
    }, 30_000);
  }

  private stopFlushLoop(): void {
    if (!this.flushSafetyTimer) {
      return;
    }
    clearInterval(this.flushSafetyTimer);
    this.flushSafetyTimer = null;
  }

  private async handleOperationResults(
    frame: SyncOpResultFrame | SyncBatchResultFrame
  ): Promise<void> {
    const results = frame.results;
    const transitions = [...results];
    await applyOperationResultsWithSnapshots({
      db: this.options.db,
      results: transitions,
      fetchSnapshots: (keys) => this.requestSnapshots(keys),
    });
    if (this.flushProcessedOperationUuids) {
      for (const result of transitions) {
        this.flushProcessedOperationUuids.add(result.operationId);
      }
    }
    if (this.flushWaiter?.matches(frame)) {
      this.flushWaiter.resolve();
      this.flushWaiter = null;
    }
  }

  private createFlushWaiter(
    frame: SyncFlushFrame,
    resolve: () => void,
    reject: (error: Error) => void
  ): NonNullable<WebSocketSyncClient['flushWaiter']> {
    if (frame.type === 'batch') {
      return {
        matches: (resultFrame) =>
          resultFrame.type === 'batch_result' && resultFrame.batchId === frame.batch.batchId,
        resolve,
        reject,
      };
    }

    const operationIds = new Set(frame.operations.map((operation) => operation.operationUuid));
    return {
      matches: (resultFrame) => {
        if (resultFrame.type !== 'op_result' || resultFrame.results.length !== operationIds.size) {
          return false;
        }
        return resultFrame.results.every((result) => operationIds.has(result.operationId));
      },
      resolve,
      reject,
    };
  }

  private setFlushWaiter(waiter: NonNullable<WebSocketSyncClient['flushWaiter']>): void {
    this.flushWaiter?.reject(new Error('Sync flush waiter replaced before matching result'));
    this.flushWaiter = waiter;
  }

  private async applyInvalidations(invalidations: SyncCatchUpInvalidation[]): Promise<void> {
    const sequenceId = await applyInvalidationsWithSnapshots({
      db: this.options.db,
      invalidations,
      fetchSnapshots: (keys) => this.requestSnapshots(keys),
    });
    if (sequenceId > 0) {
      updateTimNodeCursor(this.options.db, this.options.nodeId, sequenceId);
    }
  }

  private async fetchAndMergeSnapshots(keys: string[]): Promise<CanonicalSnapshot[]> {
    const snapshots = await this.requestSnapshots([...new Set(keys)]);
    for (const snapshot of snapshots) {
      mergeCanonicalRefresh(this.options.db, snapshot);
    }
    return snapshots;
  }

  private handleDisconnect(): void {
    const wasConnected = this.helloAccepted;
    this.ws = null;
    this.connecting = false;
    this.helloAccepted = false;
    this.stopFlushLoop();
    this.rejectWaiters(new Error('Sync WebSocket disconnected'));
    if (wasConnected) {
      this.events.emit('disconnected');
    }
    if (!this.stopped && this.options.reconnect !== false) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    const minDelay = this.options.minReconnectDelayMs ?? 1_000;
    const maxDelay = this.options.maxReconnectDelayMs ?? 60_000;
    const exponential = Math.min(maxDelay, minDelay * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    const jitter = Math.floor(Math.random() * Math.min(1_000, exponential * 0.25));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, exponential + jitter);
  }

  private async waitUntilConnected(timeoutMs = 5_000): Promise<void> {
    if (this.isConnected()) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Timed out waiting for sync client connection'));
      }, timeoutMs);
      const onConnected = () => {
        cleanup();
        resolve();
      };
      const onError = (err: unknown) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.events.off('connected', onConnected);
        this.events.off('error', onError);
      };
      this.events.on('connected', onConnected);
      this.events.on('error', onError);
    });
  }

  private isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.helloAccepted;
  }

  private send(frame: SyncClientFrame): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Sync WebSocket is not connected');
    }
    this.ws.send(JSON.stringify(frame));
  }

  private rejectWaiters(error: Error): void {
    this.rejectSnapshotWaiters(error);
    this.catchUpWaiter?.reject(error);
    this.catchUpWaiter = null;
    this.flushWaiter?.reject(error);
    this.flushWaiter = null;
  }

  private failConnection(error: Error): void {
    this.emitError(error);
    this.rejectWaiters(error);
    this.ws?.close();
  }

  private emitError(error: unknown): void {
    if (this.events.listenerCount('error') === 0) {
      return;
    }
    this.events.emit('error', error);
  }

  private rejectSnapshotWaiters(error: Error): void {
    for (const waiter of this.snapshotWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.snapshotWaiters.clear();
  }

  private resolveSnapshotWaiter(requestId: string, snapshots: CanonicalSnapshot[]): void {
    const waiter = this.snapshotWaiters.get(requestId);
    if (!waiter) {
      return;
    }
    this.snapshotWaiters.delete(requestId);
    clearTimeout(waiter.timer);
    waiter.resolve(snapshots);
  }
}

function rowToEnvelope(row: SyncOperationQueueRow): SyncOperationEnvelope {
  return {
    operationUuid: row.operation_uuid,
    projectUuid: row.project_uuid,
    originNodeId: row.origin_node_id,
    localSequence: row.local_sequence,
    createdAt: row.created_at,
    targetType: row.target_type as SyncOperationEnvelope['targetType'],
    targetKey: row.target_key,
    op: JSON.parse(row.payload) as SyncOperationEnvelope['op'],
  };
}

export function rowsToFlushFrames(db: Database, rows: SyncOperationQueueRow[]): SyncFlushFrame[] {
  const frames: SyncFlushFrame[] = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index];
    if (!row.batch_id) {
      const opRows = [row];
      index += 1;
      while (index < rows.length && !rows[index].batch_id) {
        opRows.push(rows[index]);
        index += 1;
      }
      frames.push({ type: 'op_batch', operations: opRows.map(rowToEnvelope) });
      continue;
    }
    const batchRows = [row];
    index += 1;
    while (index < rows.length && rows[index].batch_id === row.batch_id) {
      batchRows.push(rows[index]);
      index += 1;
    }
    assertCompleteBatchRows(db, row.batch_id, batchRows);
    frames.push({
      type: 'batch',
      batch: rowsToBatchEnvelope(row.batch_id, batchRows),
    });
  }
  return frames;
}

function assertCompleteBatchRows(
  db: Database,
  batchId: string,
  rows: SyncOperationQueueRow[]
): void {
  const row = db
    .prepare('SELECT COUNT(*) AS count FROM sync_operation WHERE batch_id = ?')
    .get(batchId) as { count: number };
  if (row.count !== rows.length) {
    throw new Error(
      `Refusing to flush partial sync batch ${batchId}: have ${rows.length} of ${row.count} rows`
    );
  }
}

function rowsToBatchEnvelope(
  batchId: string,
  rows: SyncOperationQueueRow[]
): SyncOperationBatchEnvelope {
  return createBatchEnvelope({
    batchId,
    originNodeId: rows[0].origin_node_id,
    createdAt: rows[0].created_at,
    operations: rows.map(rowToEnvelope),
    atomic: rows.some((row) => row.batch_atomic === 1),
  });
}

function wsUrl(serverUrl: string, path: string): string {
  const url = new URL(serverUrl.endsWith('/') ? serverUrl : `${serverUrl}/`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${path}`;
  return url.toString();
}

function rawToString(data: unknown): string {
  if (typeof data === 'string') {
    return data;
  }
  if (data instanceof Buffer) {
    return data.toString('utf8');
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8');
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  }
  return String(data);
}
