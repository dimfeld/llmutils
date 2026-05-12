import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { getArtifactByUuid } from '../db/artifact.js';
import {
  getArtifactTransfer,
  markTransferFailed,
  markTransferSucceeded,
  upsertPendingTransfer,
} from '../db/artifact_transfer.js';
import { runMigrations } from '../db/migrations.js';
import { getOrCreateProject } from '../db/project.js';
import { upsertCanonicalPlanInTransaction, upsertProjectionPlanInTransaction } from '../db/plan.js';
import { resolveArtifactPath } from '../artifacts/storage.js';
import { hashToken } from './auth.js';
import { applyOperation } from './apply.js';
import { buildArtifactAttachOperation } from './operations.js';
import { startSyncServer, type SyncServerHandle } from './server.js';
import {
  ArtifactNotYetAvailableError,
  downloadArtifact,
  uploadArtifact,
} from './artifact_transfer.js';

const PROJECT_UUID = '11111111-1111-4111-8111-111111111111';
const PLAN_UUID = '22222222-2222-4222-8222-222222222222';
const TASK_UUID = '33333333-3333-4333-8333-333333333333';
const ARTIFACT_UUID = '44444444-4444-4444-8444-444444444444';
const NODE_ID = 'persistent-a';
const MAIN_NODE_ID = 'main-node';
const TOKEN = 'secret-token';

let tempDir: string;
let servers: SyncServerHandle[] = [];

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tim-artifact-transfer-test-'));
  vi.stubEnv('XDG_DATA_HOME', tempDir);
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.stop();
  }
  vi.unstubAllEnvs();
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('artifact transfer client', () => {
  test('uploads artifact bytes to a real sync server and short-circuits after success', async () => {
    const db = createDb();
    seedPlan(db);
    const bytes = Buffer.from('upload bytes');
    const artifact = await attachArtifact(db, bytes);
    const storagePath = resolveArtifactPath(PROJECT_UUID, PLAN_UUID, ARTIFACT_UUID, '.txt');
    await fs.mkdir(path.dirname(storagePath), { recursive: true });
    await fs.writeFile(storagePath, bytes);
    const server = startTestServer(db);

    await uploadArtifact({
      db,
      serverUrl: serverUrl(server),
      token: TOKEN,
      nodeId: NODE_ID,
      syncServerNodeId: MAIN_NODE_ID,
      artifact,
    });
    const first = getArtifactTransfer(db, ARTIFACT_UUID, MAIN_NODE_ID, 'upload');
    expect(first).toMatchObject({ status: 'succeeded', attempts: 1 });

    await uploadArtifact({
      db,
      serverUrl: serverUrl(server),
      token: TOKEN,
      nodeId: NODE_ID,
      syncServerNodeId: MAIN_NODE_ID,
      artifact,
    });
    expect(getArtifactTransfer(db, ARTIFACT_UUID, MAIN_NODE_ID, 'upload')).toMatchObject({
      status: 'succeeded',
      attempts: 1,
    });
  });

  test('records upload failures from auth and retries without resetting attempts', async () => {
    const db = createDb();
    seedPlan(db);
    const bytes = Buffer.from('retry bytes');
    const artifact = await attachArtifact(db, bytes);
    const storagePath = resolveArtifactPath(PROJECT_UUID, PLAN_UUID, ARTIFACT_UUID, '.txt');
    await fs.mkdir(path.dirname(storagePath), { recursive: true });
    await fs.writeFile(storagePath, bytes);
    const server = startTestServer(db);

    await expect(
      uploadArtifact({
        db,
        serverUrl: serverUrl(server),
        token: 'wrong',
        nodeId: NODE_ID,
        syncServerNodeId: MAIN_NODE_ID,
        artifact,
      })
    ).rejects.toThrow('401');
    expect(getArtifactTransfer(db, ARTIFACT_UUID, MAIN_NODE_ID, 'upload')).toMatchObject({
      status: 'failed',
      attempts: 1,
    });

    await uploadArtifact({
      db,
      serverUrl: serverUrl(server),
      token: TOKEN,
      nodeId: NODE_ID,
      syncServerNodeId: MAIN_NODE_ID,
      artifact,
    });
    expect(getArtifactTransfer(db, ARTIFACT_UUID, MAIN_NODE_ID, 'upload')).toMatchObject({
      status: 'succeeded',
      attempts: 2,
    });
  });

  test('downloads bytes, verifies sha256, and marks file_missing as transient', async () => {
    const db = createDb();
    seedPlan(db);
    const bytes = Buffer.from('download bytes');
    const artifact = await attachArtifact(db, bytes);
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request) {
        if (request.headers.get('authorization') !== `Bearer ${TOKEN}`) {
          return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }
        return new Response(bytes, {
          headers: {
            'content-type': artifact.mimeType,
            'content-length': String(bytes.byteLength),
            'x-artifact-sha256': artifact.sha256,
          },
        });
      },
    });

    try {
      await downloadArtifact({
        db,
        serverUrl: `http://${server.hostname}:${server.port}`,
        token: TOKEN,
        nodeId: NODE_ID,
        syncServerNodeId: MAIN_NODE_ID,
        artifact,
      });
      expect(getArtifactTransfer(db, ARTIFACT_UUID, MAIN_NODE_ID, 'download')).toMatchObject({
        status: 'succeeded',
        attempts: 1,
      });
      await expect(
        fs.readFile(resolveArtifactPath(PROJECT_UUID, PLAN_UUID, ARTIFACT_UUID, '.txt'))
      ).resolves.toEqual(bytes);
    } finally {
      server.stop(true);
    }

    await fs.rm(resolveArtifactPath(PROJECT_UUID, PLAN_UUID, ARTIFACT_UUID, '.txt'), {
      force: true,
    });
    const missingServer = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch() {
        return Response.json({ error: 'file_missing' }, { status: 409 });
      },
    });
    const missingDb = createDb();
    seedPlan(missingDb);
    const missingArtifact = await attachArtifact(missingDb, bytes);
    try {
      await expect(
        downloadArtifact({
          db: missingDb,
          serverUrl: `http://${missingServer.hostname}:${missingServer.port}`,
          token: TOKEN,
          nodeId: NODE_ID,
          syncServerNodeId: MAIN_NODE_ID,
          artifact: missingArtifact,
        })
      ).rejects.toBeInstanceOf(ArtifactNotYetAvailableError);
      expect(getArtifactTransfer(missingDb, ARTIFACT_UUID, MAIN_NODE_ID, 'download')).toMatchObject(
        {
          status: 'failed',
          attempts: 1,
        }
      );
    } finally {
      missingServer.stop(true);
    }
  });

  test('upload via real server populates transfer row and server stores file; consumer detects local match', async () => {
    // Tests the upload→server path and the consumer's local-file-match short-circuit.
    // A true cross-node download round-trip requires separate per-process data dirs;
    // in-process single-XDG_DATA_HOME isolation is verified by the stub-server download
    // tests above and the GET endpoint tests in server.test.ts.
    const originDb = createDb();
    seedPlan(originDb);
    const bytes = Buffer.from('full round-trip payload');
    const originArtifact = await attachArtifact(originDb, bytes);

    const storagePath = resolveArtifactPath(PROJECT_UUID, PLAN_UUID, ARTIFACT_UUID, '.txt');
    await fs.mkdir(path.dirname(storagePath), { recursive: true });
    await fs.writeFile(storagePath, bytes);

    const server = startTestServer(originDb);

    // Upload: transfer row → succeeded; file survives at server-side path
    await uploadArtifact({
      db: originDb,
      serverUrl: serverUrl(server),
      token: TOKEN,
      nodeId: NODE_ID,
      syncServerNodeId: MAIN_NODE_ID,
      artifact: originArtifact,
    });
    expect(getArtifactTransfer(originDb, ARTIFACT_UUID, MAIN_NODE_ID, 'upload')).toMatchObject({
      status: 'succeeded',
      attempts: 1,
    });
    // File is present on disk at the shared XDG_DATA_HOME path
    await expect(fs.readFile(storagePath)).resolves.toEqual(bytes);

    // Consumer DB (no prior transfer row): downloadArtifact detects file already present
    // locally (same XDG_DATA_HOME, same computed path) and short-circuits to succeeded
    const consumerDb = createDb();
    seedPlan(consumerDb);
    const consumerArtifact = await attachArtifact(consumerDb, bytes);

    await downloadArtifact({
      db: consumerDb,
      serverUrl: serverUrl(server),
      token: TOKEN,
      nodeId: NODE_ID,
      syncServerNodeId: MAIN_NODE_ID,
      artifact: consumerArtifact,
    });

    expect(getArtifactTransfer(consumerDb, ARTIFACT_UUID, MAIN_NODE_ID, 'download')).toMatchObject({
      status: 'succeeded',
    });
  });

  test('download sha256 mismatch marks transfer failed', async () => {
    const db = createDb();
    seedPlan(db);
    // Make bytes 10 chars so we can craft wrong bytes of identical length
    const bytes = Buffer.from('0123456789'); // 10 bytes
    const artifact = await attachArtifact(db, bytes);

    // Same length, different content → sha256 differs, size matches
    const wrongBytes = Buffer.from('9876543210'); // 10 bytes, different sha256
    const corruptServer = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request) {
        if (request.headers.get('authorization') !== `Bearer ${TOKEN}`) {
          return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }
        // Return wrong bytes but correct size so size check passes and sha256 check fails
        return new Response(wrongBytes, {
          headers: {
            'content-type': artifact.mimeType,
            'content-length': String(wrongBytes.byteLength),
            'x-artifact-sha256': artifact.sha256, // correct sha256 header, wrong body
          },
        });
      },
    });

    try {
      await expect(
        downloadArtifact({
          db,
          serverUrl: `http://${corruptServer.hostname}:${corruptServer.port}`,
          token: TOKEN,
          nodeId: NODE_ID,
          syncServerNodeId: MAIN_NODE_ID,
          artifact,
        })
      ).rejects.toThrow();
      expect(getArtifactTransfer(db, ARTIFACT_UUID, MAIN_NODE_ID, 'download')).toMatchObject({
        status: 'failed',
        attempts: 1,
        last_error: expect.stringContaining('sha256'),
      });
    } finally {
      corruptServer.stop(true);
    }
  });

  test('redownloads when a succeeded download row has lost its local file', async () => {
    const db = createDb();
    seedPlan(db);
    const bytes = Buffer.from('restored bytes');
    const artifact = await attachArtifact(db, bytes);
    const storagePath = resolveArtifactPath(PROJECT_UUID, PLAN_UUID, ARTIFACT_UUID, '.txt');
    await fs.mkdir(path.dirname(storagePath), { recursive: true });
    await fs.writeFile(storagePath, bytes);
    markTransferSucceeded(db, ARTIFACT_UUID, MAIN_NODE_ID, 'download');
    await fs.rm(storagePath);

    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request) {
        if (request.headers.get('authorization') !== `Bearer ${TOKEN}`) {
          return Response.json({ error: 'Unauthorized' }, { status: 401 });
        }
        return new Response(bytes, {
          headers: {
            'content-type': artifact.mimeType,
            'content-length': String(bytes.byteLength),
            'x-artifact-sha256': artifact.sha256,
          },
        });
      },
    });

    try {
      await downloadArtifact({
        db,
        serverUrl: `http://${server.hostname}:${server.port}`,
        token: TOKEN,
        nodeId: NODE_ID,
        syncServerNodeId: MAIN_NODE_ID,
        artifact,
      });

      await expect(fs.readFile(storagePath)).resolves.toEqual(bytes);
      expect(getArtifactTransfer(db, ARTIFACT_UUID, MAIN_NODE_ID, 'download')).toMatchObject({
        status: 'succeeded',
        attempts: 1,
        last_error: null,
      });
    } finally {
      server.stop(true);
    }
  });

  test('failed recovery from a stale succeeded row records a new attempt and error', async () => {
    const db = createDb();
    seedPlan(db);
    const bytes = Buffer.from('directory collision bytes');
    const artifact = await attachArtifact(db, bytes);
    const storagePath = resolveArtifactPath(PROJECT_UUID, PLAN_UUID, ARTIFACT_UUID, '.txt');
    await fs.mkdir(storagePath, { recursive: true });
    markTransferSucceeded(db, ARTIFACT_UUID, MAIN_NODE_ID, 'download');

    try {
      await expect(
        downloadArtifact({
          db,
          serverUrl: 'http://127.0.0.1:9',
          token: TOKEN,
          nodeId: NODE_ID,
          syncServerNodeId: MAIN_NODE_ID,
          artifact,
        })
      ).rejects.toThrow('Artifact path is not a file');

      expect(getArtifactTransfer(db, ARTIFACT_UUID, MAIN_NODE_ID, 'download')).toMatchObject({
        status: 'failed',
        attempts: 1,
        last_error: expect.stringContaining('Artifact path is not a file'),
      });
    } finally {
      await fs.rm(storagePath, { recursive: true, force: true });
    }
  });

  test('download records local preflight filesystem failures before retrying later', async () => {
    const db = createDb();
    seedPlan(db);
    const bytes = Buffer.from('unreadable local bytes');
    const artifact = await attachArtifact(db, bytes);
    const storagePath = resolveArtifactPath(PROJECT_UUID, PLAN_UUID, ARTIFACT_UUID, '.txt');
    await fs.mkdir(path.dirname(storagePath), { recursive: true });
    await fs.writeFile(storagePath, bytes);
    await fs.chmod(storagePath, 0o000);

    try {
      await expect(
        downloadArtifact({
          db,
          serverUrl: 'http://127.0.0.1:9',
          token: TOKEN,
          nodeId: NODE_ID,
          syncServerNodeId: MAIN_NODE_ID,
          artifact,
        })
      ).rejects.toThrow();

      expect(getArtifactTransfer(db, ARTIFACT_UUID, MAIN_NODE_ID, 'download')).toMatchObject({
        status: 'failed',
        attempts: 1,
      });
    } finally {
      await fs.chmod(storagePath, 0o600).catch(() => {});
    }
  });

  test('keeps failed transfer rows retryable until success', async () => {
    const db = createDb();
    seedPlan(db);
    await attachArtifact(db, Buffer.from('attempts'));
    upsertPendingTransfer(db, ARTIFACT_UUID, MAIN_NODE_ID, 'download');
    markTransferFailed(db, ARTIFACT_UUID, MAIN_NODE_ID, 'download', new Error('first'));
    upsertPendingTransfer(db, ARTIFACT_UUID, MAIN_NODE_ID, 'download');
    markTransferFailed(db, ARTIFACT_UUID, MAIN_NODE_ID, 'download', new Error('second'));

    expect(getArtifactTransfer(db, ARTIFACT_UUID, MAIN_NODE_ID, 'download')).toMatchObject({
      status: 'failed',
      attempts: 0,
      last_error: 'second',
    });
  });
});

function createDb(): Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function seedPlan(db: Database): void {
  const project = getOrCreateProject(db, 'github.com__example__repo', {
    uuid: PROJECT_UUID,
    highestPlanId: 10,
  });
  const plan = {
    uuid: PLAN_UUID,
    planId: 1,
    title: 'Transfer plan',
    status: 'pending',
    revision: 1,
    tasks: [{ uuid: TASK_UUID, title: 'Task one', description: 'Do it' }],
    forceOverwrite: true,
  };
  upsertCanonicalPlanInTransaction(db, project.id, {
    ...plan,
    tasks: plan.tasks.map((task) => ({ ...task, revision: 1 })),
  });
  upsertProjectionPlanInTransaction(db, project.id, plan);
}

async function attachArtifact(db: Database, bytes: Buffer) {
  await applyOperation(
    db,
    await buildArtifactAttachOperation(
      {
        projectUuid: PROJECT_UUID,
        planUuid: PLAN_UUID,
        artifactUuid: ARTIFACT_UUID,
        filename: 'artifact.txt',
        mimeType: 'text/plain',
        size: bytes.byteLength,
        sha256: sha256(bytes),
      },
      { originNodeId: NODE_ID, localSequence: 1 }
    )
  );
  const artifact = getArtifactByUuid(db, ARTIFACT_UUID);
  if (!artifact) {
    throw new Error('Expected artifact metadata');
  }
  return artifact;
}

function startTestServer(db: Database): SyncServerHandle {
  const server = startSyncServer({
    db,
    mainNodeId: MAIN_NODE_ID,
    port: 0,
    allowedNodes: [{ nodeId: NODE_ID, tokenHash: hashToken(TOKEN) }],
  });
  servers.push(server);
  return server;
}

function serverUrl(server: SyncServerHandle): string {
  return `http://${server.hostname}:${server.port}`;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
