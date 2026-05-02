import type { Database } from 'bun:sqlite';
import type { SyncAllowedNodeConfig } from '../configSchema.js';
import { insertTimNodeIfMissing, updateTimNodeCursor } from '../db/sync_tables.js';
import {
  getPlanByUuid,
  getPlanDependenciesByUuid,
  getPlanTagsByUuid,
  getPlanTasksByUuid,
} from '../db/plan.js';
import { getProjectByUuid } from '../db/project.js';
import { getProjectSettingWithMetadata } from '../db/project_settings.js';
import { isSecureTransport } from '../../webhooks/security.js';
import { verifyNodeToken } from './auth.js';
import { applyBatch, applyOperation, type ApplyOperationResult } from './apply.js';
import { SyncFifoGapError, SyncValidationError } from './errors.js';
import type { CanonicalSnapshot } from './snapshots.js';
import type { SyncOperationEnvelope } from './types.js';
import { bootstrapSyncMetadata } from './bootstrap.js';
import {
  parseClientFrame,
  SyncBatchFrameSchema,
  SyncOpBatchFrameSchema,
  type SyncCatchUpInvalidation,
  type SyncBatchResultFrame,
  type SyncClientFrame,
  type SyncOperationResult,
  type SyncServerFrame,
} from './ws_protocol.js';

const WS_PATH = '/sync/ws';
const HELLO_TIMEOUT_MS = 10_000;
export const SYNC_MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

export interface StartSyncServerOptions {
  db: Database;
  mainNodeId: string;
  allowedNodes: SyncAllowedNodeConfig[];
  port?: number;
  hostname?: string;
  requireSecureTransport?: boolean;
}

export interface SyncServerConnection {
  connectionId: string;
  nodeId: string | null;
  authenticated: boolean;
}

export interface SyncServerHandle {
  port: number;
  hostname: string;
  stop(): void;
  broadcast(frame: SyncServerFrame): void;
  connections: ReadonlyMap<string, SyncServerConnection>;
}

interface SyncWebSocketData {
  connectionId: string;
}

type BunServerWebSocket = import('bun').ServerWebSocket<SyncWebSocketData>;

export function startSyncServer(options: StartSyncServerOptions): SyncServerHandle {
  const port = options.port ?? 0;
  const hostname = options.hostname ?? '127.0.0.1';
  const sockets = new Map<string, BunServerWebSocket>();
  const connections = new Map<string, SyncServerConnection>();
  const helloTimers = new Map<string, ReturnType<typeof setTimeout>>();
  seedAllowedPersistentNodes(options.db, options.allowedNodes);
  // Main-node only: startSyncServer is only invoked for role === 'main' (see
  // sync_service.ts). Bootstrapping seeds canonical sync_sequence rows for
  // pre-sync data so fresh peers can discover existing plans/settings on
  // initial catch-up. Persistent nodes must NOT self-seed; they receive
  // canonical state from the main node.
  bootstrapSyncMetadata(options.db);

  function send(ws: BunServerWebSocket, frame: SyncServerFrame): void {
    ws.send(JSON.stringify(frame));
  }

  function closeWithError(ws: BunServerWebSocket, code: string, message: string): void {
    send(ws, { type: 'error', code, message });
    ws.close(1008, code);
  }

  function broadcast(frame: SyncServerFrame, excludeConnectionId?: string): void {
    const payload = JSON.stringify(frame);
    for (const [connectionId, ws] of sockets) {
      const connection = connections.get(connectionId);
      if (connectionId === excludeConnectionId || !connection?.authenticated) {
        continue;
      }
      ws.send(payload);
    }
  }

  function authenticate(nodeId: string, token: string | null | undefined): boolean {
    return verifyNodeToken({
      nodeId,
      presentedToken: token,
      allowedNodes: options.allowedNodes,
    }).ok;
  }

  const server = Bun.serve<SyncWebSocketData>({
    port,
    hostname,
    fetch(request, serverRef) {
      const url = new URL(request.url);
      if (url.pathname === '/healthz') {
        return jsonResponse({ ok: true });
      }

      if (url.pathname === WS_PATH) {
        if (request.method !== 'GET') {
          return new Response('Method Not Allowed\n', { status: 405, headers: { Allow: 'GET' } });
        }
        if (options.requireSecureTransport && !isSecureTransport(request)) {
          return new Response('HTTPS required\n', { status: 400 });
        }
        const connectionId = crypto.randomUUID();
        if (serverRef.upgrade(request, { data: { connectionId } })) {
          return;
        }
        return new Response('WebSocket upgrade failed\n', { status: 400 });
      }

      if (url.pathname.startsWith('/internal/sync/')) {
        if (options.requireSecureTransport && !isSecureTransport(request)) {
          return new Response('HTTPS required\n', { status: 400 });
        }
        return handleHttpRequest(options, request, url, authenticate, broadcast);
      }

      return new Response('Not Found\n', { status: 404 });
    },
    websocket: {
      idleTimeout: 0,
      maxPayloadLength: SYNC_MAX_PAYLOAD_BYTES,
      open(ws) {
        const connectionId = ws.data.connectionId;
        sockets.set(connectionId, ws);
        connections.set(connectionId, { connectionId, nodeId: null, authenticated: false });
        helloTimers.set(
          connectionId,
          setTimeout(() => {
            const connection = connections.get(connectionId);
            if (!connection?.authenticated) {
              closeWithError(ws, 'missing_hello', 'hello frame required before sync frames');
            }
          }, HELLO_TIMEOUT_MS)
        );
      },
      message(ws, rawMessage) {
        const connectionId = ws.data.connectionId;
        if (rawByteLength(rawMessage) > SYNC_MAX_PAYLOAD_BYTES) {
          closeWithError(ws, 'payload_too_large', 'Sync frame exceeds maximum payload size');
          return;
        }
        const text = rawToString(rawMessage);
        let frame: SyncClientFrame;
        try {
          frame = parseClientFrame(text);
        } catch (err) {
          closeWithError(ws, 'bad_frame', err instanceof Error ? err.message : 'Invalid frame');
          return;
        }

        const connection = connections.get(connectionId);
        if (!connection) {
          return;
        }
        if (!connection.authenticated) {
          if (frame.type !== 'hello') {
            closeWithError(ws, 'missing_hello', 'hello frame required before sync frames');
            return;
          }
          if (!authenticate(frame.nodeId, frame.token)) {
            closeWithError(ws, 'unauthorized', 'Invalid sync node credentials');
            return;
          }
          clearTimeout(helloTimers.get(connectionId));
          helloTimers.delete(connectionId);
          connections.set(connectionId, {
            connectionId,
            nodeId: frame.nodeId,
            authenticated: true,
          });
          if (frame.lastKnownSequenceId !== undefined) {
            if (!isValidClientCursor(options.db, frame.lastKnownSequenceId)) {
              closeWithError(
                ws,
                'invalid_cursor',
                `lastKnownSequenceId ${frame.lastKnownSequenceId} exceeds current server sequence`
              );
              return;
            }
            updateTimNodeCursor(options.db, frame.nodeId, frame.lastKnownSequenceId);
          }
          send(ws, {
            type: 'hello_ack',
            mainNodeId: options.mainNodeId,
            currentSequenceId: getCurrentSequenceId(options.db),
          });
          return;
        }

        handleAuthenticatedFrame(options, ws, frame, connection.nodeId, connectionId, broadcast);
      },
      close(ws) {
        const connectionId = ws.data.connectionId;
        clearTimeout(helloTimers.get(connectionId));
        helloTimers.delete(connectionId);
        sockets.delete(connectionId);
        connections.delete(connectionId);
      },
    },
  });

  if (server.port == null) {
    throw new Error('Sync server did not report a listening port');
  }

  return {
    port: server.port,
    hostname,
    connections,
    stop: () => {
      for (const timer of helloTimers.values()) {
        clearTimeout(timer);
      }
      helloTimers.clear();
      server.stop(true);
    },
    broadcast: (frame) => broadcast(frame),
  };
}

async function handleHttpRequest(
  options: StartSyncServerOptions,
  request: Request,
  url: URL,
  authenticate: (nodeId: string, token: string | null | undefined) => boolean,
  broadcast: (frame: SyncServerFrame, excludeConnectionId?: string) => void
): Promise<Response> {
  const nodeId = request.headers.get('x-tim-node-id');
  const token = extractBearerToken(request);
  if (!nodeId || !authenticate(nodeId, token)) {
    return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
  }

  if (url.pathname === '/internal/sync/operations') {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed\n', { status: 405, headers: { Allow: 'POST' } });
    }
    const bodyResult = await readJsonBodyWithLimit(request);
    if (!bodyResult.ok) {
      return jsonResponse({ error: bodyResult.error }, { status: bodyResult.status });
    }
    const body = bodyResult.value;
    if (body && typeof body === 'object' && 'batch' in body) {
      const frame = SyncBatchFrameSchema.parse({ type: 'batch', ...(body as object) });
      const originError = validateOperationOrigins(frame.batch.operations, nodeId);
      if (originError || frame.batch.originNodeId !== nodeId) {
        return jsonResponse(
          { error: originError ?? 'Batch originNodeId mismatch' },
          { status: 400 }
        );
      }
      const result = applySyncBatchAndBroadcast(options.db, frame.batch, broadcast);
      const resultFrame = batchResultFrame(frame.batch, result);
      return jsonResponse({
        ...resultFrame,
        currentSequenceId: getCurrentSequenceId(options.db),
      });
    }
    const frame = SyncOpBatchFrameSchema.parse({ type: 'op_batch', ...(body as object) });
    const originError = validateOperationOrigins(frame.operations, nodeId);
    if (originError) {
      return jsonResponse({ error: originError }, { status: 400 });
    }
    const results = applyOperationBatchAndBroadcast(options.db, frame.operations, broadcast);
    return jsonResponse({
      results,
      currentSequenceId: getCurrentSequenceId(options.db),
    });
  }

  if (url.pathname === '/internal/sync/snapshots') {
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed\n', { status: 405, headers: { Allow: 'GET' } });
    }
    const keys = url.searchParams.getAll('keys').flatMap((value) => value.split(','));
    return jsonResponse({
      snapshots: keys
        .map((key) => loadCanonicalSnapshot(options.db, key))
        .filter((snapshot): snapshot is CanonicalSnapshot => snapshot !== null),
      currentSequenceId: getCurrentSequenceId(options.db),
    });
  }

  if (url.pathname === '/internal/sync/catch-up') {
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed\n', { status: 405, headers: { Allow: 'GET' } });
    }
    const sinceSequenceId = Number(url.searchParams.get('sinceSequenceId') ?? '0');
    if (!Number.isInteger(sinceSequenceId) || sinceSequenceId < 0) {
      return jsonResponse({ error: 'Invalid sinceSequenceId' }, { status: 400 });
    }
    if (!isValidClientCursor(options.db, sinceSequenceId)) {
      return jsonResponse(
        { error: `sinceSequenceId ${sinceSequenceId} exceeds current server sequence` },
        { status: 400 }
      );
    }
    updateTimNodeCursor(options.db, nodeId, sinceSequenceId);
    return jsonResponse({
      invalidations: loadCatchUpInvalidations(options.db, sinceSequenceId),
      currentSequenceId: getCurrentSequenceId(options.db),
    });
  }

  return new Response('Not Found\n', { status: 404 });
}

type JsonBodyResult = { ok: true; value: unknown } | { ok: false; status: number; error: string };

async function readJsonBodyWithLimit(request: Request): Promise<JsonBodyResult> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (
      !Number.isFinite(parsedLength) ||
      parsedLength < 0 ||
      parsedLength > SYNC_MAX_PAYLOAD_BYTES
    ) {
      return { ok: false, status: 413, error: 'Sync request body exceeds maximum payload size' };
    }
  }

  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > SYNC_MAX_PAYLOAD_BYTES) {
    return { ok: false, status: 413, error: 'Sync request body exceeds maximum payload size' };
  }

  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: err instanceof Error ? err.message : 'Invalid JSON request body',
    };
  }
}

function rawByteLength(rawMessage: string | Buffer): number {
  return typeof rawMessage === 'string'
    ? Buffer.byteLength(rawMessage, 'utf8')
    : rawMessage.byteLength;
}

function handleAuthenticatedFrame(
  options: StartSyncServerOptions,
  ws: BunServerWebSocket,
  frame: SyncClientFrame,
  authenticatedNodeId: string | null,
  connectionId: string,
  broadcast: (frame: SyncServerFrame, excludeConnectionId?: string) => void
): void {
  switch (frame.type) {
    case 'hello':
      ws.send(
        JSON.stringify({
          type: 'error',
          code: 'already_authenticated',
          message: 'hello was already accepted',
        } satisfies SyncServerFrame)
      );
      return;
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' } satisfies SyncServerFrame));
      return;
    case 'pong':
      return;
    case 'catch_up_request':
      if (!isValidClientCursor(options.db, frame.sinceSequenceId)) {
        ws.send(
          JSON.stringify({
            type: 'error',
            code: 'invalid_cursor',
            message: `sinceSequenceId ${frame.sinceSequenceId} exceeds current server sequence`,
          } satisfies SyncServerFrame)
        );
        return;
      }
      if (authenticatedNodeId) {
        updateTimNodeCursor(options.db, authenticatedNodeId, frame.sinceSequenceId);
      }
      ws.send(
        JSON.stringify({
          type: 'catch_up_response',
          invalidations: loadCatchUpInvalidations(options.db, frame.sinceSequenceId),
          currentSequenceId: getCurrentSequenceId(options.db),
        } satisfies SyncServerFrame)
      );
      return;
    case 'snapshot_request':
      ws.send(
        JSON.stringify({
          type: 'snapshot_response',
          requestId: frame.requestId,
          snapshots: frame.entityKeys
            .map((key) => loadCanonicalSnapshot(options.db, key))
            .filter((snapshot): snapshot is CanonicalSnapshot => snapshot !== null),
        } satisfies SyncServerFrame)
      );
      return;
    case 'op_batch': {
      if (!authenticatedNodeId) {
        ws.send(
          JSON.stringify({
            type: 'error',
            code: 'unauthenticated',
            message: 'Missing authenticated node context',
          } satisfies SyncServerFrame)
        );
        return;
      }
      const originError = validateOperationOrigins(frame.operations, authenticatedNodeId);
      if (originError) {
        ws.send(
          JSON.stringify({
            type: 'error',
            code: 'origin_mismatch',
            message: originError,
          } satisfies SyncServerFrame)
        );
        return;
      }
      const results = applyOperationBatchAndBroadcast(
        options.db,
        frame.operations,
        broadcast,
        connectionId
      );
      ws.send(JSON.stringify({ type: 'op_result', results } satisfies SyncServerFrame));
      return;
    }
    case 'batch': {
      if (!authenticatedNodeId) {
        ws.send(
          JSON.stringify({
            type: 'error',
            code: 'unauthenticated',
            message: 'Missing authenticated node context',
          } satisfies SyncServerFrame)
        );
        return;
      }
      const originError = validateOperationOrigins(frame.batch.operations, authenticatedNodeId);
      if (originError || frame.batch.originNodeId !== authenticatedNodeId) {
        ws.send(
          JSON.stringify({
            type: 'error',
            code: 'origin_mismatch',
            message: originError ?? 'Batch originNodeId does not match authenticated node',
          } satisfies SyncServerFrame)
        );
        return;
      }
      const result = applySyncBatchAndBroadcast(options.db, frame.batch, broadcast, connectionId);
      const resultFrame = batchResultFrame(frame.batch, result);
      ws.send(JSON.stringify(resultFrame satisfies SyncServerFrame));
      return;
    }
  }
}

function seedAllowedPersistentNodes(db: Database, allowedNodes: SyncAllowedNodeConfig[]): void {
  for (const node of allowedNodes) {
    insertTimNodeIfMissing(db, {
      nodeId: node.nodeId,
      role: 'persistent',
      label: node.label ?? null,
      tokenHash: node.tokenHash ?? null,
    });
  }
}

function isValidClientCursor(db: Database, value: number): boolean {
  // Reject impossible client cursors (claimed knowledge of sequences the server
  // has never emitted). Accepting them would silently advance the stored peer
  // cursor and let retention prune sequences the peer never received.
  return value <= getCurrentSequenceId(db);
}

function validateOperationOrigins(
  operations: SyncOperationEnvelope[],
  authenticatedNodeId: string
): string | null {
  const mismatch = operations.find((operation) => operation.originNodeId !== authenticatedNodeId);
  if (!mismatch) {
    return null;
  }
  return `Operation ${mismatch.operationUuid} originNodeId ${mismatch.originNodeId} does not match authenticated node ${authenticatedNodeId}`;
}

function applyOperationBatchAndBroadcast(
  db: Database,
  operations: SyncOperationEnvelope[],
  broadcast: (frame: SyncServerFrame, excludeConnectionId?: string) => void,
  excludeConnectionId?: string
): SyncOperationResult[] {
  const results = applyOperationBatch(db, operations);
  for (const result of results) {
    const sequenceId = result.sequenceIds?.at(-1);
    if (sequenceId && result.invalidations && result.invalidations.length > 0) {
      broadcast(
        { type: 'invalidate', sequenceId, entityKeys: result.invalidations },
        excludeConnectionId
      );
    }
  }
  return results;
}

export function applyOperationBatch(
  db: Database,
  operations: SyncOperationEnvelope[]
): SyncOperationResult[] {
  return operations.map((operation) => {
    try {
      const result = applyOperation(db, operation);
      return operationResult(operation.operationUuid, result);
    } catch (err) {
      if (err instanceof SyncFifoGapError) {
        return {
          operationId: operation.operationUuid,
          status: 'deferred',
          error: err.message,
        };
      }
      if (err instanceof SyncValidationError) {
        return {
          operationId: operation.operationUuid,
          status: 'rejected',
          error: err.message,
        };
      }
      return {
        operationId: operation.operationUuid,
        status: 'failed_retryable',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

export function applySyncBatchAndBroadcast(
  db: Database,
  batch: Parameters<typeof applyBatch>[1],
  broadcast: (frame: SyncServerFrame, excludeConnectionId?: string) => void,
  excludeConnectionId?: string
) {
  const result = applyBatch(db, batch);
  const sequenceId = result.sequenceIds.at(-1);
  if (sequenceId && result.invalidations.length > 0) {
    broadcast(
      { type: 'invalidate', sequenceId, entityKeys: result.invalidations },
      excludeConnectionId
    );
  }
  return result;
}

function operationResult(
  operationId: string,
  result: ApplyOperationResult,
  options: { forceRejected?: boolean } = {}
): SyncOperationResult {
  if (options.forceRejected) {
    return {
      operationId,
      status: 'rejected',
      sequenceIds: result.sequenceIds.length > 0 ? result.sequenceIds : undefined,
      invalidations: result.invalidations.length > 0 ? result.invalidations : undefined,
      error:
        result.error?.message ??
        'Operation rejected because its atomic batch did not commit on the main node',
    };
  }
  return {
    operationId,
    status: result.status,
    sequenceIds: result.sequenceIds.length > 0 ? result.sequenceIds : undefined,
    invalidations: result.invalidations.length > 0 ? result.invalidations : undefined,
    conflictId: result.conflictId,
    error: result.error?.message,
  };
}

function batchResultFrame(
  batch: Parameters<typeof applyBatch>[1],
  result: ReturnType<typeof applyBatch>
): SyncBatchResultFrame {
  return {
    type: 'batch_result',
    batchId: result.batchId,
    status: result.status,
    results: result.results.map((operationResultValue, index) =>
      operationResult(batch.operations[index].operationUuid, operationResultValue, {
        forceRejected: result.status === 'conflict',
      })
    ),
    sequenceIds: result.sequenceIds.length > 0 ? result.sequenceIds : undefined,
    invalidations: result.invalidations.length > 0 ? result.invalidations : undefined,
    error: result.error?.message,
  };
}

export function getCurrentSequenceId(db: Database): number {
  // Read the durable high-water mark from sqlite_sequence, which AUTOINCREMENT
  // updates on insert and does NOT decrement when rows are deleted. Reading
  // MAX(sequence) directly would regress after retention pruning empties the
  // table, causing peers to see a checkpoint go backwards. Fall back to 0
  // when no sequence has ever been assigned (no row in sqlite_sequence).
  const row = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'sync_sequence'").get() as
    | { seq: number }
    | undefined;
  return row?.seq ?? 0;
}

export function loadCatchUpInvalidations(
  db: Database,
  sinceSequenceId: number
): SyncCatchUpInvalidation[] {
  const rows = db
    .prepare(
      `
        SELECT sequence, target_key
        FROM sync_sequence
        WHERE sequence > ?
        ORDER BY sequence, target_key
      `
    )
    .all(sinceSequenceId) as Array<{ sequence: number; target_key: string }>;

  const grouped = new Map<number, Set<string>>();
  for (const row of rows) {
    const keys = grouped.get(row.sequence) ?? new Set<string>();
    keys.add(row.target_key);
    grouped.set(row.sequence, keys);
  }

  return [...grouped.entries()].map(([sequenceId, keys]) => ({
    sequenceId,
    entityKeys: [...keys],
  }));
}

export function loadCanonicalSnapshot(db: Database, entityKey: string): CanonicalSnapshot | null {
  if (entityKey.startsWith('plan:')) {
    return loadPlanSnapshot(db, entityKey.slice('plan:'.length));
  }
  if (entityKey.startsWith('task:')) {
    return loadTaskSnapshot(db, entityKey.slice('task:'.length));
  }
  if (entityKey.startsWith('project_setting:')) {
    return loadProjectSettingSnapshot(db, entityKey);
  }
  return null;
}

function loadPlanSnapshot(db: Database, planUuid: string): CanonicalSnapshot | null {
  const plan = getPlanByUuid(db, planUuid);
  if (!plan) {
    return loadDeletedPlanSnapshot(db, planUuid);
  }
  const project = db.prepare('SELECT uuid FROM project WHERE id = ?').get(plan.project_id) as {
    uuid: string;
  } | null;
  if (!project) {
    return null;
  }

  return {
    type: 'plan',
    projectUuid: project.uuid,
    plan: {
      uuid: plan.uuid,
      planId: plan.plan_id,
      title: plan.title,
      goal: plan.goal,
      note: plan.note,
      details: plan.details,
      status: plan.status,
      priority: plan.priority,
      branch: plan.branch,
      simple: nullableBoolean(plan.simple),
      tdd: nullableBoolean(plan.tdd),
      discoveredFrom: resolveDiscoveredFromUuid(db, plan.project_id, plan.discovered_from),
      issue: parseStringArray(plan.issue),
      pullRequest: parseStringArray(plan.pull_request),
      assignedTo: plan.assigned_to,
      baseBranch: plan.base_branch,
      temp: nullableBoolean(plan.temp),
      docs: parseStringArray(plan.docs),
      changedFiles: parseStringArray(plan.changed_files),
      planGeneratedAt: plan.plan_generated_at,
      reviewIssues: parseUnknownArray(plan.review_issues),
      parentUuid: plan.parent_uuid,
      epic: Boolean(plan.epic),
      revision: plan.revision,
      tasks: getPlanTasksByUuid(db, planUuid).map((task) => {
        if (!task.uuid) {
          throw new Error(`Plan task ${task.id} for plan ${planUuid} is missing a UUID`);
        }
        return {
          uuid: task.uuid,
          title: task.title,
          description: task.description,
          done: Boolean(task.done),
          revision: task.revision,
        };
      }),
      dependencyUuids: getPlanDependenciesByUuid(db, planUuid).map(
        (dependency) => dependency.depends_on_uuid
      ),
      tags: getPlanTagsByUuid(db, planUuid).map((tag) => tag.tag),
    },
  };
}

function loadDeletedPlanSnapshot(db: Database, planUuid: string): CanonicalSnapshot | null {
  const entityKey = `plan:${planUuid}`;
  const tombstone = db
    .prepare(
      `
        SELECT project_uuid, deleted_at
        FROM sync_tombstone
        WHERE entity_type = 'plan'
          AND entity_key = ?
      `
    )
    .get(entityKey) as { project_uuid: string; deleted_at: string } | null;
  if (!tombstone) {
    return {
      type: 'never_existed',
      entityKey,
      targetType: 'plan',
      planUuid,
    };
  }
  const sequence = db
    .prepare(
      `
        SELECT sequence
        FROM sync_sequence
        WHERE target_key = ?
        ORDER BY sequence DESC
        LIMIT 1
      `
    )
    .get(entityKey) as { sequence: number } | null;
  return {
    type: 'plan_deleted',
    projectUuid: tombstone.project_uuid,
    planUuid,
    deletedAt: tombstone.deleted_at,
    deletedBySequenceId: sequence?.sequence,
  };
}

function resolveDiscoveredFromUuid(
  db: Database,
  projectId: number,
  discoveredFrom: number | null
): string | null {
  if (discoveredFrom === null) {
    return null;
  }
  const row = db
    .prepare('SELECT uuid FROM plan WHERE project_id = ? AND plan_id = ?')
    .get(projectId, discoveredFrom) as { uuid: string } | null;
  return row?.uuid ?? null;
}

function loadTaskSnapshot(db: Database, taskUuid: string): CanonicalSnapshot | null {
  const task = db.prepare('SELECT plan_uuid FROM plan_task WHERE uuid = ?').get(taskUuid) as {
    plan_uuid: string;
  } | null;
  if (task) {
    return loadPlanSnapshot(db, task.plan_uuid);
  }

  const entityKey = `task:${taskUuid}`;
  const tombstone = db
    .prepare(
      `
        SELECT 1
        FROM sync_tombstone
        WHERE entity_type = 'task'
          AND entity_key = ?
      `
    )
    .get(entityKey);
  if (tombstone) {
    return null;
  }

  return {
    type: 'never_existed',
    entityKey,
    targetType: 'task',
    taskUuid,
  };
}

function loadProjectSettingSnapshot(db: Database, entityKey: string): CanonicalSnapshot | null {
  const [, projectUuid, setting] = entityKey.split(':');
  if (!projectUuid || !setting) {
    return null;
  }
  const project = getProjectByUuid(db, projectUuid);
  if (!project) {
    return null;
  }
  const row = getProjectSettingWithMetadata(db, project.id, setting);
  if (!row) {
    return { type: 'project_setting', projectUuid, setting, deleted: true };
  }
  return {
    type: 'project_setting',
    projectUuid,
    setting,
    value: row.value,
    revision: row.revision,
    updatedAt: row.updatedAt,
    updatedByNode: row.updatedByNode,
  };
}

function nullableBoolean(value: number | null): boolean | null {
  return value === null ? null : Boolean(value);
}

function parseStringArray(value: string | null): string[] | null {
  if (!value) {
    return null;
  }
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error(`Expected string array JSON, received ${value}`);
  }
  return parsed;
}

function parseUnknownArray(value: string | null): unknown[] | null {
  if (!value) {
    return null;
  }
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected array JSON, received ${value}`);
  }
  return parsed;
}

function extractBearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header) {
    return null;
  }
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return null;
  }
  return token;
}

function rawToString(raw: string | Buffer): string {
  return typeof raw === 'string' ? raw : raw.toString('utf8');
}

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...init.headers,
    },
  });
}
